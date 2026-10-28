# Smart Incident Response and Service On-Call Backend

## Demo data

The repeatable, fictional demo-data seeder and isolated-test instructions are
documented in [docs/demo-data.md](docs/demo-data.md). Run it against the main
application databases only after the isolated test seeding command passes.
Use `npm run seed:demo:test` for the guarded isolated-database verification and
`npm run seed:demo` for the interactively confirmed application-database run.

## Initial admin setup

1. Configure the PostgreSQL connection and set `JWT_SECRET` in the local `.env`
   file to a securely generated random value of at least 32 characters. Do not
   commit `.env` or place real credentials in `.env.example`.
2. Apply the existing PostgreSQL schema in `src/database/schema.sql`.
3. Run `npm run bootstrap:admin` from an interactive terminal. The command
   prompts for the initial admin name and email, then requests and confirms the
   password without echoing it. It accepts no credentials through command-line
   arguments or environment variables.

Bootstrap takes a PostgreSQL advisory transaction lock and succeeds only when
`app_user` contains no rows. The password must be at least 12 characters and no
more than 72 UTF-8 bytes. It is stored only as a bcrypt hash. The bootstrap
command is intended for first-time setup, not routine admin creation.

## Authentication and user permissions

`POST /api/auth/login` accepts `{ "email": "...", "password": "..." }` and
returns a short-lived bearer access token. Send it as
`Authorization: Bearer <accessToken>` to protected endpoints. Each request
checks that the account is still active and obtains its current role/team from
PostgreSQL, so deactivated accounts and stale role claims do not retain access.

Supported roles are `admin`, `manager`, and `engineer`:

- Admins can list, retrieve, create, update, and deactivate users. Only admins
  can assign or change roles and teams.
- Managers can list users in their own team, retrieve and update users in that
  team, create engineers in that team, and deactivate other users in that team.
- Engineers can retrieve and update their own profile, including changing
  their password. They cannot list users, change roles or teams, or deactivate
  accounts.
- Accounts cannot deactivate themselves. Admins cannot demote or deactivate
  their own account.

User responses omit password hashes. A supplied password is bcrypt-hashed
before insert/update; plaintext passwords are never stored or returned.

## Team endpoints

All `/api/teams` endpoints require a bearer token. Admins may list and retrieve
all teams and may create, update, and delete teams. Managers and engineers may
list and retrieve only their own team's record; engineers cannot manage teams.
Managers may update only their own team's record, and a manager without a team
is denied team access. An engineer without a team receives an empty list.
Deletion is subject to the foreign-key behavior in the unchanged PostgreSQL
schema.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/teams` | List teams |
| `GET` | `/api/teams/:teamId` | Retrieve a team |
| `POST` | `/api/teams` | Create a team (admin only) |
| `PATCH` | `/api/teams/:teamId` | Update a team (admin or own-team manager) |
| `DELETE` | `/api/teams/:teamId` | Delete a team (admin only) |

## User endpoints

All `/api/users` endpoints require a bearer token:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/users` | List users (admin: all; manager: own team) |
| `GET` | `/api/users/:userId` | Retrieve an authorized user |
| `POST` | `/api/users` | Create a user (admin or manager) |
| `PATCH` | `/api/users/:userId` | Update permitted profile fields |
| `PATCH` | `/api/users/:userId/deactivate` | Deactivate an account (admin or manager) |

Creation accepts `name`, `email`, `password`, optional `teamId`, and an optional
`role` (admin only may assign a role). Updates accept `name`, `email`,
`password`, `teamId`, `role`, and `isActive`, subject to the permissions above.
Team IDs are checked against the existing `team` table. Duplicate email
addresses return `409 Conflict`.

## Service endpoints

