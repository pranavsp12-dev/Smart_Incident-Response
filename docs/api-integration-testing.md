# Isolated API integration test setup

The live suite is opt-in and must use databases dedicated to testing. It never
creates databases or applies schema. Do not point it at the normal
`smart_incident` PostgreSQL database or the normal MongoDB database.

## 1. Provision dedicated test databases

Ask the database administrator for access if you do not have permission to
create separate databases. Use distinct test-only names, for example:

- PostgreSQL: `smart_incident_test`
- MongoDB: `smart_incident_logs_test`

The PostgreSQL test database must be initialized separately with the existing
13-table schema and the additive escalation-execution migration:

```powershell
createdb smart_incident_test
psql --set ON_ERROR_STOP=on --dbname=smart_incident_test --file=src/database/schema.sql
psql --set ON_ERROR_STOP=on --dbname=smart_incident_test --file=src/database/migrations/001_incident_escalation_execution.sql
```

These commands explicitly target `smart_incident_test`; do not substitute the
normal application database. If that dedicated database already exists, do not
drop or reset it. Have its owner verify its contents and provision a fresh
isolated test database if a clean setup is needed.

Create the initial test administrator only in this empty test database. The
bootstrap command prompts for the name, email, and password without echoing the
password:

```powershell
$env:PG_DATABASE = 'smart_incident_test'
npm run bootstrap:admin
Remove-Item Env:PG_DATABASE
```

If bootstrap reports that users already exist, do not delete them; use an
authorized existing test administrator or have the test database owner arrange
a fresh, isolated test database. Keep the normal `PG_DATABASE`, `MONGO_URI`,
database credentials, and `JWT_SECRET` in `.env` unchanged.

## 2. Set the test-only process variables

Use a PowerShell session and set variables only for that process. Do not add
them to `.env.example`, source files, shell scripts committed to the project,
or logs. The examples below prompt securely for the admin password and MongoDB
URI; the values are held in process memory only.

```powershell
function Read-SecureValue {
  param([string]$Prompt)
  $secure = Read-Host -Prompt $Prompt -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

$env:API_TEST_PG_DATABASE = 'smart_incident_test'
$env:API_TEST_ADMIN_EMAIL = Read-Host 'Dedicated test admin email'
$env:API_TEST_ADMIN_PASSWORD = Read-SecureValue 'Dedicated test admin password'
$env:API_TEST_MONGO_URI = Read-SecureValue 'Dedicated MongoDB test URI'
```

`API_TEST_MONGO_URI` must select `smart_incident_logs_test` (or another
test-only database name). Do not reuse a URI that selects the normal MongoDB
database. A URI may contain database credentials, so do not echo it or place it
in command history.

Before running the suite, remove any process-level `PG_DATABASE` override so
the runner can compare the test target against the normal application
configuration loaded from `.env`. Then run and clear the variables:

```powershell
Remove-Item Env:PG_DATABASE -ErrorAction SilentlyContinue
try {
  npm run test:api
  if ($LASTEXITCODE -ne 0) {
    throw 'The API integration suite failed.'
  }
} finally {
  Remove-Item Env:API_TEST_PG_DATABASE -ErrorAction SilentlyContinue
  Remove-Item Env:API_TEST_MONGO_URI -ErrorAction SilentlyContinue
  Remove-Item Env:API_TEST_ADMIN_EMAIL -ErrorAction SilentlyContinue
  Remove-Item Env:API_TEST_ADMIN_PASSWORD -ErrorAction SilentlyContinue
}
```

The runner requires all four variables, enforces test-only PostgreSQL and
MongoDB names, rejects targets that match the normal application databases,
and checks that the PostgreSQL test database already has the 13 schema tables
plus `incident_escalation_execution`. It starts a temporary backend against
only those test targets with the escalation worker disabled to avoid modifying
pre-existing test fixtures. It does not alter the schema or create/drop
databases.

The regular unit tests and preflight safety tests do not connect to a database.
The PostgreSQL worker integration test is also discovered by the test runner,
but it clearly skips without its explicit opt-in and disposable-database
confirmation variables:

```powershell
npm test
```

## 3. Opt-in PostgreSQL worker concurrency test

The worker integration test uses real PostgreSQL transactions and two
independent worker instances. It inserts isolated test fixtures, verifies
concurrent execution uniqueness and schedule-date handling, then removes only
the fixture rows it created. It never creates, drops, resets, or seeds a
database, and it does not write to MongoDB.

Use a newly provisioned, disposable PostgreSQL database with a unique name
beginning `smart_incident_escalation_test_`. Never use the main database or an
existing shared test database. Confirm the target database is dedicated to
this test before setting the explicit confirmation variable:

```powershell
Remove-Item Env:PG_DATABASE -ErrorAction SilentlyContinue
$env:ESCALATION_TEST_PG_DATABASE = 'smart_incident_escalation_test_run_20261027a'
$env:ESCALATION_TEST_DISPOSABLE_CONFIRM = 'I_CONFIRM_THIS_IS_A_DISPOSABLE_ISOLATED_DATABASE'
$env:RUN_ESCALATION_PG_INTEGRATION = '1'

$databaseExists = psql --dbname=postgres --set ON_ERROR_STOP=on --tuples-only --no-align --command="SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = '$env:ESCALATION_TEST_PG_DATABASE');"
if ($LASTEXITCODE -ne 0) { throw 'Could not verify the scratch database name.' }
if ($databaseExists.Trim() -ne 'f') { throw 'Choose a different, unused scratch database name; do not reuse or reset an existing database.' }

createdb --maintenance-db=postgres $env:ESCALATION_TEST_PG_DATABASE
if ($LASTEXITCODE -ne 0) { throw 'Could not create the new scratch database; do not reuse or reset an existing database.' }
psql --set ON_ERROR_STOP=on --dbname=$env:ESCALATION_TEST_PG_DATABASE --file=src/database/schema.sql
if ($LASTEXITCODE -ne 0) { throw 'The schema setup failed; do not run the migration or integration test.' }
psql --set ON_ERROR_STOP=on --dbname=$env:ESCALATION_TEST_PG_DATABASE --file=src/database/migrations/001_incident_escalation_execution.sql
if ($LASTEXITCODE -ne 0) { throw 'The migration failed; do not run the integration test.' }
npm run test:escalation:integration
if ($LASTEXITCODE -ne 0) { throw 'The PostgreSQL worker integration test failed.' }
```

PostgreSQL connection host, port, and user settings come from the normal
environment configuration; the test explicitly overrides the database name
and refuses to use the configured application database. The test also requires
the exact confirmation value above. Do not put credentials in command
arguments or print connection settings. Do not substitute an existing
database if `createdb` reports that the requested name already exists; choose
another unique name after confirming it is unused.

Remove the opt-in variables after the run. The test leaves the disposable
database itself in place for inspection:

```powershell
Remove-Item Env:ESCALATION_TEST_PG_DATABASE -ErrorAction SilentlyContinue
Remove-Item Env:ESCALATION_TEST_DISPOSABLE_CONFIRM -ErrorAction SilentlyContinue
Remove-Item Env:RUN_ESCALATION_PG_INTEGRATION -ErrorAction SilentlyContinue
```

Without `RUN_ESCALATION_PG_INTEGRATION=1`, the integration test is clearly
skipped and performs no database connection or writes.
