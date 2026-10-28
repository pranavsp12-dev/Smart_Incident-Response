import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { env } from '../../src/config/env.js';
import { createEscalationWorker } from '../../src/services/escalations.worker.js';

const { Pool } = pg;
const requested = process.env.RUN_ESCALATION_PG_INTEGRATION === '1';
const databaseName = process.env.ESCALATION_TEST_PG_DATABASE;
const confirmation = process.env.ESCALATION_TEST_DISPOSABLE_CONFIRM;
const skipReason = requested
  ? false
  : 'Set RUN_ESCALATION_PG_INTEGRATION=1 with the explicit isolated-database confirmation to enable PostgreSQL writes.';
const isolatedDatabasePattern = /^smart_incident_escalation_test_[a-z0-9_]+$/i;
const requiredConfirmation = 'I_CONFIRM_THIS_IS_A_DISPOSABLE_ISOLATED_DATABASE';

async function createFixture(pool, prefix, targetType, dates, fixtureIds) {
  const team = (await pool.query(
    'INSERT INTO team (name) VALUES ($1) RETURNING team_id',
    [`${prefix}-team`]
  )).rows[0];
  fixtureIds.teamIds.push(team.team_id);

  const user = (await pool.query(
    `INSERT INTO app_user (team_id, name, email, password_hash, role)
     VALUES ($1, $2, $3, $4, 'engineer')
     RETURNING user_id`,
    [
      team.team_id,
      `${prefix} user`,
      `${prefix}@example.invalid`,
      await bcrypt.hash(randomUUID(), 4)
    ]
  )).rows[0];
  fixtureIds.userIds.push(user.user_id);

  const environment = (await pool.query(
    'INSERT INTO environment (name) VALUES ($1) RETURNING environment_id',
    [`${prefix}-environment`]
  )).rows[0];
  fixtureIds.environmentIds.push(environment.environment_id);

  const service = (await pool.query(
    'INSERT INTO service (team_id, name) VALUES ($1, $2) RETURNING service_id',
    [team.team_id, `${prefix}-service`]
  )).rows[0];
  fixtureIds.serviceIds.push(service.service_id);

  const incident = (await pool.query(
    `INSERT INTO incident (
       service_id, environment_id, title, created_by,
       detected_at, status
     )
     VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP - INTERVAL '1 hour', 'open')
     RETURNING incident_id`,
    [service.service_id, environment.environment_id, `${prefix} incident`, user.user_id]
  )).rows[0];
  fixtureIds.incidentIds.push(incident.incident_id);

  const policy = (await pool.query(
    'INSERT INTO escalation_policy (team_id, name) VALUES ($1, $2) RETURNING policy_id',
    [team.team_id, `${prefix}-policy`]
  )).rows[0];
  fixtureIds.policyIds.push(policy.policy_id);

  await pool.query(
    `INSERT INTO escalation_level (policy_id, level_number, target_type, target_id, wait_minutes)
     VALUES ($1, 1, $2, $3, 0)`,
    [policy.policy_id, targetType, targetType === 'team' ? team.team_id : user.user_id]
  );

  if (targetType === 'team') {
    const schedule = (await pool.query(
      `INSERT INTO on_call_schedule (team_id, name, rotation_type, start_date, end_date)
       VALUES ($1, $2, 'integration', $3, $4)
       RETURNING schedule_id`,
      [team.team_id, `${prefix}-schedule`, dates.startDate, dates.endDate]
    )).rows[0];
    fixtureIds.scheduleIds.push(schedule.schedule_id);
    await pool.query(
      `INSERT INTO on_call_assignment (schedule_id, user_id, start_time, end_time)
       VALUES ($1, $2, CURRENT_TIMESTAMP - INTERVAL '1 hour',
               CURRENT_TIMESTAMP + INTERVAL '1 hour')`,
      [schedule.schedule_id, user.user_id]
    );
  }

  return { incidentId: String(incident.incident_id), policyId: String(policy.policy_id) };
}

async function readExecution(pool, incidentId) {
  const result = await pool.query(
    `SELECT e.status, e.attempt_count,
            (SELECT COUNT(*)::int
             FROM incident_assignment ia
             WHERE ia.incident_id = e.incident_id) AS assignment_count
     FROM incident_escalation_execution e
     WHERE e.incident_id = $1`,
    [incidentId]
  );
  return result.rows;
}

