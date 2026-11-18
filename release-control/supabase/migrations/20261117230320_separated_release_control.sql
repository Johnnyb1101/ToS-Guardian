-- Forward migration artifact. Installation needs separately reviewed installer pins.
-- This artifact has only been applied in the disposable local rehearsal.
BEGIN;
DO $$ BEGIN
 IF current_setting('tos.expected_database',true) IS DISTINCT FROM current_database() THEN RAISE EXCEPTION 'missing or mismatched installer database pin'; END IF;
 IF current_setting('tos.expected_installer_role',true) IS DISTINCT FROM session_user OR current_user IS DISTINCT FROM session_user THEN RAISE EXCEPTION 'missing or mismatched installer role pin'; END IF;
 IF current_setting('tos.expected_server_version_num',true) IS DISTINCT FROM current_setting('server_version_num') OR current_setting('server_version_num')::int/10000<>17 THEN RAISE EXCEPTION 'missing or mismatched supported server version pin'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname like 'tos_release_%') OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='tos_release_control') THEN RAISE EXCEPTION 'preexisting controller objects'; END IF;
END $$;
DO $preflight$ DECLARE measured text; BEGIN select encode(sha256(convert_to(jsonb_build_object(
 'version', current_setting('server_version_num'),
 'roles',(select jsonb_agg(to_jsonb(x) order by x.oid) from pg_roles x),
 'memberships',(select coalesce(jsonb_agg(to_jsonb(x) order by x.oid),'[]'::jsonb) from pg_auth_members x),
 'namespaces',(select jsonb_agg(to_jsonb(x) order by x.oid) from pg_namespace x where nspname !~ '^pg_temp_|^pg_toast_temp_'),
 'relations',(select jsonb_agg(to_jsonb(x)-array['relpages','reltuples','relallvisible','relfrozenxid','relminmxid'] order by x.oid) from pg_class x where relnamespace not in (select oid from pg_namespace where nspname ~ '^pg_|^information_schema$')),
 'columns',(select jsonb_agg(to_jsonb(x) order by x.attrelid,x.attnum) from pg_attribute x where attrelid in(select oid from pg_class where relnamespace not in(select oid from pg_namespace where nspname ~ '^pg_|^information_schema$'))),
 'routines',(select jsonb_agg(to_jsonb(x) order by x.oid) from pg_proc x where pronamespace not in(select oid from pg_namespace where nspname ~ '^pg_|^information_schema$')),
 'policies',(select coalesce(jsonb_agg(to_jsonb(x) order by x.oid),'[]'::jsonb) from pg_policy x),
 'triggers',(select coalesce(jsonb_agg(to_jsonb(x) order by x.oid),'[]'::jsonb) from pg_trigger x where not tgisinternal),
 'rules',(select coalesce(jsonb_agg(to_jsonb(x) order by x.oid),'[]'::jsonb) from pg_rewrite x where ev_class in(select oid from pg_class where relnamespace not in(select oid from pg_namespace where nspname ~ '^pg_|^information_schema$'))),
 'defaults',(select coalesce(jsonb_agg(to_jsonb(x) order by x.oid),'[]'::jsonb) from pg_default_acl x),
 'columnDefaults',(select coalesce(jsonb_agg(to_jsonb(x) order by x.oid),'[]'::jsonb) from pg_attrdef x where adrelid in(select oid from pg_class where relnamespace not in(select oid from pg_namespace where nspname ~ '^pg_|^information_schema$'))),
 'database',(select to_jsonb(x)-array['datfrozenxid','datminmxid'] from pg_database x where datname=current_database()),
 'databaseRoleSettings',(select coalesce(jsonb_agg(to_jsonb(x) order by x.setdatabase,x.setrole),'[]'::jsonb) from pg_db_role_setting x),
 'languages',(select jsonb_agg(to_jsonb(x) order by x.oid) from pg_language x),
 'types',(select jsonb_agg(to_jsonb(x) order by x.oid) from pg_type x where typnamespace not in(select oid from pg_namespace where nspname ~ '^pg_|^information_schema$')),
 'operators',(select coalesce(jsonb_agg(to_jsonb(x) order by x.oid),'[]'::jsonb) from pg_operator x where oprnamespace not in(select oid from pg_namespace where nspname ~ '^pg_|^information_schema$')),
 'casts',(select jsonb_agg(to_jsonb(x) order by x.oid) from pg_cast x),
 'collations',(select coalesce(jsonb_agg(to_jsonb(x) order by x.oid),'[]'::jsonb) from pg_collation x where collnamespace not in(select oid from pg_namespace where nspname ~ '^pg_|^information_schema$')),
 'foreignTables',(select coalesce(jsonb_agg(to_jsonb(x) order by x.ftrelid),'[]'::jsonb) from pg_foreign_table x),
 'extensions',(select jsonb_agg(to_jsonb(x) order by x.oid) from pg_extension x),
 'constraints',(select jsonb_agg(to_jsonb(x) order by x.oid) from pg_constraint x where connamespace not in(select oid from pg_namespace where nspname ~ '^pg_|^information_schema$'))
)::text,'UTF8')),'hex') INTO measured; IF coalesce(current_setting('tos.reviewed_catalog_hash',true),'')<>measured THEN RAISE EXCEPTION 'unreviewed catalog'; END IF; IF EXISTS(SELECT 1 FROM pg_foreign_table) THEN RAISE EXCEPTION 'foreign tables require a separate supported dependency audit'; END IF; END $preflight$;
CREATE ROLE tos_release_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE tos_release_controller LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
DO $$ BEGIN EXECUTE format('REVOKE CREATE,TEMPORARY ON DATABASE %I FROM PUBLIC',current_database()); END $$;
CREATE SCHEMA tos_release_control AUTHORIZATION tos_release_owner;
REVOKE ALL ON SCHEMA tos_release_control FROM PUBLIC;
SET LOCAL ROLE tos_release_owner;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
CREATE TABLE tos_release_control.registry (
 environment text PRIMARY KEY,
 destination jsonb NOT NULL,
 state jsonb NOT NULL,
 plan jsonb,
 CHECK(jsonb_typeof(destination)='object' AND jsonb_typeof(state)='object'),
 CHECK(state ?& array['governanceEpoch','governanceRegistryId','governanceHeadHash','installedVerifierHash','installedMigrationManifestHash'] AND
       state - array['governanceEpoch','governanceRegistryId','governanceHeadHash','installedVerifierHash','installedMigrationManifestHash']='{}'::jsonb AND
       state->'governanceEpoch' IN ('0'::jsonb,'1'::jsonb) AND
       jsonb_typeof(state->'governanceRegistryId')='string' AND jsonb_typeof(state->'governanceHeadHash')='string' AND
       jsonb_typeof(state->'installedVerifierHash')='string' AND jsonb_typeof(state->'installedMigrationManifestHash')='string' AND
       (state->>'governanceRegistryId') ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' AND
       (state->>'governanceHeadHash') ~ '^[a-f0-9]{64}$' AND
       (state->>'installedVerifierHash') ~ '^[a-f0-9]{64}$' AND
       (state->>'installedMigrationManifestHash') ~ '^[a-f0-9]{64}$')
);
CREATE TABLE tos_release_control.events (
 authorization_id text PRIMARY KEY,
 environment text NOT NULL REFERENCES tos_release_control.registry(environment),
 event_hash text NOT NULL UNIQUE CHECK(event_hash ~ '^[a-f0-9]{64}$'),
 event jsonb NOT NULL
);
CREATE TABLE tos_release_control.consumptions (
 authorization_id text PRIMARY KEY REFERENCES tos_release_control.events(authorization_id),
 envelope_canonical text NOT NULL,
 plan_canonical text NOT NULL,
 result jsonb NOT NULL
);
ALTER TABLE tos_release_control.registry ENABLE ROW LEVEL SECURITY;

