CREATE TABLE installation_settings (
  singleton_id smallint PRIMARY KEY DEFAULT 1 CHECK (singleton_id = 1),
  centre_name text NOT NULL CHECK (length(trim(centre_name)) > 0),
  timezone text NOT NULL CHECK (length(trim(timezone)) > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE staff_users (
  id uuid PRIMARY KEY,
  display_name text NOT NULL CHECK (length(trim(display_name)) > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE staff_identities (
  id uuid PRIMARY KEY,
  staff_user_id uuid NOT NULL REFERENCES staff_users(id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (provider = 'hanko'),
  issuer text NOT NULL CHECK (length(trim(issuer)) > 0),
  subject text NOT NULL CHECK (length(trim(subject)) > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (provider, issuer, subject),
  UNIQUE (staff_user_id, id)
);

CREATE TABLE staff_memberships (
  staff_user_id uuid PRIMARY KEY REFERENCES staff_users(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('admin', 'staff')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE orthanc_sources (
  id uuid PRIMARY KEY,
  display_name text NOT NULL CHECK (length(trim(display_name)) > 0),
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  current_fencing_token bigint NOT NULL DEFAULT 0 CHECK (current_fencing_token >= 0),
  lease_device_id uuid,
  lease_expires_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((lease_device_id IS NULL) = (lease_expires_at IS NULL)),
  UNIQUE (id, current_fencing_token)
);

CREATE TABLE source_generations (
  source_id uuid NOT NULL REFERENCES orthanc_sources(id) ON DELETE RESTRICT,
  generation bigint NOT NULL CHECK (generation > 0),
  reason text NOT NULL CHECK (reason IN ('initial', 'change_log_reset', 'orthanc_replaced', 'explicit_reconcile')),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (source_id, generation)
);

ALTER TABLE orthanc_sources
  ADD CONSTRAINT orthanc_sources_generation_fk
  FOREIGN KEY (id, generation)
  REFERENCES source_generations(source_id, generation)
  DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION record_initial_source_generation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO source_generations (source_id, generation, reason)
  VALUES (NEW.id, NEW.generation, 'initial');
  RETURN NEW;
END;
$$;

CREATE FUNCTION source_history_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'source generation and locator observations are immutable' USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER orthanc_sources_initial_generation
  AFTER INSERT ON orthanc_sources
  FOR EACH ROW EXECUTE FUNCTION record_initial_source_generation();

CREATE FUNCTION advance_source_generation(
  p_source_id uuid,
  p_expected_generation bigint,
  p_reason text
) RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_source orthanc_sources%ROWTYPE;
  v_next_generation bigint;
BEGIN
  IF p_reason NOT IN ('change_log_reset', 'orthanc_replaced', 'explicit_reconcile') THEN
    RAISE EXCEPTION 'unsupported source generation reason' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO v_source FROM orthanc_sources WHERE id = p_source_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'source does not exist' USING ERRCODE = '23503'; END IF;
  IF v_source.generation <> p_expected_generation THEN RETURN NULL; END IF;
  v_next_generation := v_source.generation + 1;
  INSERT INTO source_generations (source_id, generation, reason)
  VALUES (p_source_id, v_next_generation, p_reason);
  UPDATE orthanc_sources
     SET generation = v_next_generation,
         current_fencing_token = current_fencing_token + 1,
         lease_device_id = NULL,
         lease_expires_at = NULL,
         version = version + 1
   WHERE id = p_source_id;
  RETURN v_next_generation;
END;
$$;

CREATE TABLE device_installations (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES orthanc_sources(id) ON DELETE RESTRICT,
  display_name text NOT NULL CHECK (length(trim(display_name)) > 0),
  credential_verifier bytea NOT NULL CHECK (octet_length(credential_verifier) >= 32),
  status text NOT NULL DEFAULT 'paired' CHECK (status IN ('paired', 'revoked')),
  paired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  UNIQUE (source_id, id),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

ALTER TABLE orthanc_sources
  ADD CONSTRAINT orthanc_sources_lease_device_fk
  FOREIGN KEY (id, lease_device_id)
  REFERENCES device_installations(source_id, id)
  ON DELETE RESTRICT;

CREATE TABLE reports (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES orthanc_sources(id) ON DELETE RESTRICT,
  source_study_id text NOT NULL CHECK (length(trim(source_study_id)) > 0),
  study_instance_uid varchar(64) NOT NULL
    CHECK (study_instance_uid ~ '^[0-9]+([.][0-9]+)*$'),
  patient_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(patient_snapshot) = 'object'),
  state text NOT NULL DEFAULT 'discovered'
    CHECK (state IN ('discovered', 'syncing', 'processing', 'ready', 'needs_attention')),
  has_unresolved_conflict boolean NOT NULL DEFAULT false,
  current_manifest_revision integer,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (source_id, study_instance_uid),
  UNIQUE (id, source_id)
);

CREATE TABLE report_files (
  id uuid PRIMARY KEY,
  report_id uuid NOT NULL,
  source_id uuid NOT NULL,
  series_instance_uid varchar(64) NOT NULL
    CHECK (series_instance_uid ~ '^[0-9]+([.][0-9]+)*$'),
  sop_instance_uid varchar(64) NOT NULL
    CHECK (sop_instance_uid ~ '^[0-9]+([.][0-9]+)*$'),
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  byte_count bigint CHECK (byte_count IS NULL OR byte_count >= 0),
  state text NOT NULL DEFAULT 'discovered'
    CHECK (state IN ('discovered', 'uploading', 'received', 'processing', 'verified', 'indexed', 'needs_attention')),
  cloud_orthanc_instance_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (report_id, source_id) REFERENCES reports(id, source_id) ON DELETE RESTRICT,
  CHECK (state NOT IN ('verified', 'indexed') OR sha256 IS NOT NULL),
  CHECK (state <> 'indexed' OR (cloud_orthanc_instance_id IS NOT NULL AND length(trim(cloud_orthanc_instance_id)) > 0)),
  UNIQUE (report_id, source_id, sop_instance_uid),
  UNIQUE (source_id, sop_instance_uid),
  UNIQUE (id, report_id, source_id),
  UNIQUE (report_id, source_id, sop_instance_uid, sha256)
);

CREATE TABLE source_resource_observations (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL,
  generation bigint NOT NULL,
  report_id uuid NOT NULL,
  resource_kind text NOT NULL CHECK (resource_kind IN ('study', 'instance')),
  resource_id text NOT NULL CHECK (length(trim(resource_id)) > 0),
  report_file_id uuid,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (source_id, generation)
    REFERENCES source_generations(source_id, generation) ON DELETE RESTRICT,
  FOREIGN KEY (report_id, source_id) REFERENCES reports(id, source_id) ON DELETE RESTRICT,
  FOREIGN KEY (report_file_id, report_id, source_id)
    REFERENCES report_files(id, report_id, source_id) ON DELETE RESTRICT,
  CHECK ((resource_kind = 'study' AND report_file_id IS NULL) OR (resource_kind = 'instance' AND report_file_id IS NOT NULL)),
  UNIQUE (source_id, generation, resource_kind, resource_id)
);

CREATE UNIQUE INDEX source_observations_one_study_locator_per_report_generation
  ON source_resource_observations(report_id, generation)
  WHERE resource_kind = 'study';

CREATE UNIQUE INDEX source_observations_one_instance_locator_per_file_generation
  ON source_resource_observations(report_file_id, generation)
  WHERE resource_kind = 'instance';

CREATE TRIGGER source_generations_immutable
  BEFORE UPDATE OR DELETE ON source_generations
  FOR EACH ROW EXECUTE FUNCTION source_history_immutable();

CREATE TRIGGER source_resource_observations_immutable
  BEFORE UPDATE OR DELETE ON source_resource_observations
  FOR EACH ROW EXECUTE FUNCTION source_history_immutable();

CREATE FUNCTION guard_report_identity_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.study_instance_uid IS DISTINCT FROM OLD.study_instance_uid THEN
    RAISE EXCEPTION 'logical Report identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER reports_identity_immutable
  BEFORE UPDATE ON reports
  FOR EACH ROW EXECUTE FUNCTION guard_report_identity_update();

CREATE FUNCTION guard_report_file_identity_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.report_id IS DISTINCT FROM OLD.report_id
     OR NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.series_instance_uid IS DISTINCT FROM OLD.series_instance_uid
     OR NEW.sop_instance_uid IS DISTINCT FROM OLD.sop_instance_uid THEN
    RAISE EXCEPTION 'logical Report file identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER report_files_identity_immutable
  BEFORE UPDATE ON report_files
  FOR EACH ROW EXECUTE FUNCTION guard_report_file_identity_update();
