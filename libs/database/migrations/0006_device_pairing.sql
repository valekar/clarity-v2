ALTER TABLE public.device_installations
  ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  ADD COLUMN revoked_by_staff_user_id uuid REFERENCES public.staff_users(id) ON DELETE RESTRICT;

CREATE TABLE public.source_pairing_tokens (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES public.orthanc_sources(id) ON DELETE RESTRICT,
  token_verifier bytea NOT NULL UNIQUE CHECK (octet_length(token_verifier) = 32),
  created_by_staff_user_id uuid NOT NULL REFERENCES public.staff_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_device_id uuid REFERENCES public.device_installations(id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at),
  CHECK ((consumed_at IS NULL) = (consumed_device_id IS NULL))
);

CREATE INDEX source_pairing_tokens_live_by_verifier
  ON public.source_pairing_tokens(token_verifier, expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE public.device_security_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action text NOT NULL CHECK (action IN ('pairing_created', 'device_paired', 'device_revoked')),
  actor_staff_user_id uuid REFERENCES public.staff_users(id) ON DELETE RESTRICT,
  source_id uuid NOT NULL REFERENCES public.orthanc_sources(id) ON DELETE RESTRICT,
  device_id uuid REFERENCES public.device_installations(id) ON DELETE RESTRICT,
  pairing_id uuid REFERENCES public.source_pairing_tokens(id) ON DELETE RESTRICT,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (action = 'pairing_created' AND actor_staff_user_id IS NOT NULL AND pairing_id IS NOT NULL AND device_id IS NULL)
    OR (action = 'device_paired' AND actor_staff_user_id IS NULL AND pairing_id IS NOT NULL AND device_id IS NOT NULL)
    OR (action = 'device_revoked' AND actor_staff_user_id IS NOT NULL AND pairing_id IS NULL AND device_id IS NOT NULL)
  )
);

CREATE FUNCTION reject_device_security_audit_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'device security audit is append-only' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER device_security_audit_append_only
  BEFORE UPDATE OR DELETE ON public.device_security_audit
  FOR EACH ROW EXECUTE FUNCTION public.reject_device_security_audit_mutation();

CREATE TRIGGER device_security_audit_reject_truncate
  BEFORE TRUNCATE ON public.device_security_audit
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_device_security_audit_mutation();

