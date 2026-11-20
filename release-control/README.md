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
verifier imports, vendor files, and this SQL in that reviewed inventory. Both signed
source manifests must contain `artifacts/release-build`, the byte length and SHA-256
of the complete build artifact. Activation compares both evidence artifact hashes
and byte lengths to these signed descriptors. Completeness
requires review; hashing a supplied list does not establish completeness.

`transport.js` accepts an explicit restricted database login, password, trusted CA
file and psql executable. It sets `sslmode=verify-full`, disables GSS encryption
negotiation and ambient client certificate use, has no Data API fallback,
does not inherit PG service/connection settings, disables psql startup files, and
only dispatches four fixed RPC signatures. Arguments are UTF-8 hex encoded.
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

Adoption locks authorization ID, registry and the real active-release row. It
requires the exact unhalted generation/head/configuration and epoch zero, stores
the approved plan, and advances governance only. It does not activate the candidate.
`installedMigrationManifestHash` identifies the proxy's complete migration file
inventory; it does not alone prove installed schema. Control SQL is included in
the verifier measurement and installed SQL definitions are covered by the catalog.

Activation requires epoch one, the adopted baseline/candidate pair, full recomputed
maintenance-final evidence, independent owner release authorization, a second owner
control envelope binding destination/epoch/head/plan/authorization/release/event,
and a verified online audit event. SQL rechecks state under locks and executes a
private copy of the legacy validation/publication transaction with maintenance
evidence semantics. Release generation increments once. Events, consumptions and
pointers commit atomically; expiry is checked after waits and publication.

Exact committed retries recover the durable result even after expiry. Changed
content under the same authorization ID fails. Failure before commit rolls back.
Failure after commit is recovered by exact replay, never resetting the epoch.
Legacy activation, baseline bootstrap and old rollback APIs remain fenced. This
implementation permits only the adopted first maintenance pair and explicitly
rejects rollback actions; a later application rollback needs a separately reviewed
current-standard artifact and recovery design under the current epoch.
Never restore legacy grants or lower governance epoch as an operational rollback.

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

The harness creates a unique marked scratch cluster, binds TCP to loopback only,
and disables Unix sockets. It uses separate ephemeral SCRAM passwords and checks
that the application and controller credentials cannot be exchanged. It verifies
data directory, version, address and TLS, checks all missing or wrong installer
pins before DDL, applies the archived release and bootstrap SQL and the forward
SQL, then runs the final installed denial matrix.
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
