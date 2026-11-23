-- Install repeatable owner-governed release plans on the archive-limit catalog.
BEGIN ISOLATION LEVEL REPEATABLE READ;
SET LOCAL search_path = pg_catalog, pg_temp;

DO $identity$
BEGIN
  IF current_setting('tos.expected_database', true) IS DISTINCT FROM current_database() THEN
    RAISE EXCEPTION 'missing or mismatched installer database pin';
  END IF;
  IF current_setting('tos.expected_installer_role', true) IS DISTINCT FROM session_user
     OR current_user IS DISTINCT FROM session_user THEN
    RAISE EXCEPTION 'missing or mismatched installer role pin';
  END IF;
  IF current_setting('tos.expected_server_version_num', true) IS DISTINCT FROM current_setting('server_version_num')
     OR current_setting('server_version_num')::int / 10000 <> 17 THEN
    RAISE EXCEPTION 'missing or mismatched supported server version pin';
  END IF;
END $identity$;

-- Check the reviewed inventory before any DDL. Keep the exact query in a
-- session-private view so later checks measure the same catalog under locks
-- and after the installer's temporary membership is removed.
DO $catalog$
DECLARE
  inventory_sql CONSTANT text := $inventory$select encode(sha256(convert_to(jsonb_build_object(
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
)::text,'UTF8')),'hex')$inventory$;
  measured text;
BEGIN
  EXECUTE inventory_sql INTO STRICT measured;
  IF current_setting('tos.reviewed_catalog_hash', true) IS DISTINCT FROM measured THEN
    RAISE EXCEPTION 'unreviewed catalog';
  END IF;
  EXECUTE 'CREATE TEMPORARY VIEW pg_temp.tos_installer_catalog (hash) WITH (security_invoker=true) AS ' || inventory_sql;
END $catalog$;

-- A managed installer has ADMIN on the owner role. Borrow ownership only
-- inside this transaction. A preexisting self-grant belongs to another
-- configuration and must never be removed by this migration.
DO $borrow_owner$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
    IF EXISTS (SELECT FROM pg_auth_members
               WHERE roleid = 'tos_release_owner'::regrole
                 AND member = session_user::regrole AND grantor = session_user::regrole) THEN
      RAISE EXCEPTION 'unexpected installer self-grant';
    END IF;
    GRANT tos_release_owner TO CURRENT_USER WITH INHERIT TRUE, SET TRUE GRANTED BY CURRENT_USER;
  END IF;
END $borrow_owner$;
-- Take locks in runtime order and retain them across the permission check.
LOCK TABLE tos_release_control.catalog_pin, tos_release_control.registry IN ACCESS EXCLUSIVE MODE;
DO $preflight$
DECLARE
  measured text;
  guards_passed boolean := false;
BEGIN
  BEGIN
    IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
      REVOKE tos_release_owner FROM CURRENT_USER GRANTED BY CURRENT_USER;
    END IF;
    SELECT hash INTO STRICT measured FROM pg_temp.tos_installer_catalog;
    IF current_setting('tos.reviewed_catalog_hash', true) IS DISTINCT FROM measured THEN
      RAISE EXCEPTION 'unreviewed catalog';
    END IF;
    IF (SELECT hash FROM tos_release_control.catalog_pin WHERE singleton) IS DISTINCT FROM measured THEN
      RAISE EXCEPTION 'installed catalog drift';
    END IF;
    -- Identify the two bodies installed by the archive-limit migration. Normalize
    -- line endings for installers that read checked-out SQL on Windows.
    IF (SELECT encode(sha256(convert_to(replace(prosrc, chr(13)||chr(10), chr(10)), 'UTF8')), 'hex')
        FROM pg_proc WHERE oid = to_regprocedure('tos_release_control.read_state(text)'))
        IS DISTINCT FROM 'e5e4a3d7e6aedbdb9faa252b8ac3efe3108e02c35a0d75cd52f6da33b3bd816a'
       OR (SELECT encode(sha256(convert_to(replace(prosrc, chr(13)||chr(10), chr(10)), 'UTF8')), 'hex')
           FROM pg_proc WHERE oid = to_regprocedure('tos_release_control.recover(jsonb,text,jsonb,text)'))
        IS DISTINCT FROM '02fa7bbeeb0c9dae1abee68d7ff703b82b2b2657d27f2d03daa5ededf5f1125a' THEN
      RAISE EXCEPTION 'build archive limit migration required';
    END IF;
    -- Restore the temporary membership only after every guard succeeds.
    guards_passed := true;
    RAISE SQLSTATE 'ZMF02' USING MESSAGE = 'locked installer checks passed';
  EXCEPTION WHEN SQLSTATE 'ZMF02' THEN
    IF NOT guards_passed THEN RAISE; END IF;
  END;
