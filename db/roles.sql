-- 000_roles.sql  (run once per instance, as postgres)
-- Passwords come from environment variables OWNER_PW and APP_PW.
\set owner_pw `printf %s "$OWNER_PW"`
\set app_pw `printf %s "$APP_PW"`

-- cwui_owner: owns the databases, runs migrations. Never used by the running app.
CREATE ROLE cwui_owner LOGIN PASSWORD :'owner_pw';
-- cwui_app: what the API connects as. Data access only, no DDL, subject to row-level security.
CREATE ROLE cwui_app LOGIN PASSWORD :'app_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

-- Cloud SQL's postgres is not a true superuser, so it must be a member of the new owner first.
GRANT cwui_owner TO postgres;

ALTER DATABASE canweuseit_staging OWNER TO cwui_owner;
ALTER DATABASE canweuseit_prod    OWNER TO cwui_owner;

REVOKE ALL ON DATABASE canweuseit_staging FROM PUBLIC;
REVOKE ALL ON DATABASE canweuseit_prod    FROM PUBLIC;
GRANT CONNECT ON DATABASE canweuseit_staging TO cwui_app;
GRANT CONNECT ON DATABASE canweuseit_prod    TO cwui_app;
