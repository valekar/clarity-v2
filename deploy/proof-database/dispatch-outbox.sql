BEGIN;

INSERT INTO public.staff_users (id, display_name, active)
VALUES ('90000000-0000-4000-8000-000000000001', 'Synthetic Dispatch Admin', true);
INSERT INTO public.staff_memberships (staff_user_id, role, status)
VALUES ('90000000-0000-4000-8000-000000000001', 'admin', 'active');
INSERT INTO public.doctors (
  id, display_name, normalized_name, phone_e164, created_by_staff_user_id
) VALUES (
  '91000000-0000-4000-8000-000000000001', 'Synthetic Doctor', 'synthetic doctor',
  '+919876543211', '90000000-0000-4000-8000-000000000001'
);

DO $$
DECLARE
  v_report public.reports%ROWTYPE;
  v_dispatch_id uuid;
  v_state text;
  v_count integer;
  v_retry_id uuid;
  v_retry_count integer;
  v_sqlstate text;
BEGIN
  SELECT * INTO v_report FROM public.reports
   WHERE id = '40000000-0000-4000-8000-000000000001';
  IF v_report.state <> 'ready' OR v_report.current_manifest_revision IS NULL THEN
    RAISE EXCEPTION 'synthetic dispatch fixture must be Ready with a current revision';
  END IF;

  SELECT d.out_dispatch_id, d.out_state, d.out_recipient_count
    INTO v_dispatch_id, v_state, v_count
    FROM public.create_share_dispatch(
      '92000000-0000-4000-8000-000000000001',
      '93000000-0000-4000-8000-000000000001',
      v_report.id, v_report.version, v_report.current_manifest_revision,
      '90000000-0000-4000-8000-000000000001', true, '+919876543210',
      true, '91000000-0000-4000-8000-000000000001', 1
    ) AS d;
  IF v_dispatch_id <> '92000000-0000-4000-8000-000000000001'
     OR v_state <> 'blocked_policy' OR v_count <> 2 THEN
    RAISE EXCEPTION 'dispatch was not created in blocked state with two recipients';
  END IF;

  SELECT d.out_dispatch_id, d.out_recipient_count
    INTO v_retry_id, v_retry_count
    FROM public.create_share_dispatch(
      '92000000-0000-4000-8000-000000000002',
      '93000000-0000-4000-8000-000000000001',
      v_report.id, v_report.version, v_report.current_manifest_revision,
      '90000000-0000-4000-8000-000000000001', true, '+919876543210',
      true, '91000000-0000-4000-8000-000000000001', 1
    ) AS d;
  IF v_retry_id <> v_dispatch_id OR v_retry_count <> 2 THEN
    RAISE EXCEPTION 'same-key retry did not return its original immutable dispatch';
  END IF;

  PERFORM public.enroll_pending_hanko_identity(
    '90000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000012',
    'Synthetic Second Admin', 'https://hanko.example.invalid', 'synthetic-dispatch-admin-two'
  );
  IF NOT public.change_staff_membership(
    '90000000-0000-4000-8000-000000000001', '90000000-0000-4000-8000-000000000002',
    0, 'admin', 'active'
  ) THEN RAISE EXCEPTION 'could not seed a second synthetic administrator'; END IF;
  IF NOT public.change_staff_membership(
    '90000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000001',
    1, 'admin', 'disabled'
  ) THEN RAISE EXCEPTION 'could not disable the synthetic dispatch actor'; END IF;
  BEGIN
    PERFORM * FROM public.create_share_dispatch(
      '92000000-0000-4000-8000-000000000006',
      '93000000-0000-4000-8000-000000000001',
      v_report.id, v_report.version, v_report.current_manifest_revision,
      '90000000-0000-4000-8000-000000000001', true, '+919876543210',
      true, '91000000-0000-4000-8000-000000000001', 1
    );
    RAISE EXCEPTION 'disabled actor could retry an existing dispatch';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF NOT public.change_staff_membership(
    '90000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000001',
    2, 'admin', 'active'
  ) THEN RAISE EXCEPTION 'could not restore the synthetic dispatch actor'; END IF;

  BEGIN
    PERFORM * FROM public.create_share_dispatch(
      '92000000-0000-4000-8000-000000000003',
      '93000000-0000-4000-8000-000000000001',
      v_report.id, v_report.version, v_report.current_manifest_revision,
      '90000000-0000-4000-8000-000000000001', true, '+919876543219',
      true, '91000000-0000-4000-8000-000000000001', 1
    );
    RAISE EXCEPTION 'changed-input idempotency key reuse was accepted';
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE;
    IF v_sqlstate <> '23505' THEN RAISE; END IF;
  END;

  IF EXISTS (
    SELECT 1 FROM public.dispatch_outbox o
    WHERE o.dispatch_id = v_dispatch_id AND
      (o.state <> 'blocked_policy' OR o.authorization_ref IS NOT NULL
       OR o.message_text IS NOT NULL OR o.attempt_count <> 0)
  ) OR (SELECT count(*) FROM public.dispatch_outbox WHERE dispatch_id = v_dispatch_id) <> 2 THEN
    RAISE EXCEPTION 'initial outbox rows were not policy-blocked and payload-free';
  END IF;
  IF EXISTS (SELECT 1 FROM public.claim_dispatch_outbox('94000000-0000-4000-8000-000000000001', 60)) THEN
    RAISE EXCEPTION 'unapproved outbox rows were claimable';
  END IF;

  BEGIN
    UPDATE public.share_dispatch_recipients SET phone_e164_snapshot = '+919876543299'
     WHERE dispatch_id = v_dispatch_id AND recipient_kind = 'doctor';
    RAISE EXCEPTION 'immutable recipient snapshot was mutable';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- A later draft Report scope cannot rewrite this immutable selection.
  UPDATE public.reports SET state = 'syncing', current_manifest_revision = 3, version = version + 1
   WHERE id = v_report.id;
  IF (SELECT manifest_revision FROM public.share_dispatches WHERE id = v_dispatch_id) <> v_report.current_manifest_revision
     OR (SELECT count(*) FROM public.share_dispatch_recipients WHERE dispatch_id = v_dispatch_id) <> 2 THEN
    RAISE EXCEPTION 'later Report revision changed frozen dispatch scope';
  END IF;
  UPDATE public.reports SET state = v_report.state,
    current_manifest_revision = v_report.current_manifest_revision, version = v_report.version
   WHERE id = v_report.id;

  -- CAS failures for stale Report and Doctor snapshots.
  BEGIN
    PERFORM * FROM public.create_share_dispatch(
      '92000000-0000-4000-8000-000000000004',
      '93000000-0000-4000-8000-000000000004',
      v_report.id, v_report.version - 1, v_report.current_manifest_revision,
      '90000000-0000-4000-8000-000000000001', true, '+919876543210', false, NULL, NULL
    );
    RAISE EXCEPTION 'stale Report version was accepted';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
  UPDATE public.doctors SET version = version + 1
   WHERE id = '91000000-0000-4000-8000-000000000001';
  BEGIN
    PERFORM * FROM public.create_share_dispatch(
      '92000000-0000-4000-8000-000000000005',
      '93000000-0000-4000-8000-000000000005',
      v_report.id, v_report.version, v_report.current_manifest_revision,
      '90000000-0000-4000-8000-000000000001', false, NULL,
      true, '91000000-0000-4000-8000-000000000001', 1
    );
    RAISE EXCEPTION 'stale Doctor version was accepted';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
