# Separated controller: local rehearsal

This directory implements the approved **local** controller boundary. Nothing here
has been installed in production. The same generated forward SQL artifact used in
rehearsal requires explicit, separately reviewed installer pins before any DDL. There is no
signing command, HTTP endpoint, deployment command, bootstrap route or app-held
controller credential.

`controller.js` verifies an independent externally configured Ed25519 owner key,
the exact reviewed governance plan, source/runtime measurement callback, current
database destination and active state. The installer supplies reviewer public keys
once at construction; activation evidence cannot supply its own trusted keys.
Inputs and attachment bytes are copied before asynchronous work. The caller must
use an immutable separately installed source tree and a measured executable; the
measurement callback is a trusted installation dependency, not evidence supplied
by a release requester. `tools/maintenance-artifact-manifest.js` supplies byte and
actual Node executable measurements. Include the controller, complete transitive
verifier imports, vendor files, and all control migrations in that reviewed
inventory. Every build manifest used for publication must contain
`artifacts/release-build`, the byte length and SHA-256 of the complete build
artifact. Publication compares the two evidence artifact hashes and byte lengths
to the signed descriptors. The reserved `artifacts/release-build` entry accepts
complete archives up to 256 MiB. Ordinary files and ordered migration inventories
retain the 64,000,000-byte file limit. Completeness
requires review; hashing a supplied list does not establish completeness.

`transport.js` accepts an explicit restricted database login, password, trusted CA
file and psql executable. It sets `sslmode=verify-full`, disables GSS encryption
negotiation and ambient client certificate use, has no Data API fallback,
does not inherit PG service/connection settings, disables psql startup files, and
dispatches only the fixed state, receipt, adoption, activation and recovery RPCs.
Arguments are UTF-8 hex encoded.
Deployment must separately pin/protect psql, libpq and their native dependencies,
CA roots, network destination, installation files and credential provisioning.
These files are not a production service supervisor or secret-store integration.

The NOLOGIN owner owns private control objects and the four real public release
tables. The controller receives no table writes or ownership. The migration removes
all non-superuser table and column grants, all overloads of known release RPCs and
bootstrap-named public routines. `service_role` retains SELECT on the public release
tables so existing application reads can continue. Superusers, migration/provider
administrators and a compromised controller remain outside this trust boundary.

`catalog.sql` inventories role attributes/memberships, namespaces, user relations,
columns and column defaults, routines, policies, triggers, rules, default ACLs,
database ACL/settings, languages, types, operators, casts, collations, extensions
and constraints. Foreign tables require a separate dependency audit and are refused.
Installation requires all four session settings, with no defaults: `tos.expected_database`
must match `current_database()`, `tos.expected_installer_role` must match both
`session_user` and `current_user`, `tos.expected_server_version_num` must match the
exact PostgreSQL 17 server version number, and `tos.reviewed_catalog_hash` must
match an independently reviewed preinstallation inventory. A `SET ROLE` identity
change is refused. Database identifiers are quoted by PostgreSQL for the database
privilege change. Hostname, CA roots, administrator credentials, and authorization
to install remain separately reviewed installer configuration. These settings
protect the installation target; they are not owner release approval or a grant
of database authority. Missing/mismatched pins fail before DDL. The installed
catalog is pinned and remeasured by every public controller RPC. Unknown catalog
changes fail closed. This is a conservative supported-object inventory, not proof
against an administrator or an exhaustive audit of every PostgreSQL extension,
foreign service, provider-managed component, or dynamic SQL effect. Review the
catalog contents and external dependencies before any future production proposal.

On managed PostgreSQL 17, the non-superuser installer needs database ownership,
authority to create the two release roles, and read access to the catalog pin
after removing owner access. The managed fixture models that read access with
`pg_read_all_data` and `BYPASSRLS`. The installer takes temporary
owner-role access and briefly grants the owner `CREATE` on `public` to transfer
the release tables. The forward migrations also use temporary owner access.
The transaction removes these privileges and verifies the catalog in its final
state before committing. PostgreSQL retains its automatic `ADMIN` membership
for the role creator. This trusted installer can administer the roles, while
ordinary application roles and the controller remain outside the owner role.

Adoption locks the authorization ID, registry, and active release row. It
requires the exact unhalted snapshot and advances governance by one epoch.
Version 4 binds the starting epoch, the evidence standard, and a new owner
signature purpose. Historical version 3 adoption envelopes remain valid from
epoch zero for the original plan format.
`installedMigrationManifestHash` identifies the proxy's complete migration file
inventory; it does not alone prove installed schema. Control SQL is included in
the verifier measurement and installed SQL definitions are covered by the catalog.

Activation requires the adopted epoch and baseline/candidate pair, full evidence
recomputed under the adopted standard, independent owner authorization, a second owner
control envelope binding destination/epoch/head/plan/authorization/release/event,
and a verified online audit event. SQL rechecks state under locks and executes a
private copy of the legacy validation/publication transaction with maintenance
evidence semantics. Release generation increments once. Events, consumptions and
pointers commit atomically; expiry is checked after waits and publication.