ALTER TABLE tos_release_control.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tos_release_control.consumptions ENABLE ROW LEVEL SECURITY;

RESET ROLE;
GRANT USAGE ON SCHEMA public TO tos_release_owner;
ALTER TABLE public.learning_releases OWNER TO tos_release_owner;
ALTER TABLE public.learning_active_releases OWNER TO tos_release_owner;
ALTER TABLE public.learning_release_events OWNER TO tos_release_owner;
ALTER TABLE public.learning_release_consumptions OWNER TO tos_release_owner;
GRANT SELECT,UPDATE ON public.learning_guard,public.site_database TO tos_release_owner;
GRANT EXECUTE ON FUNCTION public.prepare_learning_release(jsonb,text) TO tos_release_owner;
-- Revoke explicit table AND column grants, including nonstandard runtime identities.
DO $fence$ DECLARE target text; actor record; col record; fn record; BEGIN
 FOREACH target IN ARRAY ARRAY['learning_releases','learning_active_releases','learning_release_events','learning_release_consumptions'] LOOP
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC',target);
  FOR actor IN SELECT rolname FROM pg_roles WHERE rolname<>'tos_release_owner' AND NOT rolsuper LOOP
   EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I',target,actor.rolname);
   FOR col IN SELECT attname FROM pg_attribute WHERE attrelid=format('public.%I',target)::regclass AND attnum>0 AND NOT attisdropped LOOP
    EXECUTE format('REVOKE ALL (%I) ON public.%I FROM %I',col.attname,target,actor.rolname);
   END LOOP;
  END LOOP;
  FOR col IN SELECT attname FROM pg_attribute WHERE attrelid=format('public.%I',target)::regclass AND attnum>0 AND NOT attisdropped LOOP
   EXECUTE format('REVOKE ALL (%I) ON public.%I FROM PUBLIC',col.attname,target);
  END LOOP;
 END LOOP;
 -- Every overload of all known legacy release and bootstrap routes is fenced.
 FOR fn IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname IN ('prepare_learning_release','activate_learning_release','set_learning_release_halt') OR p.proname ILIKE '%bootstrap%') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.signature);
  FOR actor IN SELECT rolname FROM pg_roles WHERE rolname<>'tos_release_owner' AND NOT rolsuper LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',fn.signature,actor.rolname); END LOOP;
 END LOOP;
