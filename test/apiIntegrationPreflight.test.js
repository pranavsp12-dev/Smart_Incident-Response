import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { validateConfiguration } from '../src/scripts/apiIntegration.js';

const appEnv = {
  PG: { DATABASE: 'smart_incident' },
  MONGO_URI: 'mongodb://localhost:27017/smart_incident_logs',
  JWT_SECRET: 'x'.repeat(32)
};

function testEnvironment(overrides = {}) {
  return {
    API_TEST_PG_DATABASE: 'smart_incident_test',
    API_TEST_MONGO_URI: 'mongodb://localhost:27017/smart_incident_logs_test',
    API_TEST_ADMIN_EMAIL: `${randomUUID()}@example.invalid`,
    API_TEST_ADMIN_PASSWORD: randomUUID(),
    ...overrides
  };
}

function captureError(callback) {
  try {
    callback();
  } catch (error) {
    return error;
  }
  assert.fail('Expected configuration validation to fail.');
}

test('preflight reports every missing required variable without printing values', () => {
  const missingError = captureError(() => validateConfiguration({}, appEnv));
  for (const name of [
    'API_TEST_PG_DATABASE',
    'API_TEST_MONGO_URI',
    'API_TEST_ADMIN_EMAIL',
    'API_TEST_ADMIN_PASSWORD'
  ]) {
    assert.ok(missingError.message.includes(name), `diagnostic includes ${name}`);
  }

  const privateValue = randomUUID();
  const partialError = captureError(() => validateConfiguration({
    API_TEST_ADMIN_PASSWORD: privateValue
  }, appEnv));
  assert.doesNotMatch(partialError.message, new RegExp(privateValue));
});

test('preflight rejects unsafe PostgreSQL test database names', () => {
  assert.throws(
    () => validateConfiguration(testEnvironment({ API_TEST_PG_DATABASE: 'smart_incident' }), appEnv),
    /API_TEST_PG_DATABASE must identify a dedicated database/
  );
});

test('preflight rejects the configured normal PostgreSQL database', () => {
  assert.throws(
    () => validateConfiguration(testEnvironment(), {
      ...appEnv,
      PG: { DATABASE: 'smart_incident_test' }
    }),
    /Refusing to run integration tests against the database configured by the normal application environment/
  );
});

test('preflight rejects unsafe or normal MongoDB database targets', () => {
  assert.throws(
    () => validateConfiguration(testEnvironment({
      API_TEST_MONGO_URI: 'mongodb://localhost:27017/smart_incident_logs'
    }), appEnv),
    /API_TEST_MONGO_URI must select a dedicated database/
  );

  assert.throws(
    () => validateConfiguration(testEnvironment(), {
      ...appEnv,
      MONGO_URI: 'mongodb://localhost:27017/smart_incident_logs_test'
    }),
    /Refusing to run integration tests against the MongoDB database configured by the normal application environment/
  );

  assert.throws(
    () => validateConfiguration(testEnvironment({
      API_TEST_MONGO_URI: 'mongodb://localhost:27017/smart_incident_logs_dev'
    }), appEnv),
    /API_TEST_MONGO_URI must select a dedicated database/
  );
});