END $preflight$;

SET LOCAL ROLE tos_release_owner;

-- The predecessor's state-only CHECK has the automatically assigned name
-- registry_state_check. Validate all existing rows under the replacement.
ALTER TABLE tos_release_control.registry DROP CONSTRAINT registry_state_check;
ALTER TABLE tos_release_control.registry ADD CONSTRAINT registry_state_check
 CHECK(state ?& array['governanceEpoch','governanceRegistryId','governanceHeadHash','installedVerifierHash','installedMigrationManifestHash'] AND
       state - array['governanceEpoch','governanceRegistryId','governanceHeadHash','installedVerifierHash','installedMigrationManifestHash']='{}'::jsonb AND
       jsonb_typeof(state->'governanceEpoch')='number' AND
       (state->>'governanceEpoch') ~ '^(0|[1-9][0-9]{0,15})$' AND
       (state->>'governanceEpoch')::numeric <= 9007199254740991 AND
       jsonb_typeof(state->'governanceRegistryId')='string' AND jsonb_typeof(state->'governanceHeadHash')='string' AND
       jsonb_typeof(state->'installedVerifierHash')='string' AND jsonb_typeof(state->'installedMigrationManifestHash')='string' AND
       (state->>'governanceRegistryId') ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' AND
       (state->>'governanceHeadHash') ~ '^[a-f0-9]{64}$' AND
       (state->>'installedVerifierHash') ~ '^[a-f0-9]{64}$' AND
       (state->>'installedMigrationManifestHash') ~ '^[a-f0-9]{64}$');

CREATE FUNCTION tos_release_control.plan_standard(p_plan jsonb) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $standard$
  SELECT CASE
    WHEN p_plan->'v' = '1'::jsonb AND p_plan->>'toStandard' = 'maintenance-final/v1' THEN 'maintenance-final/v1'
    WHEN p_plan->'v' = '4'::jsonb AND p_plan->>'standard' IN ('maintenance-final/v1','maintenance-dependency/v1') THEN p_plan->>'standard'
  END
$standard$;