END $fence$;
-- The existing application may read immutable releases and the active pointer.
-- BYPASSRLS never substitutes for a missing write grant.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  GRANT SELECT ON public.learning_releases,public.learning_active_releases,public.learning_release_events,public.learning_release_consumptions TO service_role;
 END IF;
END $$;
SET LOCAL ROLE tos_release_owner;
CREATE TABLE tos_release_control.catalog_pin (singleton boolean PRIMARY KEY CHECK(singleton), hash text NOT NULL);
ALTER TABLE tos_release_control.catalog_pin ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION tos_release_control.measure_catalog() RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,tos_release_control,pg_temp AS $catalog$ select encode(sha256(convert_to(jsonb_build_object(
 'version', current_setting('server_version_num'),
 'roles',(select jsonb_agg(to_jsonb(x) order by x.oid) from pg_roles x),
 'memberships',(select coalesce(jsonb_agg(to_jsonb(x) order by x.oid),'[]'::jsonb) from pg_auth_members x),
 'namespaces',(select jsonb_agg(to_jsonb(x) order by x.oid) from pg_namespace x where nspname !~ '^pg_temp_|^pg_toast_temp_'),
 'relations',(select jsonb_agg(to_jsonb(x)-array['relpages','reltuples','relallvisible','relfrozenxid','relminmxid'] order by x.oid) from pg_class x where relnamespace not in (select oid from pg_namespace where nspname ~ '^pg_|^information_schema$')),
 'columns',(select jsonb_agg(to_jsonb(x) order by x.attrelid,x.attnum) from pg_attribute x where attrelid in(select oid from pg_class where relnamespace not in(select oid from pg_namespace where nspname ~ '^pg_|^information_schema$'))),
 'routines',(select jsonb_agg(to_jsonb(x) order by x.oid) from pg_proc x where pronamespace not in(select oid from pg_namespace where nspname ~ '^pg_|^information_schema$')),
 'policies',(select coalesce(jsonb_agg(to_jsonb(x) order by x.oid),'[]'::jsonb) from pg_policy x),
 'triggers',(select coalesce(jsonb_agg(to_jsonb(x) order by x.oid),'[]'::jsonb) from pg_trigger x where not tgisinternal),
 'rules',(select coalesce(jsonb_agg(to_jsonb(x) order by x.oid),'[]'::jsonb) from pg_rewrite x where ev_class in(select oid from pg_class where relnamespace not in(select oid from pg_namespace where nspname ~ '^pg_|^information_schema$'))),
 'defaults',(select coalesce(jsonb_agg(to_jsonb(x) order by x.oid),'[]'::jsonb) from pg_default_acl x),
 'columnDefaults',(select coalesce(jsonb_agg(to_jsonb(x) order by x.oid),'[]'::jsonb) from pg_attrdef x where adrelid in(select oid from pg_class where relnamespace not in(select oid from pg_namespace where nspname ~ '^pg_|^information_schema$'))),
 'database',(select to_jsonb(x)-array['datfrozenxid','datminmxid'] from pg_database x where datname=current_database()),
 'databaseRoleSettings',(select coalesce(jsonb_agg(to_jsonb(x) order by x.setdatabase,x.setrole),'[]'::jsonb) from pg_db_role_setting x),
 'languages',(select jsonb_agg(to_jsonb(x) order by x.oid) from pg_language x),
 'types',(select jsonb_agg(to_jsonb(x) order by x.oid) from pg_type x where typnamespace not in(select oid from pg_namespace where nspname ~ '^pg_|^information_schema$')),
 'operators',(select coalesce(jsonb_agg(to_jsonb(x) order by x.oid),'[]'::jsonb) from pg_operator x where oprnamespace not in(select oid from pg_namespace where nspname ~ '^pg_|^information_schema$')),
 'casts',(select jsonb_agg(to_jsonb(x) order by x.oid) from pg_cast x),
 'collations',(select coalesce(jsonb_agg(to_jsonb(x) order by x.oid),'[]'::jsonb) from pg_collation x where collnamespace not in(select oid from pg_namespace where nspname ~ '^pg_|^information_schema$')),
 'foreignTables',(select coalesce(jsonb_agg(to_jsonb(x) order by x.ftrelid),'[]'::jsonb) from pg_foreign_table x),
 'extensions',(select jsonb_agg(to_jsonb(x) order by x.oid) from pg_extension x),
 'constraints',(select jsonb_agg(to_jsonb(x) order by x.oid) from pg_constraint x where connamespace not in(select oid from pg_namespace where nspname ~ '^pg_|^information_schema$'))
)::text,'UTF8')),'hex'); $catalog$;
CREATE FUNCTION tos_release_control.assert_catalog() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,tos_release_control,pg_temp AS $catalog$ BEGIN
 IF tos_release_control.measure_catalog() IS DISTINCT FROM (SELECT hash FROM tos_release_control.catalog_pin WHERE singleton) THEN RAISE EXCEPTION 'installed catalog drift'; END IF;
