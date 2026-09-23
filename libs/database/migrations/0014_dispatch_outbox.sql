CREATE TABLE public.share_dispatches (
  id uuid PRIMARY KEY,
  idempotency_key uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  report_id uuid NOT NULL,
  source_id uuid NOT NULL,
  report_version bigint NOT NULL CHECK (report_version > 0),
  manifest_revision integer NOT NULL CHECK (manifest_revision > 0),
  actor_staff_user_id uuid NOT NULL REFERENCES public.staff_users(id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'blocked_policy' CHECK (state = 'blocked_policy'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (report_id, source_id) REFERENCES public.reports(id, source_id) ON DELETE RESTRICT,
  FOREIGN KEY (report_id, source_id, manifest_revision)
    REFERENCES public.ingestion_batches(report_id, source_id, revision) ON DELETE RESTRICT,
  UNIQUE (actor_staff_user_id, idempotency_key),
  UNIQUE (id, report_id, source_id)
);

CREATE TABLE public.share_dispatch_recipients (
  id uuid PRIMARY KEY,
  dispatch_id uuid NOT NULL,
  report_id uuid NOT NULL,
  source_id uuid NOT NULL,
  recipient_kind text NOT NULL CHECK (recipient_kind IN ('patient', 'doctor')),
  doctor_id uuid REFERENCES public.doctors(id) ON DELETE RESTRICT,
  doctor_version bigint,
  display_name_snapshot text NOT NULL CHECK (length(trim(display_name_snapshot)) BETWEEN 1 AND 160),
  phone_e164_snapshot text NOT NULL CHECK (phone_e164_snapshot ~ '^\+[1-9][0-9]{7,14}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (dispatch_id, report_id, source_id)
    REFERENCES public.share_dispatches(id, report_id, source_id) ON DELETE RESTRICT,
  UNIQUE (dispatch_id, recipient_kind),
  UNIQUE (id, dispatch_id),
  CHECK (
    (recipient_kind = 'patient' AND doctor_id IS NULL AND doctor_version IS NULL)
    OR (recipient_kind = 'doctor' AND doctor_id IS NOT NULL AND doctor_version IS NOT NULL AND doctor_version > 0)
  )
);

CREATE TABLE public.dispatch_outbox (
  id uuid PRIMARY KEY,
  dispatch_id uuid NOT NULL,
  recipient_id uuid NOT NULL UNIQUE,
  idempotency_key uuid NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'blocked_policy'
    CHECK (state IN ('blocked_policy', 'queued', 'submitted', 'delivered', 'failed', 'uncertain')),
  authorization_ref uuid,
  message_text text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 100),
  claim_token uuid,
  claim_expires_at timestamptz,
  provider_message_id text,
  last_error_code text,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (recipient_id, dispatch_id)
    REFERENCES public.share_dispatch_recipients(id, dispatch_id) ON DELETE RESTRICT,
  CHECK ((claim_token IS NULL) = (claim_expires_at IS NULL)),
  CHECK (provider_message_id IS NULL OR length(trim(provider_message_id)) BETWEEN 1 AND 200),
  CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z0-9_]{1,64}$'),
  CHECK (
    (state = 'blocked_policy' AND authorization_ref IS NULL AND message_text IS NULL
      AND attempt_count = 0 AND claim_token IS NULL AND provider_message_id IS NULL)
    OR (state = 'queued' AND authorization_ref IS NOT NULL
      AND message_text IS NOT NULL AND length(trim(message_text)) BETWEEN 1 AND 2000
      AND provider_message_id IS NULL)
    OR (state IN ('submitted', 'delivered') AND authorization_ref IS NOT NULL
      AND message_text IS NOT NULL AND length(trim(message_text)) BETWEEN 1 AND 2000
      AND provider_message_id IS NOT NULL AND claim_token IS NULL)
    OR (state = 'failed' AND authorization_ref IS NOT NULL
      AND message_text IS NOT NULL AND length(trim(message_text)) BETWEEN 1 AND 2000
      AND claim_token IS NULL)
    OR (state = 'uncertain' AND authorization_ref IS NOT NULL
      AND message_text IS NOT NULL AND length(trim(message_text)) BETWEEN 1 AND 2000
      AND claim_token IS NULL)
  )
);

CREATE INDEX dispatch_outbox_claimable
  ON public.dispatch_outbox (created_at, id)
  WHERE state = 'queued' AND authorization_ref IS NOT NULL;

CREATE TABLE public.dispatch_callback_events (
  event_id text PRIMARY KEY CHECK (event_id ~ '^[A-Za-z0-9_-]{8,128}$'),
  idempotency_key uuid NOT NULL,
  provider_message_id text NOT NULL CHECK (length(trim(provider_message_id)) BETWEEN 1 AND 200),
  delivery_state text NOT NULL CHECK (delivery_state IN ('submitted', 'delivered', 'failed')),
  occurred_at timestamptz NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION public.reject_dispatch_snapshot_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'dispatch request and recipient snapshots are immutable' USING ERRCODE = '23514';
END;
$$;
REVOKE ALL ON FUNCTION public.reject_dispatch_snapshot_mutation() FROM PUBLIC;

CREATE TRIGGER share_dispatches_immutable
  BEFORE UPDATE OR DELETE ON public.share_dispatches
  FOR EACH ROW EXECUTE FUNCTION public.reject_dispatch_snapshot_mutation();
CREATE TRIGGER share_dispatch_recipients_immutable
  BEFORE UPDATE OR DELETE ON public.share_dispatch_recipients
  FOR EACH ROW EXECUTE FUNCTION public.reject_dispatch_snapshot_mutation();

CREATE FUNCTION public.guard_dispatch_outbox_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.dispatch_id IS DISTINCT FROM OLD.dispatch_id
     OR NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'dispatch outbox identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_dispatch_outbox_identity() FROM PUBLIC;

CREATE TRIGGER dispatch_outbox_identity_immutable
  BEFORE UPDATE ON public.dispatch_outbox
  FOR EACH ROW EXECUTE FUNCTION public.guard_dispatch_outbox_identity();

CREATE FUNCTION public.reject_dispatch_callback_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'provider callback receipts are append-only' USING ERRCODE = '23514';
END;
$$;
REVOKE ALL ON FUNCTION public.reject_dispatch_callback_mutation() FROM PUBLIC;

CREATE TRIGGER dispatch_callback_events_immutable
  BEFORE UPDATE OR DELETE ON public.dispatch_callback_events
  FOR EACH ROW EXECUTE FUNCTION public.reject_dispatch_callback_mutation();

CREATE FUNCTION public.create_share_dispatch(
  p_dispatch_id uuid,
  p_idempotency_key uuid,
  p_report_id uuid,
  p_expected_report_version bigint,
  p_expected_manifest_revision integer,
  p_actor_staff_user_id uuid,
  p_send_to_patient boolean,
  p_patient_phone_e164 text,
  p_send_to_doctor boolean,
  p_doctor_id uuid,
  p_expected_doctor_version bigint
) RETURNS TABLE (out_dispatch_id uuid, out_state text, out_recipient_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_request jsonb;
  v_fingerprint text;
  v_existing public.share_dispatches%ROWTYPE;
  v_report public.reports%ROWTYPE;
  v_source_generation bigint;
  v_doctor public.doctors%ROWTYPE;
  v_patient_recipient uuid;
  v_doctor_recipient uuid;
  v_recipient_count integer := 0;
BEGIN
  IF p_dispatch_id IS NULL OR p_idempotency_key IS NULL OR p_report_id IS NULL
     OR p_expected_report_version IS NULL OR p_expected_report_version < 1
     OR p_expected_manifest_revision IS NULL OR p_expected_manifest_revision < 1
     OR p_actor_staff_user_id IS NULL OR p_send_to_patient IS NULL OR p_send_to_doctor IS NULL
     OR (NOT p_send_to_patient AND NOT p_send_to_doctor)
     OR (p_send_to_patient AND (p_patient_phone_e164 IS NULL OR p_patient_phone_e164 !~ '^\+[1-9][0-9]{7,14}$'))
     OR (NOT p_send_to_patient AND p_patient_phone_e164 IS NOT NULL)
     OR (p_send_to_doctor AND (p_doctor_id IS NULL OR p_expected_doctor_version IS NULL OR p_expected_doctor_version < 1))
     OR (NOT p_send_to_doctor AND (p_doctor_id IS NOT NULL OR p_expected_doctor_version IS NOT NULL)) THEN
    RAISE EXCEPTION 'dispatch request is invalid' USING ERRCODE = '22023';
  END IF;

  v_request := jsonb_build_object(
    'report', p_report_id, 'reportVersion', p_expected_report_version,
    'manifestRevision', p_expected_manifest_revision,
    'sendToPatient', p_send_to_patient, 'patientPhone', p_patient_phone_e164,
    'sendToDoctor', p_send_to_doctor, 'doctorId', p_doctor_id,
    'doctorVersion', p_expected_doctor_version
  );
  v_fingerprint := encode(digest(v_request::text, 'sha256'), 'hex');

  -- Even idempotent retries require the actor's membership to remain active.
  IF NOT public.require_active_doctor_staff(p_actor_staff_user_id) THEN
    RAISE EXCEPTION 'staff access is inactive' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_staff_user_id::text || ':' || p_idempotency_key::text, 0));
  SELECT * INTO v_existing FROM public.share_dispatches d
   WHERE d.actor_staff_user_id = p_actor_staff_user_id AND d.idempotency_key = p_idempotency_key
   FOR UPDATE;
  IF FOUND THEN
    IF v_existing.request_fingerprint IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'dispatch idempotency key was reused for a different request' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT v_existing.id, v_existing.state,
      (SELECT count(*)::integer FROM public.share_dispatch_recipients r WHERE r.dispatch_id = v_existing.id);
    RETURN;
  END IF;

  SELECT * INTO v_report FROM public.reports r WHERE r.id = p_report_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Report does not exist' USING ERRCODE = '23503'; END IF;
  IF v_report.state IS DISTINCT FROM 'ready'
     OR v_report.version IS DISTINCT FROM p_expected_report_version
     OR v_report.current_manifest_revision IS DISTINCT FROM p_expected_manifest_revision
     OR v_report.has_unresolved_conflict THEN
    RAISE EXCEPTION 'Report readiness or version changed' USING ERRCODE = '40001';
  END IF;
  SELECT s.generation INTO v_source_generation FROM public.orthanc_sources s
    WHERE s.id = v_report.source_id;
  IF NOT EXISTS (
    SELECT 1 FROM public.ingestion_batches b
    JOIN public.report_manifest_proofs proof
      ON proof.report_id = b.report_id AND proof.source_id = b.source_id AND proof.revision = b.revision
    WHERE b.report_id = v_report.id AND b.source_id = v_report.source_id
      AND b.revision = p_expected_manifest_revision AND b.state = 'sealed'
      AND proof.source_generation = v_source_generation
      AND proof.source_stable AND proof.inventory_complete
  ) THEN
    RAISE EXCEPTION 'Report current manifest is not sealed and verified' USING ERRCODE = '23514';
  END IF;

  IF p_send_to_doctor THEN
    SELECT * INTO v_doctor FROM public.doctors d WHERE d.id = p_doctor_id FOR SHARE;
    IF NOT FOUND OR NOT v_doctor.active OR v_doctor.version IS DISTINCT FROM p_expected_doctor_version THEN
      RAISE EXCEPTION 'selected doctor changed or is inactive' USING ERRCODE = '40001';
    END IF;
  END IF;

  INSERT INTO public.share_dispatches (
    id, idempotency_key, request_fingerprint, report_id, source_id,
    report_version, manifest_revision, actor_staff_user_id
  ) VALUES (
    p_dispatch_id, p_idempotency_key, v_fingerprint, v_report.id, v_report.source_id,
    v_report.version, v_report.current_manifest_revision, p_actor_staff_user_id
  );

  IF p_send_to_patient THEN
    v_patient_recipient := gen_random_uuid();
    INSERT INTO public.share_dispatch_recipients (
      id, dispatch_id, report_id, source_id, recipient_kind,
      display_name_snapshot, phone_e164_snapshot
    ) VALUES (
      v_patient_recipient, p_dispatch_id, v_report.id, v_report.source_id, 'patient',
      'Patient', p_patient_phone_e164
    );
    INSERT INTO public.dispatch_outbox (id, dispatch_id, recipient_id, idempotency_key)
    VALUES (gen_random_uuid(), p_dispatch_id, v_patient_recipient, gen_random_uuid());
    v_recipient_count := v_recipient_count + 1;
  END IF;

  IF p_send_to_doctor THEN
    v_doctor_recipient := gen_random_uuid();
    INSERT INTO public.share_dispatch_recipients (
      id, dispatch_id, report_id, source_id, recipient_kind, doctor_id,
      doctor_version, display_name_snapshot, phone_e164_snapshot
    ) VALUES (
      v_doctor_recipient, p_dispatch_id, v_report.id, v_report.source_id, 'doctor', v_doctor.id,
      v_doctor.version, v_doctor.display_name, v_doctor.phone_e164
    );
    INSERT INTO public.dispatch_outbox (id, dispatch_id, recipient_id, idempotency_key)
    VALUES (gen_random_uuid(), p_dispatch_id, v_doctor_recipient, gen_random_uuid());
    v_recipient_count := v_recipient_count + 1;
  END IF;

  RETURN QUERY SELECT p_dispatch_id, 'blocked_policy'::text, v_recipient_count;
END;
$$;

CREATE FUNCTION public.claim_dispatch_outbox(
  p_claim_token uuid,
  p_claim_seconds integer
) RETURNS TABLE (
  outbox_id uuid, idempotency_key uuid, destination_phone_e164 text,
  message_text text, attempt_count integer, claim_expires_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_item public.dispatch_outbox%ROWTYPE;
BEGIN
  IF p_claim_token IS NULL OR p_claim_seconds IS NULL OR p_claim_seconds NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'outbox claim request is invalid' USING ERRCODE = '22023';
  END IF;

  -- A crashed first-attempt worker has an unknown provider outcome. Never put
  -- that intent back into the claim queue; it must use provider reconciliation.
  WITH expired AS (
    SELECT o.id FROM public.dispatch_outbox o
     WHERE o.state = 'queued' AND o.claim_token IS NOT NULL
       AND o.claim_expires_at <= clock_timestamp()
     ORDER BY o.claim_expires_at, o.id
     FOR UPDATE SKIP LOCKED LIMIT 100
  )
  UPDATE public.dispatch_outbox o SET state = 'uncertain', claim_token = NULL,
    claim_expires_at = NULL, last_error_code = 'worker_claim_expired',
    updated_at = clock_timestamp(), version = version + 1
   FROM expired WHERE o.id = expired.id;

  SELECT * INTO v_item FROM public.dispatch_outbox o
   WHERE o.state = 'queued' AND o.authorization_ref IS NOT NULL
     AND o.message_text IS NOT NULL AND o.claim_token IS NULL AND o.attempt_count = 0
   ORDER BY o.created_at, o.id FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE public.dispatch_outbox o SET claim_token = p_claim_token,
    claim_expires_at = clock_timestamp() + make_interval(secs => p_claim_seconds),
    attempt_count = 1, updated_at = clock_timestamp(), version = version + 1
   WHERE o.id = v_item.id;
  RETURN QUERY SELECT o.id, o.idempotency_key, r.phone_e164_snapshot,
    o.message_text, o.attempt_count, o.claim_expires_at
    FROM public.dispatch_outbox o
    JOIN public.share_dispatch_recipients r ON r.id = o.recipient_id
   WHERE o.id = v_item.id;
END;
$$;

CREATE FUNCTION public.record_dispatch_provider_outcome(
  p_outbox_id uuid,
  p_claim_token uuid,
  p_outcome text,
  p_provider_message_id text,
  p_error_code text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_item public.dispatch_outbox%ROWTYPE;
  v_state text;
BEGIN
  IF p_outbox_id IS NULL OR p_claim_token IS NULL
     OR p_outcome IS NULL OR p_outcome NOT IN ('accepted', 'unknown', 'rejected')
     OR (p_outcome = 'accepted' AND (p_provider_message_id IS NULL OR length(trim(p_provider_message_id)) NOT BETWEEN 1 AND 200))
     OR (p_outcome <> 'accepted' AND p_provider_message_id IS NOT NULL)
     OR (p_error_code IS NOT NULL AND p_error_code !~ '^[a-z0-9_]{1,64}$') THEN
    RAISE EXCEPTION 'provider outcome is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_item FROM public.dispatch_outbox o WHERE o.id = p_outbox_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'outbox item does not exist' USING ERRCODE = '23503'; END IF;
  IF v_item.state <> 'queued' OR v_item.claim_token IS DISTINCT FROM p_claim_token
     OR v_item.claim_expires_at IS NULL OR v_item.claim_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'outbox claim is stale' USING ERRCODE = '40001';
  END IF;
  v_state := CASE p_outcome WHEN 'accepted' THEN 'submitted'
    WHEN 'unknown' THEN 'uncertain' ELSE 'failed' END;
  UPDATE public.dispatch_outbox SET state = v_state,
    provider_message_id = p_provider_message_id,
    last_error_code = CASE WHEN p_outcome = 'accepted' THEN NULL ELSE p_error_code END,
    claim_token = NULL, claim_expires_at = NULL,
    updated_at = clock_timestamp(), version = version + 1
   WHERE id = p_outbox_id;
  RETURN v_state;
END;
$$;

CREATE FUNCTION public.reconcile_dispatch_outbox(
  p_idempotency_key uuid,
  p_provider_message_id text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_item public.dispatch_outbox%ROWTYPE;
BEGIN
  IF p_idempotency_key IS NULL OR
     (p_provider_message_id IS NOT NULL AND length(trim(p_provider_message_id)) NOT BETWEEN 1 AND 200) THEN
    RAISE EXCEPTION 'provider reconciliation input is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_item FROM public.dispatch_outbox o
   WHERE o.idempotency_key = p_idempotency_key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'outbox item does not exist' USING ERRCODE = '23503'; END IF;
  IF v_item.state <> 'uncertain' THEN
    RAISE EXCEPTION 'outbox item is not awaiting reconciliation' USING ERRCODE = '23514';
  END IF;
  IF p_provider_message_id IS NULL THEN RETURN 'uncertain'; END IF;
  UPDATE public.dispatch_outbox SET state = 'submitted', provider_message_id = p_provider_message_id,
    last_error_code = NULL, updated_at = clock_timestamp(), version = version + 1
   WHERE id = v_item.id;
  RETURN 'submitted';
END;
$$;

CREATE FUNCTION public.apply_dispatch_provider_callback(
  p_event_id text,
  p_idempotency_key uuid,
  p_provider_message_id text,
  p_delivery_state text,
  p_occurred_at timestamptz,
  p_payload_sha256 text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_prior public.dispatch_callback_events%ROWTYPE;
  v_item public.dispatch_outbox%ROWTYPE;
BEGIN
  IF p_event_id IS NULL OR p_event_id !~ '^[A-Za-z0-9_-]{8,128}$'
     OR p_idempotency_key IS NULL OR p_provider_message_id IS NULL
     OR length(trim(p_provider_message_id)) NOT BETWEEN 1 AND 200
     OR p_delivery_state IS NULL OR p_delivery_state NOT IN ('submitted', 'delivered', 'failed')
     OR p_occurred_at IS NULL OR p_payload_sha256 IS NULL OR p_payload_sha256 !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'provider callback is invalid' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('dispatch-callback:' || p_event_id, 0));
  SELECT * INTO v_prior FROM public.dispatch_callback_events e WHERE e.event_id = p_event_id FOR UPDATE;
  IF FOUND THEN
    IF v_prior.idempotency_key IS DISTINCT FROM p_idempotency_key
       OR v_prior.provider_message_id IS DISTINCT FROM p_provider_message_id
       OR v_prior.delivery_state IS DISTINCT FROM p_delivery_state
       OR v_prior.payload_sha256 IS DISTINCT FROM p_payload_sha256 THEN
      RAISE EXCEPTION 'provider callback event ID was reused' USING ERRCODE = '23505';
    END IF;
    SELECT * INTO v_item FROM public.dispatch_outbox o WHERE o.idempotency_key = p_idempotency_key;
    RETURN v_item.state;
  END IF;
  SELECT * INTO v_item FROM public.dispatch_outbox o
   WHERE o.idempotency_key = p_idempotency_key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'callback has no matching outbox item' USING ERRCODE = '23503'; END IF;
  IF (v_item.provider_message_id IS NOT NULL AND v_item.provider_message_id IS DISTINCT FROM p_provider_message_id)
     OR v_item.state NOT IN ('submitted', 'uncertain', 'delivered', 'failed') THEN
    RAISE EXCEPTION 'callback does not match an accepted provider message' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.dispatch_callback_events (
    event_id, idempotency_key, provider_message_id, delivery_state, occurred_at, payload_sha256
  ) VALUES (p_event_id, p_idempotency_key, p_provider_message_id, p_delivery_state, p_occurred_at, p_payload_sha256);
  IF v_item.state IN ('delivered', 'failed') THEN RETURN v_item.state; END IF;
  UPDATE public.dispatch_outbox SET state = p_delivery_state,
    provider_message_id = COALESCE(provider_message_id, p_provider_message_id),
    claim_token = NULL, claim_expires_at = NULL,
    last_error_code = CASE WHEN p_delivery_state = 'failed' THEN 'provider_delivery_failed' ELSE NULL END,
    updated_at = clock_timestamp(), version = version + 1
   WHERE id = v_item.id;
  RETURN p_delivery_state;
END;
$$;

REVOKE ALL ON TABLE public.share_dispatches, public.share_dispatch_recipients,
  public.dispatch_outbox, public.dispatch_callback_events FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_share_dispatch(uuid, uuid, uuid, bigint, integer, uuid, boolean, text, boolean, uuid, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_dispatch_outbox(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_dispatch_provider_outcome(uuid, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconcile_dispatch_outbox(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_dispatch_provider_callback(text, uuid, text, text, timestamptz, text) FROM PUBLIC;

COMMENT ON TABLE public.share_dispatches IS
  'Immutable, CAS-bound sharing intent. Initial rows are blocked_policy pending recipient-authorization policy.';
COMMENT ON TABLE public.dispatch_outbox IS
  'Transactional provider work queue. Initial rows contain no authorization, message or share link and cannot be claimed. Dispatch rows stay blocked_policy; later policy migrations may activate individual outbox rows.';
COMMENT ON FUNCTION public.create_share_dispatch(uuid, uuid, uuid, bigint, integer, uuid, boolean, text, boolean, uuid, bigint) IS
  'Captures immutable recipients for a Ready Report. Does not authorize a recipient, mint a link or enable Send.';
COMMENT ON FUNCTION public.apply_dispatch_provider_callback(text, uuid, text, text, timestamptz, text) IS
  'Applies a deduplicated provider callback after the caller has verified its signature and bounded the request body.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clarity_v2_runtime') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.share_dispatches, public.share_dispatch_recipients, public.dispatch_outbox, public.dispatch_callback_events FROM clarity_v2_runtime';
    EXECUTE 'REVOKE ALL ON FUNCTION public.create_share_dispatch(uuid, uuid, uuid, bigint, integer, uuid, boolean, text, boolean, uuid, bigint) FROM clarity_v2_runtime';
    EXECUTE 'REVOKE ALL ON FUNCTION public.claim_dispatch_outbox(uuid, integer) FROM clarity_v2_runtime';
    EXECUTE 'REVOKE ALL ON FUNCTION public.record_dispatch_provider_outcome(uuid, uuid, text, text, text) FROM clarity_v2_runtime';
    EXECUTE 'REVOKE ALL ON FUNCTION public.reconcile_dispatch_outbox(uuid, text) FROM clarity_v2_runtime';
    EXECUTE 'REVOKE ALL ON FUNCTION public.apply_dispatch_provider_callback(text, uuid, text, text, timestamptz, text) FROM clarity_v2_runtime';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clarity_v2_device_auth') THEN
    EXECUTE 'REVOKE ALL ON TABLE public.share_dispatches, public.share_dispatch_recipients, public.dispatch_outbox, public.dispatch_callback_events FROM clarity_v2_device_auth';
    EXECUTE 'REVOKE ALL ON FUNCTION public.create_share_dispatch(uuid, uuid, uuid, bigint, integer, uuid, boolean, text, boolean, uuid, bigint) FROM clarity_v2_device_auth';
    EXECUTE 'REVOKE ALL ON FUNCTION public.claim_dispatch_outbox(uuid, integer) FROM clarity_v2_device_auth';
    EXECUTE 'REVOKE ALL ON FUNCTION public.record_dispatch_provider_outcome(uuid, uuid, text, text, text) FROM clarity_v2_device_auth';
    EXECUTE 'REVOKE ALL ON FUNCTION public.reconcile_dispatch_outbox(uuid, text) FROM clarity_v2_device_auth';
    EXECUTE 'REVOKE ALL ON FUNCTION public.apply_dispatch_provider_callback(text, uuid, text, text, timestamptz, text) FROM clarity_v2_device_auth';
  END IF;
END;
$$;