The optional recovery migration must be installed before adoption, using all four
installer pins. Its catalog pin must match the independently reviewed, already
pinned catalog of the installed separated controller. The migration adds only a
restricted recovery RPC and measures the resulting catalog in the same transaction.
The archive limit migration follows it and must also be installed before adopting
a plan with a larger archive. The controller checks for the installed limit before
consuming such a plan. The migration retains the recovery function's grants and
remeasures the reviewed catalog.

Install the repeatable governance migration after the archive limit migration.
Apply it outside an enclosing transaction so it can select a repeatable read
snapshot. Set `tos.reviewed_catalog_hash` to the independently reviewed catalog
after installing the first three migrations. This value must match the existing
stored catalog pin and the catalog measured under lock. Save the new pin after
installation. Later adoption requires ledger evidence that the preceding plan
published its candidate or recovered release. The incoming baseline archive
must match the published SHA-256 and byte count.

The initial adoption plan may bind one recovery build with its own exact release
configuration and complete artifact manifest. Its recovery edge starts at the
activated candidate, uses the same database schema and migration inventory,
and allows only a change to the server pipeline fingerprint. A recovery attempt
needs fresh independent owner authorization, a recovery-specific control
signature, and full maintenance-final evidence for the candidate-to-recovery
pair when that is the adopted standard. Version 4 also accepts
`maintenance-dependency/v1` with the complete evidence package and externally
configured model rates. It publishes the declared backup as the next generation
in the same epoch. The approved first activation omits a recovery declaration.
Subsequent version 4 plans require one.

Exact committed retries return the stored result even after expiry. Changed
content under the same authorization ID fails. A failed transaction leaves the
active pointer, events and consumed authorizations intact. If the response is
lost after commit, reconcile by submitting the exact request again. The epoch
and prior audit history are retained. Legacy activation, bootstrap and rollback
routes remain fenced.

For a later operator cutover, close user ingress and drain all old proxy instances
before switching the active release. Unexpired session pins can still reach a
surviving old proxy. Reopen ingress only after the intended image is serving the
matching active release. Rehearse these hosting steps separately with both exact
images. The local database tests exercise the publication contract with fixture
backup artifacts and fixture signatures.

Run `tests/release-control-db.test.js` on Windows or Linux with explicit absolute
paths for the PostgreSQL 17.11 bin directory, scratch directory, proxy source and
native OpenSSL executable. On Linux, run as a non-root user and use scratch on a
native filesystem that enforces Unix permissions. For WSL, use storage inside the
distro. The same command takes the platform's native paths:

```text
node tests/release-control-db.test.js <pg-bin> <scratch> <proxy-source> <openssl> [artifact-directory|-] [supabase-cli]
```

The optional artifact directory must contain verifier inputs measured for the
actual source bytes and Node executable on this platform. With no artifact
directory, the harness uses synthetic build inputs. The optional Supabase CLI
runs security advisors against the disposable database. Use `-` to supply the
CLI with synthetic build inputs. `--preflight-only` stops after installation and
catalog checks (and advisors if supplied), before activation testing.
`--managed-installer` runs all four migrations through a separate non-superuser
`postgres` login with the observed managed role memberships and public schema
ownership. It checks that an installation failure rolls back and that temporary
owner access is gone after every migration. The bootstrap fixture account handles
test data and ephemeral credentials. For WSL, supply the saved production RLS
function as `--ensure-rls-file=<absolute-path>` in managed-installer mode. The
harness checks its hash and verifies the trigger while modeling the managed
role grants. Rehearse hosted behavior under separate approval.

The harness creates a unique marked scratch cluster, binds TCP to loopback only,
and disables Unix sockets. It uses separate ephemeral SCRAM passwords and checks
that the application and controller credentials cannot be exchanged. It verifies
data directory, version, address and TLS, checks all missing or wrong installer
pins before DDL, applies the archived release and bootstrap SQL and the forward
migrations, then runs the final installed denial matrix and recovery tests.
The harness never accepts a database URL, host or port from the caller; it always
creates its own disposable loopback cluster. Lab restrictions belong to this
harness, so rehearsal and a separately approved future installation use identical
SQL bytes. It stops PostgreSQL in `finally`, verifies the port is closed, and removes
ephemeral TLS private keys and marked database data. Synthetic observed evidence and fixture owner signatures exercise
contracts only; they never certify real model evaluation or authorize production.

Forward SQL was scaffolded with the existing Supabase CLI using `migration new`.
No dependency was installed and no historical proxy migration was rewritten.
Production catalog review, credential retirement, hosting separation, network/TLS
policy, paid evaluation, actual owner signing, cutover and deployment remain later
explicit approvals.