END $catalog$;
CREATE OR REPLACE FUNCTION tos_release_control.adopt(p_envelope jsonb,p_envelope_canonical text,p_plan jsonb,p_plan_canonical text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,tos_release_control,pg_temp AS $$
DECLARE
 p jsonb := p_envelope->'payload';
 id text := p_envelope->'payload'->>'authorizationId';
 env text := p_envelope->'payload'->'destination'->>'environment';
 r tos_release_control.registry%ROWTYPE;
 used tos_release_control.consumptions%ROWTYPE;
 active jsonb; expected_payload jsonb; event_body jsonb; event_hash text; result jsonb;
 issued timestamptz; expires timestamptz;
BEGIN
 PERFORM tos_release_control.assert_catalog();
 IF p_envelope IS NULL OR p_plan IS NULL OR p_envelope_canonical IS NULL OR p_plan_canonical IS NULL OR
    length(p_envelope_canonical)>1000000 OR length(p_plan_canonical)>4000000 OR
    p_envelope_canonical::jsonb IS DISTINCT FROM p_envelope OR
    p_plan_canonical::jsonb IS DISTINCT FROM (p_plan-'hash') OR
    encode(sha256(convert_to(p_plan_canonical,'UTF8')),'hex') IS DISTINCT FROM p_plan->>'hash' OR
    coalesce(id,'') !~ '^[A-Za-z0-9_-]{16,128}$' OR coalesce(env,'') !~ '^[a-z][a-z0-9-]{0,63}$'
 THEN RAISE EXCEPTION 'invalid bounded envelope/plan'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('tos.lab.authorization.'||id,0));
 SELECT * INTO used FROM tos_release_control.consumptions WHERE authorization_id=id;
 IF FOUND THEN
   IF used.envelope_canonical IS DISTINCT FROM p_envelope_canonical OR used.plan_canonical IS DISTINCT FROM p_plan_canonical
   THEN RAISE EXCEPTION 'conflicting authorization reuse'; END IF;
   RETURN used.result || jsonb_build_object('status','already-applied');
 END IF;
 SELECT * INTO r FROM tos_release_control.registry WHERE environment=env FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'unknown governance registry'; END IF;
 SELECT jsonb_build_object('generation',generation,'configHash',config_hash,'headHash',head_hash,'halted',halted) INTO active FROM public.learning_active_releases WHERE environment=env FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'unknown release state'; END IF;
 IF r.destination IS DISTINCT FROM p_plan->'destination' OR
    (r.state || active) IS DISTINCT FROM p_plan->'active' OR
    r.state->'governanceEpoch' IS DISTINCT FROM '0'::jsonb OR
    active->'halted' IS DISTINCT FROM 'false'::jsonb OR
    (active->>'generation')::bigint < 1
 THEN RAISE EXCEPTION 'stale or halted state'; END IF;
 IF p_plan->'v' IS DISTINCT FROM '1'::jsonb OR p_plan->>'kind' IS DISTINCT FROM 'governance-transition-plan' OR
    p_plan->'nextGovernanceEpoch' IS DISTINCT FROM '1'::jsonb OR
    p_plan->>'fromStandard' IS DISTINCT FROM 'step2-final/v2' OR p_plan->>'toStandard' IS DISTINCT FROM 'maintenance-final/v1'
 THEN RAISE EXCEPTION 'invalid governance standard'; END IF;
 expected_payload:=jsonb_build_object('v',3,'kind','governance-transition','action','adopt-maintenance-standard',
   'authorizationId',id,'issuedAt',p->'issuedAt','expiresAt',p->'expiresAt','planHash',p_plan->'hash',
   'destination',p_plan->'destination','expected',p_plan->'active','nextGovernanceEpoch',1,
   'fromStandard',p_plan->'fromStandard','toStandard',p_plan->'toStandard',
   'baselineConfigHash',p_plan->'baseline'->'configHash','candidateConfigHash',p_plan->'candidate'->'configHash',
   'baselineManifestHash',p_plan->'baselineManifest'->'hash','candidateManifestHash',p_plan->'candidateManifest'->'hash',
   'migrationManifestHash',p_plan->'migrationManifest'->'hash','standardDocumentHash',p_plan->'standardDocumentHash',
   'verifierHash',p_plan->'verifierHash','ownerKeyFingerprint',p_plan->'ownerKeyFingerprint');
 IF p IS DISTINCT FROM expected_payload THEN RAISE EXCEPTION 'payload plan binding mismatch'; END IF;
 issued:=(p->>'issuedAt')::timestamptz; expires:=(p->>'expiresAt')::timestamptz;
 IF issued IS NULL OR expires IS NULL OR issued>clock_timestamp() OR expires<=clock_timestamp() OR
    expires<=issued OR expires-issued>interval '24 hours'
 THEN RAISE EXCEPTION 'expired or invalid lifetime'; END IF;
 event_body:=jsonb_build_object('kind','governance-adopted','environment',env,'authorizationId',id,
   'authorizationHash',encode(sha256(convert_to(p_envelope_canonical,'UTF8')),'hex'),
   'planHash',p_plan->'hash','previousGovernanceHead',r.state->'governanceHeadHash','epoch',1);
 event_hash:=encode(sha256(convert_to(event_body::text,'UTF8')),'hex');
 result:=jsonb_build_object('status','adopted','epoch',1,'head',event_hash);
 INSERT INTO tos_release_control.events VALUES(id,env,event_hash,event_body);
 INSERT INTO tos_release_control.consumptions VALUES(id,p_envelope_canonical,p_plan_canonical,result);
 -- Recheck after possible constraint/index/trigger waits. Error rolls back preceding inserts.
 IF expires<=clock_timestamp() THEN RAISE EXCEPTION 'expired before publication'; END IF;
 UPDATE tos_release_control.registry SET state=state || jsonb_build_object('governanceEpoch',1,'governanceHeadHash',event_hash,'installedVerifierHash',p_plan->'verifierHash','installedMigrationManifestHash',p_plan->'migrationManifest'->'hash'), plan=p_plan
 WHERE environment=env;
 IF expires<=clock_timestamp() THEN RAISE EXCEPTION 'expired during publication'; END IF;
 RETURN result;