All `/api/services` endpoints require a bearer token:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/services` | List services available to the caller |
| `GET` | `/api/services/:serviceId` | Retrieve a service |
| `POST` | `/api/services` | Create a service (admin or manager) |
| `PATCH` | `/api/services/:serviceId` | Update a service (admin or own-team manager) |
| `PATCH` | `/api/services/:serviceId/deactivate` | Deactivate a service without deleting it |

Admins can manage services for any team. Managers can manage services only in
their own team; managers without a team cannot list or manage services.
Engineers can view active services assigned to their team but cannot create,
update, or deactivate services. Engineers without a team see no services.
Admins and managers may list and retrieve inactive services; engineers cannot.

Service names are globally unique according to the PostgreSQL schema. Creation
accepts `name`, optional `description`, optional `criticality` (`low`, `medium`,
`high`, or `critical`; defaults to `medium`), and optional `teamId`. Admins may
create unassigned services; managers create only in their assigned team.
Deactivation sets `is_active` to false and retains the service row for
historical references.

## Environment endpoints

All `/api/environments` endpoints require a bearer token:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/environments` | List environments |
| `GET` | `/api/environments/:environmentId` | Retrieve an environment |
| `POST` | `/api/environments` | Create an environment (admin or manager) |
| `PATCH` | `/api/environments/:environmentId` | Update an environment (admin or manager) |

Admins and managers can manage environments. Engineers can list and retrieve
them but cannot create or update them. Environment names are globally unique;
creation requires a 1-100 character `name` and accepts an optional
`description` string or `null`.

Environment deactivation is not supported: the existing `environment` table
has no activation column, and its schema is intentionally unchanged.

## Automated API integration tests

The project uses Node's built-in test runner for the regular unit/API tests.
No Postman collection, Postman CLI, or Newman dependency is required. To run
the live API integration suite:

```powershell
npm run test:api
```

This opt-in suite starts its own backend process on an available local port and
uses the existing PostgreSQL and MongoDB drivers. It refuses to run unless
`API_TEST_PG_DATABASE` names a dedicated database with a `test_` prefix or
`_test`/`_testing` suffix, and that database differs from `PG_DATABASE` loaded
by the normal app configuration. `API_TEST_MONGO_URI` must point to a MongoDB
database with the same test-only naming convention and differ from the normal
`MONGO_URI` database. The PostgreSQL test database must already have the 13
tables from `src/database/schema.sql` plus the `incident_escalation_execution`
table created by migration
`src/database/migrations/001_incident_escalation_execution.sql` (14 tables
total); the suite never creates or changes schema.

Follow [the isolated API integration test setup guide](docs/api-integration-testing.md)
to provision dedicated databases and configure the four required variables
without saving credentials to tracked files.

The suite logs in as that existing admin, creates uniquely named fixtures only
through the APIs, checks PostgreSQL rows and MongoDB `incident_events`
independently, exercises user listing/retrieval and role boundaries,
service/environment/incident creation, incident history and assignments,
escalation policies and levels, on-call schedules and assignments, validation,
and team-scoped permissions, then removes only its own records and verifies
cleanup against the database table-count baseline.
The initial test administrator is a prerequisite and is deliberately retained.
MongoDB and PostgreSQL are not covered by a shared atomic transaction; the
existing unit tests cover injected database/event failures, while the live
suite verifies successful event persistence.

## Incident endpoints

