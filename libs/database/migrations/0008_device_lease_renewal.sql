CREATE FUNCTION public.renew_device_source_lease(
  p_source_id uuid,
  p_device_id uuid,
  p_expected_generation bigint,
  p_expected_fencing_token bigint,
  p_lease_expires_at timestamptz
) RETURNS TABLE (source_generation bigint, fencing_token bigint, lease_expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_source public.orthanc_sources%ROWTYPE;
  v_device_status text;
BEGIN
  IF p_lease_expires_at IS NULL OR p_lease_expires_at <= clock_timestamp()
     OR p_lease_expires_at > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'lease expiry must be within five minutes' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_source FROM public.orthanc_sources WHERE id = p_source_id FOR UPDATE;
  SELECT status INTO v_device_status FROM public.device_installations
   WHERE id = p_device_id AND source_id = p_source_id FOR SHARE;
  IF v_source.id IS NULL OR v_device_status <> 'paired' OR v_source.status <> 'active'
     OR v_source.generation <> p_expected_generation
     OR v_source.current_fencing_token <> p_expected_fencing_token
     OR v_source.lease_device_id <> p_device_id
     OR v_source.lease_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'lease renewal used a stale generation, token, owner, or expiry' USING ERRCODE = '23514';
  END IF;
  UPDATE public.orthanc_sources
     SET lease_expires_at = p_lease_expires_at, version = version + 1
   WHERE id = p_source_id;
  RETURN QUERY SELECT v_source.generation, v_source.current_fencing_token, p_lease_expires_at;
END;
$$;

REVOKE ALL ON FUNCTION public.renew_device_source_lease(uuid, uuid, bigint, bigint, timestamptz) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'clarity_v2_device_auth') THEN
    GRANT EXECUTE ON FUNCTION public.renew_device_source_lease(uuid, uuid, bigint, bigint, timestamptz) TO clarity_v2_device_auth;
  END IF;
END $$;
