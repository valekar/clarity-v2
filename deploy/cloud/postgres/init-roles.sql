\getenv clarity_migrator_password CLARITY_MIGRATOR_PASSWORD
\getenv clarity_runtime_password CLARITY_RUNTIME_PASSWORD
\getenv clarity_worker_password CLARITY_WORKER_PASSWORD
\getenv hanko_migrator_password HANKO_MIGRATOR_PASSWORD
\getenv hanko_runtime_password HANKO_RUNTIME_PASSWORD
\getenv orthanc_runtime_password ORTHANC_RUNTIME_PASSWORD

CREATE ROLE clarity_v2_migrator LOGIN PASSWORD :'clarity_migrator_password';
CREATE ROLE clarity_v2_runtime LOGIN PASSWORD :'clarity_runtime_password';
CREATE ROLE clarity_v2_worker LOGIN PASSWORD :'clarity_worker_password';
CREATE ROLE clarity_v2_device_auth NOLOGIN;
CREATE ROLE clarity_v2_bootstrap_operator NOLOGIN;
CREATE DATABASE clarity_v2_app OWNER clarity_v2_migrator;
REVOKE ALL ON DATABASE clarity_v2_app FROM PUBLIC;
GRANT CONNECT ON DATABASE clarity_v2_app TO clarity_v2_runtime;
GRANT CONNECT ON DATABASE clarity_v2_app TO clarity_v2_worker;
GRANT CONNECT ON DATABASE clarity_v2_app TO clarity_v2_device_auth;
GRANT CONNECT ON DATABASE clarity_v2_app TO clarity_v2_bootstrap_operator;
\connect clarity_v2_app
CREATE EXTENSION IF NOT EXISTS pgcrypto;
\connect postgres

CREATE ROLE hanko_migrator LOGIN PASSWORD :'hanko_migrator_password';
CREATE ROLE hanko_runtime LOGIN PASSWORD :'hanko_runtime_password';
CREATE DATABASE hanko OWNER hanko_migrator;
REVOKE ALL ON DATABASE hanko FROM PUBLIC;
GRANT CONNECT ON DATABASE hanko TO hanko_runtime;
\connect hanko
GRANT USAGE ON SCHEMA public TO hanko_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE hanko_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hanko_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE hanko_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO hanko_runtime;
\connect postgres

CREATE ROLE orthanc_runtime LOGIN PASSWORD :'orthanc_runtime_password';
CREATE DATABASE orthanc OWNER orthanc_runtime;
REVOKE ALL ON DATABASE orthanc FROM PUBLIC;