CREATE FUNCTION create_source_pairing(
  p_actor_user_id uuid,
  p_source_id uuid,
  p_pairing_id uuid,
  p_token_verifier bytea,
  p_expires_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_source public.orthanc_sources%ROWTYPE;
  v_pairing_id uuid;
BEGIN
  IF p_actor_user_id IS NULL OR p_pairing_id IS NULL OR p_token_verifier IS NULL
     OR octet_length(p_token_verifier) <> 32 OR p_expires_at IS NULL
     OR p_expires_at <= clock_timestamp() + interval '1 minute'
     OR p_expires_at > clock_timestamp() + interval '15 minutes' THEN
    RAISE EXCEPTION 'pairing request fields or expiry are invalid' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_source FROM public.orthanc_sources WHERE id = p_source_id FOR UPDATE;
  IF NOT FOUND OR v_source.status <> 'active' THEN
    RAISE EXCEPTION 'source is unavailable' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.staff_access_control WHERE singleton_id = 1 FOR UPDATE;
  IF NOT public.is_effective_staff_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'effective administrator access is required' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.source_pairing_tokens (
    id, source_id, token_verifier, created_by_staff_user_id, expires_at
  ) VALUES (p_pairing_id, p_source_id, p_token_verifier, p_actor_user_id, p_expires_at)
  RETURNING id INTO v_pairing_id;
  INSERT INTO public.device_security_audit (action, actor_staff_user_id, source_id, pairing_id, details)
  VALUES ('pairing_created', p_actor_user_id, p_source_id, v_pairing_id,
          jsonb_build_object('expires_at', p_expires_at));
  RETURN v_pairing_id;
END;
$$;

CREATE FUNCTION consume_source_pairing(
  p_token_verifier bytea,
  p_device_id uuid,
  p_device_name text,
  p_device_verifier bytea
) RETURNS TABLE (device_id uuid, source_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_pairing_id uuid;
  v_source_id uuid;
  v_source public.orthanc_sources%ROWTYPE;
  v_pairing public.source_pairing_tokens%ROWTYPE;
BEGIN
  IF p_token_verifier IS NULL OR octet_length(p_token_verifier) <> 32
     OR p_device_id IS NULL OR p_device_verifier IS NULL
     OR octet_length(p_device_verifier) <> 32
     OR p_device_name IS NULL OR length(trim(p_device_name)) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'pairing credentials or device name are invalid' USING ERRCODE = '22023';
  END IF;
  SELECT p.id, p.source_id INTO v_pairing_id, v_source_id
    FROM public.source_pairing_tokens AS p
   WHERE p.token_verifier = p_token_verifier AND p.consumed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'pairing token is invalid or already used' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_source FROM public.orthanc_sources WHERE id = v_source_id FOR UPDATE;
  SELECT * INTO v_pairing FROM public.source_pairing_tokens WHERE id = v_pairing_id FOR UPDATE;
  IF v_source.status <> 'active' OR v_pairing.consumed_at IS NOT NULL
     OR v_pairing.expires_at <= clock_timestamp()
     OR v_pairing.token_verifier IS DISTINCT FROM p_token_verifier THEN
    RAISE EXCEPTION 'pairing token expired, consumed, or source unavailable' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.device_installations (id, source_id, display_name, credential_verifier)
  VALUES (p_device_id, v_source_id, trim(p_device_name), p_device_verifier);
  UPDATE public.source_pairing_tokens
     SET consumed_at = clock_timestamp(), consumed_device_id = p_device_id
   WHERE id = v_pairing_id;
  INSERT INTO public.device_security_audit (action, source_id, device_id, pairing_id)
  VALUES ('device_paired', v_source_id, p_device_id, v_pairing_id);
  RETURN QUERY SELECT p_device_id, v_source_id;
END;
$$;

CREATE FUNCTION revoke_source_device(
  p_actor_user_id uuid,
  p_device_id uuid,
  p_expected_version bigint
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_source_id uuid;
  v_source public.orthanc_sources%ROWTYPE;
  v_device public.device_installations%ROWTYPE;
BEGIN
  IF p_actor_user_id IS NULL OR p_device_id IS NULL
     OR p_expected_version IS NULL OR p_expected_version < 1 THEN
    RAISE EXCEPTION 'device revocation fields are invalid' USING ERRCODE = '22023';
  END IF;
  SELECT source_id INTO v_source_id FROM public.device_installations WHERE id = p_device_id;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO v_source FROM public.orthanc_sources WHERE id = v_source_id FOR UPDATE;
  PERFORM 1 FROM public.staff_access_control WHERE singleton_id = 1 FOR UPDATE;
  IF NOT public.is_effective_staff_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'effective administrator access is required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_device FROM public.device_installations
   WHERE id = p_device_id AND source_id = v_source_id FOR UPDATE;
  IF v_device.status <> 'paired' OR v_device.version <> p_expected_version THEN RETURN false; END IF;
  UPDATE public.device_installations
     SET status = 'revoked', revoked_at = clock_timestamp(),
         revoked_by_staff_user_id = p_actor_user_id, version = version + 1
   WHERE id = p_device_id;
  IF v_source.lease_device_id = p_device_id THEN
    UPDATE public.orthanc_sources
       SET lease_device_id = NULL, lease_expires_at = NULL,
           current_fencing_token = current_fencing_token + 1, version = version + 1
     WHERE id = v_source_id;
  END IF;
  INSERT INTO public.device_security_audit (action, actor_staff_user_id, source_id, device_id,
                                             details)
  VALUES ('device_revoked', p_actor_user_id, v_source_id, p_device_id,
          jsonb_build_object('previous_version', v_device.version));
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION acquire_source_lease(
  p_source_id uuid,
  p_device_id uuid,
  p_lease_expires_at timestamptz
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_source public.orthanc_sources%ROWTYPE;
  v_device_status text;
  v_next_token bigint;
BEGIN
  IF p_lease_expires_at IS NULL OR p_lease_expires_at <= clock_timestamp()
     OR p_lease_expires_at > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'lease expiry must be within five minutes' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_source FROM public.orthanc_sources WHERE id = p_source_id FOR UPDATE;
  IF NOT FOUND OR v_source.status <> 'active' THEN
    RAISE EXCEPTION 'source is unavailable' USING ERRCODE = '23514';
  END IF;
  SELECT status INTO v_device_status FROM public.device_installations
   WHERE id = p_device_id AND source_id = p_source_id FOR SHARE;
  IF v_device_status IS DISTINCT FROM 'paired' THEN
    RAISE EXCEPTION 'device is not paired to this source' USING ERRCODE = '23514';
  END IF;
  IF v_source.lease_device_id IS NOT NULL AND v_source.lease_expires_at > clock_timestamp()
     AND v_source.lease_device_id <> p_device_id THEN
    RAISE EXCEPTION 'source lease is held by another device' USING ERRCODE = '23514';
  END IF;
  IF v_source.lease_device_id IS DISTINCT FROM p_device_id
     OR v_source.lease_expires_at <= clock_timestamp() THEN
    v_next_token := v_source.current_fencing_token + 1;
  ELSE
    v_next_token := v_source.current_fencing_token;
  END IF;
  UPDATE public.orthanc_sources
     SET lease_device_id = p_device_id, lease_expires_at = p_lease_expires_at,
         current_fencing_token = v_next_token, version = version + 1
   WHERE id = p_source_id;
  RETURN v_next_token;
END;
$$;

CREATE FUNCTION acquire_device_source_lease(
  p_source_id uuid,
  p_device_id uuid,
  p_lease_expires_at timestamptz
) RETURNS TABLE (source_generation bigint, fencing_token bigint, lease_expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_fencing_token bigint;
  v_source public.orthanc_sources%ROWTYPE;
BEGIN
  v_fencing_token := public.acquire_source_lease(p_source_id, p_device_id, p_lease_expires_at);
  SELECT * INTO v_source FROM public.orthanc_sources WHERE id = p_source_id FOR SHARE;
  IF NOT FOUND OR v_source.lease_device_id IS DISTINCT FROM p_device_id
     OR v_source.current_fencing_token IS DISTINCT FROM v_fencing_token THEN
    RAISE EXCEPTION 'current source lease could not be confirmed' USING ERRCODE = '40001';
  END IF;
  RETURN QUERY SELECT v_source.generation, v_source.current_fencing_token, v_source.lease_expires_at;
END;
$$;

CREATE FUNCTION release_source_lease(
  p_source_id uuid,
  p_device_id uuid,
  p_fencing_token bigint
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_source public.orthanc_sources%ROWTYPE;
BEGIN
  SELECT * INTO v_source FROM public.orthanc_sources WHERE id = p_source_id FOR UPDATE;
  IF NOT FOUND OR v_source.lease_device_id IS DISTINCT FROM p_device_id
     OR v_source.current_fencing_token IS DISTINCT FROM p_fencing_token THEN
    RETURN false;
  END IF;
  UPDATE public.orthanc_sources
     SET lease_device_id = NULL, lease_expires_at = NULL,
         current_fencing_token = current_fencing_token + 1, version = version + 1
   WHERE id = p_source_id;
  RETURN true;
END;
$$;

REVOKE ALL ON public.source_pairing_tokens, public.device_security_audit FROM PUBLIC;
REVOKE ALL ON FUNCTION create_source_pairing(uuid, uuid, uuid, bytea, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION consume_source_pairing(bytea, uuid, text, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION revoke_source_device(uuid, uuid, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION acquire_source_lease(uuid, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION acquire_device_source_lease(uuid, uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION release_source_lease(uuid, uuid, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_device_security_audit_mutation() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'clarity_v2_runtime') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.create_source_pairing(uuid, uuid, uuid, bytea, timestamptz) TO clarity_v2_runtime';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.revoke_source_device(uuid, uuid, bigint) TO clarity_v2_runtime';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'clarity_v2_device_auth') THEN
    EXECUTE 'GRANT SELECT (id, source_id, status, credential_verifier, version) ON public.device_installations TO clarity_v2_device_auth';
    EXECUTE 'GRANT SELECT (id, status, generation, current_fencing_token, lease_device_id, lease_expires_at) ON public.orthanc_sources TO clarity_v2_device_auth';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.consume_source_pairing(bytea, uuid, text, bytea) TO clarity_v2_device_auth';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.acquire_source_lease(uuid, uuid, timestamptz) TO clarity_v2_device_auth';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.acquire_device_source_lease(uuid, uuid, timestamptz) TO clarity_v2_device_auth';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.release_source_lease(uuid, uuid, bigint) TO clarity_v2_device_auth';
  END IF;
END;
$$;
