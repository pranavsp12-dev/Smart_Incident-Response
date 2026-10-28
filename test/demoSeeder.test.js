import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertSafeApplicationTarget,
  buildDemoCatalog,
  ensureListedRecord,
  validateDemoPassword,
  validateIsolatedTestSettings
} from '../src/scripts/seedDemo.js';

const normalEnv = {
  NODE_ENV: 'development',
  PG: { DATABASE: 'smart_incident' },
  MONGO_URI: 'mongodb://localhost:27017/smart_incident_logs'
};

test('demo catalog meets requested entity counts and keeps relationships team-scoped', () => {
  const catalog = buildDemoCatalog(new Date('2026-10-27T12:00:00.000Z'));
  const teamKeys = new Set(catalog.teams.map((team) => team.key));
  const serviceKeys = new Set(catalog.services.map((service) => service.key));
  const userKeys = new Set(catalog.users.map((user) => user.key));
  const allowedStatuses = new Set([
    'open', 'acknowledged', 'investigating', 'mitigated', 'resolved', 'closed'
  ]);

  assert.equal(catalog.teams.length, 4);
  assert.equal(catalog.users.length, 12);
  assert.equal(catalog.services.length, 8);
  assert.equal(catalog.environments.length, 4);
  assert.equal(catalog.incidents.length, 20);
  assert.equal(catalog.policies.length, 4);
  assert.equal(catalog.schedules.length, 4);
  assert.equal(catalog.tags.length, 8);
  assert.equal(userKeys.has('platform-manager'), true);

  for (const service of catalog.services) {
    assert.ok(teamKeys.has(service.team));
  }
  for (const incident of catalog.incidents) {
    assert.ok(allowedStatuses.has(incident.status));
    assert.ok(serviceKeys.has(incident.service.key));
    assert.equal(incident.service.team, incident.team.key);
    assert.equal(incident.assignedUser.team, incident.team.key);
    assert.equal(incident.manager.team, incident.team.key);
    assert.equal(new Set(incident.tags.map((tag) => tag.name)).size, incident.tags.length);
    assert.equal(incident.history.length, 2);
  }
  for (const policy of catalog.policies) {
    assert.equal(policy.targets.length, 2);
    assert.ok(policy.targets.every((target) => target.targetUser.team === policy.team.key));
  }
  for (const schedule of catalog.schedules) {
    assert.equal(schedule.assignments.length, 2);
    assert.ok(schedule.assignments.every((user) => user.team === schedule.team.key));
    assert.ok(Date.parse(schedule.endTime) > Date.parse(schedule.startTime));
  }
});

test('demo password validation enforces application length and bcrypt byte limits', () => {
  assert.throws(() => validateDemoPassword('short'), /12 characters/);
  assert.doesNotThrow(() => validateDemoPassword('x'.repeat(12)));
  assert.doesNotThrow(() => validateDemoPassword('é'.repeat(36)));
  assert.throws(() => validateDemoPassword('é'.repeat(37)), /72 UTF-8 bytes/);
});

test('main seed target rejects test databases and production mode', () => {
  assert.doesNotThrow(() => assertSafeApplicationTarget(normalEnv));
  assert.throws(
    () => assertSafeApplicationTarget({
      ...normalEnv,
      PG: { DATABASE: 'smart_incident_test' }
    }),
    /test-only name/
  );
  assert.throws(
    () => assertSafeApplicationTarget({
      ...normalEnv,
      MONGO_URI: 'mongodb://localhost:27017/smart_incident_logs_testing'
    }),
    /test-only name/
  );
  assert.throws(
    () => assertSafeApplicationTarget({ ...normalEnv, NODE_ENV: 'production' }),
    /NODE_ENV is production/
  );
});

test('isolated seed preflight requires dedicated targets and rejects normal databases', () => {
  const settings = {
    API_TEST_PG_DATABASE: 'smart_incident_test',
    API_TEST_MONGO_URI: 'mongodb://localhost:27017/smart_incident_logs_test',
    API_TEST_ADMIN_EMAIL: 'isolated@example.invalid',
    API_TEST_ADMIN_PASSWORD: 'process-only-secret'
  };
  assert.doesNotThrow(() => validateIsolatedTestSettings(settings, normalEnv));
  assert.throws(
    () => validateIsolatedTestSettings({}, normalEnv),
    /API_TEST_PG_DATABASE, API_TEST_MONGO_URI, API_TEST_ADMIN_EMAIL, API_TEST_ADMIN_PASSWORD/
  );
  assert.throws(
    () => validateIsolatedTestSettings({
      ...settings,
      API_TEST_PG_DATABASE: 'smart_incident'
    }, normalEnv),
    /test-only database name/
  );
  assert.throws(
    () => validateIsolatedTestSettings({
      ...settings,
      API_TEST_MONGO_URI: 'mongodb://localhost:27017/smart_incident_logs'
    }, normalEnv),
    /test-only database name/
  );
  assert.throws(
    () => validateIsolatedTestSettings(settings, {
      ...normalEnv,
      PG: { DATABASE: 'smart_incident_test' }
    }),
    /differ from the configured application database/
  );
});

test('record ensure helper creates once and counts later matches without rewriting', async () => {
  const summary = { teams: { created: 0, existed: 0 } };
  const records = [];
  let createCalls = 0;
  const request = async (method, route, { body } = {}) => {
    assert.equal(method, 'POST');
    assert.equal(route, '/teams');
    createCalls += 1;
    return { data: { team_id: '1', name: body.name, description: body.description } };
  };
  const options = {
    request,
    records,
    keyField: 'name',
    keyValue: 'DEMO | Example Team',
    route: '/teams',
    body: { name: 'DEMO | Example Team', description: 'Fictional.' },
    expected: { name: 'DEMO | Example Team', description: 'Fictional.' },
    entity: 'teams',
    summary
  };

  const created = await ensureListedRecord(options);
  const existing = await ensureListedRecord(options);
  assert.equal(created, existing);
  assert.equal(createCalls, 1);
  assert.deepEqual(summary.teams, { created: 1, existed: 1 });
});

test('record ensure helper refuses a conflicting existing fixture without mutation', async () => {
  const summary = { teams: { created: 0, existed: 0 } };
  let createCalls = 0;
  await assert.rejects(() => ensureListedRecord({
    request: async () => { createCalls += 1; return { data: {} }; },
    records: [{ team_id: '7', name: 'DEMO | Example Team', description: 'Not the demo description.' }],
    keyField: 'name',
    keyValue: 'DEMO | Example Team',
    route: '/teams',
    body: {},
    expected: { description: 'Fictional.' },
    entity: 'teams',
    summary
  }), /left unchanged/);
  assert.equal(createCalls, 0);
  assert.deepEqual(summary.teams, { created: 0, existed: 0 });
});
