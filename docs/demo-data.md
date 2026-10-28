# Local demo data

The demo seeder adds fictional, prefixed records to the configured databases.
It does not drop, truncate, or delete data, and it does not update existing
records. The main command refuses test-named database targets and requires you
to type the configured PostgreSQL database name before making changes.
`NODE_ENV=production` is refused.

## Validate on isolated databases first

Provision a dedicated PostgreSQL database with the existing schema, a separate
MongoDB test database, and a test-only admin using the instructions in
[api-integration-testing.md](./api-integration-testing.md). The isolated
seeding command requires the four `API_TEST_*` settings in the current
PowerShell process. It confirms the PostgreSQL database identity and exact
13-table schema, checks that MongoDB is a differently named test database,
authenticates the test admin, verifies PostgreSQL relationships and MongoDB
incident events, and performs a second seed run to confirm idempotency.

Set the demo password and secret-bearing API settings only in the current
PowerShell process. The secure prompt helper below avoids echoing those values:

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
$env:API_TEST_MONGO_URI = Read-SecureValue 'Dedicated MongoDB test URI'
$env:API_TEST_ADMIN_EMAIL = Read-Host 'Dedicated test admin email'
$env:API_TEST_ADMIN_PASSWORD = Read-SecureValue 'Dedicated test admin password'
$env:DEMO_SEED_PASSWORD = Read-SecureValue 'Password to hash for demo accounts'
try {
  npm run seed:demo:test
  if ($LASTEXITCODE -ne 0) { throw 'Isolated demo seed verification failed.' }
} finally {
  Remove-Item Env:API_TEST_PG_DATABASE -ErrorAction SilentlyContinue
  Remove-Item Env:API_TEST_MONGO_URI -ErrorAction SilentlyContinue
  Remove-Item Env:API_TEST_ADMIN_EMAIL -ErrorAction SilentlyContinue
  Remove-Item Env:API_TEST_ADMIN_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:DEMO_SEED_PASSWORD -ErrorAction SilentlyContinue
}
```

The test command only accepts PostgreSQL names beginning with `test_` or ending
in `_test`/`_testing`, requires the MongoDB target to follow the same naming
rule, rejects targets matching the normal application databases, and never
creates databases or applies schema. It adds demo data to the isolated test
databases and deliberately does not delete it.

## Populate the configured local application databases

Only after the isolated run succeeds, set the demo password in the process
environment (use the secure helper above) and invoke:

```powershell
$env:DEMO_SEED_PASSWORD = Read-SecureValue 'Password to hash for demo accounts'
try {
  npm run seed:demo
  if ($LASTEXITCODE -ne 0) { throw 'Demo seeding failed.' }
} finally {
  Remove-Item Env:DEMO_SEED_PASSWORD -ErrorAction SilentlyContinue
}
```

The command uses the application database configuration loaded from `.env`,
not any `API_TEST_*` target. It asks for the PostgreSQL database name as an
interactive confirmation. It refuses database names matching the test-only
naming convention and refuses `NODE_ENV=production`. Do not change the normal
database settings to work around these safeguards.

The seeder verifies that the existing `user_id = 53`, `admin@smart.com` record
is present and never updates it. It creates a separate demo administrator,
then uses the existing authenticated API routes to create the rest of the
fixtures. User passwords are bcrypt-hashed by the existing user service. Tags
and incident-tag relationships use parameterized SQL because this API has no
tag routes. Incident, assignment, and update events are emitted by the
existing application services and verified in MongoDB; events are not
fabricated for pre-existing rows.

## Demo sign-ins

All demo accounts created by the seeder share the `DEMO_SEED_PASSWORD` value
provided on the initial seed run. The value is not generated, printed, saved in
`.env`, or included in this guide. Keep it in a password manager if it is
needed for local sign-in and provide the same value on future seed runs; the
seeder refuses to change existing demo account passwords.

Demo administrator:

- `demo.admin@smart-incident.example.invalid`

For each team key `platform`, `customer`, `data`, and `workplace`, the seeder
creates:

- `demo.manager.<team-key>@smart-incident.example.invalid`
- `demo.engineer.<team-key>.1@smart-incident.example.invalid`
- `demo.engineer.<team-key>.2@smart-incident.example.invalid`

The existing `admin@smart.com` account is not a demo account and its password
and credentials are never changed.

## Scope and persistence behavior

The seed set contains four teams, thirteen demo accounts (one admin, four
managers, eight engineers), eight services, four environments, twenty
incidents, incident assignments and two append-only updates per incident, four
two-level escalation policies, four schedules with two eligible assignments
each, eight tags, and incident-tag associations.

Stable `DEMO |` names, incident titles, and demo emails make reruns idempotent.
Existing matching records are verified and counted; conflicting records are
left untouched and cause the seeder to stop. API writes commit as separate
operations, so an interruption can leave a partial seed; rerun is safe after
resolving any reported conflict. PostgreSQL and MongoDB do not share an atomic
transaction. The normal application API's existing transaction and
compensation behavior is used for incident event writes.
