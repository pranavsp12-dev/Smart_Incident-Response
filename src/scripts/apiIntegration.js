import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { MongoClient } from 'mongodb';
import { env } from '../config/env.js';

const { Pool } = pg;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const marker = `api-test-${randomUUID()}`;
const databaseNamePattern = /^(?:test_[a-z0-9_]+|[a-z0-9_]+_test|[a-z0-9_]+_testing)$/i;
const expectedTables = [
  'app_user',
  'environment',
  'escalation_level',
  'escalation_policy',
  'incident',
  'incident_assignment',
  'incident_escalation_execution',
  'incident_tag',
  'incident_update',
  'on_call_assignment',
  'on_call_schedule',
  'service',
  'tag',
  'team'
];
const passed = [];

function fail(message) {
  throw new Error(message);
}

export function validateConfiguration(testEnv = process.env, appEnv = env) {
  const requiredVariables = [
    'API_TEST_PG_DATABASE',
    'API_TEST_MONGO_URI',
    'API_TEST_ADMIN_EMAIL',
    'API_TEST_ADMIN_PASSWORD'
  ];
  const missingVariables = requiredVariables.filter((name) =>
    typeof testEnv[name] !== 'string' || testEnv[name].trim() === ''
  );
  if (missingVariables.length > 0) {
    fail(`Missing required test configuration: ${missingVariables.join(', ')}.`);
  }

  const { API_TEST_ADMIN_EMAIL: adminEmail, API_TEST_ADMIN_PASSWORD: adminPassword } = testEnv;
  const testDatabase = testEnv.API_TEST_PG_DATABASE;
  const testMongoUri = testEnv.API_TEST_MONGO_URI;
  if (!databaseNamePattern.test(testDatabase)) {
    fail('API_TEST_PG_DATABASE must identify a dedicated database ending in _test/_testing or beginning with test_.');
  }
  if (testDatabase === appEnv.PG.DATABASE) {
    fail('Refusing to run integration tests against the database configured by the normal application environment.');
  }
  if (appEnv.JWT_SECRET.length < 32) {
    fail('The existing JWT_SECRET does not meet the minimum application length; no test server was started.');
  }

  let testMongoDatabase;
  let configuredMongoDatabase;
  try {
    testMongoDatabase = new MongoClient(testMongoUri).db().databaseName;
    configuredMongoDatabase = new MongoClient(appEnv.MONGO_URI).db().databaseName;
  } catch {
    fail('A MongoDB URI is invalid; no test server was started.');
  }
  if (!databaseNamePattern.test(testMongoDatabase)) {
    fail('API_TEST_MONGO_URI must select a dedicated database ending in _test/_testing or beginning with test_.');
  }
  if (testMongoDatabase === configuredMongoDatabase) {
    fail('Refusing to run integration tests against the MongoDB database configured by the normal application environment.');
  }

  return { adminEmail, adminPassword, testDatabase, testMongoUri };
}

async function reserveLocalPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function tableCounts(pool) {
  const tables = await pool.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`
  );
  const counts = new Map();
  for (const { table_name: tableName } of tables.rows) {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count FROM public."${tableName.replaceAll('"', '""')}"`
    );
    counts.set(tableName, result.rows[0].count);
  }
  return counts;
}

function assertCountsEqual(actual, expected, label) {
  assert.deepEqual([...actual.entries()].sort(), [...expected.entries()].sort(), label);
}

async function waitForServer(child, baseUrl) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      fail('The isolated API server exited before it became ready.');
    }
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) {
        const health = await response.json();
        if (health.databases?.postgres?.connected && health.databases?.mongodb?.connected) {
          return;
        }
      }
    } catch {
      // The child is still starting; retry until the bounded readiness deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  fail('The isolated API server did not become healthy within 30 seconds.');
}

async function apiRequest(baseUrl, method, route, { token, body, expectedStatus } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  const payload = response.status === 204 ? null : await response.json();
  if (expectedStatus !== undefined) {
    assert.equal(response.status, expectedStatus, `${method} ${route} response status`);
  }
  return { response, payload };
}

