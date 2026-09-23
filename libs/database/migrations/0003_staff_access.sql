CREATE TABLE staff_access_control (
  singleton_id smallint PRIMARY KEY DEFAULT 1 CHECK (singleton_id = 1),
  bootstrap_completed boolean NOT NULL DEFAULT false,
  bootstrap_completed_at timestamptz,
  bootstrapped_user_id uuid REFERENCES staff_users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (
    (bootstrap_completed = false AND bootstrap_completed_at IS NULL AND bootstrapped_user_id IS NULL)
    OR (bootstrap_completed = true AND bootstrap_completed_at IS NOT NULL AND bootstrapped_user_id IS NOT NULL)
  )
);

INSERT INTO staff_access_control (singleton_id) VALUES (1);

CREATE TABLE staff_access_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action text NOT NULL CHECK (action IN (
    'identity_enrolled', 'first_admin_bootstrapped',
    'membership_changed', 'user_active_changed'
  )),
  actor_user_id uuid REFERENCES staff_users(id) ON DELETE RESTRICT,
  actor_database_role text,
  target_user_id uuid NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
  identity_id uuid REFERENCES staff_identities(id) ON DELETE RESTRICT,
  previous_values jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(previous_values) = 'object'),
  new_values jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(new_values) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION reject_staff_access_audit_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'staff access audit is append-only' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER staff_access_audit_append_only
  BEFORE UPDATE OR DELETE ON staff_access_audit
  FOR EACH ROW EXECUTE FUNCTION reject_staff_access_audit_mutation();

CREATE TRIGGER staff_access_audit_reject_truncate
  BEFORE TRUNCATE ON staff_access_audit
  FOR EACH STATEMENT EXECUTE FUNCTION reject_staff_access_audit_mutation();

CREATE FUNCTION enroll_pending_hanko_identity(
  p_staff_user_id uuid,
  p_identity_id uuid,
  p_display_name text,
  p_issuer text,
  p_subject text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_existing_user_id uuid;
BEGIN
  IF p_staff_user_id IS NULL OR p_identity_id IS NULL
     OR length(trim(p_display_name)) = 0 OR length(trim(p_issuer)) = 0 OR length(trim(p_subject)) = 0 THEN
    RAISE EXCEPTION 'staff identity enrollment fields are required' USING ERRCODE = '22023';
  END IF;

  SELECT staff_user_id INTO v_existing_user_id
    FROM public.staff_identities
   WHERE provider = 'hanko' AND issuer = p_issuer AND subject = p_subject;
  IF FOUND THEN RETURN v_existing_user_id; END IF;

  BEGIN
    INSERT INTO public.staff_users (id, display_name, active)
    VALUES (p_staff_user_id, p_display_name, true);
    INSERT INTO public.staff_identities (id, staff_user_id, provider, issuer, subject)
    VALUES (p_identity_id, p_staff_user_id, 'hanko', p_issuer, p_subject);
    INSERT INTO public.staff_access_audit (action, target_user_id, identity_id, new_values)
    VALUES (
      'identity_enrolled', p_staff_user_id, p_identity_id,
      jsonb_build_object('provider', 'hanko', 'membership_created', false)
    );
  EXCEPTION WHEN unique_violation THEN
    SELECT staff_user_id INTO v_existing_user_id
      FROM public.staff_identities
     WHERE provider = 'hanko' AND issuer = p_issuer AND subject = p_subject;
    IF FOUND THEN RETURN v_existing_user_id; END IF;
    RAISE;
  END;
  RETURN p_staff_user_id;
END;
$$;

CREATE FUNCTION bootstrap_first_staff_admin(
  p_staff_user_id uuid,
  p_identity_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_control public.staff_access_control%ROWTYPE;
  v_identity public.staff_identities%ROWTYPE;
BEGIN
  IF NOT pg_has_role(session_user, 'clarity_v2_bootstrap_operator', 'MEMBER') THEN
    RAISE EXCEPTION 'first-admin bootstrap requires the operator database role' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_control
    FROM public.staff_access_control
   WHERE singleton_id = 1
   FOR UPDATE;
  IF NOT FOUND OR v_control.bootstrap_completed THEN
    RAISE EXCEPTION 'first-admin bootstrap was already completed' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.staff_users u
      JOIN public.staff_memberships m ON m.staff_user_id = u.id
     WHERE u.active AND m.status = 'active' AND m.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'an effective administrator already exists' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_identity
    FROM public.staff_identities
   WHERE id = p_identity_id AND staff_user_id = p_staff_user_id AND provider = 'hanko'
   FOR SHARE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.staff_users WHERE id = p_staff_user_id AND active
  ) THEN
    RAISE EXCEPTION 'bootstrap identity is not an active enrolled Hanko identity' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public.staff_memberships WHERE staff_user_id = p_staff_user_id) THEN
    RAISE EXCEPTION 'bootstrap target already has a membership' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.staff_memberships (staff_user_id, role, status, version)
  VALUES (p_staff_user_id, 'admin', 'active', 1);
  UPDATE public.staff_access_control
     SET bootstrap_completed = true,
         bootstrap_completed_at = clock_timestamp(),
         bootstrapped_user_id = p_staff_user_id,
         updated_at = clock_timestamp()
   WHERE singleton_id = 1;
  INSERT INTO public.staff_access_audit (action, actor_database_role, target_user_id, identity_id, new_values)
  VALUES (
    'first_admin_bootstrapped', session_user, p_staff_user_id, p_identity_id,
    jsonb_build_object('role', 'admin', 'status', 'active', 'version', 1)
  );
  RETURN true;
