-- Close the Supabase Data API on every table.
--
-- The application reaches the database only through Prisma, as the table owner, so nothing here
-- changes how it runs. Supabase also publishes the `public` schema through PostgREST to the `anon`
-- and `authenticated` roles, and the anon key is public. Until now no table had row level security
-- and both roles could read and write all of them. This turns RLS on (with no policies, so the
-- roles are refused), removes their privileges, and makes sure tables made later start closed too.
--
-- Guarded so it also runs on a plain Postgres with none of Supabase's roles (a shadow database).

DO $$
DECLARE
  t record;
BEGIN
  -- Row level security on every table in the schema, this one's own bookkeeping table included.
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM authenticated;
  END IF;
END
$$;

-- A table created after this turns row level security on by itself, so a later migration cannot
-- quietly reopen the Data API. Best effort: an event trigger needs a privilege some hosts withhold.
CREATE OR REPLACE FUNCTION public.kestrel_enable_rls_on_new_tables() RETURNS event_trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  obj record;
BEGIN
  FOR obj IN
    SELECT * FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO') AND schema_name = 'public'
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', obj.object_identity);
  END LOOP;
END
$fn$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtname = 'kestrel_enable_rls') THEN
    DROP EVENT TRIGGER kestrel_enable_rls;
  END IF;
  CREATE EVENT TRIGGER kestrel_enable_rls ON ddl_command_end
    WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
    EXECUTE FUNCTION public.kestrel_enable_rls_on_new_tables();
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Could not create the event trigger; new tables still start with no access for anon and authenticated (default privileges above).';
END
$$;

REVOKE ALL ON FUNCTION public.kestrel_enable_rls_on_new_tables() FROM PUBLIC;
