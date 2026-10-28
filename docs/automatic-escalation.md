# Automatic escalation

The backend runs one PostgreSQL-backed escalation worker as part of
`npm start`. It polls every 30 seconds, and also performs a cycle at startup.
The worker can be stopped with Ctrl+C or the normal process termination signal;
shutdown waits for the current cycle before closing database connections.

## Required migration

The existing schema has no incident-to-policy reference or durable per-level
execution history. The worker therefore selects the one active policy attached
to the incident service's team and records each attempt in the additive
`incident_escalation_execution` table. Apply the migration separately to each
database that will run this application. The application does not run schema
migrations automatically.

For the main application database, review the target before running:

```powershell
psql --set ON_ERROR_STOP=on --dbname=smart_incident --file=src/database/migrations/001_incident_escalation_execution.sql
```

For an isolated API test database, apply the same migration only after
confirming its test-only target:

```powershell
psql --set ON_ERROR_STOP=on --dbname=smart_incident_test --file=src/database/migrations/001_incident_escalation_execution.sql
```

Do not run the migration on a database unless it is the intended target. Apply
it once; the migration deliberately fails if its table or indexes already
exist. Restart the backend after migration. If the migration is missing, the
API continues to start, but the worker logs an explicit startup error and does
not process escalations.

## Scheduling and eligibility

- Only `open`, `acknowledged`, `investigating`, and `mitigated` incidents are
  eligible. `resolved` and `closed` incidents are not processed.
- An incident uses the active escalation policy for its service's team only
  when exactly one active policy exists. No policy means no work; multiple
  active policies are treated as an ambiguous configuration and logged rather
  than guessed.
- Levels are processed by `level_number`, then `level_id`. Each level's
  `wait_minutes` is added cumulatively to the incident's `detected_at`.
- A level is not attempted until its computed due time. Failures are persisted
  and retried on later worker cycles. Successful level state persists across
  process restarts.
- `user` targets must identify an active user in the policy team. `team`
  targets must identify that same team and resolve to an active, current
  on-call assignee whose parent schedule includes the PostgreSQL session's
  `CURRENT_DATE` (start and end dates are inclusive), as well as an assignment
  whose start/end timestamps include the current time. Missing responders and
  invalid/stale targets are recorded as failed attempts and retried.
- The worker locks the incident row while it rechecks status, active policy,
  level progress, target availability, and active assignments. This serializes
  concurrent worker processes for a given incident. An already-active
  assignment to the same target is recorded as already assigned instead of
  creating a duplicate. A new escalation assignment closes the previous
  escalation-type assignment; manually created responder assignments are
  preserved.
- Successful assignments write `incident.escalation.applied` to MongoDB before
  PostgreSQL commits. If the transaction then fails, the Mongo event is
  compensated where possible. PostgreSQL execution rows preserve attempts,
  outcomes, failures, and notification state.

## Notifications

No email, SMS, or other delivery provider is configured. The current notifier
is intentionally a development-only structured log; it does not claim that a
message was delivered. Automatic escalation notifications are stored with the
execution row and retried if logging fails. Manual assignment create/update/
unassign operations use the same abstraction and report development logs after
their PostgreSQL/MongoDB transaction commits, but manual notification failures
are logged only and are not durably retried. Automatic logging is at-least-once:
the notifier runs before PostgreSQL commits the `logged` status, so a process
or commit failure can cause the same log to be emitted again. A stable
idempotency key is included for a future provider to honor; this is not an
exactly-once delivery guarantee.

Durable retries for manual assignment notifications need a small follow-up
outbox table written in the same PostgreSQL transaction as assignment
create/update/unassign. The existing escalation execution table is scoped to
one policy level per incident and is not a safe place to persist manual
assignment events.

Configure and test an actual delivery provider as a separate change before
relying on notifications operationally. No provider credentials are required
for this development implementation.
