CREATE TABLE public.source_health_reports (
  source_id uuid PRIMARY KEY REFERENCES public.orthanc_sources(id) ON DELETE RESTRICT,
  device_id uuid NOT NULL,
  source_generation bigint NOT NULL CHECK (source_generation > 0),
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  source_reachable boolean NOT NULL,
  sync_state text NOT NULL CHECK (sync_state IN ('idle', 'syncing', 'attention')),
  last_error_code text CHECK (last_error_code IN
    ('orthanc_unavailable', 'low_spool_space', 'source_changed', 'sync_failed')),
  queued_studies integer NOT NULL CHECK (queued_studies BETWEEN 0 AND 1000000),
  queued_uploads integer NOT NULL CHECK (queued_uploads BETWEEN 0 AND 1000000),
  spool_free_bytes bigint CHECK (spool_free_bytes >= 0),
  spool_capacity_bytes bigint CHECK (spool_capacity_bytes >= 0),
  last_successful_sync_at timestamptz,
  reported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (source_id, device_id)
    REFERENCES public.device_installations(source_id, id) ON DELETE RESTRICT,
  CHECK (spool_free_bytes IS NULL OR spool_capacity_bytes IS NULL OR
         spool_free_bytes <= spool_capacity_bytes),
  CHECK ((sync_state = 'attention') = (last_error_code IS NOT NULL))
);

CREATE FUNCTION public.record_source_health(
  p_source_id uuid,
  p_device_id uuid,
  p_generation bigint,
  p_fencing_token bigint,
  p_source_reachable boolean,
  p_sync_state text,
  p_last_error_code text,
  p_queued_studies integer,
  p_queued_uploads integer,
  p_spool_free_bytes bigint,
  p_spool_capacity_bytes bigint,
  p_last_successful_sync_at timestamptz
) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_source public.orthanc_sources%ROWTYPE;
  v_device_status text;
  v_reported_at timestamptz := clock_timestamp();
BEGIN
  IF p_sync_state NOT IN ('idle', 'syncing', 'attention') OR
     (p_last_error_code IS NOT NULL AND p_last_error_code NOT IN
       ('orthanc_unavailable', 'low_spool_space', 'source_changed', 'sync_failed')) OR
     ((p_sync_state = 'attention') <> (p_last_error_code IS NOT NULL)) OR
     p_queued_studies NOT BETWEEN 0 AND 1000000 OR
     p_queued_uploads NOT BETWEEN 0 AND 1000000 OR
     p_spool_free_bytes < 0 OR p_spool_capacity_bytes < 0 OR
     (p_spool_free_bytes IS NOT NULL AND p_spool_capacity_bytes IS NOT NULL AND
       p_spool_free_bytes > p_spool_capacity_bytes) THEN
    RAISE EXCEPTION 'source health report is invalid' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_source FROM public.orthanc_sources WHERE id = p_source_id FOR UPDATE;
  SELECT status INTO v_device_status FROM public.device_installations
   WHERE source_id = p_source_id AND id = p_device_id FOR SHARE;
  v_reported_at := clock_timestamp();
  IF v_source.id IS NULL OR v_device_status IS DISTINCT FROM 'paired'
     OR v_source.status <> 'active' OR v_source.generation <> p_generation
     OR v_source.current_fencing_token <> p_fencing_token
     OR v_source.lease_device_id IS DISTINCT FROM p_device_id
     OR v_source.lease_expires_at IS NULL OR v_source.lease_expires_at <= v_reported_at
     OR (p_last_successful_sync_at IS NOT NULL AND
         p_last_successful_sync_at > v_reported_at + interval '1 minute') THEN
    RAISE EXCEPTION 'source health report has a stale device fence' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.source_health_reports (
    source_id, device_id, source_generation, fencing_token, source_reachable,
    sync_state, last_error_code, queued_studies, queued_uploads, spool_free_bytes,
    spool_capacity_bytes, last_successful_sync_at, reported_at
  ) VALUES (
    p_source_id, p_device_id, p_generation, p_fencing_token, p_source_reachable,
    p_sync_state, p_last_error_code, p_queued_studies, p_queued_uploads,
    p_spool_free_bytes, p_spool_capacity_bytes, p_last_successful_sync_at, v_reported_at
  ) ON CONFLICT (source_id) DO UPDATE SET
    device_id = EXCLUDED.device_id,
    source_generation = EXCLUDED.source_generation,
    fencing_token = EXCLUDED.fencing_token,
    source_reachable = EXCLUDED.source_reachable,
    sync_state = EXCLUDED.sync_state,
    last_error_code = EXCLUDED.last_error_code,
    queued_studies = EXCLUDED.queued_studies,
    queued_uploads = EXCLUDED.queued_uploads,
    spool_free_bytes = EXCLUDED.spool_free_bytes,
    spool_capacity_bytes = EXCLUDED.spool_capacity_bytes,
    last_successful_sync_at = EXCLUDED.last_successful_sync_at,
    reported_at = EXCLUDED.reported_at;
  RETURN v_reported_at;
