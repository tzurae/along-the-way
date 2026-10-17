#!/usr/bin/env sh
set -eu

: "${APP_DATABASE_USER:?Set APP_DATABASE_USER}"
: "${APP_DATABASE_PASSWORD:?Set APP_DATABASE_PASSWORD}"
: "${PGUSER:?Set PGUSER to the administrative role}"

case "$APP_DATABASE_USER" in
  ""|[0-9]*|*[!A-Za-z0-9_]*)
    echo "APP_DATABASE_USER must be a simple PostgreSQL identifier" >&2
    exit 1
    ;;
  *) ;;
esac

if [ "$APP_DATABASE_USER" = "$PGUSER" ] || [ "$APP_DATABASE_USER" = "postgres" ]; then
  echo "APP_DATABASE_USER must not be an administrative role" >&2
  exit 1
fi

psql \
  --set ON_ERROR_STOP=1 \
  --set app_user="$APP_DATABASE_USER" \
  --set app_password="$APP_DATABASE_PASSWORD" <<'SQL'
SELECT
  EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user') AS role_exists,
  COALESCE((
    SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
    FROM pg_roles
    WHERE rolname = :'app_user'
  ), false) AS role_privileged,
  COALESCE((
    SELECT shobj_description(oid, 'pg_authid') = 'managed-by:along-the-way'
    FROM pg_roles
    WHERE rolname = :'app_user'
  ), false) AS role_managed
\gset

\if :role_privileged
  \echo 'Refusing to alter a privileged PostgreSQL role'
  SELECT 1 / 0;
\endif

\if :role_exists
  \if :role_managed
  \else
    \echo 'Refusing to alter a role not owned by Along the Way'
    SELECT 1 / 0;
  \endif
\endif

BEGIN;

SELECT format('CREATE ROLE %I', :'app_user')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user')
\gexec

SELECT format(
  'ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
  :'app_user',
  :'app_password'
)
\gexec

SELECT format(
  'COMMENT ON ROLE %I IS %L',
  :'app_user',
  'managed-by:along-the-way'
)
\gexec

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'app_user')
\gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'app_user')
\gexec
SELECT format(
  'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I',
  :'app_user'
)
\gexec
SELECT format(
  'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO %I',
  :'app_user'
)
\gexec

-- Kysely alone owns migration state, and PostGIS owns spatial_ref_sys. A
-- compromised runtime role must not be able to make the next admin migration
-- rerun old work or use a forged SRID definition.
SELECT format(
  'REVOKE ALL PRIVILEGES ON TABLE public.kysely_migration, public.kysely_migration_lock FROM %I',
  :'app_user'
)
\gexec
SELECT format(
  'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.spatial_ref_sys FROM %I',
  :'app_user'
)
\gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
  :'app_user'
)
\gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I',
  :'app_user'
)
\gexec

SELECT
  has_table_privilege(:'app_user', 'public.kysely_migration', 'SELECT')
    OR has_table_privilege(:'app_user', 'public.kysely_migration', 'INSERT')
    OR has_table_privilege(:'app_user', 'public.kysely_migration', 'UPDATE')
    OR has_table_privilege(:'app_user', 'public.kysely_migration', 'DELETE')
    OR has_table_privilege(:'app_user', 'public.kysely_migration_lock', 'SELECT')
    OR has_table_privilege(:'app_user', 'public.kysely_migration_lock', 'INSERT')
    OR has_table_privilege(:'app_user', 'public.kysely_migration_lock', 'UPDATE')
    OR has_table_privilege(:'app_user', 'public.kysely_migration_lock', 'DELETE')
    AS migration_privilege_remaining,
  has_table_privilege(:'app_user', 'public.spatial_ref_sys', 'INSERT')
    OR has_table_privilege(:'app_user', 'public.spatial_ref_sys', 'UPDATE')
    OR has_table_privilege(:'app_user', 'public.spatial_ref_sys', 'DELETE')
    OR has_table_privilege(:'app_user', 'public.spatial_ref_sys', 'TRUNCATE')
    OR has_table_privilege(:'app_user', 'public.spatial_ref_sys', 'REFERENCES')
    OR has_table_privilege(:'app_user', 'public.spatial_ref_sys', 'TRIGGER')
    AS spatial_write_privilege_remaining,
  has_table_privilege(:'app_user', 'public.spatial_ref_sys', 'SELECT')
    AS spatial_read_available
\gset

\if :migration_privilege_remaining
  \echo 'Application role still has migration bookkeeping privileges'
  SELECT 1 / 0;
\endif
\if :spatial_write_privilege_remaining
  \echo 'Application role still has spatial_ref_sys write privileges'
  SELECT 1 / 0;
\endif
\if :spatial_read_available
\else
  \echo 'Application role lost required spatial_ref_sys read access'
  SELECT 1 / 0;
\endif

COMMIT;
SQL
