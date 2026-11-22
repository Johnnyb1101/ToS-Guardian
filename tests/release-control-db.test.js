'use strict';
// Explicit localhost fixture only. Requires existing PG17 and OpenSSL binaries.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),net=require('node:net');
const {spawnSync,spawn}=require('node:child_process');
const C=require('../tools/final-corpus-lib'),G=require('../tools/governance-transition'),S=require('../tools/sites-lib');
const {createController,PURPOSE,RECOVERY_PURPOSE,EVENT_PURPOSE}=require('../release-control/controller');
const {createTransport}=require('../release-control/transport');
const {makeRelease}=require('./final-test-fixtures');
const args=process.argv.slice(2);
const preflightOnly=args.includes('--preflight-only');
const managedInstaller=args.includes('--managed-installer');
const ensureRlsArgs=args.filter(arg=>arg.startsWith('--ensure-rls-file='));
const ensureRlsFile=ensureRlsArgs[0]?.slice('--ensure-rls-file='.length);
const flags=new Set(['--preflight-only','--managed-installer']);
const [pgBin,scratchPath,proxy,openssl,artifactArgument,supabaseCli,...extra]=args.filter(arg=>!flags.has(arg)&&!ensureRlsArgs.includes(arg));
const artifactDirectory=artifactArgument && artifactArgument!=='-'?artifactArgument:null;
const requiredPaths=[pgBin,scratchPath,proxy,openssl];
if(extra.length||!requiredPaths.every(p=>p&&path.isAbsolute(p)) || (artifactDirectory&&!path.isAbsolute(artifactDirectory)) || (supabaseCli&&!path.isAbsolute(supabaseCli)))throw Error('Explicit absolute PG bin, scratch, proxy and OpenSSL paths required; optional paths must also be absolute');
if(ensureRlsArgs.length && (ensureRlsArgs.length!==1 || !managedInstaller || !ensureRlsFile || !path.isAbsolute(ensureRlsFile)))throw Error('The ensure_rls fixture requires one absolute path and managed-installer mode');
if(!['win32','linux'].includes(process.platform))throw Error('This test harness supports Windows and Linux only');
const linux=process.platform==='linux';
if(linux&&process.getuid()===0)throw Error('Run the PostgreSQL rehearsal as a non-root user');
fs.mkdirSync(scratchPath,{recursive:true});
const scratch=fs.realpathSync(scratchPath);
const dir=fs.mkdtempSync(path.join(scratch,'controller-db-')),data=path.join(dir,'data');
if(linux&&(fs.statSync(dir).mode&0o077)!==0)throw Error('Linux rehearsal requires private native filesystem storage');
const bin=n=>path.join(pgBin,linux?n:n+'.exe');
const appRoles=['anon','authenticated','service_role','runtime_app'];
const controllerRole='tos_release_controller';
const installer='postgres';
const admin=managedInstaller?'fixture_bootstrap_admin':installer;
const passwords=Object.fromEntries([...new Set([admin,installer,...appRoles,controllerRole,'authenticator'])].map(role=>[role,crypto.randomBytes(32).toString('base64url')]));
const redact=text=>Object.values(passwords).reduce((s,pw)=>s.replaceAll(pw,'[EPHEMERAL-REDACTED]'),String(text||''));
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/^PG/i.test(k)));
if(linux)env.LC_ALL='C';
Object.assign(env,{PGUSER:admin,PGPASSWORD:passwords[admin],PGDATABASE:'postgres',PGHOST:'127.0.0.1',PGCONNECT_TIMEOUT:'5',PGSSLMODE:'verify-full',PGSSLROOTCERT:path.join(dir,'server.crt'),PGGSSENCMODE:'disable',PGSSLCERTMODE:'disable',PGCLIENTENCODING:'UTF8',PGOPTIONS:'-c tos.isolated_rehearsal=yes -c statement_timeout=15000 -c lock_timeout=10000'});
function run(exe,args,options={}) {const r=spawnSync(exe,args,{env,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:32000000,...options});if(r.error)throw r.error;return r;}
function pass(r,label){assert.equal(r.status,0,redact(label+': '+r.stderr));return String(r.stdout||'').trim();}
const quote=x=>"'"+String(x).replace(/'/g,"''")+"'",json=x=>quote(C.canonicalJson(x))+'::jsonb';
function sql(q,{user=admin,fail=false,db='tos_governance_lab',pw=passwords[user],checkWarnings=false,continueOnError=false}={}) {
  const file=path.join(dir,'query-'+crypto.randomUUID()+'.sql');
  fs.writeFileSync(file,q,{mode:0o600});
  let result;
  try {
    const errorMode=continueOnError?'ON_ERROR_STOP=0':'ON_ERROR_STOP=1';
    result=run(bin('psql'),['-X','-w','-q','-A','-t','-v',errorMode,'-d',db,'-f',file],{env:{...env,PGUSER:user,PGPASSWORD:pw}});
  } finally { fs.unlinkSync(file); }
  if(fail){
    assert.notEqual(result.status,0,'unexpected SQL success: '+redact(q));
    return redact(result.stderr);
  }
  if(checkWarnings)assert.doesNotMatch(redact(result.stderr),/WARNING:.*(?:no privileges|not all privileges)/i);
  const output=pass(result,redact(q).slice(0,70));
  return continueOnError?redact(result.stderr):output;
}
const install=(q,options)=>sql(q,{...options,user:installer,checkWarnings:managedInstaller});
function asyncSql(q,user=controllerRole){return new Promise((resolve,reject)=>{const p=spawn(bin('psql'),['-X','-w','-q','-A','-t','-v','ON_ERROR_STOP=1','-d','tos_governance_lab'],{env:{...env,PGUSER:user,PGPASSWORD:passwords[user]},windowsHide:true});let out='',err='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x);p.on('error',reject);p.on('close',code=>code?reject(Error(redact(err))):resolve(out.trim()));p.stdin.end(q);});}
async function availablePort(){const s=net.createServer();await new Promise((r,j)=>s.once('error',j).listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port;}
let attemptedStart=false,port,passed=0;
function ok(label){passed++;console.log('PASS '+label);}
(async()=>{try{
  for(const name of ['postgres','psql','initdb','pg_ctl'])assert.match(pass(run(bin(name),['--version']),name),/\b17\.11(?:\s|$)/);
  pass(run(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-keyout',path.join(dir,'server.key'),'-out',path.join(dir,'server.crt'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1']), 'ephemeral certificate');
  if(linux){
    fs.chmodSync(path.join(dir,'server.key'),0o600);
    assert.equal(fs.statSync(path.join(dir,'server.key')).mode&0o077,0);
  }
  const pwfile=path.join(dir,'pwfile');fs.writeFileSync(pwfile,passwords[admin]+'\n',{mode:0o600});
  try{pass(run(bin('initdb'),['-D',data,'-U',admin,'--auth-local=scram-sha-256','--auth-host=scram-sha-256','--pwfile='+pwfile,'--no-locale','--encoding=UTF8']),'initdb');}finally{fs.unlinkSync(pwfile);}
  fs.writeFileSync(path.join(data,'TOS_DISPOSABLE_REHEARSAL'),'governance-control-v1');
  fs.appendFileSync(path.join(data,'postgresql.conf'),"\nssl=on\nssl_cert_file='../server.crt'\nssl_key_file='../server.key'\nunix_socket_directories=''\n");
  port=await availablePort();env.PGPORT=String(port);
  const log=fs.openSync(path.join(dir,'startup.log'),'w');
  try{attemptedStart=true;pass(run(bin('pg_ctl'),['-D',data,'-l',path.join(dir,'postgres.log'),'-o',`-h 127.0.0.1 -p ${port}`,'-w','-t','20','start'],{stdio:['ignore',log,log]}),'start');}finally{fs.closeSync(log);}
  assert.equal(fs.readFileSync(path.join(data,'TOS_DISPOSABLE_REHEARSAL'),'utf8'),'governance-control-v1');
  const identity=JSON.parse(sql("select json_build_object('data',current_setting('data_directory'),'version',current_setting('server_version_num'),'host',host(inet_server_addr()),'port',inet_server_port(),'ssl',(select ssl from pg_stat_ssl where pid=pg_backend_pid()));",{db:'postgres'}));
  assert.equal(fs.realpathSync(identity.data),fs.realpathSync(data));assert.equal(identity.version,'170011');assert.equal(identity.host,'127.0.0.1');assert.equal(identity.port,port);assert.equal(identity.ssl,true);
  if(managedInstaller)sql(`create role postgres login inherit createrole createdb nosuperuser bypassrls password ${quote(passwords[installer])};`,{db:'postgres'});
  sql('create database tos_governance_lab owner postgres;',{db:'postgres'});
  for(const role of appRoles)sql(`create role ${role} login${role==='service_role'?' bypassrls':''} password ${quote(passwords[role])};`);
  if(managedInstaller){
    // The independent API role logins exist only for the denial matrix.
    sql(`create role authenticator login noinherit password ${quote(passwords.authenticator)};
create role supabase_privileged_role nologin;
grant anon,authenticated,service_role to authenticator with inherit false,set true;
grant anon,authenticated,authenticator,service_role,pg_create_subscription,pg_monitor,pg_read_all_data,pg_signal_backend to postgres with admin true,inherit true,set true;
grant supabase_privileged_role to postgres with admin false,inherit true,set true;`);
    assert.equal(install(`select concat_ws('|',session_user,current_user,rolsuper,rolcreaterole,rolcreatedb,rolbypassrls,rolinherit,current_setting('createrole_self_grant'))
from pg_roles where rolname=current_user;`),'postgres|postgres|f|t|t|t|t|');
    assert.equal(install("select pg_get_userbyid(nspowner) from pg_namespace where nspname='public'"),'pg_database_owner');
    assert.equal(install("select count(*) from pg_namespace n cross join lateral aclexplode(n.nspacl) a where n.nspname='public' and a.grantee=0 and a.privilege_type='CREATE'"),'0');
    assert.equal(install("select count(*) from pg_auth_members where member=current_user::regrole and set_option and inherit_option"),'9');
    ok('managed PostgreSQL installer has observed memberships and no superuser or automatic owner access');
  }
  install('create table public.analyses(id int,domain text,created_at timestamptz);create table public.learning_guard(key text,value jsonb);create table public.site_database(domain text,is_static boolean);');
  if(ensureRlsFile){
    const saved=fs.readFileSync(ensureRlsFile,'utf8').replace(/\r\n/g,'\n');
    const triggerHash='dd9ce3fd3905d621611cf0ea2e7591bada6d61f827445cfa2afe27e69b03f271';
    assert.equal(C.hashText(saved),triggerHash,'Saved production ensure_rls function changed');
    install(saved);
    // PostgreSQL itself requires a superuser session to create an event trigger.
    sql("BEGIN; ALTER ROLE postgres SUPERUSER; SET LOCAL ROLE postgres; CREATE EVENT TRIGGER ensure_rls ON ddl_command_end WHEN TAG IN ('CREATE TABLE','CREATE TABLE AS','SELECT INTO') EXECUTE FUNCTION public.rls_auto_enable(); RESET ROLE; ALTER ROLE postgres NOSUPERUSER; COMMIT;");
    assert.equal(sql("select (not rolsuper)::text from pg_roles where rolname='postgres'"),'true');
    const actualTrigger=JSON.parse(sql("select jsonb_build_object('enabled',t.evtenabled,'event',t.evtevent,'tags',t.evttags,'owner',pg_get_userbyid(t.evtowner),'functionOwner',pg_get_userbyid(p.proowner),'digest',encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')) from pg_event_trigger t join pg_proc p on p.oid=t.evtfoid where t.evtname='ensure_rls'"));
    assert.deepEqual(actualTrigger,{enabled:'O',event:'ddl_command_end',tags:['CREATE TABLE','CREATE TABLE AS','SELECT INTO'],owner:'postgres',functionOwner:'postgres',digest:triggerHash});
    ok('saved production ensure_rls trigger verified with a nonsuperuser managed installer');
  }
  install(fs.readFileSync(path.join(proxy,'migrations/0006_release_activation.sql'),'utf8'));
  install(fs.readFileSync(path.join(proxy,'migrations/20261030040050_baseline_bootstrap.sql'),'utf8'));
  // Seed the actual legacy direct-write and halt routes before installing the fence.
  sql("select public.set_learning_release_halt('positive',false);",{user:'service_role'});
  ok('actual legacy service_role halt route exposed before fencing');
  const migration=fs.readFileSync(path.join(__dirname,'../release-control/supabase/migrations/20261117230320_separated_release_control.sql'),'utf8');
  const catalogQuery=fs.readFileSync(path.join(__dirname,'../release-control/catalog.sql'),'utf8');
  const catalog=install(catalogQuery);
  const pins={expected_database:'tos_governance_lab',expected_installer_role:'postgres',expected_server_version_num:identity.version,reviewed_catalog_hash:catalog};
  const installerSettings=values=>Object.entries(values).map(([key,value])=>`set tos.${key}=${quote(value)};`).join('');
  const noInstallation=()=>{assert.equal(sql("select count(*) from pg_roles where rolname like 'tos_release_%'"),'0');assert.equal(sql("select count(*) from pg_namespace where nspname='tos_release_control'"),'0');};
  assert.match(install(migration,{fail:true}),/installer database pin/);noInstallation();
  const pinChecks=[['expected_database',/installer database pin/],['expected_installer_role',/installer role pin/],['expected_server_version_num',/server version pin/],['reviewed_catalog_hash',/unreviewed catalog/]];
  for(const [key,reason] of pinChecks){
    const missing={...pins};delete missing[key];
    assert.match(install(installerSettings(missing)+migration,{fail:true}),reason);noInstallation();
    const wrong={...pins,[key]:key==='expected_server_version_num'?'170000':key==='reviewed_catalog_hash'?'0'.repeat(64):'wrong_installer_pin'};
    assert.match(install(installerSettings(wrong)+migration,{fail:true}),reason);noInstallation();
  }
  assert.match(install(installerSettings(pins)+'set role service_role;'+migration,{fail:true}),/installer role pin/);noInstallation();
  ok('missing/wrong database, installer, exact version and catalog pins plus SET ROLE fail before DDL');
  if(managedInstaller){
    const failBeforeCommit=migration.replace(/\bCOMMIT;\s*$/i,"do $$ begin raise exception 'injected installer failure'; end $$;\nCOMMIT;");
    assert.notEqual(failBeforeCommit,migration);
    assert.match(install(installerSettings(pins)+failBeforeCommit,{fail:true}),/injected installer failure/);
    noInstallation();
    assert.equal(install(catalogQuery),catalog);
    assert.equal(sql("select has_table_privilege('service_role','public.learning_active_releases','UPDATE')"),'t');
    ok('managed first-install failure rolls back roles, grants and catalog together');
  }
  function verifyClosedInstallerAccess(){
    if(!managedInstaller)return;
    for(const role of ['tos_release_owner',controllerRole]){
      assert.match(install(`set role ${role}`,{fail:true}),/permission denied to set role/i);
      assert.equal(sql(`select count(*) from pg_auth_members
where roleid='${role}'::regrole and member='postgres'::regrole and grantor=${quote(admin)}::regrole
  and admin_option and not set_option and not inherit_option`),'1');
      assert.equal(sql(`select count(*) from pg_auth_members where roleid='${role}'::regrole and (set_option or inherit_option)`),'0');
    }
    assert.equal(sql("select has_schema_privilege('tos_release_owner','public','CREATE')"),'f');
  }
  install(installerSettings(pins)+migration);
  verifyClosedInstallerAccess();
  const pinBeforePassword=sql('select hash from tos_release_control.catalog_pin');
  // Local fixture credential provisioning is separate from the migrations.
  sql(`alter role tos_release_controller password ${quote(passwords[controllerRole])};`);
  assert.equal(install(catalogQuery),pinBeforePassword);
  const recoveryMigration=fs.readFileSync(path.join(__dirname,'../release-control/supabase/migrations/20261120161406_maintenance_recovery.sql'),'utf8');
  const measureCatalog=()=>sql('select tos_release_control.measure_catalog()');
  const previousCatalog=measureCatalog();
  const recoveryPins={...pins,reviewed_catalog_hash:previousCatalog};
  function recoveryNotInstalled(){
    assert.equal(sql("select to_regprocedure('tos_release_control.recover(jsonb,text,jsonb,text)') is null"),'t');
    assert.equal(sql('select hash from tos_release_control.catalog_pin'),previousCatalog);
    assert.equal(measureCatalog(),previousCatalog);
  }
  for(const [key,reason] of pinChecks){
    const missing={...recoveryPins};
    delete missing[key];
    assert.match(install(installerSettings(missing)+recoveryMigration,{fail:true}),reason);
    recoveryNotInstalled();
    const wrong={...recoveryPins,[key]:key==='expected_server_version_num'?'170000':key==='reviewed_catalog_hash'?catalog:'wrong_installer_pin'};
    assert.match(install(installerSettings(wrong)+recoveryMigration,{fail:true}),reason);
    recoveryNotInstalled();
  }
  assert.match(install(installerSettings(recoveryPins)+'set role service_role;'+recoveryMigration,{fail:true}),/installer role pin/);
  recoveryNotInstalled();
  function installRecovery(){
    install(installerSettings(recoveryPins)+recoveryMigration);
    verifyClosedInstallerAccess();
    const measured=measureCatalog();
    assert.notEqual(measured,previousCatalog);
    assert.equal(sql('select hash from tos_release_control.catalog_pin'),measured);
    ok('recovery migration requires installer pins and the reviewed previous installation');
    return measured;
  }
  const archiveLimitMigration=fs.readFileSync(path.join(__dirname,'../release-control/supabase/migrations/20261120173728_expand_build_archive_limit.sql'),'utf8');
  const recoverDefinition=()=>sql("select pg_get_functiondef('tos_release_control.recover(jsonb,text,jsonb,text)'::regprocedure)");
  function installArchiveLimit(recoveryCatalog){
    const priorDefinition=recoverDefinition();
    const archivePins={...pins,reviewed_catalog_hash:recoveryCatalog};
    const badPins={...archivePins,reviewed_catalog_hash:previousCatalog};
    assert.match(install(installerSettings(badPins)+archiveLimitMigration,{fail:true}),/unreviewed catalog/);
    assert.equal(recoverDefinition(),priorDefinition);
    assert.equal(measureCatalog(),recoveryCatalog);
    assert.ok(priorDefinition.includes('BETWEEN 1 AND 64000000'));
    install(installerSettings(archivePins)+archiveLimitMigration);
    verifyClosedInstallerAccess();
    assert.equal(recoverDefinition(),priorDefinition.replace('BETWEEN 1 AND 64000000','BETWEEN 1 AND 268435456'));
    const measured=measureCatalog();
    assert.notEqual(measured,recoveryCatalog);
    assert.equal(sql('select hash from tos_release_control.catalog_pin'),measured);
    ok('forward migration requires reviewed catalog and changes only the recovery archive bound');
    return measured;
  }
  function installRepeatableGovernance(predecessor){
    const migration=fs.readFileSync(path.join(__dirname,'../release-control/supabase/migrations/20261122165501_repeatable_release_governance.sql'),'utf8');
    const repeatablePins={...pins,reviewed_catalog_hash:predecessor};
    assert.match(install(installerSettings({...repeatablePins,reviewed_catalog_hash:previousCatalog})+migration,{fail:true}),/unreviewed catalog/);
    assert.equal(measureCatalog(),predecessor);
    assert.equal(sql('select hash from tos_release_control.catalog_pin'),predecessor);
    install(installerSettings(repeatablePins)+migration);
    verifyClosedInstallerAccess();
    const installed=measureCatalog();
    assert.notEqual(installed,predecessor);
    assert.equal(sql('select hash from tos_release_control.catalog_pin'),installed);
    ok('repeatable governance installs only over the reviewed predecessor and pins the final catalog');
    return {predecessor,installed};
  }
  function runAdvisors(){
    if(!supabaseCli)return;
    const url=`postgresql://postgres@127.0.0.1:${port}/tos_governance_lab?sslmode=verify-full&sslrootcert=${encodeURIComponent(path.join(dir,'server.crt'))}`;
    const cleanEnv=Object.fromEntries(Object.entries(env).filter(([name])=>!/^SUPABASE_|^DATABASE_URL$/i.test(name)));
    const localEnv={...cleanEnv,PGPASSWORD:passwords.postgres,SUPABASE_DB_PASSWORD:passwords.postgres,
      SUPABASE_TELEMETRY_DISABLED:'1',SUPABASE_NO_UPDATE_NOTIFIER:'1',DO_NOT_TRACK:'1'};
    const help=pass(run(supabaseCli,['db','advisors','--help'],{env:localEnv}),'local advisor help');
    const target=help.includes('--db-url')?['--db-url',url]:[`--remote=${url}`];
    const advisors=run(supabaseCli,['db','advisors',...target,'--type','security','--fail-on','error',
      '--workdir',path.resolve(__dirname,'../release-control')],{env:localEnv});
    const safe=redact(String(advisors.stdout||'')+'\n'+String(advisors.stderr||''));
    fs.writeFileSync(path.join(dir,'security-advisors.log'),safe);
    assert.equal(advisors.status,0,'Local security advisor failed; see redacted security-advisors.log');
    ok('Supabase local security advisors completed');
  }
  if(preflightOnly){
    const catalog=installRepeatableGovernance(installArchiveLimit(installRecovery()));
    runAdvisors();
    console.log(JSON.stringify({passed,preflightOnly:true,productionApplied:false,labOnly:true,catalog,evidenceDirectory:dir}));
    return;
  }
  const controllerConnection={psql:bin('psql'),host:'127.0.0.1',port,database:'tos_governance_lab',user:controllerRole,password:passwords[controllerRole],rootCertificate:path.join(dir,'server.crt')};
  const transport=createTransport(controllerConnection);
  const pair=()=>crypto.generateKeyPairSync('ed25519'),owner=pair(),online=pair(),pem=k=>k.export({type:'spki',format:'pem'});
  const hash=C.hashText,manifest=(name,seed)=>C.seal({files:[{path:name,bytes:1,sha256:hash(seed)}]});
  function release(seed){const r=makeRelease([]);r.config.policy.versions.serverPipeline=hash(seed);r.config.policy.cache={shared:'disabled'};r.configHash=S.releaseConfigHash(r.config);return r;}
  const actual=artifactDirectory?JSON.parse(fs.readFileSync(path.join(artifactDirectory,'controller-inputs.json'),'utf8')):null;
  const baseline=actual?actual.baseline:release('old'),candidate=actual?actual.candidate:release('new'),migrationManifest=actual?actual.migrationManifest:manifest('migrations/test.sql','migration');
  if(!actual)for(const r of [baseline,candidate]){r.config.policy.versions.migrationManifest=migrationManifest.hash;r.configHash=S.releaseConfigHash(r.config);}
  const buildArtifacts=Object.fromEntries(['baseline','candidate'].map(arm=>[arm,actual?fs.readFileSync(path.join(artifactDirectory,actual[arm+'ArtifactFile'])):Buffer.from(arm+' artifact fixture')]));
  const measureVerifier=actual?()=>require('../tools/maintenance-artifact-manifest').verifyExecution({extension:path.resolve(__dirname,'..'),proxy},actual.verifierMeasurement).hash:()=>hash('verifier');
  const destination={environment:'lab',projectId:'fixture',serviceId:'fixture',databaseId:'fixture'};
  const active={generation:1,configHash:baseline.configHash,headHash:hash('head'),halted:false,governanceEpoch:0,governanceRegistryId:'fixture',governanceHeadHash:hash('gov-head'),installedVerifierHash:hash('old-verifier'),installedMigrationManifestHash:hash('old-migrations')};
  const buildManifest=(name,seed,arm)=>C.seal({files:[{path:'artifacts/release-build',bytes:buildArtifacts[arm].length,sha256:crypto.createHash('sha256').update(buildArtifacts[arm]).digest('hex')},...(actual?actual[arm+'SourceManifest']:manifest(name,seed)).files].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)});
  const planInput={destination,active,baseline,candidate,baselineManifest:buildManifest('old.js','old','baseline'),candidateManifest:buildManifest('new.js','new','candidate'),migrationManifest,standardDocumentHash:actual?actual.standardDocumentHash:hash('standard'),verifierHash:measureVerifier(),ownerKeyFingerprint:crypto.createHash('sha256').update(owner.publicKey.export({type:'spki',format:'der'})).digest('hex')};
  const plan=G.preparePlan(planInput);
  function seed(initial=baseline){sql(`delete from tos_release_control.consumptions;delete from tos_release_control.events;delete from tos_release_control.registry;delete from public.learning_release_consumptions;delete from public.learning_release_events;delete from public.learning_active_releases where environment='lab';delete from public.learning_releases;insert into public.learning_releases(config_hash,release) values(${quote(initial.configHash)},${json(initial)});insert into public.learning_active_releases values('lab',1,${quote(initial.configHash)},${quote(active.headHash)},false);insert into tos_release_control.registry(environment,destination,state) values('lab',${json(destination)},${json(Object.fromEntries(Object.entries(active).filter(([k])=>!['generation','configHash','headHash','halted'].includes(k))))});`);}
  const controllerConfig={transport,trustedOwnerKey:pem(owner.publicKey),onlinePublicKeys:[pem(online.publicKey)],destination,measureVerifier};
  const controller=createController({...controllerConfig,reviewedPlan:plan});
  const sign=(payload,purpose,key=owner.privateKey)=>({payload,signature:crypto.sign(null,Buffer.from(purpose+C.canonicalJson(payload)),key).toString('base64')});
  const envelope=(id='controller_fixture_adoption_0001',ms=60000,reviewedPlan=plan)=>{
    const payload=G.payloadFor(reviewedPlan,{authorizationId:id,issuedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+ms).toISOString()});
    return {payload,signature:crypto.sign(null,Buffer.from(G.message(payload)),owner.privateKey).toString('base64')};
  };

  // Recovery bytes and every approval and observation are synthetic, including runs with an actual initial pair.
  const recoveryBytes=Buffer.from('synthetic recovery build fixture');
  const recoveryRelease=JSON.parse(C.canonicalJson(candidate));
  recoveryRelease.config.policy.versions.serverPipeline=hash('synthetic recovery runtime fixture');
  recoveryRelease.configHash=S.releaseConfigHash(recoveryRelease.config);
  const recoveryArtifact={bytes:recoveryBytes.length,sha256:crypto.createHash('sha256').update(recoveryBytes).digest('hex')};
  const recoveryManifest=C.seal({files:[{path:'artifacts/release-build',...recoveryArtifact}]});
  const recoveryPlan=G.preparePlan({...planInput,recovery:{release:recoveryRelease,manifest:recoveryManifest}});

  seed();
  const beforeInstall=transport.rpc('read_state',['lab']);
  assert.equal(beforeInstall.recoveryVersion,undefined);
  const unsupportedController=createController({...controllerConfig,reviewedPlan:recoveryPlan});
  const unsupportedAdoption=envelope('recovery_unsupported_adoption_0001',60000,recoveryPlan);
  await assert.rejects(unsupportedController.adopt(unsupportedAdoption),/recovery.*(install|capability|version)/i);
  assert.deepEqual(transport.rpc('read_state',['lab']),beforeInstall);
  assert.equal(sql('select count(*) from tos_release_control.events'),'0');
  assert.equal(sql('select count(*) from tos_release_control.consumptions'),'0');
  ok('adopting a recovery plan requires database support');
  const smallBuild=arm=>manifest('artifacts/release-build',arm+' legacy installer fixture');
  const oldPlan=G.preparePlan({...planInput,baselineManifest:smallBuild('baseline'),candidateManifest:smallBuild('candidate')});
  const oldController=createController({...controllerConfig,reviewedPlan:oldPlan});
  const oldAdoption=envelope('base_only_fixture_adoption_0001',60000,oldPlan);
  assert.equal((await oldController.adopt(oldAdoption)).status,'adopted');
  assert.match(install(installerSettings(recoveryPins)+recoveryMigration,{fail:true}),/recovery must be installed before adoption/);
  assert.match(install(installerSettings(recoveryPins)+recoveryMigration,{continueOnError:true}),/recovery must be installed before adoption/);
  recoveryNotInstalled();
  assert.equal((await oldController.adopt(oldAdoption)).status,'already-applied');
  ok('installer refuses an adopted database without changing its catalog or durable adoption');
  seed();
  const recoveryCatalog=installRecovery();
  assert.equal(transport.rpc('read_state',['lab']).recoveryVersion,1);
  const largeRecoveryManifest=C.seal({files:[{path:'artifacts/release-build',...recoveryArtifact,bytes:64000001}]});
  const largeArchivePlan=G.preparePlan({...planInput,recovery:{release:recoveryRelease,manifest:largeRecoveryManifest}});
  const largeArchiveController=createController({...controllerConfig,reviewedPlan:largeArchivePlan});
  const beforeArchiveMigration=transport.rpc('read_state',['lab']);
  assert.equal(beforeArchiveMigration.buildArchiveMaxBytes,undefined);
  const largeAdoption=envelope('archive_limit_required_fixture_0001',60000,largeArchivePlan);
  await assert.rejects(largeArchiveController.adopt(largeAdoption),/Build archive limit migration must be installed/);
  assert.deepEqual(transport.rpc('read_state',['lab']),beforeArchiveMigration);
  assert.equal(sql('select count(*) from tos_release_control.consumptions'),'0');
  ok('large-archive adoption waits for installed database support');
  const installedRecoveryCatalog=installArchiveLimit(recoveryCatalog);
  assert.equal(transport.rpc('read_state',['lab']).buildArchiveMaxBytes,268435456);

  assert.equal(transport.rpc('read_state',['missing']),null);
  assert.throws(()=>createTransport({...controllerConnection,user:'service_role',password:passwords.service_role}),/Restricted/);
  assert.throws(()=>createTransport({...controllerConnection,password:'wrong'}).rpc('read_state',['missing']),/failed/);
  assert.throws(()=>createTransport({...controllerConnection,rootCertificate:__filename}).rpc('read_state',['missing']),/failed/);
  const wrongHost=run(bin('psql'),['-X','-w','-q','-A','-t','-c','select 1'],{env:{...env,PGHOST:'not-the-certificate.invalid',PGHOSTADDR:'127.0.0.1'}});
  assert.notEqual(wrongHost.status,0);assert.match(wrongHost.stderr,/does not match host name/);
  assert.throws(()=>transport.rpc('execute_sql',['select 1']),/Unknown/);
  ok('TLS verify-full controller login, wrong password and narrow RPC transport');
  assert.match(sql('select current_user',{user:controllerRole,pw:passwords.service_role,fail:true}),/password authentication failed/);
  assert.match(sql('select current_user',{user:'service_role',pw:passwords[controllerRole],fail:true}),/password authentication failed/);
  ok('application and controller passwords cannot be exchanged');
  const tables=['public.learning_releases','public.learning_active_releases','public.learning_release_events','public.learning_release_consumptions','tos_release_control.registry','tos_release_control.events','tos_release_control.consumptions','tos_release_control.catalog_pin'];
  const actors=[...appRoles,controllerRole];
  const columns=Object.fromEntries(tables.map(table=>[table,sql(`select attname from pg_attribute where attrelid=${quote(table)}::regclass and attnum>0 and not attisdropped order by attnum limit 1`)]));
  function denialMatrix(){
  let denials=0;
  for(const actor of actors){for(const table of tables){for(const op of [`insert into ${table} default values`,`delete from ${table}`,`truncate ${table}`,`update ${table} set ${columns[table]}=${columns[table]} where false`]){assert.match(sql(op,{user:actor,fail:true}),/permission denied/);denials++;}}
    for(const q of ['set role tos_release_owner','grant tos_release_owner to runtime_app','create function public.attack() returns int language sql as $$select 1$$','create table tos_release_control.attack(id int)']){assert.match(sql(q,{user:actor,fail:true}),/permission denied|must have|not permitted/);denials++;}
    for(const q of ["select public.set_learning_release_halt('positive',true)","select public.prepare_learning_release('{}','{}')","select public.activate_learning_release('positive','{}','{}','{}','x','{}',1,'x','{}','{}')"]){assert.match(sql(q,{user:actor,fail:true}),/permission denied/);denials++;}
    if(actor!=='tos_release_controller')for(const q of ["select tos_release_control.read_state('x')","select tos_release_control.adopt('{}','{}','{}','{}')","select tos_release_control.activate('{}','{}','{}','{}')","select tos_release_control.recover('{}','{}','{}','{}')"]){assert.match(sql(q,{user:actor,fail:true}),/permission denied/);denials++;}
    if(actor!=='tos_release_controller'){assert.match(sql('set role tos_release_controller',{user:actor,fail:true}),/permission denied/);denials++;}
  }
  for(const q of ["select tos_release_control.measure_catalog()","select tos_release_control.assert_catalog()","select tos_release_control.activate_validated('x','{}','{}','{}','x','{}',1,'x','{}','{}')"]){assert.match(sql(q,{user:'tos_release_controller',fail:true}),/permission denied/);denials++;}
  verifyClosedInstallerAccess();
  assert.equal(sql("select count(*) from pg_auth_members m where roleid in(select oid from pg_roles where rolname in('tos_release_owner','tos_release_controller'));"),managedInstaller?'2':'0');
  return denials;
  }
  const denials=denialMatrix();
  ok(`final installed independent LOGIN denial matrix: ${denials} denials`);
  seed();const good=envelope();const bad=JSON.parse(JSON.stringify(good));bad.signature=Buffer.alloc(64).toString('base64');await assert.rejects(controller.adopt(bad),/signature/);assert.equal(sql('select count(*) from tos_release_control.events'),'0');
  assert.equal((await controller.adopt(good)).status,'adopted');assert.equal(sql("select generation from public.learning_active_releases where environment='lab'"),'1');assert.equal((await controller.adopt(good)).status,'already-applied');
  ok('real owner verifier reaches SQL adoption; generation unchanged; exact replay durable');
  seed();const {hash:ph,...body}=plan;const query=e=>`select tos_release_control.adopt(${json(e)},${quote(C.canonicalJson(e))},${json(plan)},${quote(C.canonicalJson(body))});`;
  const races=await Promise.allSettled([asyncSql(query(envelope('fixture_race_authorization_0001'))),asyncSql(query(envelope('fixture_race_authorization_0002')))]);assert.equal(races.filter(x=>x.status==='fulfilled').length,1);assert.equal(sql('select count(*) from tos_release_control.events'),'1');
  ok('concurrent adoption serializes with exactly one committed authorization');
  // Hypothetical observed evidence is signed with fresh ephemeral TEST identities.
  // It exercises the full acceptance contract; it is not real evaluation evidence.
  const F=require('../tools/maintenance-final-evidence');
  const {makeFinalFixture}=require('./maintenance-final-fixtures');
  const fixture=makeFinalFixture({mode:'observed',baselineRelease:baseline,candidateRelease:candidate,buildArtifacts});
  const evidenceContext={protocol:fixture.protocol,evidence:fixture.evidence,attachments:fixture.context.attachments};
  const maintenanceController=createController({transport,trustedOwnerKey:pem(owner.publicKey),onlinePublicKeys:[pem(online.publicKey)],trustedReviewers:fixture.context.trustedReviewers,destination,reviewedPlan:plan,measureVerifier});
  const report=F.validateFinalEvidence(fixture.protocol,fixture.evidence,{...fixture.context,now:new Date().toISOString()});
  assert.equal(report.promotionEligible,true,report.reasons.join('; '));
  function publicationRequest({id,target,approvedReport,reviewedPlan,kind,purpose,action='activate',binding=F.authorizationEvidence(approvedReport)}){
    const current=transport.rpc('read_state',['lab']).active;
    const authorization=sign({v:2,kind:'release-activation',authorizationId:id,action,environment:'lab',configHash:target.configHash,expectedGeneration:current.generation,expectedConfigHash:current.configHash,expectedHeadHash:current.headHash,issuedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),evidence:binding},S.AUTHORIZATION_PURPOSE);
    const body={v:2,kind:action==='rollback'?'release-rolled-back':'release-activated',environment:'lab',generation:current.generation+1,previousConfigHash:current.configHash,configHash:target.configHash,prevHash:current.headHash,authorizationId:id,authorizationHash:C.digest(authorization),createdAt:new Date().toISOString()};
    const event={body,hash:C.digest(body),publicKey:pem(online.publicKey)};event.signature=crypto.sign(null,Buffer.from(EVENT_PURPOSE+event.hash),online.privateKey).toString('base64');
    const controlEnvelope=sign({v:1,kind,authorizationId:id,issuedAt:authorization.payload.issuedAt,expiresAt:authorization.payload.expiresAt,destination,expected:current,planHash:reviewedPlan.hash,authorizationHash:C.digest(authorization),releaseHash:C.digest(target),eventHash:event.hash},purpose);
    return {controlEnvelope,authorization,release:target,event};
  }
  function activation(id='controller_fixture_activation_01',reviewedPlan=plan){
    return publicationRequest({id,target:candidate,approvedReport:report,reviewedPlan,kind:'maintenance-control',purpose:PURPOSE});
  }
  seed();await controller.adopt(envelope());
  const request=activation();
  const broken={...evidenceContext,attachments:{...evidenceContext.attachments}};delete broken.attachments[Object.keys(broken.attachments)[0]];
  await assert.rejects(maintenanceController.activate(request,broken),/evidence|Evidence/);
  assert.equal(sql("select generation from public.learning_active_releases where environment='lab'"),'1');
  const fault=activation('controller_atomic_failure_0001');
  sql(`insert into tos_release_control.events values('controller_atomic_failure_0001','lab',${quote(hash('fixture-induced-postpublication-conflict'))},'{}');`);
  await assert.rejects(maintenanceController.activate(fault,evidenceContext),/failed/);
  assert.equal(sql("select generation from public.learning_active_releases where environment='lab'"),'1');
  assert.equal(sql('select count(*) from public.learning_release_events'),'0');
  assert.equal(sql('select count(*) from public.learning_release_consumptions'),'0');
  assert.equal(sql('select count(*) from tos_release_control.consumptions'),'1');
  sql("delete from tos_release_control.events where authorization_id='controller_atomic_failure_0001';");
  ok('failure after inner publication rolls back pointer, release event and both consumption effects');
  assert.equal((await maintenanceController.activate(request,evidenceContext)).status,'activated');
  assert.equal(sql("select generation from public.learning_active_releases where environment='lab'"),'2');
  const future=createController({transport,trustedOwnerKey:pem(owner.publicKey),onlinePublicKeys:[pem(online.publicKey)],trustedReviewers:fixture.context.trustedReviewers,destination,reviewedPlan:plan,measureVerifier,now:()=>new Date(Date.now()+86400000).toISOString()});
  assert.equal((await future.activate(request,evidenceContext)).status,'already-applied');
  const changed=JSON.parse(JSON.stringify(request));changed.event.signature='tampered';await assert.rejects(maintenanceController.activate(changed,evidenceContext),/failed/);
  assert.equal(sql('select count(*) from tos_release_control.consumptions'),'2');
  ok('complete signed evidence→owner authorization→separated controller→SQL activation; tampering fails; expired exact replay recovers');
  seed();await controller.adopt(envelope());
  const req1=activation('controller_race_activation_0001'),req2=activation('controller_race_activation_0002');
  const activations=await Promise.allSettled([maintenanceController.activate(req1,evidenceContext),maintenanceController.activate(req2,evidenceContext)]);
  assert.equal(activations.filter(x=>x.status==='fulfilled').length,1);assert.equal(sql("select generation from public.learning_active_releases where environment='lab'"),'2');
  ok('competing maintenance authorizations serialize with one activation and no partial consumption');
  seed();const expired=envelope('fixture_expired_authorization_01',-1);await assert.rejects(controller.adopt(expired),/expired/);assert.equal(sql('select count(*) from tos_release_control.events'),'0');
  const locker=asyncSql("begin;select generation from public.learning_active_releases where environment='lab' for update;select pg_sleep(3);commit;",admin).then(()=>({ok:true}),error=>({error}));
  let observedLock=false;
  for(let i=0;i<20;i++){await new Promise(resolve=>setTimeout(resolve,20));if(sql("select count(*) from pg_stat_activity where application_name='psql' and wait_event='PgSleep'")!=='0'){observedLock=true;break;}}
  if(!observedLock)await locker;
  assert.equal(observedLock,true);
  const lockedEnvelope=envelope('fixture_lock_expiry_auth_0001',1000);
  assert.equal(G.verifyEnvelope(lockedEnvelope,plan,{trustedOwnerKey:pem(owner.publicKey),onlinePublicKeys:[pem(online.publicKey)],destination,active,reviewedPlanHash:plan.hash,reviewedVerifierHash:plan.verifierHash,reviewedStandardHash:plan.standardDocumentHash,consumedAuthorizationIds:[],now:new Date().toISOString()}).valid,true);
  await assert.rejects(asyncSql(query(lockedEnvelope)),/expired/);assert.equal((await locker).ok,true);
  assert.equal(sql('select count(*) from tos_release_control.events'),'0');
  ok('approval expiry after a real row-lock wait leaves no event or consumption');

  const recoveryFixture=makeFinalFixture({mode:'observed',baselineRelease:candidate,candidateRelease:recoveryRelease,buildArtifacts:{baseline:buildArtifacts.candidate,candidate:recoveryBytes}});
  function recoveryEvidence(fixture){
    const {protocol,evidence,context}=fixture;
    const report=F.validateFinalEvidence(protocol,evidence,{...context,now:new Date().toISOString()});
    assert.equal(report.promotionEligible,true,report.reasons.join('; '));
    return {report,context:{protocol,evidence,attachments:context.attachments}};
  }
  const approvedRecovery=recoveryEvidence(recoveryFixture);
  const {path:artifactPath,...candidateArtifact}=recoveryPlan.candidateManifest.files.find(file=>file.path==='artifacts/release-build');
  assert.equal(artifactPath,'artifacts/release-build');
  assert.deepEqual(recoveryFixture.builds.baseline.artifact,candidateArtifact);
  assert.deepEqual(recoveryFixture.builds.candidate.artifact,recoveryArtifact);

  const recoveryConfig={...controllerConfig,trustedReviewers:recoveryFixture.context.trustedReviewers,reviewedPlan:recoveryPlan};
  const recoveryController=createController(recoveryConfig);
  const firstEdgeController=createController({...recoveryConfig,trustedReviewers:fixture.context.trustedReviewers});
  function recoveryRequest(id,overrides={}){
    return publicationRequest({id,target:recoveryRelease,approvedReport:approvedRecovery.report,reviewedPlan:recoveryPlan,kind:'maintenance-recovery',purpose:RECOVERY_PURPOSE,...overrides});
  }
  function recordedState(){
    const records=tables.map(table=>`${quote(table)},(select coalesce(jsonb_agg(to_jsonb(entry) order by to_jsonb(entry)),'[]'::jsonb) from ${table} entry)`);
    return JSON.parse(sql(`select jsonb_build_object(${records.join(',')})`));
  }

  seed();
  const recoveryAdoption=envelope('recovery_fixture_adoption_0001',60000,recoveryPlan);
  assert.equal((await recoveryController.adopt(recoveryAdoption)).status,'adopted');
  const firstEdgeState=recordedState();
  const earlyRecovery=recoveryRequest('recovery_before_first_edge_0001');
  await assert.rejects(recoveryController.recover(earlyRecovery,approvedRecovery.context),/outside adopted maintenance pair/i);
  assert.deepEqual(recordedState(),firstEdgeState);
  const firstEdge=activation('recovery_fixture_first_edge_0001',recoveryPlan);
  await assert.rejects(recoveryController.recover(firstEdge,approvedRecovery.context),/owner signature/i);
  assert.equal((await firstEdgeController.activate(firstEdge,evidenceContext)).status,'activated');
  const recoverySource=transport.rpc('read_state',['lab']);
  assert.equal(recoverySource.active.generation,active.generation+1);
  assert.equal(recoverySource.active.configHash,candidate.configHash);
  assert.equal(recoverySource.active.headHash,firstEdge.event.hash);

  const beforeRecovery=recordedState();
  await assert.rejects(recoveryController.recover(earlyRecovery,approvedRecovery.context),/envelope binding mismatch/i);
  const wrongTarget=recoveryRequest('recovery_to_legacy_baseline_0001',{target:baseline});
  await assert.rejects(recoveryController.recover(wrongTarget,approvedRecovery.context),/outside adopted maintenance pair/i);
  const rollback=recoveryRequest('recovery_as_rollback_0001',{action:'rollback'});
  await assert.rejects(recoveryController.recover(rollback,approvedRecovery.context),/forward publication/i);
  const wrongRoute=recoveryRequest('recovery_in_activation_rpc_0001');
  await assert.rejects(firstEdgeController.activate(wrongRoute,evidenceContext),/owner signature/i);
  const staleSource=JSON.parse(C.canonicalJson(recoveryRelease));
  staleSource.config.policy.versions.serverPipeline=hash('synthetic stale runtime fixture');
  staleSource.configHash=S.releaseConfigHash(staleSource.config);
  const staleFixture=makeFinalFixture({mode:'observed',baselineRelease:staleSource,candidateRelease:recoveryRelease,buildArtifacts:{baseline:buildArtifacts.baseline,candidate:recoveryBytes}});
  const staleEvidence=recoveryEvidence(staleFixture);
  const staleController=createController({...recoveryConfig,trustedReviewers:staleFixture.context.trustedReviewers});
  const staleRequest=recoveryRequest('recovery_stale_evidence_0001',{approvedReport:staleEvidence.report});
  await assert.rejects(staleController.recover(staleRequest,staleEvidence.context),/evidence build pair mismatch/i);
  assert.deepEqual(recordedState(),beforeRecovery);
  ok('recovery requires the activated candidate, a fresh matching snapshot and evidence, and its own forward approval');

  const failedRecovery=recoveryRequest('recovery_atomic_failure_0001');
  sql(`insert into tos_release_control.events values('recovery_atomic_failure_0001','lab',${quote(hash('synthetic recovery postpublication conflict'))},'{}');`);
  const withConflict=recordedState();
  await assert.rejects(recoveryController.recover(failedRecovery,approvedRecovery.context),/failed/);
  assert.deepEqual(recordedState(),withConflict);
  sql("delete from tos_release_control.events where authorization_id='recovery_atomic_failure_0001';");
  assert.deepEqual(recordedState(),beforeRecovery);
  ok('postpublication recovery failure rolls back the prepared build, pointer, audit and consumption writes');

  // Dispatch both approvals through separate PostgreSQL sessions. Leave the committed reply with the test transport.
  const recoveryRace=[recoveryRequest('recovery_fixture_race_0001'),recoveryRequest('recovery_fixture_race_0002')];
  const lostReply='Synthetic loss of the committed recovery reply';
  let recoveryDispatches=0;
  let committedRecovery;
  const racingTransport={async rpc(name,args){
    if(name!=='recover')return transport.rpc(name,args);
    recoveryDispatches++;
    const [envelope,canonicalEnvelope,request,canonicalRequest]=args;
    const result=JSON.parse(await asyncSql(`select tos_release_control.recover(${json(envelope)},${quote(canonicalEnvelope)},${json(request)},${quote(canonicalRequest)});`));
    assert.equal(result.status,'recovered');
    committedRecovery={authorizationId:envelope.payload.authorizationId,result};
    throw Error(lostReply);
  }};
  const racingController=createController({...recoveryConfig,transport:racingTransport});
  const outcomes=await Promise.allSettled(recoveryRace.map(request=>racingController.recover(request,approvedRecovery.context)));
  assert.equal(recoveryDispatches,2);
  assert.ok(outcomes.every(outcome=>outcome.status==='rejected'));
  assert.equal(outcomes.filter(outcome=>outcome.reason.message===lostReply).length,1);
  assert.match(outcomes.find(outcome=>outcome.reason.message!==lostReply).reason.message,/stale|candidate|release pair/i);
  const {authorizationId:recoveredId,result:recoveredResult}=committedRecovery;
  const committedRequest=recoveryRace.find(request=>request.authorization.payload.authorizationId===recoveredId);
  assert.deepEqual(recoveredResult.event,committedRequest.event);
  assert.deepEqual(transport.rpc('read_state',['lab']),{...recoverySource,active:{...recoverySource.active,generation:recoverySource.active.generation+1,configHash:recoveryRelease.configHash,headHash:committedRequest.event.hash}});
  const afterRecovery=recordedState();
  assert.deepEqual(afterRecovery['tos_release_control.registry'],beforeRecovery['tos_release_control.registry']);
  assert.deepEqual(afterRecovery['tos_release_control.catalog_pin'],beforeRecovery['tos_release_control.catalog_pin']);
  const additions={
    'public.learning_releases':['config_hash',recoveryRelease.configHash],
    'public.learning_release_events':['event_hash',committedRequest.event.hash],
    'public.learning_release_consumptions':['authorization_id',recoveredId],
    'tos_release_control.events':['authorization_id',recoveredId],
    'tos_release_control.consumptions':['authorization_id',recoveredId]
  };
  for(const [table,[key,value]] of Object.entries(additions)){
    assert.equal(afterRecovery[table].filter(row=>row[key]===value).length,1,table);
    assert.deepEqual(afterRecovery[table].filter(row=>row[key]!==value),beforeRecovery[table],table);
  }
  assert.deepEqual(JSON.parse(sql(`select release from public.learning_releases where config_hash=${quote(recoveryRelease.configHash)}`,{user:'service_role'})),recoveryRelease);
  assert.equal(measureCatalog(),installedRecoveryCatalog);
  assert.match(install(installerSettings({...pins,reviewed_catalog_hash:installedRecoveryCatalog})+archiveLimitMigration,{fail:true}),/build archive limit must be installed before adoption/);
  assert.match(install(installerSettings({...pins,reviewed_catalog_hash:installedRecoveryCatalog})+archiveLimitMigration,{continueOnError:true}),/build archive limit must be installed before adoption/);
  assert.equal(measureCatalog(),installedRecoveryCatalog);
  const restartedController=createController({...recoveryConfig,transport:createTransport(controllerConnection),now:()=>new Date(Date.now()+86400000).toISOString()});
  assert.deepEqual(await restartedController.recover(committedRequest,approvedRecovery.context),{...recoveredResult,status:'already-applied'});
  const otherDestination={...destination,databaseId:'other-fixture'};
  const otherPlan=G.preparePlan({...planInput,destination:otherDestination,recovery:{release:recoveryRelease,manifest:recoveryManifest}});
  const otherController=createController({...recoveryConfig,destination:otherDestination,reviewedPlan:otherPlan});
  await assert.rejects(otherController.recover(committedRequest,approvedRecovery.context),/destination or plan mismatch/);
  const alteredReplay={...committedRequest,event:{...committedRequest.event,signature:'tampered'}};
  await assert.rejects(restartedController.recover(alteredReplay,approvedRecovery.context),/failed/);
  const repeatedRecovery=recoveryRequest('recovery_after_recovery_0001');
  await assert.rejects(recoveryController.recover(repeatedRecovery,approvedRecovery.context),/outside adopted maintenance pair/i);
  assert.deepEqual(recordedState(),afterRecovery);
  ok('competing approvals publish one recovery, preserve governance and immutable history, and replay the lost result after expiry');

  const completedLegacy=transport.rpc('read_state',['lab']).active;
  const repeatableCatalog=installRepeatableGovernance(installedRecoveryCatalog);
  const upgraded=transport.rpc('read_state',['lab']);
  assert.deepEqual(upgraded.active,completedLegacy);
  assert.equal(upgraded.standard,'maintenance-final/v1');
  assert.equal(upgraded.governanceVersion,4);
  assert.equal(upgraded.publicationComplete,true);
  assert.equal(denialMatrix(),denials);
  const privateHelpers=[
    "select tos_release_control.publication_complete('lab','{}','{}',1,'x','x')",
    "select tos_release_control.plan_standard('{}')",
    "select tos_release_control.release_build('{}')",
    "select tos_release_control.published_build('{}',1)",
  ];
  for(const actor of actors){
    for(const query of privateHelpers)assert.match(sql(query,{user:actor,fail:true}),/permission denied/);
  }
  ok(`repeatable governor preserves the legacy registry and all ${denials} denials, with its new helpers private`);
  assert.equal((await restartedController.recover(committedRequest,approvedRecovery.context)).status,'already-applied');
  seed();
  assert.equal((await controller.adopt(envelope())).status,'adopted');
  assert.equal((await maintenanceController.activate(activation(),evidenceContext)).status,'activated');
  assert.equal(transport.rpc('read_state',['lab']).publicationComplete,true);
  ok('historical version 3 authorization and maintenance-final publication still work after the upgrade');

  const D=require('../tools/maintenance-dependency-evidence');
  const {fixture:dependencyFixture}=require('./maintenance-dependency-fixtures');
  const builds=['baseline','first','second','recovery'].map((id,i)=>({
    id,version:`1.0.${i}`,indexSource:i===0?'legacy server fixture':'patched server fixture',
    migrationManifestHash:migrationManifest.hash,
  }));
  const first=await dependencyFixture({className:'E',builds:builds.slice(0,2),ownerKey:owner});
  const second=await dependencyFixture({builds:builds.slice(1,3),ownerKey:owner});
  const laterRecovery=await dependencyFixture({builds:builds.slice(2),ownerKey:owner});
  const plannedBuild=arm=>({path:'artifacts/release-build',sha256:arm.image.sha256,bytes:arm.image.bytes});
  const manifestFor=arm=>C.seal({files:[plannedBuild(arm)]});
  const approved=data=>{
    const {protocol,evidence,context}=data;
    const report=D.validateDependencyEvidence(protocol,evidence,context);
    assert.equal(report.promotionEligible,true,report.reasons.join('; '));
    return {protocol,evidence,attachments:context.attachments,binding:D.authorizationEvidence(report)};
  };
  const v4Plan=(snapshot,source,target,fallback)=>G.preparePlan({...planInput,active:snapshot,
    fromGovernanceEpoch:snapshot.governanceEpoch,standard:'maintenance-dependency/v1',
    baseline:source.release,candidate:target.release,baselineManifest:manifestFor(source),candidateManifest:manifestFor(target),
    ...(fallback?{recovery:{release:fallback.release,manifest:manifestFor(fallback)}}:{}),
  });
  const v4Controller=(reviewedPlan,data)=>createController({...controllerConfig,reviewedPlan,
    trustedReviewers:data.context.trustedReviewers,trustedRates:data.context.trustedRates});
  const snapshot=()=>transport.rpc('read_state',['lab']);
  const newAdoption=(reviewedPlan,id)=>envelope(id,60000,reviewedPlan);
  const adoptSql=(reviewedPlan,signed)=>{
    const {hash,...body}=reviewedPlan;
    return `select tos_release_control.adopt(${json(signed)},${quote(C.canonicalJson(signed))},${json(reviewedPlan)},${quote(C.canonicalJson(body))});`;
  };
  const sendPublicationSql=(rpc,request)=>{
    const full={...request,canonicalAuthorization:C.canonicalJson(request.authorization),
      canonicalRelease:C.canonicalJson({v:2,config:request.release.config}),canonicalEvent:C.canonicalJson(request.event.body)};
    return `select tos_release_control.${rpc}(${json(full.controlEnvelope)},${quote(C.canonicalJson(full.controlEnvelope))},${json(full)},${quote(C.canonicalJson(full))});`;
  };
  const dependencyRequest=(reviewedPlan,target,binding,id,recovery=false)=>publicationRequest({
    id,target:target.release,reviewedPlan,binding,kind:recovery?'maintenance-recovery':'maintenance-control',
    purpose:recovery?RECOVERY_PURPOSE:PURPOSE,
  });
  const evidenceOnly=({protocol,evidence,attachments})=>({protocol,evidence,attachments});

  seed(first.arms[0].release);
  const firstPlan=v4Plan(snapshot().active,...first.arms);
  assert.equal(firstPlan.recovery,undefined);
  const firstController=v4Controller(firstPlan,first);
  const firstAdoption=newAdoption(firstPlan,'first_v4_lab_adoption_0001');
  assert.equal((await firstController.adopt(firstAdoption)).status,'adopted');
  assert.equal(snapshot().active.governanceEpoch,1);
  assert.equal(snapshot().publicationComplete,false);
  const midFlight=v4Plan(snapshot().active,...first.arms,laterRecovery.arms[1]);
  const midFlightApproval=newAdoption(midFlight,'midflight_v4_lab_adoption_01');
  await assert.rejects(v4Controller(midFlight,first).adopt(midFlightApproval),/publication/i);
  assert.match(sql(adoptSql(midFlight,midFlightApproval),{user:controllerRole,fail:true}),/publication|stale/i);
  const firstEvidence=approved(first);
  const wrongPhase=dependencyRequest(firstPlan,first.arms[1],{...firstEvidence.binding,phase:'maintenance-final'},'wrong_v4_lab_phase_0001');
  await assert.rejects(firstController.activate(wrongPhase,evidenceOnly(firstEvidence)),/phase|standard/i);
  assert.match(sql(sendPublicationSql('activate',wrongPhase),{user:controllerRole,fail:true}),/phase|evidence/i);
  const undeclared=dependencyRequest(firstPlan,first.arms[1],firstEvidence.binding,'undeclared_lab_recover_001',true);
  await assert.rejects(firstController.recover(undeclared,evidenceOnly(firstEvidence)),/No recovery release/i);
  assert.match(sql(sendPublicationSql('recover',undeclared),{user:controllerRole,fail:true}),/recover/i);
  const firstRequest=dependencyRequest(firstPlan,first.arms[1],firstEvidence.binding,'first_v4_lab_activate_0001');
  assert.equal((await firstController.activate(firstRequest,evidenceOnly(firstEvidence))).status,'activated');
  assert.equal(snapshot().publicationComplete,true);
  assert.deepEqual(snapshot().activeBuild,plannedBuild(first.arms[1]));
  assert.equal(snapshot().active.generation,2);
  ok('first maintenance-dependency plan activates without recovery and refuses crossed evidence and unfinished adoption');

  async function denyDifferentBaseline(validPlan,data,id){
    const {hash,v,kind,nextGovernanceEpoch,policyDiff,...input}=validPlan;
    const files=input.baselineManifest.files.map(file=>({...file,sha256:C.hashText('unpublished fixture baseline'),bytes:file.bytes+1}));
    const mismatch=G.preparePlan({...input,baselineManifest:C.seal({files})});
    const auth=newAdoption(mismatch,id);
    await assert.rejects(v4Controller(mismatch,data).adopt(auth),/baseline|build/i);
    assert.match(sql(adoptSql(mismatch,auth),{user:controllerRole,fail:true}),/baseline|build/i);
  }
  const secondPlan=v4Plan(snapshot().active,...second.arms,laterRecovery.arms[1]);
  await denyDifferentBaseline(secondPlan,second,'bad_v4_candidate_base_0001');
  const secondEdge=v4Controller(secondPlan,second);
  assert.equal((await secondEdge.adopt(newAdoption(secondPlan,'second_v4_lab_adoption_001'))).epoch,2);
  await assert.rejects(firstController.adopt(newAdoption(firstPlan,'stale_v4_lab_adoption_0001')),/state|epoch/i);
  assert.match(sql(adoptSql(firstPlan,newAdoption(firstPlan,'stale_v4_sql_adoption_0001')),{user:controllerRole,fail:true}),/stale|epoch/i);
  const secondEvidence=approved(second);
  const secondRequest=dependencyRequest(secondPlan,second.arms[1],secondEvidence.binding,'second_v4_lab_activate_001');
  assert.equal((await secondEdge.activate(secondRequest,evidenceOnly(secondEvidence))).status,'activated');
  assert.equal(snapshot().active.generation,3);
  const laterEvidence=approved(laterRecovery);
  const recoveryRequestV4=dependencyRequest(secondPlan,laterRecovery.arms[1],laterEvidence.binding,'second_v4_lab_recover_0001',true);
  assert.equal((await v4Controller(secondPlan,laterRecovery).recover(recoveryRequestV4,evidenceOnly(laterEvidence))).status,'recovered');
  const recovered=snapshot();
  assert.equal(recovered.active.governanceEpoch,2);
  assert.equal(recovered.active.generation,4);
  assert.equal(recovered.publicationComplete,true);
  assert.deepEqual(recovered.activeBuild,plannedBuild(laterRecovery.arms[1]));
  const nextPlan=v4Plan(recovered.active,laterRecovery.arms[1],first.arms[1],second.arms[1]);
  await denyDifferentBaseline(nextPlan,second,'bad_v4_recovered_base_0001');
  const probeFromRecovery=newAdoption(nextPlan,'test_adopt_after_recovery_01');
  const candidateAdoption=JSON.parse(sql(`begin;${adoptSql(nextPlan,probeFromRecovery)}rollback;`,{user:controllerRole}));
  assert.equal(candidateAdoption.epoch,3);
  assert.equal((await firstController.adopt(firstAdoption)).status,'already-applied');
  assert.equal((await firstController.activate(firstRequest,evidenceOnly(firstEvidence))).status,'already-applied');
  assert.deepEqual(snapshot(),recovered);
  assert.equal(measureCatalog(),repeatableCatalog.installed);
  ok('later dependency plan adopts, activates and recovers with exact build continuity and immutable older receipts');
  runAdvisors();
  // Restoring a default's SQL expression creates a fresh catalog OID, so run
  // the deliberate catalog drift checks at the end of the disposable fixture.
  sql("create function public.unreviewed() returns int language sql as $$select 1$$;");assert.throws(()=>transport.rpc('read_state',['lab']),/failed/);sql('drop function public.unreviewed();');
  sql("alter table public.learning_releases alter column created_at set default '2000-01-01'::timestamptz;");assert.throws(()=>transport.rpc('read_state',['lab']),/failed/);sql('alter table public.learning_releases alter column created_at set default now();');
  ok('expired request rolls back; unreviewed catalog changes fence all controller reads');

  console.log(JSON.stringify({passed,denials,managedInstaller,ensureRls:!!ensureRlsFile,productionApplied:false,productionReady:false,labOnly:true,maintenanceActivationTested:true,maintenanceRecoveryTested:true,repeatableGovernance:{firstActivationRecoveryDeclared:false,finalEpoch:recovered.active.governanceEpoch,finalGeneration:recovered.active.generation,catalog:repeatableCatalog},evaluationEvidence:'hypothetical-fixtures-only',actualArtifactBindings:!!actual,recoveryArtifactBinding:'synthetic-fixture-only',baselineConfigHash:baseline.configHash,candidateConfigHash:candidate.configHash,verifierHash:plan.verifierHash,evidenceDirectory:dir}));
}finally{
  if(attemptedStart){
    const status=run(bin('pg_ctl'),['-D',data,'status']);
    if(status.status===0)pass(run(bin('pg_ctl'),['-D',data,'-m','fast','-w','-t','20','stop']),'stop');
    else assert.equal(status.status,3,'Could not confirm the disposable PostgreSQL process is stopped');
  }
  if(port)await new Promise((resolve,reject)=>{const s=net.connect({host:'127.0.0.1',port});s.once('connect',()=>{s.destroy();reject(Error('Disposable port remains open'));});s.once('error',resolve);});
  for(const name of ['server.key','server.crt']){const p=path.join(dir,name);if(fs.existsSync(p))fs.unlinkSync(p);}
  if(fs.existsSync(path.join(data,'TOS_DISPOSABLE_REHEARSAL'))){
    const resolved=fs.realpathSync(data),root=fs.realpathSync(scratch);
    assert.equal(resolved,path.resolve(data));assert.ok(resolved.startsWith(root+path.sep));
    assert.equal(fs.readFileSync(path.join(resolved,'TOS_DISPOSABLE_REHEARSAL'),'utf8'),'governance-control-v1');
    fs.rmSync(resolved,{recursive:true,maxRetries:3,retryDelay:100});
  }
  console.log('Disposable PostgreSQL stopped; port closed; ephemeral TLS keys and marked data removed');
}})().catch(e=>{console.error(e);process.exitCode=1;});