All `/api/incidents` endpoints require a bearer token:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/incidents` | List incidents in the caller's authorized scope |
| `GET` | `/api/incidents/:incidentId` | Retrieve one in-scope incident |
| `POST` | `/api/incidents` | Create an incident for an active service |
| `PATCH` | `/api/incidents/:incidentId` | Update permitted incident fields |

Admins can access incidents across teams. Managers and engineers are scoped
through `incident.service_id` to the service's `team_id`; unassigned services
are not visible to non-admins. Managers without a team are denied incident
listing and retrieval. Engineers without a team receive an empty list and
cannot create incidents. Admins may create incidents for any active service;
managers and engineers may create incidents only for an active service in
their own team.

Creation requires `serviceId`, `environmentId`, and `title`. It also accepts
optional `description` (string or `null`), `severity` (`SEV1` through `SEV5`,
default `SEV3`), `priority` (`P1` through `P5`, default `P3`), and `status`
(`open`, `acknowledged`, `investigating`, `mitigated`, `resolved`, or `closed`;
default `open`). Updates accept `title`, `description`, `severity`, `priority`,
and `status`. Engineers may update only `status`; managers and admins may
update all listed fields. Creator, resolver, and timestamps are server
managed. Acknowledgement and resolution timestamps are maintained when status
changes. Invalid fields or values return `400`; missing or out-of-scope
incidents return `404`.

Incidents are stored in PostgreSQL using the existing `incident` table.
Creation and permitted field updates also append flexible event documents to
MongoDB's `incident_events` collection. If event logging fails, the PostgreSQL
transaction rollback is attempted and the endpoint returns `503`. Other
PostgreSQL failures return `500`; when a MongoDB event was already written,
the service attempts to remove it. Rollback or compensation failures are
logged for operator follow-up. PostgreSQL and MongoDB do not support a shared
atomic transaction, so an infrastructure failure may leave the final outcome
uncertain and must not be treated as cross-database atomicity.

Incident assignment, escalation-policy management, and on-call schedule
management are provided by separate endpoints documented below. Incidents do
not have a delete endpoint. Automatic escalation execution is implemented by
the PostgreSQL-backed worker described in
[docs/automatic-escalation.md](docs/automatic-escalation.md). It polls eligible,
unresolved incidents, applies levels in order after cumulative `wait_minutes`,
and persists attempts so failed work can be retried and completed work survives
restarts. The worker requires the additive escalation-execution migration and
uses the one active policy for the incident service's team; ambiguous multiple
active policies are skipped and logged. Notifications are development-only
structured logs, not email or SMS delivery. The original 13-table schema is
unchanged; the separate migration adds the execution table.

## Incident assignment endpoints

All `/api/incident-assignments` endpoints require a bearer token:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/incident-assignments` | List assignments for accessible incidents |
| `GET` | `/api/incident-assignments/:assignmentId` | Retrieve an in-scope assignment |
| `POST` | `/api/incident-assignments` | Assign an eligible user to an incident |
| `PATCH` | `/api/incident-assignments/:assignmentId` | Change an active assignment's type |
| `PATCH` | `/api/incident-assignments/:assignmentId/unassign` | Set `unassigned_at`, retaining history |

Assignment creation accepts required `incidentId` and `userId`, plus optional
`assignmentType` (1-50 characters; defaults to `responder`). Updating accepts
only `assignmentType`. Assignment IDs and referenced IDs must be positive
integers. Assignments are not physically deleted.

Admins may read and manage assignments across teams and may assign an active
user from any team. Managers may read and manage assignments only for incidents
whose service belongs to their own team, and may target only active users in
that team. Engineers may list and retrieve assignments for incidents in their
own team but cannot create, change, or unassign them. Managers without a team
are denied access; engineers without a team see an empty list and cannot
retrieve assignments.

The existing `incident_assignment` schema has no uniqueness constraint on
incident/user pairs, so duplicate assignment records are permitted and retained
as written. It stores `assignment_id`, `incident_id`, `user_id`, `assigned_at`,
`unassigned_at`, and `assignment_type`; the latter defaults to `responder`.
Its foreign keys reference `incident` and `app_user`, with incident deletion
cascading and user deletion restricted. Its check constraint requires
`unassigned_at` to be null or no earlier than `assigned_at`.

Assignment creation, type changes, and unassignment also append events to
MongoDB's `incident_events` collection. MongoDB write failures cause a
PostgreSQL rollback attempt and return `503`. Other PostgreSQL failures return
`500`; if the Mongo event was already written, event removal is attempted.
Rollback and compensation failures are logged. PostgreSQL and MongoDB do not
share an atomic transaction, so cross-database outcomes can be uncertain during
infrastructure failures.

## Incident update history endpoints