test('independent PostgreSQL workers serialize escalation and honor schedule dates', {
  skip: skipReason
}, async () => {
  assert.equal(confirmation, requiredConfirmation,
    'Set the exact disposable-database confirmation before enabling this write test.');
  assert.match(databaseName || '', isolatedDatabasePattern,
    'ESCALATION_TEST_PG_DATABASE must use a unique smart_incident_escalation_test_* name.');
  assert.notEqual(databaseName, env.PG.DATABASE,
    'Refusing to use the normal application PostgreSQL database.');

  const pool = new Pool({
    host: env.PG.HOST,
    port: env.PG.PORT,
    database: databaseName,
    user: env.PG.USER,
    password: env.PG.PASSWORD,
    max: 4,
    connectionTimeoutMillis: 5000
  });
  const fixtureIds = {
    teamIds: [],
    userIds: [],
    environmentIds: [],
    serviceIds: [],
    incidentIds: [],
    policyIds: [],
    scheduleIds: []
  };
  const events = [];
  const prefix = `escalation-${randomUUID()}`;

  try {
    const identity = await pool.query(
      `SELECT current_database() AS database_name,
              to_regclass('public.incident_escalation_execution') IS NOT NULL AS migration_ready,
              CURRENT_DATE::text AS today,
              (CURRENT_DATE + 1)::text AS future_date,
              (CURRENT_DATE - 1)::text AS prior_date`
    );
    assert.equal(identity.rows[0].database_name, databaseName);
    assert.equal(identity.rows[0].migration_ready, true,
      'Apply the migration to this isolated database before running the test.');
    const { today, future_date: futureDate, prior_date: priorDate } = identity.rows[0];

    const concurrencyFixture = await createFixture(
      pool, `${prefix}-concurrent`, 'user', {}, fixtureIds
    );
    const futureScheduleFixture = await createFixture(
      pool, `${prefix}-future`, 'team', { startDate: futureDate, endDate: null }, fixtureIds
    );
    const expiredScheduleFixture = await createFixture(
      pool, `${prefix}-expired`, 'team', { startDate: priorDate, endDate: priorDate }, fixtureIds
    );
    const currentScheduleFixture = await createFixture(
      pool, `${prefix}-current`, 'team', { startDate: today, endDate: today }, fixtureIds
    );

    const eventWriter = async (event) => {
      const eventId = randomUUID();
      events.push({ ...event, eventId });
      return {
        eventId,
        db: {
          collection() {
            return {
              async deleteOne(filter) {
                const index = events.findIndex((entry) => entry.eventId === filter._id);
                if (index >= 0) events.splice(index, 1);
                return { deletedCount: index >= 0 ? 1 : 0 };
              }
            };
          }
        }
      };
    };
    const options = {
      pool,
      eventWriter,
      notifier: async () => ({ status: 'logged', mode: 'integration-test' }),
      logger: { error() {} },
      clock: () => new Date()
    };
    const firstWorker = createEscalationWorker(options);
    const secondWorker = createEscalationWorker(options);

    await Promise.all([firstWorker.tick(), secondWorker.tick()]);

    const concurrentRows = await readExecution(pool, concurrencyFixture.incidentId);
    assert.equal(concurrentRows.length, 1, 'Expected one execution row for the concurrent level.');
    assert.equal(concurrentRows[0].status, 'applied');
    assert.equal(concurrentRows[0].attempt_count, 1);
    assert.equal(concurrentRows[0].assignment_count, 1,
      'Expected one assignment for the concurrent level.');

    for (const [fixture, expectedStatus, expectedAssignments] of [
      [futureScheduleFixture, 'failed', 0],
      [expiredScheduleFixture, 'failed', 0],
      [currentScheduleFixture, 'applied', 1]
    ]) {
      const rows = await readExecution(pool, fixture.incidentId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, expectedStatus);
      assert.equal(rows[0].assignment_count, expectedAssignments);
    }

    assert.equal(events.filter((event) =>
      event.incident_id === concurrencyFixture.incidentId
    ).length, 1, 'Expected one Mongo-event-writer call for the concurrent level.');
  } finally {
    try {
      if (fixtureIds.incidentIds.length) {
        await pool.query('DELETE FROM incident WHERE incident_id = ANY($1::bigint[])', [
          fixtureIds.incidentIds
        ]);
      }
      if (fixtureIds.serviceIds.length) {
        await pool.query('DELETE FROM service WHERE service_id = ANY($1::bigint[])', [
          fixtureIds.serviceIds
        ]);
      }
      if (fixtureIds.policyIds.length) {
        await pool.query('DELETE FROM escalation_policy WHERE policy_id = ANY($1::bigint[])', [
          fixtureIds.policyIds
        ]);
      }
      if (fixtureIds.scheduleIds.length) {
        await pool.query('DELETE FROM on_call_schedule WHERE schedule_id = ANY($1::bigint[])', [
          fixtureIds.scheduleIds
        ]);
      }
      if (fixtureIds.environmentIds.length) {
        await pool.query('DELETE FROM environment WHERE environment_id = ANY($1::bigint[])', [
          fixtureIds.environmentIds
        ]);
      }
      if (fixtureIds.userIds.length) {
        await pool.query('DELETE FROM app_user WHERE user_id = ANY($1::bigint[])', [
          fixtureIds.userIds
        ]);
      }
      if (fixtureIds.teamIds.length) {
        await pool.query('DELETE FROM team WHERE team_id = ANY($1::bigint[])', [
          fixtureIds.teamIds
        ]);
      }
    } finally {
      await pool.end();
    }
  }
});
