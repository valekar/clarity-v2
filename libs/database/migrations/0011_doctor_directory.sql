CREATE TABLE doctors (
  id uuid PRIMARY KEY,
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 160),
  normalized_name text NOT NULL CHECK (length(trim(normalized_name)) BETWEEN 1 AND 160),
  phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  active boolean NOT NULL DEFAULT true,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by_staff_user_id uuid NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (normalized_name, phone_e164)
);

CREATE INDEX doctors_active_name ON doctors (normalized_name, id) WHERE active;
CREATE INDEX doctors_active_phone ON doctors (phone_e164, id) WHERE active;

CREATE FUNCTION require_active_doctor_staff(p_actor_staff_user_id uuid) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_actor_staff_user_id IS NULL THEN RETURN false; END IF;
  PERFORM 1
    FROM public.staff_users u
    JOIN public.staff_memberships m ON m.staff_user_id = u.id
   WHERE u.id = p_actor_staff_user_id AND u.active AND m.status = 'active'
   FOR SHARE OF u, m;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION require_active_doctor_staff(uuid) FROM PUBLIC;

CREATE FUNCTION insert_doctor_record(
  p_id uuid,
  p_display_name text,
  p_normalized_name text,
  p_phone_e164 text,
  p_actor_staff_user_id uuid
) RETURNS SETOF doctors
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT public.require_active_doctor_staff(p_actor_staff_user_id) THEN
    RAISE EXCEPTION 'staff access is inactive' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    INSERT INTO public.doctors (
      id, display_name, normalized_name, phone_e164, created_by_staff_user_id
    ) VALUES (
      p_id, p_display_name, p_normalized_name, p_phone_e164, p_actor_staff_user_id
    ) RETURNING *;
END;
$$;

REVOKE ALL ON FUNCTION insert_doctor_record(uuid, text, text, text, uuid) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clarity_v2_runtime') THEN
    EXECUTE 'GRANT SELECT ON public.doctors TO clarity_v2_runtime';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.require_active_doctor_staff(uuid) TO clarity_v2_runtime';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.insert_doctor_record(uuid, text, text, text, uuid) TO clarity_v2_runtime';
  END IF;
END;
$$;