All incident update history endpoints require a bearer token:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/incidents/:incidentId/updates` | List an incident's updates in chronological order |
| `GET` | `/api/incidents/:incidentId/updates/:updateId` | Retrieve one update belonging to that incident |
| `POST` | `/api/incidents/:incidentId/updates` | Append an update to an accessible incident |

Creation accepts required `message` (1-10,000 characters after trimming) and
optional `status`. Status may be `null` or one of `open`, `acknowledged`,
`investigating`, `mitigated`, `resolved`, or `closed`. The authenticated user's
ID and creation timestamp are server-managed. The optional status is recorded
only on the history entry; it does not change the incident's current status.
Admins, managers, and engineers
may append updates to incidents they can access; managers and engineers are
limited to incidents whose service belongs to their team. Users without a team
do not gain broader access. Existing update history is append-only through
this API; editing and deletion endpoints are not provided.

The existing `incident_update` table contains `update_id`, `incident_id`,
`user_id`, nullable `status`, required `message`, and `created_at`. Its foreign
keys reference `incident` (cascade on incident deletion) and `app_user`
(restrict on user deletion). The table defines no status check constraint;
the API accepts only the incident statuses listed above, plus `null`.

Each created update also appends an event to MongoDB's `incident_events`
collection. Mongo write failure triggers a PostgreSQL rollback attempt and
returns `503`. Other PostgreSQL failures return `500`; after a Mongo event has
been written, compensation is attempted. Rollback and compensation failures
are logged. PostgreSQL and MongoDB do not share an atomic transaction, so
infrastructure failures can leave the final outcome uncertain.

## Escalation policy and level endpoints

All `/api/escalation-policies` endpoints require a bearer token:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/escalation-policies` | List policies in the caller's authorized scope |
| `GET` | `/api/escalation-policies/:policyId` | Retrieve an in-scope policy |
| `POST` | `/api/escalation-policies` | Create a policy |
| `PATCH` | `/api/escalation-policies/:policyId` | Update a policy |
| `DELETE` | `/api/escalation-policies/:policyId` | Delete a policy and its levels |
| `GET` | `/api/escalation-policies/:policyId/levels` | List the policy's levels |
| `GET` | `/api/escalation-policies/:policyId/levels/:levelId` | Retrieve a level belonging to that policy |
| `POST` | `/api/escalation-policies/:policyId/levels` | Create a policy level |
| `PATCH` | `/api/escalation-policies/:policyId/levels/:levelId` | Update a level belonging to that policy |
| `DELETE` | `/api/escalation-policies/:policyId/levels/:levelId` | Delete a level belonging to that policy |

Admins can read and manage policies across teams. Managers can read and manage
policies only for their own team; policy creation assigns the manager's team,
and managers cannot change policy ownership. Engineers may read policies and
levels in their own team, but only while the policy is active; they cannot
mutate them. Admins and managers can also read inactive policies. Managers
without a team are denied access; engineers without a team see no policies and
cannot retrieve individual policies or levels. Out-of-scope or engineer-hidden
inactive records are reported as not found.

Policy creation requires `name` and, for admins, `teamId`; it accepts optional
`description` (string or `null`) and `isActive` (boolean). Policy updates accept
any non-empty subset of those fields. Only admins may provide or change
`teamId`. Level creation requires `levelNumber` (positive 32-bit integer),
`targetType` (non-empty string up to 50 characters), and `targetId` (positive
integer); `waitMinutes` is an optional non-negative 32-bit integer defaulting
to 5. Level updates accept a non-empty subset of those fields. Unknown request
properties are rejected. A repeated level number within the same policy
returns `409 Conflict`; policy names are not unique in the existing schema, so
same-named policies are allowed.

The existing `escalation_policy` table stores `policy_id`, required `team_id`,
required `name`, nullable `description`, and `is_active` (default true). Its
team foreign key cascades on team deletion. The existing `escalation_level`
table stores `level_id`, required `policy_id`, `level_number`, `target_type`,
`target_id`, and `wait_minutes` (default 5). Level numbers must be at least 1,
wait minutes must be non-negative, and `(policy_id, level_number)` is unique.
Deleting a policy cascades to its levels; deleting a level removes only that
level. The schema does not constrain `target_type` to an enum and `target_id`
has no foreign key, so the API validates their formats but cannot verify that
a target exists or belongs to a particular target table. These policy
endpoints store configuration; automatic execution and on-call target
resolution are handled by the separate worker documented in
[docs/automatic-escalation.md](docs/automatic-escalation.md). Policy
configuration uses PostgreSQL only; MongoDB incident event logging is not used
for policy changes.