-- Both ledgers must identify the adopted candidate event. A recovered head
-- must extend that same candidate event. Generation and config alone cannot
-- establish that a particular plan published either release.
CREATE FUNCTION tos_release_control.publication_complete(
  p_environment text, p_state jsonb, p_plan jsonb, p_generation bigint, p_config_hash text, p_head_hash text
) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = pg_catalog, tos_release_control, pg_temp AS $complete$
  SELECT EXISTS (
    SELECT FROM public.learning_release_events activated
    JOIN tos_release_control.events ce ON ce.event_hash = activated.event_hash
    WHERE activated.environment = p_environment
      AND activated.generation = (p_plan#>>'{active,generation}')::bigint + 1
      AND ce.environment = p_environment
      AND ce.event->>'kind' = 'maintenance-release-activated'
      AND ce.event->'event' = activated.event
      AND ce.event#>'{controlEnvelope,payload,planHash}' = p_plan->'hash'
      AND ce.event#>'{controlEnvelope,payload,expected,governanceHeadHash}' = p_state->'governanceHeadHash'
      AND ce.event#>'{controlEnvelope,payload,expected,governanceEpoch}' = p_state->'governanceEpoch'
      AND activated.event->>'hash' = activated.event_hash
      AND activated.event#>'{body,prevHash}' = p_plan#>'{active,headHash}'
      AND activated.event#>'{body,previousConfigHash}' = p_plan#>'{baseline,configHash}'
      AND activated.event#>'{body,configHash}' = p_plan#>'{candidate,configHash}'
      AND activated.event#>'{body,generation}' = to_jsonb(activated.generation)
      AND (
        (p_generation = activated.generation AND p_head_hash = activated.event_hash
         AND p_config_hash = p_plan#>>'{candidate,configHash}')
        OR EXISTS (
          SELECT FROM public.learning_release_events recovered
          JOIN tos_release_control.events re ON re.event_hash = recovered.event_hash
          WHERE recovered.environment = p_environment AND re.environment = p_environment
            AND recovered.generation = activated.generation + 1 AND p_generation = recovered.generation
            AND p_head_hash = recovered.event_hash AND recovered.event->>'hash' = p_head_hash
            AND re.event->>'kind' = 'maintenance-release-recovered'
            AND re.event->'event' = recovered.event
            AND re.event#>'{controlEnvelope,payload,planHash}' = p_plan->'hash'
            AND re.event#>'{controlEnvelope,payload,expected,governanceHeadHash}' = p_state->'governanceHeadHash'
            AND re.event#>'{controlEnvelope,payload,expected,governanceEpoch}' = p_state->'governanceEpoch'
            AND recovered.event#>>'{body,prevHash}' = activated.event_hash
            AND recovered.event#>'{body,previousConfigHash}' = p_plan#>'{candidate,configHash}'
            AND recovered.event#>'{body,configHash}' = p_plan#>'{recovery,release,configHash}'
            AND recovered.event#>'{body,generation}' = to_jsonb(p_generation)
            AND p_config_hash = p_plan#>>'{recovery,release,configHash}'
        )
      )
  )
$complete$;

-- A missing, malformed or ambiguous archive cannot establish build continuity.
CREATE FUNCTION tos_release_control.release_build(p_manifest jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $build$
  SELECT CASE WHEN count(*) = 1 AND bool_and(
    jsonb_typeof(f->'sha256') = 'string' AND f->>'sha256' ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(f->'bytes') = 'number' AND f->>'bytes' ~ '^[1-9][0-9]{0,8}$'
    AND f->'bytes' <= '268435456'::jsonb
  ) THEN jsonb_build_object('path','artifacts/release-build','sha256',min(f->>'sha256'),'bytes',min(f->>'bytes')::bigint) END
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_manifest->'files') = 'array'
                                 THEN p_manifest->'files' ELSE '[]'::jsonb END) f
  WHERE f->>'path' = 'artifacts/release-build'
$build$;

-- The caller first proves publication against both ledgers, so generation
-- then selects the exact manifest for the candidate or its declared recovery.
CREATE FUNCTION tos_release_control.published_build(p_plan jsonb, p_generation bigint) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $published$
  SELECT tos_release_control.release_build(CASE p_generation - (p_plan#>>'{active,generation}')::bigint
    WHEN 1 THEN p_plan->'candidateManifest'
    WHEN 2 THEN p_plan#>'{recovery,manifest}'
  END)
$published$;

REVOKE ALL ON FUNCTION tos_release_control.plan_standard(jsonb),
  tos_release_control.release_build(jsonb), tos_release_control.published_build(jsonb,bigint),
  tos_release_control.publication_complete(text,jsonb,jsonb,bigint,text,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION tos_release_control.read_state(p_environment text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, tos_release_control, pg_temp AS $state$
DECLARE result jsonb;
BEGIN
  PERFORM tos_release_control.assert_catalog();
  SELECT jsonb_build_object(
    'governanceVersion',4, 'standard',tos_release_control.plan_standard(r.plan),
    'publicationComplete',publication.complete,
    'activeBuild',CASE WHEN publication.complete THEN tos_release_control.published_build(r.plan,a.generation) END,
    'recoveryVersion',1, 'buildArchiveMaxBytes',268435456, 'destination',r.destination, 'planHash',r.plan->'hash',
    'standardDocumentHash',r.plan->'standardDocumentHash',
    'active',r.state || jsonb_build_object('generation',a.generation,'configHash',a.config_hash,'headHash',a.head_hash,'halted',a.halted)
  ) INTO result
  FROM tos_release_control.registry r JOIN public.learning_active_releases a ON a.environment = r.environment
  CROSS JOIN LATERAL (SELECT tos_release_control.publication_complete(
    r.environment,r.state,r.plan,a.generation,a.config_hash,a.head_hash) AS complete) publication
  WHERE r.environment = p_environment;
  RETURN result;
END $state$;

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
 epoch bigint; next_epoch bigint; transition_fields jsonb; active_build jsonb;
 issued timestamptz; expires timestamptz;
BEGIN
 PERFORM tos_release_control.assert_catalog();
 IF p_envelope IS NULL OR p_plan IS NULL OR p_envelope_canonical IS NULL OR p_plan_canonical IS NULL OR
    length(p_envelope_canonical)>1000000 OR length(p_plan_canonical)>4000000 OR
    p_envelope_canonical IS NOT JSON OBJECT WITH UNIQUE KEYS OR p_plan_canonical IS NOT JSON OBJECT WITH UNIQUE KEYS OR
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
    active->'configHash' IS DISTINCT FROM p_plan#>'{baseline,configHash}' OR
    active->'halted' IS DISTINCT FROM 'false'::jsonb OR
    (active->>'generation')::bigint < 1
 THEN RAISE EXCEPTION 'stale or halted state'; END IF;
 epoch := (r.state->>'governanceEpoch')::bigint;
 next_epoch := epoch + 1;
 IF p_plan->>'kind' IS DISTINCT FROM 'governance-transition-plan'
    OR p_plan->'nextGovernanceEpoch' IS DISTINCT FROM to_jsonb(next_epoch)
    OR next_epoch > 9007199254740991
    OR (epoch = 0 AND r.plan IS NOT NULL)
    OR (epoch > 0 AND NOT tos_release_control.publication_complete(
      env,r.state,r.plan,(active->>'generation')::bigint,active->>'configHash',active->>'headHash')) THEN
   RAISE EXCEPTION 'invalid epoch or incomplete previous publication';
 END IF;
 IF (active->>'generation')::bigint > 9007199254740991 - (CASE WHEN p_plan ? 'recovery' THEN 2 ELSE 1 END) THEN
   RAISE EXCEPTION 'insufficient remaining safe release generations';
 END IF;
 IF epoch > 0 THEN
   active_build := tos_release_control.published_build(r.plan,(active->>'generation')::bigint);
   IF active_build IS NULL OR active_build IS DISTINCT FROM tos_release_control.release_build(p_plan->'baselineManifest') THEN
     RAISE EXCEPTION 'baseline build differs from previous publication';
   END IF;
 END IF;
 IF p_plan->'v' = '1'::jsonb AND epoch = 0
    AND p_plan->>'fromStandard' = 'step2-final/v2' AND p_plan->>'toStandard' = 'maintenance-final/v1'
    AND NOT (p_plan ?| ARRAY['fromGovernanceEpoch','standard']) THEN
   transition_fields := jsonb_build_object('v',3,'fromStandard',p_plan->'fromStandard','toStandard',p_plan->'toStandard');
 ELSIF p_plan->'v' = '4'::jsonb AND p_plan->'fromGovernanceEpoch' = to_jsonb(epoch)
    AND tos_release_control.plan_standard(p_plan) IS NOT NULL
    AND NOT (p_plan ?| ARRAY['fromStandard','toStandard'])
    AND (epoch = 0 OR (jsonb_typeof(p_plan#>'{recovery,release}') = 'object'
                        AND jsonb_typeof(p_plan#>'{recovery,manifest}') = 'object'
                        AND (p_plan#>>'{recovery,release,configHash}') ~ '^[a-f0-9]{64}$'
                        AND (p_plan#>>'{recovery,manifest,hash}') ~ '^[a-f0-9]{64}$')) THEN
   transition_fields := jsonb_build_object('v',4,'fromGovernanceEpoch',epoch,'standard',p_plan->'standard');
 ELSE
   RAISE EXCEPTION 'invalid governance standard or recovery declaration';
 END IF;
 expected_payload:=transition_fields || jsonb_build_object('kind','governance-transition','action','adopt-maintenance-standard',
   'authorizationId',id,'issuedAt',p->'issuedAt','expiresAt',p->'expiresAt','planHash',p_plan->'hash',
   'destination',p_plan->'destination','expected',p_plan->'active','nextGovernanceEpoch',next_epoch,
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
   'planHash',p_plan->'hash','previousGovernanceHead',r.state->'governanceHeadHash','epoch',next_epoch);
 event_hash:=encode(sha256(convert_to(event_body::text,'UTF8')),'hex');
 result:=jsonb_build_object('status','adopted','epoch',next_epoch,'head',event_hash);
 INSERT INTO tos_release_control.events VALUES(id,env,event_hash,event_body);
 INSERT INTO tos_release_control.consumptions VALUES(id,p_envelope_canonical,p_plan_canonical,result);
 -- Recheck after possible constraint/index/trigger waits. Error rolls back preceding inserts.
 IF expires<=clock_timestamp() THEN RAISE EXCEPTION 'expired before publication'; END IF;
 UPDATE tos_release_control.registry SET state=state || jsonb_build_object('governanceEpoch',next_epoch,'governanceHeadHash',event_hash,'installedVerifierHash',p_plan->'verifierHash','installedMigrationManifestHash',p_plan->'migrationManifest'->'hash'), plan=p_plan
 WHERE environment=env;
 IF expires<=clock_timestamp() THEN RAISE EXCEPTION 'expired during publication'; END IF;
 RETURN result;
END $$;

create or replace function tos_release_control.activate_validated(
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
  if evidence->>'phase' is null or evidence->>'phase' is distinct from (
       select split_part(tos_release_control.plan_standard(r.plan),'/',1)
       from tos_release_control.registry r where r.environment = p_environment
     ) or evidence->>'configHash' is distinct from config_hash_value
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

CREATE OR REPLACE FUNCTION tos_release_control.activate(p_envelope jsonb,p_envelope_canonical text,p_request jsonb,p_request_canonical text)
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
 IF NOT FOUND OR r.plan IS NULL OR r.state->'governanceEpoch' IS DISTINCT FROM r.plan->'nextGovernanceEpoch' OR active->'halted' IS DISTINCT FROM 'false'::jsonb OR (active->>'generation')::bigint<1 OR (r.state||active) IS DISTINCT FROM p->'expected' OR r.destination IS DISTINCT FROM p->'destination' OR r.plan->'hash' IS DISTINCT FROM p->'planHash' THEN RAISE EXCEPTION 'stale halted or unadopted state'; END IF;
 IF a->'payload'->>'action' IS DISTINCT FROM 'activate' THEN RAISE EXCEPTION 'application rollback requires separately reviewed current-standard recovery'; END IF;
 IF tos_release_control.plan_standard(r.plan) IS NULL
    OR a#>>'{payload,evidence,phase}' IS DISTINCT FROM split_part(tos_release_control.plan_standard(r.plan),'/',1)
 THEN RAISE EXCEPTION 'evidence phase differs from the adopted standard'; END IF;
 IF active->'generation' IS DISTINCT FROM r.plan#>'{active,generation}'
    OR active->'headHash' IS DISTINCT FROM r.plan#>'{active,headHash}'
    OR release IS DISTINCT FROM r.plan->'candidate'
 THEN RAISE EXCEPTION 'outside adopted candidate activation'; END IF;
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

CREATE OR REPLACE FUNCTION tos_release_control.recover(
  p_envelope jsonb, p_envelope_canonical text, p_request jsonb, p_request_canonical text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, tos_release_control, pg_temp AS $recover$
DECLARE
  p jsonb := p_envelope->'payload';
  id text := p->>'authorizationId';
  env text := p#>>'{destination,environment}';
  release_authorization jsonb := p_request->'authorization';
  auth jsonb := release_authorization->'payload';
  release jsonb := p_request->'release';
  audit_event jsonb := p_request->'event';
  body jsonb := audit_event->'body';
  canonical_auth text := p_request->>'canonicalAuthorization';
  canonical_config text := p_request->>'canonicalRelease';
  canonical_event text := p_request->>'canonicalEvent';
  r tos_release_control.registry%ROWTYPE;
  used tos_release_control.consumptions%ROWTYPE;
  active jsonb;
  candidate jsonb;
  manifest jsonb;
  expected_payload jsonb;
  issued timestamptz;
  expires timestamptz;
  result jsonb;
BEGIN
  PERFORM tos_release_control.assert_catalog();
  IF p_envelope_canonical IS NULL OR length(p_envelope_canonical) > 1000000
     OR p_request_canonical IS NULL OR length(p_request_canonical) > 8000000
     OR p_envelope_canonical IS NOT JSON OBJECT WITH UNIQUE KEYS
     OR p_request_canonical IS NOT JSON OBJECT WITH UNIQUE KEYS
     OR p_envelope_canonical::jsonb IS DISTINCT FROM p_envelope
     OR p_request_canonical::jsonb IS DISTINCT FROM p_request
     OR p_request->'controlEnvelope' IS DISTINCT FROM p_envelope
     OR p_request - ARRAY['controlEnvelope','authorization','release','event','canonicalAuthorization','canonicalRelease','canonicalEvent'] <> '{}'::jsonb
     OR p_envelope - ARRAY['payload','signature'] <> '{}'::jsonb
     OR jsonb_typeof(p_envelope->'signature') IS DISTINCT FROM 'string'
     OR p_envelope->>'signature' !~ '^[A-Za-z0-9+/]{86}==$'
     OR p->>'kind' IS DISTINCT FROM 'maintenance-recovery' OR p->'v' IS DISTINCT FROM '1'::jsonb
     OR jsonb_typeof(p->'authorizationId') IS DISTINCT FROM 'string'
     OR coalesce(id, '') !~ '^[A-Za-z0-9_-]{16,128}$'
     OR coalesce(env, '') !~ '^[a-z][a-z0-9-]{0,63}$' THEN
    RAISE EXCEPTION 'invalid bounded recovery request';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('tos.lab.authorization.' || id, 0));
  SELECT * INTO used FROM tos_release_control.consumptions WHERE authorization_id = id;
  IF FOUND THEN
    IF used.envelope_canonical IS DISTINCT FROM p_envelope_canonical
       OR used.plan_canonical IS DISTINCT FROM p_request_canonical
       OR used.result->>'status' IS DISTINCT FROM 'recovered' THEN
      RAISE EXCEPTION 'conflicting authorization reuse';
    END IF;
    RETURN used.result || jsonb_build_object('status','already-applied');
  END IF;

  SELECT * INTO r FROM tos_release_control.registry WHERE environment = env FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown governance registry'; END IF;
  SELECT jsonb_build_object('generation',generation,'configHash',config_hash,'headHash',head_hash,'halted',halted)
    INTO active FROM public.learning_active_releases WHERE environment = env FOR UPDATE;
  IF NOT FOUND OR r.plan IS NULL OR r.state->'governanceEpoch' IS DISTINCT FROM r.plan->'nextGovernanceEpoch'
     OR active->'halted' IS DISTINCT FROM 'false'::jsonb
     OR (r.state || active) IS DISTINCT FROM p->'expected'
     OR r.destination IS DISTINCT FROM p->'destination' OR r.destination IS DISTINCT FROM r.plan->'destination'
     OR r.plan->'hash' IS DISTINCT FROM p->'planHash'
     OR r.state->'installedVerifierHash' IS DISTINCT FROM r.plan->'verifierHash'
     OR r.state->'installedMigrationManifestHash' IS DISTINCT FROM r.plan#>'{migrationManifest,hash}' THEN
    RAISE EXCEPTION 'stale, halted or unadopted recovery state';
  END IF;

  candidate := r.plan->'candidate';
  manifest := r.plan#>'{recovery,manifest}';
  IF jsonb_typeof(r.plan#>'{active,generation}') IS DISTINCT FROM 'number'
     OR (active->>'generation')::bigint IS DISTINCT FROM (r.plan#>>'{active,generation}')::bigint + 1
     OR active->'configHash' IS DISTINCT FROM candidate->'configHash'
     OR NOT tos_release_control.publication_complete(env,r.state,r.plan,(active->>'generation')::bigint,
                                                    active->>'configHash',active->>'headHash') THEN
    RAISE EXCEPTION 'recovery requires the adopted candidate activation';
  END IF;
  IF jsonb_typeof(release) IS DISTINCT FROM 'object' OR release IS DISTINCT FROM r.plan#>'{recovery,release}'
     OR release - ARRAY['v','config','configHash'] <> '{}'::jsonb OR release->'v' IS DISTINCT FROM '2'::jsonb
     OR release->'configHash' IN (candidate->'configHash', r.plan#>'{baseline,configHash}')
     OR jsonb_typeof(release->'configHash') IS DISTINCT FROM 'string'
     OR coalesce(release->>'configHash', '') !~ '^[a-f0-9]{64}$'
     OR jsonb_typeof(release#>'{config,policy,versions,serverPipeline}') IS DISTINCT FROM 'string'
     OR coalesce(release#>>'{config,policy,versions,serverPipeline}', '') !~ '^[a-f0-9]{64}$'
     OR release#>'{config,policy,versions,serverPipeline}' IS NOT DISTINCT FROM candidate#>'{config,policy,versions,serverPipeline}'
     OR (release->'config' #- '{policy,versions,serverPipeline}') IS DISTINCT FROM (candidate->'config' #- '{policy,versions,serverPipeline}')
     OR release#>>'{config,policy,cache,shared}' IS DISTINCT FROM 'disabled'
     OR release#>'{config,policy,versions,migrationManifest}' IS DISTINCT FROM r.state->'installedMigrationManifestHash'
     OR jsonb_typeof(manifest->'hash') IS DISTINCT FROM 'string'
     OR coalesce(manifest->>'hash', '') !~ '^[a-f0-9]{64}$'
     OR jsonb_typeof(manifest->'files') IS DISTINCT FROM 'array'
     OR NOT EXISTS (SELECT FROM jsonb_array_elements(manifest->'files') f
                    WHERE f->>'path' = 'artifacts/release-build' AND jsonb_typeof(f->'bytes') = 'number'
                    AND (f->>'bytes')::bigint BETWEEN 1 AND 268435456
                    AND jsonb_typeof(f->'sha256') = 'string' AND f->>'sha256' ~ '^[a-f0-9]{64}$'
                    AND f->>'sha256' <> (SELECT cf->>'sha256' FROM jsonb_array_elements(r.plan#>'{candidateManifest,files}') cf
                                          WHERE cf->>'path' = 'artifacts/release-build')) THEN
    RAISE EXCEPTION 'outside adopted recovery release or policy scope';
  END IF;

  -- The json (rather than jsonb) accessor retains the exact canonical release
  -- bytes signed by the owner. canonicalRelease separately hashes just {config,v}.
  expected_payload := jsonb_build_object(
    'v',1, 'kind','maintenance-recovery', 'authorizationId',auth->'authorizationId',
    'issuedAt',auth->'issuedAt', 'expiresAt',auth->'expiresAt', 'destination',r.destination,
    'expected',r.state || active, 'planHash',r.plan->'hash',
    'authorizationHash',encode(sha256(convert_to(canonical_auth,'UTF8')),'hex'),
    'releaseHash',encode(sha256(convert_to((p_request_canonical::json->'release')::text,'UTF8')),'hex'),
    'eventHash',audit_event->'hash'
  );
  IF expected_payload IS DISTINCT FROM p
     OR jsonb_typeof(p_request->'canonicalAuthorization') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_request->'canonicalRelease') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_request->'canonicalEvent') IS DISTINCT FROM 'string'
     OR canonical_auth::jsonb IS DISTINCT FROM release_authorization
     OR canonical_config::jsonb IS DISTINCT FROM jsonb_build_object('config',release->'config','v',2)
     OR canonical_event::jsonb IS DISTINCT FROM body
     OR release_authorization - ARRAY['payload','signature'] <> '{}'::jsonb
     OR auth - ARRAY['v','kind','action','authorizationId','environment','configHash','expectedGeneration',
                     'expectedConfigHash','expectedHeadHash','issuedAt','expiresAt','evidence'] <> '{}'::jsonb
     OR auth->'v' IS DISTINCT FROM '2'::jsonb OR auth->>'action' IS DISTINCT FROM 'activate'
     OR auth->'expectedGeneration' IS DISTINCT FROM active->'generation'
     OR auth->'configHash' IS DISTINCT FROM release->'configHash'
     OR auth->'expectedConfigHash' IS DISTINCT FROM active->'configHash'
     OR auth->'expectedHeadHash' IS DISTINCT FROM active->'headHash'
     OR tos_release_control.plan_standard(r.plan) IS NULL
     OR auth#>>'{evidence,phase}' IS DISTINCT FROM split_part(tos_release_control.plan_standard(r.plan),'/',1)
     OR auth#>'{evidence,configHash}' IS DISTINCT FROM release->'configHash'
     OR jsonb_typeof(auth#>'{evidence,evidenceHash}') IS DISTINCT FROM 'string'
     OR jsonb_typeof(auth#>'{evidence,protocolHash}') IS DISTINCT FROM 'string'
     OR jsonb_typeof(auth#>'{evidence,corpusHash}') IS DISTINCT FROM 'string'
     OR (auth->'evidence') - ARRAY['phase','configHash','evidenceHash','protocolHash','corpusHash',
                                   'evaluationPassed','promotionEligible','diagnosticOnly'] <> '{}'::jsonb
     OR jsonb_typeof(release_authorization->'signature') IS DISTINCT FROM 'string'
     OR release_authorization->>'signature' !~ '^[A-Za-z0-9+/]{86}==$'
     OR body->'v' IS DISTINCT FROM '2'::jsonb OR body->>'kind' IS DISTINCT FROM 'release-activated'
     OR body->'generation' IS DISTINCT FROM to_jsonb((active->>'generation')::bigint + 1)
     OR body->'configHash' IS DISTINCT FROM release->'configHash'
     OR body->'previousConfigHash' IS DISTINCT FROM active->'configHash'
     OR body->'prevHash' IS DISTINCT FROM active->'headHash'
     OR body->'authorizationId' IS DISTINCT FROM p->'authorizationId'
     OR body->'authorizationHash' IS DISTINCT FROM p->'authorizationHash'
     OR jsonb_typeof(audit_event->'hash') IS DISTINCT FROM 'string'
     OR jsonb_typeof(body->'createdAt') IS DISTINCT FROM 'string' OR NOT isfinite((body->>'createdAt')::timestamptz)
     OR jsonb_typeof(audit_event->'publicKey') IS DISTINCT FROM 'string' OR audit_event->>'publicKey' = ''
     OR jsonb_typeof(audit_event->'signature') IS DISTINCT FROM 'string'
     OR audit_event->>'signature' !~ '^[A-Za-z0-9+/]{86}==$' THEN
    RAISE EXCEPTION 'recovery control binding mismatch';
  END IF;
  issued := (p->>'issuedAt')::timestamptz;
  expires := (p->>'expiresAt')::timestamptz;
  IF jsonb_typeof(p->'issuedAt') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'expiresAt') IS DISTINCT FROM 'string'
     OR NOT isfinite(issued) OR NOT isfinite(expires) OR issued > clock_timestamp() OR expires <= clock_timestamp()
     OR expires <= issued OR expires - issued > interval '24 hours' THEN
    RAISE EXCEPTION 'expired or invalid recovery lifetime';
  END IF;

  result := tos_release_control.activate_validated(env,release,canonical_config,release_authorization,p->>'authorizationHash',
    canonical_auth,(active->>'generation')::bigint,active->>'configHash',audit_event,canonical_event);
  IF result->>'status' IS DISTINCT FROM 'activated' THEN
    RAISE EXCEPTION 'recovery rejected: %', result->>'reason';
  END IF;
  result := result || jsonb_build_object('status','recovered');
  INSERT INTO tos_release_control.events VALUES (
    id,env,audit_event->>'hash',jsonb_build_object('kind','maintenance-release-recovered','event',audit_event,'controlEnvelope',p_envelope)
  );
  INSERT INTO tos_release_control.consumptions VALUES (id,p_envelope_canonical,p_request_canonical,result);
  IF expires <= clock_timestamp() THEN RAISE EXCEPTION 'expired during recovery publication'; END IF;
  RETURN result;
END $recover$;

RESET ROLE;
-- The catalog includes role memberships. Measure the final privilege state
-- in a subtransaction, restore ownership long enough to write the pin, then
-- remove the grant for good and verify the stored and actual hashes together.
DO $finalize_pin$
DECLARE
  managed boolean := NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user);
  final_hash text;
BEGIN
  IF managed THEN
    BEGIN
      REVOKE tos_release_owner FROM CURRENT_USER GRANTED BY CURRENT_USER;
      SELECT hash INTO STRICT final_hash FROM pg_temp.tos_installer_catalog;
      RAISE SQLSTATE 'ZMF01' USING MESSAGE = 'restore temporary installer membership';
    EXCEPTION WHEN SQLSTATE 'ZMF01' THEN
      NULL; -- The transaction state rolls back. The local variable retains the measurement.
    END;
  ELSE
    SELECT hash INTO STRICT final_hash FROM pg_temp.tos_installer_catalog;
  END IF;
  IF final_hash IS NULL OR final_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid final catalog measurement';
  END IF;

  SET LOCAL ROLE tos_release_owner;
  UPDATE tos_release_control.catalog_pin SET hash = final_hash WHERE singleton;
  RESET ROLE;
  IF managed THEN
    REVOKE tos_release_owner FROM CURRENT_USER GRANTED BY CURRENT_USER;
  END IF;
  IF (SELECT hash FROM pg_temp.tos_installer_catalog) IS DISTINCT FROM final_hash OR
     (SELECT hash FROM tos_release_control.catalog_pin WHERE singleton) IS DISTINCT FROM final_hash THEN
    RAISE EXCEPTION 'installed catalog drift';
  END IF;
END $finalize_pin$;
DROP VIEW pg_temp.tos_installer_catalog;
COMMIT;