function recordPass(label) {
  passed.push(label);
  console.log(`PASS ${label}`);
}

async function assertStatus(baseUrl, label, method, route, options) {
  await apiRequest(baseUrl, method, route, options);
  recordPass(`${label} (${options.expectedStatus})`);
}

async function createUser(baseUrl, adminToken, role, teamId) {
  const email = `${marker}-${role}-${randomBytes(4).toString('hex')}@example.invalid`;
  const password = randomBytes(24).toString('base64url');
  const created = await apiRequest(baseUrl, 'POST', '/users', {
    token: adminToken,
    expectedStatus: 201,
    body: {
      name: `${marker} ${role}`,
      email,
      password,
      role,
      teamId
    }
  });
  const user = created.payload.data;
  assert.equal(Object.hasOwn(user, 'password_hash'), false);
  assert.equal(Object.hasOwn(user, 'password'), false);
  const id = String(user.user_id ?? user.id);
  const login = await apiRequest(baseUrl, 'POST', '/auth/login', {
    expectedStatus: 200,
    body: { email, password }
  });
  assert.equal(login.payload.user.role, role);
  return {
    id,
    token: login.payload.accessToken
  };
}

async function run() {
  const { adminEmail, adminPassword, testDatabase, testMongoUri } = validateConfiguration();

  const pool = new Pool({
    host: env.PG.HOST,
    port: env.PG.PORT,
    database: testDatabase,
    user: env.PG.USER,
    password: env.PG.PASSWORD,
    connectionTimeoutMillis: 3000
  });
  const mongoClient = new MongoClient(testMongoUri, { serverSelectionTimeoutMS: 3000 });
  let child;
  let baselineCounts;
  const incidentIds = [];
  let fixturesMayExist = false;
  let cleanupVerified = false;

  try {
    const dbCheck = await pool.query('SELECT current_database() AS database_name');
    assert.equal(dbCheck.rows[0].database_name, testDatabase);
    baselineCounts = await tableCounts(pool);
    assert.equal(baselineCounts.size, 14, 'test database must already have the 13 schema tables and escalation migration table');
    assert.deepEqual(
      [...baselineCounts.keys()].sort(),
      expectedTables,
      'test database must contain the existing schema tables'
    );

    await mongoClient.connect();
    const mongoDb = mongoClient.db();
    await mongoDb.command({ ping: 1 });

    const port = await reserveLocalPort();
    const baseUrl = `http://127.0.0.1:${port}/api`;
    child = spawn(process.execPath, ['src/server.js'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(port),
        PG_DATABASE: testDatabase,
        MONGO_URI: testMongoUri
      },
      stdio: 'ignore',
      windowsHide: true
    });
    await waitForServer(child, baseUrl);
    recordPass('Isolated API server uses healthy PostgreSQL and MongoDB test databases');

    const login = await apiRequest(baseUrl, 'POST', '/auth/login', {
      expectedStatus: 200,
      body: { email: adminEmail, password: adminPassword }
    });
    const adminToken = login.payload.accessToken;
    assert.equal(login.payload.tokenType, 'Bearer');
    assert.equal(Object.hasOwn(login.payload.user, 'password_hash'), false);
    assert.equal(Object.hasOwn(login.payload.user, 'password'), false);
    assert.equal(Object.hasOwn(login.payload, 'password_hash'), false);
    recordPass('Admin login returns bearer JWT without password data');
    await assertStatus(baseUrl, 'Invalid login credentials rejected', 'POST', '/auth/login', {
      expectedStatus: 401,
      body: { email: adminEmail, password: randomBytes(24).toString('base64url') }
    });

    await assertStatus(baseUrl, 'Unauthenticated protected request rejected', 'GET', '/services', {
      expectedStatus: 401
    });

    fixturesMayExist = true;
    const teamA = (await apiRequest(baseUrl, 'POST', '/teams', {
      token: adminToken,
      expectedStatus: 201,
      body: { name: `${marker}-team-a` }
    })).payload.data;
    const teamB = (await apiRequest(baseUrl, 'POST', '/teams', {
      token: adminToken,
      expectedStatus: 201,
      body: { name: `${marker}-team-b` }
    })).payload.data;
    recordPass('Admin creates isolated teams');

    const managerA = await createUser(baseUrl, adminToken, 'manager', String(teamA.team_id));
    const engineerA = await createUser(baseUrl, adminToken, 'engineer', String(teamA.team_id));
    const managerB = await createUser(baseUrl, adminToken, 'manager', String(teamB.team_id));
    const engineerB = await createUser(baseUrl, adminToken, 'engineer', String(teamB.team_id));
    const noTeamManager = await createUser(baseUrl, adminToken, 'manager', null);
    const noTeamEngineer = await createUser(baseUrl, adminToken, 'engineer', null);
    recordPass('Create and authenticate manager/engineer role fixtures');

    await apiRequest(baseUrl, 'GET', `/teams/${teamA.team_id}`, {
      token: managerA.token,
      expectedStatus: 200
    });
    await assertStatus(baseUrl, 'Manager cannot retrieve another team', 'GET', `/teams/${teamB.team_id}`, {
      token: managerA.token,
      expectedStatus: 404
    });
    const adminUsers = await apiRequest(baseUrl, 'GET', '/users', {
      token: adminToken,
      expectedStatus: 200
    });
    const managerUsers = await apiRequest(baseUrl, 'GET', '/users', {
      token: managerA.token,
      expectedStatus: 200
    });
    assert.ok(adminUsers.payload.data.some((user) => String(user.user_id ?? user.id) === managerA.id));
    assert.ok(managerUsers.payload.data.some((user) => String(user.user_id ?? user.id) === engineerA.id));
    await apiRequest(baseUrl, 'GET', `/users/${engineerA.id}`, {
      token: managerA.token,
      expectedStatus: 200
    });
    await assertStatus(baseUrl, 'Manager cannot retrieve another team user', 'GET', `/users/${engineerB.id}`, {
      token: managerA.token,
      expectedStatus: 404
    });
    await assertStatus(baseUrl, 'Engineer cannot list users', 'GET', '/users', {
      token: engineerA.token,
      expectedStatus: 403
    });
    recordPass('User listing and retrieval enforce role and team scope');

    const createdServiceA = await apiRequest(baseUrl, 'POST', '/services', {
      token: managerA.token,
      expectedStatus: 201,
      body: { name: `${marker}-service-a`, criticality: 'high' }
    });
    const serviceA = createdServiceA.payload.data;
    await apiRequest(baseUrl, 'GET', `/services/${serviceA.service_id}`, {
      token: managerA.token,
      expectedStatus: 200
    });
    const listedServices = await apiRequest(baseUrl, 'GET', '/services', {
      token: managerA.token,
      expectedStatus: 200
    });
    assert.ok(listedServices.payload.data.some(
      (service) => String(service.service_id) === String(serviceA.service_id)
    ));
    recordPass('Manager creates service in own team');

    const serviceB = (await apiRequest(baseUrl, 'POST', '/services', {
      token: adminToken,
      expectedStatus: 201,
      body: {
        name: `${marker}-service-b`,
        teamId: String(teamB.team_id),
        criticality: 'medium'
      }
    })).payload.data;
    recordPass('Service records created through API with team ownership');

    await assertStatus(baseUrl, 'Engineer service creation forbidden', 'POST', '/services', {
      token: engineerA.token,
      expectedStatus: 403,
      body: { name: `${marker}-engineer-service` }
    });
    await assertStatus(baseUrl, 'Manager cannot create service in another team', 'POST', '/services', {
      token: managerA.token,
      expectedStatus: 403,
      body: { name: `${marker}-cross-team-service`, teamId: String(teamB.team_id) }
    });
    await assertStatus(baseUrl, 'Invalid service criticality rejected', 'POST', '/services', {
      token: managerA.token,
      expectedStatus: 400,
      body: { name: `${marker}-invalid-service`, criticality: 'urgent' }
    });
    await assertStatus(baseUrl, 'Duplicate service name rejected', 'POST', '/services', {
      token: adminToken,
      expectedStatus: 409,
      body: { name: `${marker}-service-a`, teamId: String(teamA.team_id) }
    });

    const environment = (await apiRequest(baseUrl, 'POST', '/environments', {
      token: managerA.token,
      expectedStatus: 201,
      body: { name: `${marker}-environment`, description: 'Isolated API test environment' }
    })).payload.data;
    await apiRequest(baseUrl, 'GET', `/environments/${environment.environment_id}`, {
      token: managerA.token,
      expectedStatus: 200
    });
    const listedEnvironments = await apiRequest(baseUrl, 'GET', '/environments', {
      token: managerA.token,
      expectedStatus: 200
    });
    assert.ok(listedEnvironments.payload.data.some(
      (item) => String(item.environment_id) === String(environment.environment_id)
    ));
    recordPass('Manager creates environment through API');
    await assertStatus(baseUrl, 'Invalid environment name rejected', 'POST', '/environments', {
      token: managerA.token,
      expectedStatus: 400,
      body: { name: '   ' }
    });

    const policyA = (await apiRequest(baseUrl, 'POST', '/escalation-policies', {
      token: managerA.token,
      expectedStatus: 201,
      body: { name: `${marker}-policy-a`, description: 'Isolated API integration policy' }
    })).payload.data;
    const levelA = (await apiRequest(
      baseUrl,
      'POST',
      `/escalation-policies/${policyA.policy_id}/levels`,
      {
        token: managerA.token,
        expectedStatus: 201,
        body: {
          levelNumber: 1,
          targetType: 'user',
          targetId: Number(engineerA.id),
          waitMinutes: 5
        }
      }
    )).payload.data;
    await apiRequest(baseUrl, 'GET', `/escalation-policies/${policyA.policy_id}`, {
      token: engineerA.token,
      expectedStatus: 200
    });
    const listedPolicies = await apiRequest(baseUrl, 'GET', '/escalation-policies', {
      token: managerA.token,
      expectedStatus: 200
    });
    assert.ok(listedPolicies.payload.data.some(
      (policy) => String(policy.policy_id) === String(policyA.policy_id)
    ));
    await apiRequest(
      baseUrl,
      'GET',
      `/escalation-policies/${policyA.policy_id}/levels/${levelA.level_id}`,
      { token: engineerA.token, expectedStatus: 200 }
    );
    const listedLevels = await apiRequest(
      baseUrl,
      'GET',
      `/escalation-policies/${policyA.policy_id}/levels`,
      { token: managerA.token, expectedStatus: 200 }
    );
    assert.ok(listedLevels.payload.data.some(
      (level) => String(level.level_id) === String(levelA.level_id)
    ));
    await assertStatus(
      baseUrl,
      'Engineer cannot create escalation policy',
      'POST',
      '/escalation-policies',
      {
        token: engineerA.token,
        expectedStatus: 403,
        body: { name: `${marker}-engineer-policy` }
      }
    );
    const policyB = (await apiRequest(baseUrl, 'POST', '/escalation-policies', {
      token: adminToken,
      expectedStatus: 201,
      body: {
        name: `${marker}-policy-b`,
        teamId: String(teamB.team_id)
      }
    })).payload.data;
    const levelB = (await apiRequest(
      baseUrl,
      'POST',
      `/escalation-policies/${policyB.policy_id}/levels`,
      {
        token: adminToken,
        expectedStatus: 201,
        body: {
          levelNumber: 1,
          targetType: 'user',
          targetId: Number(engineerB.id),
          waitMinutes: 10
        }
      }
    )).payload.data;
    await assertStatus(
      baseUrl,
      'Manager cannot retrieve another team escalation policy',
      'GET',
      `/escalation-policies/${policyB.policy_id}`,
      { token: managerA.token, expectedStatus: 404 }
    );
    await assertStatus(
      baseUrl,
      'Escalation level cannot be retrieved through a different parent policy',
      'GET',
      `/escalation-policies/${policyA.policy_id}/levels/${levelB.level_id}`,
      { token: adminToken, expectedStatus: 404 }
    );
    recordPass('Escalation policies and levels support scoped CRUD reads and authorized creation');

    const scheduleA = (await apiRequest(baseUrl, 'POST', '/on-call-schedules', {
      token: managerA.token,
      expectedStatus: 201,
      body: {
        name: `${marker}-schedule-a`,
        rotationType: 'weekly',
        startDate: '2026-10-26'
      }
    })).payload.data;
    const scheduleAssignment = (await apiRequest(
      baseUrl,
      'POST',
      `/on-call-schedules/${scheduleA.schedule_id}/assignments`,
      {
        token: managerA.token,
        expectedStatus: 201,
        body: {
          userId: Number(engineerA.id),
          startTime: '2026-10-26T00:00:00Z',
          endTime: '2026-11-02T00:00:00Z'
        }
      }
    )).payload.data;
    await apiRequest(baseUrl, 'GET', `/on-call-schedules/${scheduleA.schedule_id}`, {
      token: engineerA.token,
      expectedStatus: 200
    });
    const listedSchedules = await apiRequest(baseUrl, 'GET', '/on-call-schedules', {
      token: managerA.token,
      expectedStatus: 200
    });
    assert.ok(listedSchedules.payload.data.some(
      (schedule) => String(schedule.schedule_id) === String(scheduleA.schedule_id)
    ));
    await apiRequest(
      baseUrl,
      'GET',
      `/on-call-schedules/${scheduleA.schedule_id}/assignments/${scheduleAssignment.assignment_id}`,
      { token: managerA.token, expectedStatus: 200 }
    );
    const listedScheduleAssignments = await apiRequest(
      baseUrl,
      'GET',
      `/on-call-schedules/${scheduleA.schedule_id}/assignments`,
      { token: managerA.token, expectedStatus: 200 }
    );
    assert.ok(listedScheduleAssignments.payload.data.some(
      (assignment) => String(assignment.assignment_id) === String(scheduleAssignment.assignment_id)
    ));
    await assertStatus(
      baseUrl,
      'Engineer cannot create on-call schedule',
      'POST',
      '/on-call-schedules',
      {
        token: engineerA.token,
        expectedStatus: 403,
        body: {
          name: `${marker}-engineer-schedule`,
          rotationType: 'weekly',
          startDate: '2026-10-26'
        }
      }
    );
    const scheduleB = (await apiRequest(baseUrl, 'POST', '/on-call-schedules', {
      token: adminToken,
      expectedStatus: 201,
      body: {
        teamId: String(teamB.team_id),
        name: `${marker}-schedule-b`,
        rotationType: 'daily',
        startDate: '2026-10-26'
      }
    })).payload.data;
    const scheduleAssignmentB = (await apiRequest(
      baseUrl,
      'POST',
      `/on-call-schedules/${scheduleB.schedule_id}/assignments`,
      {
        token: adminToken,
        expectedStatus: 201,
        body: {
          userId: Number(engineerB.id),
          startTime: '2026-10-26T00:00:00Z',
          endTime: '2026-11-02T00:00:00Z'
        }
      }
    )).payload.data;
    await assertStatus(
      baseUrl,
      'Manager cannot retrieve another team on-call schedule',
      'GET',
      `/on-call-schedules/${scheduleB.schedule_id}`,
      { token: managerA.token, expectedStatus: 404 }
    );
    await assertStatus(
      baseUrl,
      'On-call assignment cannot be retrieved through a different parent schedule',
      'GET',
      `/on-call-schedules/${scheduleA.schedule_id}/assignments/${scheduleAssignmentB.assignment_id}`,
      { token: adminToken, expectedStatus: 404 }
    );
    recordPass('On-call schedules and assignments support scoped reads and authorized creation');

    const incidentEventsStartedAt = new Date();
    const incidentA = (await apiRequest(baseUrl, 'POST', '/incidents', {
      token: managerA.token,
      expectedStatus: 201,
      body: {
        serviceId: String(serviceA.service_id),
        environmentId: String(environment.environment_id),
        title: `${marker}-incident-a`,
        description: 'Created by isolated API integration test',
        severity: 'SEV2',
        priority: 'P2'
      }
    })).payload.data;
    incidentIds.push(String(incidentA.incident_id));
    const incidentB = (await apiRequest(baseUrl, 'POST', '/incidents', {
      token: adminToken,
      expectedStatus: 201,
      body: {
        serviceId: String(serviceB.service_id),
        environmentId: String(environment.environment_id),
        title: `${marker}-incident-b`
      }
    })).payload.data;
    incidentIds.push(String(incidentB.incident_id));
    recordPass('Manager and admin create incidents for their allowed service scopes');
    const listedIncidents = await apiRequest(baseUrl, 'GET', '/incidents', {
      token: managerA.token,
      expectedStatus: 200
    });
    assert.ok(listedIncidents.payload.data.some(
      (incident) => String(incident.incident_id) === String(incidentA.incident_id)
    ));
    assert.equal(listedIncidents.payload.data.some(
      (incident) => String(incident.incident_id) === String(incidentB.incident_id)
    ), false);

    await assertStatus(baseUrl, 'Malformed incident ID rejected', 'GET', '/incidents/not-a-number', {
      token: adminToken,
      expectedStatus: 400
    });
    await assertStatus(baseUrl, 'Invalid incident severity rejected', 'POST', '/incidents', {
      token: managerA.token,
      expectedStatus: 400,
      body: {
        serviceId: String(serviceA.service_id),
        environmentId: String(environment.environment_id),
        title: `${marker}-invalid-incident`,
        severity: 'urgent'
      }
    });
    await assertStatus(baseUrl, 'Manager cannot retrieve other-team incident', 'GET', `/incidents/${incidentB.incident_id}`, {
      token: managerA.token,
      expectedStatus: 404
    });
    await assertStatus(baseUrl, 'Engineer cannot retrieve other-team incident', 'GET', `/incidents/${incidentB.incident_id}`, {
      token: engineerA.token,
      expectedStatus: 404
    });
    await assertStatus(baseUrl, 'Manager without a team cannot list incidents', 'GET', '/incidents', {
      token: noTeamManager.token,
      expectedStatus: 403
    });
    const noTeamIncidents = await apiRequest(baseUrl, 'GET', '/incidents', {
      token: noTeamEngineer.token,
      expectedStatus: 200
    });
    assert.deepEqual(noTeamIncidents.payload.data, []);
    recordPass('No-team engineer receives no incidents');

    const assignment = (await apiRequest(baseUrl, 'POST', '/incident-assignments', {
      token: managerA.token,
      expectedStatus: 201,
      body: {
        incidentId: String(incidentA.incident_id),
        userId: engineerA.id,
        assignmentType: 'responder'
      }
    })).payload.data;
    await apiRequest(baseUrl, 'GET', `/incident-assignments/${assignment.assignment_id}`, {
      token: engineerA.token,
      expectedStatus: 200
    });
    const listedIncidentAssignments = await apiRequest(
      baseUrl,
      'GET',
      '/incident-assignments',
      { token: managerA.token, expectedStatus: 200 }
    );
    assert.ok(listedIncidentAssignments.payload.data.some(
      (item) => String(item.assignment_id) === String(assignment.assignment_id)
    ));
    const reassigned = await apiRequest(
      baseUrl,
      'PATCH',
      `/incident-assignments/${assignment.assignment_id}`,
      {
        token: managerA.token,
        expectedStatus: 200,
        body: { assignmentType: 'incident_commander' }
      }
    );
    assert.equal(reassigned.payload.data.assignment_type, 'incident_commander');
    const unassigned = await apiRequest(
      baseUrl,
      'PATCH',
      `/incident-assignments/${assignment.assignment_id}/unassign`,
      { token: managerA.token, expectedStatus: 200 }
    );
    assert.ok(unassigned.payload.data.unassigned_at);
    recordPass('Manager creates, retrieves, updates, and unassigns a responder assignment');
    await assertStatus(baseUrl, 'Engineer cannot manage incident assignments', 'POST', '/incident-assignments', {
      token: engineerA.token,
      expectedStatus: 403,
      body: { incidentId: String(incidentA.incident_id), userId: engineerA.id }
    });
    await assertStatus(baseUrl, 'Manager cannot assign across team scope', 'POST', '/incident-assignments', {
      token: managerA.token,
      expectedStatus: 404,
      body: { incidentId: String(incidentB.incident_id), userId: engineerB.id }
    });
    await assertStatus(baseUrl, 'Malformed assignment ID rejected', 'GET', '/incident-assignments/bad-id', {
      token: adminToken,
      expectedStatus: 400
    });

    const update = (await apiRequest(baseUrl, 'POST', `/incidents/${incidentA.incident_id}/updates`, {
      token: engineerA.token,
      expectedStatus: 201,
      body: { status: 'investigating', message: `${marker} response started` }
    })).payload.data;
    const history = await apiRequest(baseUrl, 'GET', `/incidents/${incidentA.incident_id}/updates`, {
      token: managerA.token,
      expectedStatus: 200
    });
    assert.ok(history.payload.data.some((item) => String(item.update_id) === String(update.update_id)));
    const currentIncident = await pool.query(
      'SELECT status FROM incident WHERE incident_id = $1',
      [incidentA.incident_id]
    );
    assert.equal(currentIncident.rows[0]?.status, 'open');
    recordPass('Incident update history persists while current incident status remains unchanged');
    await assertStatus(baseUrl, 'Empty update message rejected', 'POST', `/incidents/${incidentA.incident_id}/updates`, {
      token: engineerA.token,
      expectedStatus: 400,
      body: { message: '   ' }
    });
    const statusUpdate = await apiRequest(baseUrl, 'PATCH', `/incidents/${incidentA.incident_id}`, {
      token: managerA.token,
      expectedStatus: 200,
      body: { status: 'investigating' }
    });
    assert.equal(statusUpdate.payload.data.status, 'investigating');
    const persistedStatus = await pool.query(
      'SELECT status FROM incident WHERE incident_id = $1',
      [incidentA.incident_id]
    );
    assert.equal(persistedStatus.rows[0]?.status, 'investigating');
    recordPass('Incident status update persists through PostgreSQL');

    const persisted = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM service WHERE service_id = $1) AS service_count,
         (SELECT COUNT(*)::int FROM environment WHERE environment_id = $2) AS environment_count,
         (SELECT COUNT(*)::int FROM incident WHERE incident_id = $3 AND created_by = $4) AS incident_count,
         (SELECT COUNT(*)::int FROM incident_assignment WHERE assignment_id = $5) AS assignment_count,
         (SELECT COUNT(*)::int FROM incident_update WHERE update_id = $6 AND user_id = $7) AS update_count,
         (SELECT COUNT(*)::int FROM escalation_policy WHERE policy_id = $8 AND team_id = $9) AS policy_count,
         (SELECT COUNT(*)::int FROM escalation_level WHERE level_id = $10 AND policy_id = $8) AS level_count,
         (SELECT COUNT(*)::int FROM on_call_schedule WHERE schedule_id = $11 AND team_id = $9) AS schedule_count,
         (SELECT COUNT(*)::int FROM on_call_assignment WHERE assignment_id = $12 AND schedule_id = $11) AS on_call_assignment_count`,
      [
        serviceA.service_id,
        environment.environment_id,
        incidentA.incident_id,
        managerA.id,
        assignment.assignment_id,
        update.update_id,
        engineerA.id,
        policyA.policy_id,
        teamA.team_id,
        levelA.level_id,
        scheduleA.schedule_id,
        scheduleAssignment.assignment_id
      ]
    );
    assert.deepEqual(Object.values(persisted.rows[0]), [1, 1, 1, 1, 1, 1, 1, 1, 1]);
    const mongoEvents = await mongoDb.collection('incident_events')
      .find(
        {
          incident_id: String(incidentA.incident_id),
          occurred_at: { $gte: incidentEventsStartedAt }
        },
        { projection: { event_type: 1 } }
      )
      .toArray();
    const eventTypes = mongoEvents.map((event) => event.event_type).sort();
    assert.deepEqual(eventTypes, [
      'incident.assignment.created',
      'incident.assignment.unassigned',
      'incident.assignment.updated',
      'incident.created',
      'incident.updated',
      'incident.update.created'
    ].sort());
    recordPass('Direct PostgreSQL persistence and independent MongoDB event verification');
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => {
        if (child.exitCode !== null) resolve();
        else {
          child.once('exit', resolve);
          setTimeout(resolve, 5000).unref();
        }
      });
    }

    if (baselineCounts && fixturesMayExist) {
      try {
        const ownedIncidentIds = new Set(incidentIds);
        const createdTitles = [`${marker}-incident-a`, `${marker}-incident-b`];
        const cleanupFailures = [];

        try {
          const incidentRows = await pool.query(
            'SELECT incident_id FROM incident WHERE title LIKE $1',
            [`${marker}-%`]
          );
          for (const row of incidentRows.rows) ownedIncidentIds.add(String(row.incident_id));
        } catch {
          cleanupFailures.push('could not discover all marker-owned PostgreSQL incidents');
        }

        const postgresCleanup = async () => {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            await client.query('DELETE FROM incident WHERE title LIKE $1', [`${marker}-%`]);
            await client.query('DELETE FROM service WHERE name LIKE $1', [`${marker}-%`]);
            await client.query('DELETE FROM environment WHERE name LIKE $1', [`${marker}-%`]);
            await client.query(
              `DELETE FROM on_call_schedule
               WHERE team_id IN (SELECT team_id FROM team WHERE name LIKE $1)`,
              [`${marker}-%`]
            );
            await client.query(
              `DELETE FROM escalation_policy
               WHERE team_id IN (SELECT team_id FROM team WHERE name LIKE $1)`,
              [`${marker}-%`]
            );
            await client.query('DELETE FROM app_user WHERE email LIKE $1', [`${marker}-%@example.invalid`]);
            await client.query('DELETE FROM team WHERE name LIKE $1', [`${marker}-%`]);
            await client.query('COMMIT');
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          } finally {
            client.release();
          }
        };
        const mongoCleanup = async () => mongoClient.db()
          .collection('incident_events')
          .deleteMany({
            $or: [
              { incident_id: { $in: [...ownedIncidentIds] } },
              { 'snapshot.title': { $in: createdTitles } }
            ]
          });
        const cleanupResults = await Promise.allSettled([postgresCleanup(), mongoCleanup()]);
        for (const result of cleanupResults) {
          if (result.status === 'rejected') cleanupFailures.push('could not remove fixture records from a database');
        }

        try {
          const afterCounts = await tableCounts(pool);
          assertCountsEqual(afterCounts, baselineCounts, 'PostgreSQL table counts must return to baseline after cleanup');
        } catch {
          cleanupFailures.push('PostgreSQL fixture cleanup verification failed');
        }
        try {
          const remainingEvents = await mongoClient.db()
            .collection('incident_events')
            .countDocuments({
              $or: [
                { incident_id: { $in: [...ownedIncidentIds] } },
                { 'snapshot.title': { $in: createdTitles } }
              ]
            });
          assert.equal(remainingEvents, 0, 'test incident MongoDB events must be removed');
        } catch {
          cleanupFailures.push('MongoDB event cleanup verification failed');
        }

        if (cleanupFailures.length > 0) {
          console.error('FAIL Integration fixture cleanup or cleanup verification failed.');
          throw new Error('Fixture cleanup verification failed.');
        }
        cleanupVerified = true;
        console.log('PASS PostgreSQL fixture cleanup and MongoDB event cleanup verified');
      } catch {
        console.error('FAIL Integration fixture cleanup or cleanup verification failed.');
      }
    } else {
      cleanupVerified = true;
    }

    await mongoClient.close();
    await pool.end();
  }

  if (fixturesMayExist && !cleanupVerified) {
    fail('Integration fixture cleanup could not be verified.');
  }
  console.log(`API_INTEGRATION_CHECKS_PASSED=${passed.length}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run().catch((error) => {
    console.error(`API integration test failed: ${error.message}`);
    process.exitCode = 1;
  });
}