## On-call schedule and assignment endpoints

All `/api/on-call-schedules` endpoints require a bearer token:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/on-call-schedules` | List schedules in the caller's authorized scope |
| `GET` | `/api/on-call-schedules/:scheduleId` | Retrieve an in-scope schedule |
| `POST` | `/api/on-call-schedules` | Create a schedule |
| `PATCH` | `/api/on-call-schedules/:scheduleId` | Update a schedule |
| `DELETE` | `/api/on-call-schedules/:scheduleId` | Delete a schedule and its assignments |
| `GET` | `/api/on-call-schedules/:scheduleId/assignments` | List assignments for an in-scope schedule |
| `GET` | `/api/on-call-schedules/:scheduleId/assignments/:assignmentId` | Retrieve an assignment belonging to that schedule |
| `POST` | `/api/on-call-schedules/:scheduleId/assignments` | Add a user assignment |
| `PATCH` | `/api/on-call-schedules/:scheduleId/assignments/:assignmentId` | Update an assignment |
| `DELETE` | `/api/on-call-schedules/:scheduleId/assignments/:assignmentId` | Delete an assignment |

Admins can read and manage schedules across teams. Managers can read and
manage schedules only for their team; creating a schedule assigns the
manager's team, and managers cannot provide or change `teamId`. Engineers can
read schedules and assignments for their own team but cannot mutate them.
Managers without a team are denied access; engineers without a team receive
no unrestricted access. Assignment operations verify both schedule scope and
that the assignment belongs to the schedule in the URL.

Schedule creation requires `name` (1-150 characters), `rotationType`
(1-50 characters), and `startDate` (`YYYY-MM-DD`). Admins must also provide
`teamId`; managers' team is assigned automatically. `endDate` is optional
and may be `null`, but if present it must be on or after `startDate`.
Schedule updates accept a non-empty subset of those fields. Admins may change
`teamId` only while a schedule has no assignments; this prevents changing the
team ownership underneath existing assignees.

Assignment creation requires `userId`, `startTime`, and `endTime`. Times must
be ISO-8601 timestamps with a timezone (up to six fractional-second digits),
and `endTime` must be later than `startTime`. The user must be active and
belong to the schedule's team;
this team eligibility rule is enforced by the application because the schema
does not relate an assignment's user to its schedule's team. Assignment
updates accept a non-empty subset of those fields and revalidate any new
assignee. Unknown fields and malformed IDs/timestamps are rejected. Database
foreign-key and check-constraint violations return `400`; inaccessible or
missing records return `404`.

The existing `on_call_schedule` table stores `schedule_id`, required
`team_id`, required `name`, required `rotation_type`, required `start_date`,
and nullable `end_date`; its team foreign key cascades on team deletion and
`end_date` cannot precede `start_date`. The `on_call_assignment` table stores
`assignment_id`, required `schedule_id`, required `user_id`, `start_time`,
and `end_time`; schedule deletion cascades to its assignments, while deleting
a referenced user is restricted. The assignment check requires `end_time`
to be later than `start_time`.

The schema defines no uniqueness, overlap, or schedule-to-assignment date
constraint. Consequently, overlapping schedules and assignments (including
multiple simultaneous assignments for a user) are allowed; this API does not
infer a rotation or overlap policy. Deletes are physical, consistent with
these tables having no soft-delete/history columns. PostgreSQL multi-step
mutations use transactions; no escalation execution, notifications, or MongoDB
event logging is part of this module.

## Tests

- `npm test` runs the automated API tests.
- `npm run test:db` checks PostgreSQL and MongoDB connectivity.