END;
$$;

CREATE FUNCTION public.read_source_health(p_staff_user_id uuid)
RETURNS TABLE (
  source_id uuid,
  source_name text,
  source_reachable boolean,
  sync_state text,
  last_error_code text,
  queued_studies integer,
  queued_uploads integer,
  spool_free_bytes bigint,
  spool_capacity_bytes bigint,
  last_successful_sync_at timestamptz,
  reported_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s.id, s.display_name, h.source_reachable, h.sync_state, h.last_error_code,
         h.queued_studies, h.queued_uploads, h.spool_free_bytes, h.spool_capacity_bytes,
         h.last_successful_sync_at, h.reported_at
    FROM public.orthanc_sources s
    JOIN public.staff_users u ON u.id = p_staff_user_id AND u.active
    JOIN public.staff_memberships m ON m.staff_user_id = u.id AND m.status = 'active'
    LEFT JOIN public.source_health_reports h ON h.source_id = s.id
      AND h.source_generation = s.generation
      AND h.fencing_token = s.current_fencing_token
      AND h.device_id = s.lease_device_id
      AND s.lease_expires_at > clock_timestamp()
      AND EXISTS (SELECT 1 FROM public.device_installations d
                   WHERE d.id = h.device_id AND d.source_id = s.id AND d.status = 'paired')
   WHERE s.status = 'active'
   ORDER BY s.display_name, s.id
   LIMIT 100;
$$;

REVOKE ALL ON TABLE public.source_health_reports FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_source_health(uuid, uuid, bigint, bigint, boolean, text, text, integer, integer, bigint, bigint, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.read_source_health(uuid) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clarity_v2_migrator') THEN
    GRANT SELECT ON public.orthanc_sources, public.device_installations,
      public.staff_users, public.staff_memberships TO clarity_v2_migrator;
    GRANT UPDATE (version) ON public.orthanc_sources TO clarity_v2_migrator;
    GRANT UPDATE (version) ON public.device_installations TO clarity_v2_migrator;
    GRANT SELECT, INSERT, UPDATE ON public.source_health_reports TO clarity_v2_migrator;
    ALTER FUNCTION public.record_source_health(uuid, uuid, bigint, bigint, boolean, text, text, integer, integer, bigint, bigint, timestamptz) OWNER TO clarity_v2_migrator;
    ALTER FUNCTION public.read_source_health(uuid) OWNER TO clarity_v2_migrator;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clarity_v2_device_auth') THEN
    GRANT EXECUTE ON FUNCTION public.record_source_health(uuid, uuid, bigint, bigint, boolean, text, text, integer, integer, bigint, bigint, timestamptz) TO clarity_v2_device_auth;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clarity_v2_runtime') THEN
    GRANT EXECUTE ON FUNCTION public.read_source_health(uuid) TO clarity_v2_runtime;
  END IF;
END;
$$;