END;
$$;

CREATE FUNCTION is_effective_staff_admin(p_staff_user_id uuid) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.staff_users u
      JOIN public.staff_memberships m ON m.staff_user_id = u.id
     WHERE u.id = p_staff_user_id
       AND u.active
       AND m.role = 'admin'
       AND m.status = 'active'
  );
$$;

CREATE FUNCTION change_staff_membership(
  p_actor_user_id uuid,
  p_target_user_id uuid,
  p_expected_version bigint,
  p_new_role text,
  p_new_status text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_membership public.staff_memberships%ROWTYPE;
  v_previous jsonb;
  v_effective_admins bigint;
  v_has_membership boolean;
BEGIN
  IF p_expected_version IS NULL OR p_expected_version < 0 THEN
    RAISE EXCEPTION 'expected membership version must be nonnegative' USING ERRCODE = '22023';
  END IF;
  UPDATE public.staff_access_control
     SET updated_at = clock_timestamp()
   WHERE singleton_id = 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'staff access control row is missing' USING ERRCODE = '23514'; END IF;
  IF NOT public.is_effective_staff_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'current actor is not an active administrator' USING ERRCODE = '42501';
  END IF;
  IF p_new_role IS NULL OR p_new_status IS NULL
     OR p_new_role NOT IN ('admin', 'staff') OR p_new_status NOT IN ('active', 'disabled') THEN
    RAISE EXCEPTION 'unsupported staff role or status' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_membership
    FROM public.staff_memberships
   WHERE staff_user_id = p_target_user_id
   FOR UPDATE;
  v_has_membership := FOUND;
  IF v_has_membership THEN
    IF v_membership.version IS DISTINCT FROM p_expected_version THEN RETURN false; END IF;
    v_previous := jsonb_build_object(
      'role', v_membership.role, 'status', v_membership.status, 'version', v_membership.version
    );
    UPDATE public.staff_memberships
       SET role = p_new_role,
           status = p_new_status,
           version = version + 1,
           updated_at = clock_timestamp()
     WHERE staff_user_id = p_target_user_id;
  ELSE
    IF p_expected_version <> 0 OR NOT EXISTS (
      SELECT 1 FROM public.staff_users WHERE id = p_target_user_id
    ) THEN RETURN false; END IF;
    v_previous := '{}'::jsonb;
    INSERT INTO public.staff_memberships (staff_user_id, role, status, version)
    VALUES (p_target_user_id, p_new_role, p_new_status, 1);
  END IF;

  SELECT count(*) INTO v_effective_admins
    FROM public.staff_users u
    JOIN public.staff_memberships m ON m.staff_user_id = u.id
   WHERE u.active AND m.status = 'active' AND m.role = 'admin';
  IF v_effective_admins = 0 THEN
    RAISE EXCEPTION 'cannot remove the last effective administrator' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.staff_access_audit (action, actor_user_id, target_user_id, previous_values, new_values)
  VALUES (
    'membership_changed', p_actor_user_id, p_target_user_id, v_previous,
    jsonb_build_object('role', p_new_role, 'status', p_new_status, 'version', CASE WHEN v_has_membership THEN v_membership.version + 1 ELSE 1 END)
  );
  RETURN true;
END;
$$;

CREATE FUNCTION change_staff_user_active(
  p_actor_user_id uuid,
  p_target_user_id uuid,
  p_expected_version bigint,
  p_expected_active boolean,
  p_new_active boolean
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_membership public.staff_memberships%ROWTYPE;
  v_previous_active boolean;
  v_effective_admins bigint;
BEGIN
  IF p_expected_version IS NULL OR p_expected_version < 1 OR p_expected_active IS NULL OR p_new_active IS NULL THEN
    RAISE EXCEPTION 'expected membership version and active values are required' USING ERRCODE = '22023';
  END IF;
  UPDATE public.staff_access_control
     SET updated_at = clock_timestamp()
   WHERE singleton_id = 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'staff access control row is missing' USING ERRCODE = '23514'; END IF;
  IF NOT public.is_effective_staff_admin(p_actor_user_id) THEN
    RAISE EXCEPTION 'current actor is not an active administrator' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_membership
    FROM public.staff_memberships
   WHERE staff_user_id = p_target_user_id
   FOR UPDATE;
  IF NOT FOUND OR v_membership.version <> p_expected_version THEN RETURN false; END IF;
  SELECT active INTO v_previous_active
    FROM public.staff_users
   WHERE id = p_target_user_id
   FOR UPDATE;
  IF NOT FOUND OR v_previous_active IS DISTINCT FROM p_expected_active THEN RETURN false; END IF;

  UPDATE public.staff_users SET active = p_new_active WHERE id = p_target_user_id;
  UPDATE public.staff_memberships
     SET version = version + 1, updated_at = clock_timestamp()
   WHERE staff_user_id = p_target_user_id;
  SELECT count(*) INTO v_effective_admins
    FROM public.staff_users u
    JOIN public.staff_memberships m ON m.staff_user_id = u.id
   WHERE u.active AND m.status = 'active' AND m.role = 'admin';
  IF v_effective_admins = 0 THEN
    RAISE EXCEPTION 'cannot remove the last effective administrator' USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.staff_access_audit (action, actor_user_id, target_user_id, previous_values, new_values)
  VALUES (
    'user_active_changed', p_actor_user_id, p_target_user_id,
    jsonb_build_object('active', v_previous_active, 'membership_version', v_membership.version),
    jsonb_build_object('active', p_new_active, 'membership_version', v_membership.version + 1)
  );
  RETURN true;
END;
$$;

CREATE FUNCTION reject_staff_membership_direct_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF current_user = 'clarity_v2_migrator' AND session_user <> current_user THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'staff membership changes require reviewed functions' USING ERRCODE = '23514';
  END IF;
  IF NEW.role IS DISTINCT FROM OLD.role OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.version IS DISTINCT FROM OLD.version THEN
    RAISE EXCEPTION 'staff membership changes require reviewed functions' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER staff_membership_mutations_reviewed
  BEFORE UPDATE OR DELETE ON staff_memberships
  FOR EACH ROW EXECUTE FUNCTION reject_staff_membership_direct_mutation();

CREATE FUNCTION reject_staff_user_active_direct_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF current_user = 'clarity_v2_migrator' AND session_user <> current_user THEN
    RETURN NEW;
  END IF;
  IF NEW.active IS DISTINCT FROM OLD.active THEN
    RAISE EXCEPTION 'staff active status changes require reviewed functions' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER staff_user_active_mutations_reviewed
  BEFORE UPDATE OF active ON staff_users
  FOR EACH ROW EXECUTE FUNCTION reject_staff_user_active_direct_mutation();

REVOKE ALL ON TABLE staff_access_control, staff_access_audit FROM PUBLIC;
REVOKE ALL ON FUNCTION enroll_pending_hanko_identity(uuid, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION bootstrap_first_staff_admin(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION is_effective_staff_admin(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION change_staff_membership(uuid, uuid, bigint, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION change_staff_user_active(uuid, uuid, bigint, boolean, boolean) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'clarity_v2_runtime') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.staff_users, public.staff_identities, public.staff_memberships, public.staff_access_control, public.staff_access_audit FROM clarity_v2_runtime';
    EXECUTE 'GRANT SELECT ON public.staff_users, public.staff_identities, public.staff_memberships TO clarity_v2_runtime';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.enroll_pending_hanko_identity(uuid, uuid, text, text, text) TO clarity_v2_runtime';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.is_effective_staff_admin(uuid) TO clarity_v2_runtime';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.change_staff_membership(uuid, uuid, bigint, text, text) TO clarity_v2_runtime';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.change_staff_user_active(uuid, uuid, bigint, boolean, boolean) TO clarity_v2_runtime';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'clarity_v2_bootstrap_operator') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.bootstrap_first_staff_admin(uuid, uuid) TO clarity_v2_bootstrap_operator';
  END IF;
END;
$$;
