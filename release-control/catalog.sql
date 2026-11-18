-- PostgreSQL 17 fail-closed inventory. OIDs intentionally bind one database.
-- Review the inventory, not merely a hash supplied by the same untrusted caller.
-- Covers the supported object classes below and role/membership/default privilege paths.
select encode(sha256(convert_to(jsonb_build_object(
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
)::text,'UTF8')),'hex');