END $$;

CREATE FUNCTION tos_release_control.read_state(p_environment text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,tos_release_control,pg_temp AS $$
 DECLARE result jsonb; BEGIN PERFORM tos_release_control.assert_catalog();
 SELECT jsonb_build_object('destination',r.destination,'planHash',r.plan->'hash','standardDocumentHash',r.plan->'standardDocumentHash','active',r.state || jsonb_build_object('generation',a.generation,'configHash',a.config_hash,'headHash',a.head_hash,'halted',a.halted)) INTO result
 FROM tos_release_control.registry r JOIN public.learning_active_releases a ON a.environment=r.environment WHERE r.environment=p_environment;
 RETURN result; END $$;
CREATE FUNCTION tos_release_control.read_committed(p_id text,p_envelope text,p_plan text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,tos_release_control,pg_temp AS $$
DECLARE used tos_release_control.consumptions%ROWTYPE;
BEGIN
 PERFORM tos_release_control.assert_catalog();
 SELECT * INTO used FROM tos_release_control.consumptions WHERE authorization_id=p_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF used.envelope_canonical IS DISTINCT FROM p_envelope OR used.plan_canonical IS DISTINCT FROM p_plan THEN RAISE EXCEPTION 'conflicting committed replay'; END IF;
 RETURN used.result || jsonb_build_object('status','already-applied');
END $$;
create function tos_release_control.activate_validated(
  p_environment text, p_release jsonb, p_canonical text,
  p_authorization jsonb, p_authorization_hash text, p_canonical_authorization text,
  p_expected_generation bigint, p_expected_config_hash text,
  p_event jsonb, p_canonical_event text
) returns jsonb language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  a public.learning_active_releases%rowtype;
  used public.learning_release_consumptions%rowtype;
  auth jsonb := p_authorization->'payload';
  evidence jsonb := p_authorization->'payload'->'evidence';
  body jsonb := p_event->'body';
  authorization_id_value text := p_authorization->'payload'->>'authorizationId';
  config_hash_value text := p_release->>'configHash';
  next_active jsonb;
  outcome jsonb;
  site jsonb;
begin
  if p_environment is null or p_environment !~ '^[a-z][a-z0-9-]{0,63}$'
     or authorization_id_value is null or authorization_id_value !~ '^[a-zA-Z0-9_-]{16,128}$' then
    raise exception 'invalid release environment or authorization id';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('tos-guardian.authorization.' || authorization_id_value, 0));
  perform pg_advisory_xact_lock(hashtextextended('tos-guardian.release.' || p_environment, 0));
  select * into used from public.learning_release_consumptions where authorization_id = authorization_id_value;
  if found then
    if used.authorization_hash is distinct from p_authorization_hash or used.environment is distinct from p_environment
       or used.config_hash is distinct from config_hash_value then
      return jsonb_build_object('status', 'invalid', 'reason', 'authorization id already consumed with different content');
    end if;
    return used.result || jsonb_build_object('status', 'already-applied');
  end if;
  if p_canonical_authorization::jsonb is distinct from p_authorization
     or encode(sha256(convert_to(p_canonical_authorization, 'UTF8')), 'hex') is distinct from p_authorization_hash
     or auth->>'v' is distinct from '2' or auth->>'kind' is distinct from 'release-activation'
     or auth->>'action' not in ('activate', 'rollback') or auth->>'action' is null
     or auth->>'environment' is distinct from p_environment or auth->>'configHash' is distinct from config_hash_value
     or auth->>'expectedGeneration' is distinct from p_expected_generation::text
     or auth->>'expectedConfigHash' is distinct from p_expected_config_hash
     or p_authorization->>'signature' is null then
    raise exception 'invalid release authorization binding';
  end if;
  if evidence->>'phase' is distinct from 'maintenance-final' or evidence->>'configHash' is distinct from config_hash_value
     or evidence->'evaluationPassed' is distinct from 'true'::jsonb
     or evidence->'promotionEligible' is distinct from 'true'::jsonb
     or evidence->'diagnosticOnly' is distinct from 'false'::jsonb
     or coalesce(evidence->>'evidenceHash', '') !~ '^[a-f0-9]{64}$'
     or coalesce(evidence->>'protocolHash', '') !~ '^[a-f0-9]{64}$'
     or coalesce(evidence->>'corpusHash', '') !~ '^[a-f0-9]{64}$' then
    raise exception 'final evidence binding required';
  end if;
  if (auth->>'issuedAt')::timestamptz > clock_timestamp() or (auth->>'expiresAt')::timestamptz <= clock_timestamp()
     or auth->>'issuedAt' is null or auth->>'expiresAt' is null then
    return jsonb_build_object('status', 'invalid', 'reason', 'release authorization is outside its lifetime');
  end if;
  select * into a from public.learning_active_releases where environment = p_environment for update;
  if not found then
    a.environment := p_environment; a.generation := 0; a.config_hash := null; a.head_hash := null; a.halted := false;
  end if;
  if a.generation is distinct from p_expected_generation or a.config_hash is distinct from p_expected_config_hash
     or a.head_hash is distinct from (auth->>'expectedHeadHash') then
    return jsonb_build_object('status', 'conflict', 'reason', 'active release changed');
  end if;
  lock table public.learning_guard in share mode;
  if a.halted or exists(select 1 from public.learning_guard where key = 'halt' and value->'halted' = 'true'::jsonb) then
    return jsonb_build_object('status', 'halted', 'reason', 'release activation is halted');
  end if;
  lock table public.site_database in share mode;
  if (auth->>'expiresAt')::timestamptz <= clock_timestamp() then
    return jsonb_build_object('status', 'invalid', 'reason', 'release authorization expired while waiting for storage locks');
  end if;
  if jsonb_typeof(p_release->'config'->'sites') is distinct from 'array' then raise exception 'invalid release sites'; end if;
  for site in select value from jsonb_array_elements(p_release->'config'->'sites') loop
    if (site->>'expires_at')::timestamptz <= clock_timestamp() or (site->>'verified_at')::timestamptz > clock_timestamp()
       or site->>'expires_at' is null or site->>'verified_at' is null then
      return jsonb_build_object('status', 'invalid', 'reason', 'release site is outside its verified lifetime');
    end if;
    if exists(select 1 from public.site_database where domain = site->>'domain' and is_static) then
      return jsonb_build_object('status', 'invalid', 'reason', 'release conflicts with a static site');
    end if;
  end loop;
  if p_canonical_event::jsonb is distinct from body
     or encode(sha256(convert_to(p_canonical_event, 'UTF8')), 'hex') is distinct from (p_event->>'hash')
     or body->>'environment' is distinct from p_environment
     or body->>'generation' is distinct from (a.generation + 1)::text
     or body->>'previousConfigHash' is distinct from a.config_hash
     or body->>'configHash' is distinct from config_hash_value
     or body->>'prevHash' is distinct from a.head_hash
     or body->>'authorizationId' is distinct from authorization_id_value
     or body->>'authorizationHash' is distinct from p_authorization_hash
     or body->>'v' is distinct from '2'
     or body->>'kind' is distinct from (case when auth->>'action' = 'rollback' then 'release-rolled-back' else 'release-activated' end)
     or p_event->>'signature' is null or p_event->>'publicKey' is null then
    raise exception 'invalid release event binding';
  end if;
  perform public.prepare_learning_release(p_release, p_canonical);
  -- An immutable insert can wait for a concurrent prepare in another environment.
  -- Raise here so even the prepared snapshot is rolled back with this attempt.
  if (auth->>'expiresAt')::timestamptz <= clock_timestamp() then
    raise exception 'release authorization expired before publication';
  end if;
  for site in select value from jsonb_array_elements(p_release->'config'->'sites') loop
    if (site->>'expires_at')::timestamptz <= clock_timestamp() then
      raise exception 'release site expired before publication';
    end if;
  end loop;
  next_active := jsonb_build_object('environment', p_environment, 'generation', a.generation + 1,
    'configHash', config_hash_value, 'headHash', p_event->>'hash', 'halted', false);
  outcome := jsonb_build_object('status', 'activated', 'active', next_active, 'configHash', config_hash_value, 'event', p_event);
  insert into public.learning_release_events(environment, generation, event_hash, event)
    values (p_environment, a.generation + 1, p_event->>'hash', p_event);
  insert into public.learning_release_consumptions(authorization_id, authorization_hash, environment, config_hash, result)
    values (authorization_id_value, p_authorization_hash, p_environment, config_hash_value, outcome);
  insert into public.learning_active_releases(environment, generation, config_hash, head_hash, halted)
    values (p_environment, a.generation + 1, config_hash_value, p_event->>'hash', false)
    on conflict (environment) do update set generation = excluded.generation, config_hash = excluded.config_hash,
      head_hash = excluded.head_hash, halted = excluded.halted;
  return outcome;
end;
$$;

CREATE FUNCTION tos_release_control.activate(p_envelope jsonb,p_envelope_canonical text,p_request jsonb,p_request_canonical text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,tos_release_control,pg_temp AS $$
DECLARE p jsonb:=p_envelope->'payload'; id text:=p->>'authorizationId'; env text:=p->'destination'->>'environment';
 r tos_release_control.registry%ROWTYPE; used tos_release_control.consumptions%ROWTYPE; active jsonb; result jsonb; a jsonb:=p_request->'authorization'; release jsonb:=p_request->'release'; e jsonb:=p_request->'event'; expected jsonb; expires timestamptz;
BEGIN
 PERFORM tos_release_control.assert_catalog();
 IF p_envelope_canonical IS NULL OR p_request_canonical IS NULL OR length(p_request_canonical)>8000000 OR length(p_envelope_canonical)>1000000 OR p_envelope_canonical::jsonb IS DISTINCT FROM p_envelope OR p_request_canonical::jsonb IS DISTINCT FROM p_request OR p_request->'controlEnvelope' IS DISTINCT FROM p_envelope OR coalesce(id,'')!~'^[A-Za-z0-9_-]{16,128}$' THEN RAISE EXCEPTION 'invalid request'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('tos.lab.authorization.'||id,0));
 SELECT * INTO used FROM tos_release_control.consumptions WHERE authorization_id=id;
 IF FOUND THEN
  IF used.envelope_canonical IS DISTINCT FROM p_envelope_canonical OR used.plan_canonical IS DISTINCT FROM p_request_canonical THEN RAISE EXCEPTION 'conflicting authorization reuse'; END IF;
  RETURN used.result || jsonb_build_object('status','already-applied');
 END IF;
 SELECT * INTO r FROM tos_release_control.registry WHERE environment=env FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'unknown registry'; END IF;
 SELECT jsonb_build_object('generation',generation,'configHash',config_hash,'headHash',head_hash,'halted',halted) INTO active FROM public.learning_active_releases WHERE environment=env FOR UPDATE;
 IF NOT FOUND OR r.state->'governanceEpoch' IS DISTINCT FROM '1'::jsonb OR active->'halted' IS DISTINCT FROM 'false'::jsonb OR (active->>'generation')::bigint<1 OR (r.state||active) IS DISTINCT FROM p->'expected' OR r.destination IS DISTINCT FROM p->'destination' OR r.plan->'hash' IS DISTINCT FROM p->'planHash' THEN RAISE EXCEPTION 'stale halted or unadopted state'; END IF;
 IF a->'payload'->>'action' IS DISTINCT FROM 'activate' THEN RAISE EXCEPTION 'application rollback requires separately reviewed current-standard recovery'; END IF;
 IF release->'configHash' IS DISTINCT FROM r.plan->'candidate'->'configHash' OR active->'configHash' IS DISTINCT FROM r.plan->'baseline'->'configHash' THEN RAISE EXCEPTION 'outside adopted release pair'; END IF;
 expected:=jsonb_build_object('v',1,'kind','maintenance-control','authorizationId',a->'payload'->'authorizationId','issuedAt',a->'payload'->'issuedAt','expiresAt',a->'payload'->'expiresAt','destination',r.destination,'expected',r.state||active,'planHash',r.plan->'hash','authorizationHash',p->'authorizationHash','releaseHash',p->'releaseHash','eventHash',e->'hash');
 IF expected IS DISTINCT FROM p OR p_request - ARRAY['controlEnvelope','authorization','release','event','canonicalAuthorization','canonicalRelease','canonicalEvent']<>'{}'::jsonb OR (p_request->>'canonicalAuthorization')::jsonb IS DISTINCT FROM a OR (p_request->>'canonicalRelease')::jsonb IS DISTINCT FROM jsonb_build_object('v',2,'config',release->'config') OR (p_request->>'canonicalEvent')::jsonb IS DISTINCT FROM e->'body' OR encode(sha256(convert_to(p_request->>'canonicalAuthorization','UTF8')),'hex') IS DISTINCT FROM p->>'authorizationHash' THEN RAISE EXCEPTION 'control binding mismatch'; END IF;
 expires:=(p->>'expiresAt')::timestamptz;
 IF expires IS NULL OR expires<=clock_timestamp() OR (p->>'issuedAt')::timestamptz>clock_timestamp() OR expires-(p->>'issuedAt')::timestamptz>interval '24 hours' THEN RAISE EXCEPTION 'invalid lifetime'; END IF;
 result:=tos_release_control.activate_validated(env,release,p_request->>'canonicalRelease',a,p->>'authorizationHash',p_request->>'canonicalAuthorization',(active->>'generation')::bigint,active->>'configHash',e,p_request->>'canonicalEvent');
 IF result->>'status' IS DISTINCT FROM 'activated' THEN RAISE EXCEPTION 'activation rejected: %',result->>'reason'; END IF;
 INSERT INTO tos_release_control.events VALUES(id,env,e->>'hash',jsonb_build_object('kind','maintenance-release-activated','event',e,'controlEnvelope',p_envelope));
 INSERT INTO tos_release_control.consumptions VALUES(id,p_envelope_canonical,p_request_canonical,result);
 IF expires<=clock_timestamp() THEN RAISE EXCEPTION 'expired during publication'; END IF;
 RETURN result;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA tos_release_control FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA tos_release_control FROM PUBLIC;
GRANT USAGE ON SCHEMA tos_release_control TO tos_release_controller;
GRANT EXECUTE ON FUNCTION tos_release_control.read_state(text),tos_release_control.read_committed(text,text,text),tos_release_control.adopt(jsonb,text,jsonb,text),tos_release_control.activate(jsonb,text,jsonb,text) TO tos_release_controller;
RESET ROLE;
INSERT INTO tos_release_control.catalog_pin VALUES(true,tos_release_control.measure_catalog());
COMMIT;
