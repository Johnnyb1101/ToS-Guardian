-- Raise the full build archive limit to 256 MiB before governance adoption.
BEGIN;
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

-- Runtime RPCs read the catalog pin before locking the registry.
LOCK TABLE tos_release_control.catalog_pin, tos_release_control.registry IN ACCESS EXCLUSIVE MODE;
DO $preflight$
DECLARE measured text;
BEGIN
  -- Measure with the checked-in catalog query before trusting installed functions.
  SELECT encode(sha256(convert_to(jsonb_build_object(
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
)::text,'UTF8')),'hex') INTO measured;
  IF current_setting('tos.reviewed_catalog_hash', true) IS DISTINCT FROM measured THEN
    RAISE EXCEPTION 'unreviewed catalog';
  END IF;
  IF (SELECT hash FROM tos_release_control.catalog_pin WHERE singleton) IS DISTINCT FROM measured THEN
    RAISE EXCEPTION 'installed catalog drift';
  END IF;
  IF EXISTS (SELECT FROM tos_release_control.registry
             WHERE plan IS NOT NULL OR state->'governanceEpoch' IS DISTINCT FROM '0'::jsonb) THEN
    RAISE EXCEPTION 'build archive limit must be installed before adoption';
  END IF;
  IF to_regprocedure('tos_release_control.recover(jsonb,text,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION 'maintenance recovery must be installed before the build archive limit';
  END IF;
END $preflight$;

SET LOCAL ROLE tos_release_owner;

-- Report the new limit in the same transaction that installs and pins it.
CREATE OR REPLACE FUNCTION tos_release_control.read_state(p_environment text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, tos_release_control, pg_temp AS $state$
DECLARE result jsonb;
BEGIN
  PERFORM tos_release_control.assert_catalog();
  SELECT jsonb_build_object(
    'recoveryVersion',1, 'buildArchiveMaxBytes',268435456, 'destination',r.destination, 'planHash',r.plan->'hash',
    'standardDocumentHash',r.plan->'standardDocumentHash',
    'active',r.state || jsonb_build_object('generation',a.generation,'configHash',a.config_hash,'headHash',a.head_hash,'halted',a.halted)
  ) INTO result
  FROM tos_release_control.registry r JOIN public.learning_active_releases a ON a.environment = r.environment
  WHERE r.environment = p_environment;
  RETURN result;
END $state$;

-- Replacing these overloads preserves their owners and existing grants.
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
  IF NOT FOUND OR r.state->'governanceEpoch' IS DISTINCT FROM '1'::jsonb
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
     OR NOT EXISTS (
       SELECT FROM tos_release_control.events ce WHERE ce.environment = env AND ce.event_hash = active->>'headHash'
       AND ce.event->>'kind' = 'maintenance-release-activated'
       AND ce.event#>'{controlEnvelope,payload,planHash}' = r.plan->'hash'
       AND ce.event#>'{event,body,prevHash}' = r.plan#>'{active,headHash}'
       AND ce.event#>'{event,body,previousConfigHash}' = r.plan#>'{baseline,configHash}'
       AND ce.event#>'{event,body,configHash}' = active->'configHash'
       AND ce.event#>'{event,body,generation}' = active->'generation'
     ) THEN
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
     OR auth#>>'{evidence,phase}' IS DISTINCT FROM 'maintenance-final'
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

UPDATE tos_release_control.catalog_pin SET hash = tos_release_control.measure_catalog() WHERE singleton;
RESET ROLE;
COMMIT;