END;
$$;

DO $$
DECLARE
  v_outbox_id uuid;
  v_key uuid;
  v_claim uuid := '94000000-0000-4000-8000-000000000002';
  v_message_id text := 'synthetic-provider-message-001';
  v_state text;
BEGIN
  SELECT o.id, o.idempotency_key INTO v_outbox_id, v_key
    FROM public.dispatch_outbox o
   WHERE o.dispatch_id = '92000000-0000-4000-8000-000000000001'
   ORDER BY o.id LIMIT 1;

  -- Synthetic proof-only authorization; the entire transaction rolls back.
  UPDATE public.dispatch_outbox SET state = 'queued',
    authorization_ref = '95000000-0000-4000-8000-000000000001',
    message_text = 'Synthetic proof only; no share link or delivery.'
   WHERE id = v_outbox_id;
  IF NOT EXISTS (SELECT 1 FROM public.claim_dispatch_outbox(v_claim, 60)) THEN
    RAISE EXCEPTION 'authorized synthetic outbox item was not claimed';
  END IF;
  BEGIN
    PERFORM public.record_dispatch_provider_outcome(v_outbox_id, v_claim, NULL, NULL, NULL);
    RAISE EXCEPTION 'NULL provider outcome was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  IF NOT EXISTS (SELECT 1 FROM public.dispatch_outbox WHERE id = v_outbox_id AND state = 'queued'
      AND claim_token = v_claim AND attempt_count = 1) THEN
    RAISE EXCEPTION 'invalid provider outcome changed the claimed outbox row';
  END IF;
  IF public.record_dispatch_provider_outcome(v_outbox_id, v_claim, 'unknown', NULL, 'synthetic_timeout') <> 'uncertain' THEN
    RAISE EXCEPTION 'unknown provider outcome was not marked uncertain';
  END IF;
  IF public.reconcile_dispatch_outbox(v_key, NULL) <> 'uncertain' THEN
    RAISE EXCEPTION 'no-match reconciliation incorrectly made delivery retryable';
  END IF;
  IF EXISTS (SELECT 1 FROM public.claim_dispatch_outbox('94000000-0000-4000-8000-000000000003', 60)) THEN
    RAISE EXCEPTION 'uncertain delivery was automatically resent';
  END IF;
  IF public.reconcile_dispatch_outbox(v_key, v_message_id) <> 'submitted' THEN
    RAISE EXCEPTION 'positive provider reconciliation did not recover acceptance';
  END IF;
  IF public.apply_dispatch_provider_callback(
    'synthetic-event-0001', v_key, v_message_id, 'delivered', clock_timestamp(), repeat('a', 64)
  ) <> 'delivered' THEN
    RAISE EXCEPTION 'synthetic provider callback did not mark delivery';
  END IF;
  IF public.apply_dispatch_provider_callback(
    'synthetic-event-0001', v_key, v_message_id, 'delivered', clock_timestamp(), repeat('a', 64)
  ) <> 'delivered' THEN
    RAISE EXCEPTION 'duplicate provider callback was not idempotent';
  END IF;
END;
$$;

SET LOCAL ROLE clarity_v2_runtime;
DO $$
DECLARE
  v_denied boolean := false;
BEGIN
  BEGIN
    EXECUTE 'SELECT count(*) FROM public.dispatch_outbox';
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'web runtime can read the dispatch outbox'; END IF;
  v_denied := false;
  BEGIN
    EXECUTE 'SELECT * FROM public.create_share_dispatch(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)';
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true;
  END;
  IF NOT v_denied THEN RAISE EXCEPTION 'web runtime can create or authorize a dispatch'; END IF;
END;
$$;
RESET ROLE;

ROLLBACK;
SELECT 'Synthetic dispatch/outbox transaction assertions passed; all fixture state rolled back.' AS result;
