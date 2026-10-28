import bcrypt from 'bcryptjs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { pathToFileURL } from 'node:url';

const processSeedPassword = process.env.DEMO_SEED_PASSWORD;
const processTestSettings = Object.fromEntries(
  [
    'API_TEST_PG_DATABASE',
    'API_TEST_MONGO_URI',
    'API_TEST_ADMIN_EMAIL',
    'API_TEST_ADMIN_PASSWORD'
  ].map((name) => [name, process.env[name]])
);
const databaseNamePattern = /^(?:test_[a-z0-9_]+|[a-z0-9_]+_test|[a-z0-9_]+_testing)$/i;
const demoAdmin = {
  name: 'Demo Administrator',
  email: 'demo.admin@smart-incident.example.invalid',
  role: 'admin'
};

const teams = [
  { key: 'platform', name: 'DEMO | Platform Operations', description: 'Fictional platform reliability team.' },
  { key: 'customer', name: 'DEMO | Customer Systems', description: 'Fictional customer applications team.' },
  { key: 'data', name: 'DEMO | Data Services', description: 'Fictional analytics and data team.' },
  { key: 'workplace', name: 'DEMO | Workplace Technology', description: 'Fictional internal technology team.' }
];

const environments = [
  { name: 'DEMO | Development', description: 'Fictional development environment.' },
  { name: 'DEMO | Staging', description: 'Fictional pre-production environment.' },
  { name: 'DEMO | Production', description: 'Fictional production environment.' },
  { name: 'DEMO | Disaster Recovery', description: 'Fictional recovery environment.' }
];

const services = [
  { key: 'edge-api', team: 'platform', name: 'DEMO | Edge API', criticality: 'critical' },
  { key: 'identity', team: 'platform', name: 'DEMO | Identity Gateway', criticality: 'high' },
  { key: 'customer-portal', team: 'customer', name: 'DEMO | Customer Portal', criticality: 'high' },
  { key: 'billing', team: 'customer', name: 'DEMO | Billing Engine', criticality: 'critical' },
  { key: 'event-stream', team: 'data', name: 'DEMO | Event Stream', criticality: 'high' },
  { key: 'warehouse', team: 'data', name: 'DEMO | Analytics Warehouse', criticality: 'medium' },
  { key: 'directory', team: 'workplace', name: 'DEMO | Employee Directory', criticality: 'medium' },
  { key: 'device-manager', team: 'workplace', name: 'DEMO | Device Manager', criticality: 'medium' }
];

const roleUsers = teams.flatMap((team) => [
  {
    key: `${team.key}-manager`,
    name: `${team.name.replace('DEMO | ', '')} Manager`,
    email: `demo.manager.${team.key}@smart-incident.example.invalid`,
    role: 'manager',
    team: team.key
  },
  ...[1, 2].map((number) => ({
    key: `${team.key}-engineer-${number}`,
    name: `${team.name.replace('DEMO | ', '')} Engineer ${number}`,
    email: `demo.engineer.${team.key}.${number}@smart-incident.example.invalid`,
    role: 'engineer',
    team: team.key
  }))
]);

const statuses = [
  'open', 'acknowledged', 'investigating', 'mitigated', 'resolved', 'closed',
  'open', 'acknowledged', 'investigating', 'resolved',
  'open', 'mitigated', 'closed', 'acknowledged',
  'investigating', 'resolved', 'open', 'mitigated', 'acknowledged', 'closed'
];
const severities = ['SEV1', 'SEV2', 'SEV3', 'SEV4', 'SEV5'];
const priorities = ['P1', 'P2', 'P3', 'P4', 'P5'];

const tags = [
  { name: 'DEMO | Availability', description: 'Fictional availability incident category.' },
  { name: 'DEMO | Performance', description: 'Fictional performance incident category.' },
  { name: 'DEMO | Security', description: 'Fictional security incident category.' },
  { name: 'DEMO | Database', description: 'Fictional database incident category.' },
  { name: 'DEMO | Networking', description: 'Fictional networking incident category.' },
  { name: 'DEMO | Customer Impact', description: 'Fictional customer-impact marker.' },
  { name: 'DEMO | Deployment', description: 'Fictional deployment incident category.' },
  { name: 'DEMO | Data Integrity', description: 'Fictional data integrity incident category.' }
];

const incidentTitles = [
  'Elevated gateway response times', 'Intermittent identity token errors',
  'Portal search requests timing out', 'Billing reconciliation backlog',
  'Event stream consumer lag', 'Warehouse refresh completed late',
  'Directory profile updates delayed', 'Device inventory sync stalled',
  'Gateway error rate increased after release', 'Identity cache miss rate elevated',
  'Portal notifications delivered slowly', 'Billing invoice export retrying',
  'Event stream partition rebalanced repeatedly', 'Warehouse query queue saturated',
  'Directory lookup returned stale records', 'Device enrollment requests delayed',
  'Gateway health probes intermittently failed', 'Billing totals differed in preview',
  'Event stream schema validation warnings', 'Portal session refresh latency increased'
];

const summaryEntities = [
  'teams', 'users', 'services', 'environments', 'incidents',
  'incidentAssignments', 'incidentUpdates', 'escalationPolicies',
  'escalationLevels', 'onCallSchedules', 'onCallAssignments',
  'tags', 'incidentTags'
];

function createSummary() {
  return Object.fromEntries(summaryEntities.map((name) => [name, { created: 0, existed: 0 }]));
}

function count(summary, entity, created) {
  summary[entity][created ? 'created' : 'existed'] += 1;
}

function idOf(record, field) {
  const value = record?.[field];
  if (value === undefined || value === null) {
    throw new Error(`The API response did not include ${field}.`);
  }
  return String(value);
}

function assertRecordMatches(record, expected, label) {
  for (const [field, expectedValue] of Object.entries(expected)) {
    const actualValue = record[field];
    if (expectedValue === null ? actualValue !== null : String(actualValue) !== String(expectedValue)) {
      throw new Error(`Existing ${label} does not match the demo fixture at ${field}; it was left unchanged.`);
    }
  }
}

export function validateDemoPassword(password) {
  if (typeof password !== 'string' || password.length < 12 ||
      Buffer.byteLength(password, 'utf8') > 72) {
    throw new Error('DEMO_SEED_PASSWORD must be at least 12 characters and at most 72 UTF-8 bytes.');
  }
}

export function assertSafeApplicationTarget(appEnv, { allowIsolatedTest = false } = {}) {
  if (typeof appEnv.PG?.DATABASE !== 'string' ||
      (!allowIsolatedTest && databaseNamePattern.test(appEnv.PG.DATABASE))) {
    throw new Error('Refusing to seed a PostgreSQL database with a test-only name.');
  }
  if (appEnv.NODE_ENV === 'production') {
    throw new Error('Demo seeding is disabled when NODE_ENV is production.');
  }

  let mongoDatabase;
  try {
    mongoDatabase = mongoDatabaseName(appEnv.MONGO_URI);
  } catch {
    throw new Error('The configured MongoDB URI is invalid; demo seeding was not started.');
  }
  if (!mongoDatabase || (!allowIsolatedTest && databaseNamePattern.test(mongoDatabase))) {
    throw new Error('Refusing to seed a MongoDB database with a test-only name.');
  }
}

export function buildDemoCatalog(now = new Date()) {
  const teamByKey = new Map(teams.map((team) => [team.key, team]));
  const servicesByTeam = new Map();
  for (const service of services) {
    const items = servicesByTeam.get(service.team) ?? [];
    items.push(service);
    servicesByTeam.set(service.team, items);
  }
  const usersByKey = new Map(roleUsers.map((user) => [user.key, user]));
  const start = new Date(now);
  start.setUTCMinutes(0, 0, 0);
  start.setUTCHours(start.getUTCHours() + 1);
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);

  const incidents = incidentTitles.map((title, index) => {
    const team = teams[index % teams.length];
    const teamServices = servicesByTeam.get(team.key);
    const status = statuses[index];
    return {
      key: `DEMO-IR-${String(index + 1).padStart(3, '0')}`,
      title: `DEMO-IR-${String(index + 1).padStart(3, '0')} | ${title}`,
      description: `Fictional demonstration incident ${index + 1}; no real customer or production data.`,
      service: teamServices[index % teamServices.length],
      environment: environments[(index + 2) % environments.length],
      team,
      severity: severities[index % severities.length],
      priority: priorities[(index * 2) % priorities.length],
      status,
      assignedUser: usersByKey.get(`${team.key}-engineer-${(index % 2) + 1}`),
      manager: usersByKey.get(`${team.key}-manager`),
      history: [
        `Demo history ${index + 1}: initial triage recorded for ${title.toLowerCase()}.`,
        `Demo history ${index + 1}: follow-up review completed; current incident status is ${status}.`
      ],
      tags: [...new Map(
        [tags[index % tags.length], tags[5]].map((tag) => [tag.name, tag])
      ).values()]
    };
  });

  return {
    teams,
    environments,
    services,
    users: roleUsers,
    incidents,
    policies: teams.map((team, index) => ({
      team,
      name: `DEMO | ${team.name.replace('DEMO | ', '')} Escalation`,
      description: `Fictional escalation policy for ${team.name.replace('DEMO | ', '')}.`,
      targets: [
        { targetType: 'user', targetUser: usersByKey.get(`${team.key}-manager`), waitMinutes: 5 },
        { targetType: 'user', targetUser: usersByKey.get(`${team.key}-engineer-1`), waitMinutes: 15 + index * 5 }
      ]
    })),
    schedules: teams.map((team) => ({
      team,
      name: `DEMO | ${team.name.replace('DEMO | ', '')} Weekly On-Call`,
      rotationType: 'weekly',
      startDate: start.toISOString().slice(0, 10),
      assignments: [
        usersByKey.get(`${team.key}-engineer-1`),
        usersByKey.get(`${team.key}-engineer-2`)
      ],
      startTime: start.toISOString(),
      endTime: end.toISOString()
    })),
    tags
  };
}

export async function ensureListedRecord({
  request,
  records,
  keyField,
  keyValue,
  route,
  body,
  expected,
  entity,
  summary,
  token
}) {
  let record = records.find((item) => String(item[keyField]) === String(keyValue));
  if (record) {
    assertRecordMatches(record, expected, entity);
    count(summary, entity, false);
    return record;
  }

  const response = await request('POST', route, { token, body });
  record = response?.data;
  if (!record) throw new Error(`Creating demo ${entity} returned no record.`);
  assertRecordMatches(record, expected, entity);
  records.push(record);
  count(summary, entity, true);
  return record;
}

function requireData(payload, label) {
  if (!payload || !Array.isArray(payload.data)) {
    throw new Error(`The API returned an invalid ${label} response.`);
  }
  return payload.data;
}

async function ensureDemoAdmin(pool, password, summary, createUserRecord) {
  const lookup = await pool.query(
    `SELECT user_id, team_id, name, email, role, is_active, password_hash
     FROM app_user
     WHERE email = $1`,
    [demoAdmin.email]
  );
  let user = lookup.rows[0];
  let created = false;
  if (!user) {
    user = await createUserRecord({
      name: demoAdmin.name,
      email: demoAdmin.email,
      password,
      role: demoAdmin.role,
      teamId: null
    });
    created = true;
    const inserted = await pool.query(
      `SELECT user_id, team_id, name, email, role, is_active, password_hash
       FROM app_user
       WHERE email = $1`,
      [demoAdmin.email]
    );
    user = inserted.rows[0];
  }
  if (!user || user.name !== demoAdmin.name || user.email !== demoAdmin.email ||
      user.role !== 'admin' || user.team_id !== null || !user.is_active ||
      !(await bcrypt.compare(password, user.password_hash))) {
    throw new Error('The existing demo administrator conflicts with the expected demo account; it was not changed.');
  }
  count(summary, 'users', created);
  return user;
}

async function verifyUserPassword(pool, userId, password) {
  const result = await pool.query(
    'SELECT password_hash FROM app_user WHERE user_id = $1 AND is_active = TRUE',
    [userId]
  );
  if (!result.rows[0] || !(await bcrypt.compare(password, result.rows[0].password_hash))) {
    throw new Error('An existing demo user does not use DEMO_SEED_PASSWORD; no password was changed.');
  }
}

async function ensureTag(pool, tag, summary) {
  const found = await pool.query('SELECT tag_id, name, description FROM tag WHERE name = $1', [tag.name]);
  if (found.rows[0]) {
    assertRecordMatches(found.rows[0], { description: tag.description }, 'tag');
    count(summary, 'tags', false);
    return found.rows[0];
  }

  const inserted = await pool.query(
    `INSERT INTO tag (name, description)
     VALUES ($1, $2)
     ON CONFLICT (name) DO NOTHING
     RETURNING tag_id, name, description`,
    [tag.name, tag.description]
  );
  const record = inserted.rows[0] ??
    (await pool.query('SELECT tag_id, name, description FROM tag WHERE name = $1', [tag.name])).rows[0];
  if (!record) throw new Error('A demo tag could not be created or retrieved.');
  assertRecordMatches(record, { description: tag.description }, 'tag');
  count(summary, 'tags', Boolean(inserted.rows[0]));
  return record;
}

async function ensureIncidentTag(pool, incidentId, tagId, summary) {
  const result = await pool.query(
    `INSERT INTO incident_tag (incident_id, tag_id)
     VALUES ($1, $2)
     ON CONFLICT (incident_id, tag_id) DO NOTHING
     RETURNING incident_id`,
    [incidentId, tagId]
  );
  count(summary, 'incidentTags', result.rowCount > 0);
}

async function verifyIncidentEvents(db, incidents, assignments, updates) {
  const collection = db.collection('incident_events');
  let verified = 0;
  const expected = [
    ...incidents.map((incident) => ({
      incident_id: idOf(incident, 'incident_id'),
      event_type: 'incident.created'
    })),
    ...assignments.map((assignment) => ({
      incident_id: idOf(assignment, 'incident_id'),
      event_type: 'incident.assignment.created',
      assignment_id: idOf(assignment, 'assignment_id')
    })),
    ...updates.map((update) => ({
      incident_id: idOf(update, 'incident_id'),
      event_type: 'incident.update.created',
      update_id: idOf(update, 'update_id')
    }))
  ];

  for (const criteria of expected) {
    if (await collection.countDocuments(criteria) < 1) {
      throw new Error(`A persisted MongoDB incident event is missing for ${criteria.event_type}.`);
    }
    verified += 1;
  }
  return verified;
}

async function assertPersistedCount(pool, query, values, expected, label) {
  const result = await pool.query(query, values);
  const actual = Number(result.rows[0]?.count);
  if (actual !== expected) {
    throw new Error(`PostgreSQL persistence check failed for ${label}: expected ${expected}, found ${actual}.`);
  }
}

async function verifyRelationalPersistence({
  pool,
  teams,
  users,
  services,
  environments,
  incidents,
  assignments,
  updates,
  policies,
  levels,
  schedules,
  onCallAssignments,
  tagRecords,
  incidentTagCount
}) {
  const teamIds = teams.map((record) => idOf(record, 'team_id'));
  const userIds = users.map((record) => idOf(record, 'user_id'));
  const serviceIds = services.map((record) => idOf(record, 'service_id'));
  const environmentIds = environments.map((record) => idOf(record, 'environment_id'));
  const incidentIds = incidents.map((record) => idOf(record, 'incident_id'));
  const policyIds = policies.map((record) => idOf(record, 'policy_id'));
  const scheduleIds = schedules.map((record) => idOf(record, 'schedule_id'));
  const tagIds = [...tagRecords.values()].map((record) => idOf(record, 'tag_id'));

  await assertPersistedCount(
    pool,
    'SELECT COUNT(*)::int AS count FROM team WHERE team_id = ANY($1::bigint[])',
    [teamIds],
    teams.length,
    'teams'
  );
  await assertPersistedCount(
    pool,
    'SELECT COUNT(*)::int AS count FROM app_user WHERE user_id = ANY($1::bigint[]) AND is_active = TRUE',
    [userIds],
    users.length,
    'demo users'
  );
  await assertPersistedCount(
    pool,
    `SELECT COUNT(*)::int AS count
     FROM service s
     JOIN team t ON t.team_id = s.team_id
     WHERE s.service_id = ANY($1::bigint[])`,
    [serviceIds],
    services.length,
    'services and team references'
  );
  await assertPersistedCount(
    pool,
    'SELECT COUNT(*)::int AS count FROM environment WHERE environment_id = ANY($1::bigint[])',
    [environmentIds],
    environments.length,
    'environments'
  );
  await assertPersistedCount(
    pool,
    `SELECT COUNT(*)::int AS count
     FROM incident i
     JOIN service s ON s.service_id = i.service_id
     JOIN environment e ON e.environment_id = i.environment_id
     JOIN app_user creator ON creator.user_id = i.created_by
     WHERE i.incident_id = ANY($1::bigint[])`,
    [incidentIds],
    incidents.length,
    'incidents and their service/environment/creator references'
  );
  await assertPersistedCount(
    pool,
    `SELECT COUNT(*)::int AS count
     FROM incident_assignment ia
     JOIN incident i ON i.incident_id = ia.incident_id
     JOIN service s ON s.service_id = i.service_id
     JOIN app_user u ON u.user_id = ia.user_id AND u.team_id = s.team_id
     WHERE ia.assignment_id = ANY($1::bigint[])`,
    [assignments.map((record) => idOf(record, 'assignment_id'))],
    assignments.length,
    'incident assignments and team eligibility'
  );
  await assertPersistedCount(
    pool,
    `SELECT COUNT(*)::int AS count
     FROM incident_update iu
     JOIN incident i ON i.incident_id = iu.incident_id
     JOIN app_user u ON u.user_id = iu.user_id
     WHERE iu.update_id = ANY($1::bigint[])`,
    [updates.map((record) => idOf(record, 'update_id'))],
    updates.length,
    'incident update histories'
  );
  await assertPersistedCount(
    pool,
    `SELECT COUNT(*)::int AS count
     FROM escalation_level el
     JOIN escalation_policy ep ON ep.policy_id = el.policy_id
     JOIN team t ON t.team_id = ep.team_id
     JOIN app_user target ON el.target_type = 'user' AND target.user_id = el.target_id
     WHERE el.level_id = ANY($1::bigint[])`,
    [levels.map((record) => idOf(record, 'level_id'))],
    levels.length,
    'escalation levels and targets'
  );
  await assertPersistedCount(
    pool,
    `SELECT COUNT(*)::int AS count
     FROM on_call_assignment oa
     JOIN on_call_schedule s ON s.schedule_id = oa.schedule_id
     JOIN app_user u ON u.user_id = oa.user_id AND u.team_id = s.team_id
     WHERE oa.assignment_id = ANY($1::bigint[])`,
    [onCallAssignments.map((record) => idOf(record, 'assignment_id'))],
    onCallAssignments.length,
    'on-call assignments and team eligibility'
  );
  await assertPersistedCount(
    pool,
    'SELECT COUNT(*)::int AS count FROM escalation_policy WHERE policy_id = ANY($1::bigint[])',
    [policyIds],
    policies.length,
    'escalation policies'
  );
  await assertPersistedCount(
    pool,
    'SELECT COUNT(*)::int AS count FROM on_call_schedule WHERE schedule_id = ANY($1::bigint[])',
    [scheduleIds],
    schedules.length,
    'on-call schedules'
  );
  await assertPersistedCount(
    pool,
    'SELECT COUNT(*)::int AS count FROM tag WHERE tag_id = ANY($1::bigint[])',
    [tagIds],
    tagRecords.size,
    'tags'
  );
  await assertPersistedCount(
    pool,
    `SELECT COUNT(*)::int AS count
     FROM incident_tag it
     JOIN incident i ON i.incident_id = it.incident_id
     JOIN tag t ON t.tag_id = it.tag_id
     WHERE it.incident_id = ANY($1::bigint[])
       AND it.tag_id = ANY($2::bigint[])`,
    [incidentIds, tagIds],
    incidentTagCount,
    'incident-tag associations'
  );
}

function logSummary(summary, eventCount, success) {
  console.log(success ? 'Demo seed summary:' : 'Demo seed stopped; partial writes may remain and are safe to retry:');
  for (const [entity, counts] of Object.entries(summary)) {
    console.log(`  ${entity}: created ${counts.created}, already existed ${counts.existed}`);
  }
  if (eventCount !== null) {
    console.log(`  MongoDB incident events verified: ${eventCount}`);
  }
}

function assertNoSeedCreates(summary) {
  const unexpected = Object.entries(summary)
    .filter(([, counts]) => counts.created !== 0)
    .map(([entity]) => entity);
  if (unexpected.length > 0) {
    throw new Error(`The repeat seed run was not idempotent; it created records in: ${unexpected.join(', ')}.`);
  }
}

export async function seedDemoData({
  request,
  pool,
  password,
  createUserRecord,
  connectMongo,
  preserveAdmin = { userId: '53', email: 'admin@smart.com' },
  summary = createSummary(),
  now = new Date()
}) {
  validateDemoPassword(password);
  const catalog = buildDemoCatalog(now);

  if (preserveAdmin) {
    const preserved = await pool.query(
      'SELECT user_id, email FROM app_user WHERE user_id = $1 AND email = $2',
      [preserveAdmin.userId, preserveAdmin.email]
    );
    if (preserved.rowCount !== 1) {
      throw new Error(`Expected existing admin user_id ${preserveAdmin.userId} (${preserveAdmin.email}) was not found; no demo records were seeded.`);
    }
  }

  const adminUser = await ensureDemoAdmin(pool, password, summary, createUserRecord);
  const login = await request('POST', '/auth/login', {
    body: { email: demoAdmin.email, password }
  });
  if (!login?.accessToken || login.user?.role !== 'admin' ||
      String(login.user.id) !== String(adminUser.user_id)) {
    throw new Error('The demo administrator could not authenticate.');
  }
  const token = login.accessToken;

  const teamRecords = requireData(await request('GET', '/teams', { token }), 'team list');
  const teamByKey = new Map();
  for (const team of catalog.teams) {
    const record = await ensureListedRecord({
      request, records: teamRecords, keyField: 'name', keyValue: team.name,
      route: '/teams', body: { name: team.name, description: team.description },
      expected: { name: team.name, description: team.description },
      entity: 'teams', summary, token
    });
    teamByKey.set(team.key, record);
  }

  const userRecords = requireData(await request('GET', '/users', { token }), 'user list');
  const usersByKey = new Map();
  const seededUsers = [adminUser];
  for (const fixture of catalog.users) {
    const team = teamByKey.get(fixture.team);
    const record = await ensureListedRecord({
      request, records: userRecords, keyField: 'email', keyValue: fixture.email,
      route: '/users',
      body: {
        name: fixture.name,
        email: fixture.email,
        password,
        role: fixture.role,
        teamId: idOf(team, 'team_id')
      },
      expected: {
        name: fixture.name,
        email: fixture.email,
        role: fixture.role,
        team_id: idOf(team, 'team_id'),
        is_active: true
      },
      entity: 'users', summary, token
    });
    await verifyUserPassword(pool, idOf(record, 'user_id'), password);
    usersByKey.set(fixture.key, record);
    seededUsers.push(record);
  }

  const serviceRecords = requireData(await request('GET', '/services', { token }), 'service list');
  const servicesByKey = new Map();
  const seededServices = [];
  for (const service of catalog.services) {
    const team = teamByKey.get(service.team);
    const record = await ensureListedRecord({
      request, records: serviceRecords, keyField: 'name', keyValue: service.name,
      route: '/services',
      body: {
        name: service.name,
        description: `Fictional ${service.name.replace('DEMO | ', '')} service.`,
        criticality: service.criticality,
        teamId: idOf(team, 'team_id')
      },
      expected: {
        name: service.name,
        team_id: idOf(team, 'team_id'),
        criticality: service.criticality,
        is_active: true
      },
      entity: 'services', summary, token
    });
    servicesByKey.set(service.key, record);
    seededServices.push(record);
  }

  const environmentRecords = requireData(
    await request('GET', '/environments', { token }),
    'environment list'
  );
  const environmentByName = new Map();
  const seededEnvironments = [];
  for (const environment of catalog.environments) {
    const record = await ensureListedRecord({
      request, records: environmentRecords, keyField: 'name', keyValue: environment.name,
      route: '/environments',
      body: { name: environment.name, description: environment.description },
      expected: { name: environment.name, description: environment.description },
      entity: 'environments', summary, token
    });
    environmentByName.set(environment.name, record);
    seededEnvironments.push(record);
  }

  const incidentRecords = requireData(await request('GET', '/incidents', { token }), 'incident list');
  const seededIncidents = [];
  for (const fixture of catalog.incidents) {
    const service = servicesByKey.get(fixture.service.key);
    const environment = environmentByName.get(fixture.environment.name);
    const record = await ensureListedRecord({
      request, records: incidentRecords, keyField: 'title', keyValue: fixture.title,
      route: '/incidents',
      body: {
        serviceId: idOf(service, 'service_id'),
        environmentId: idOf(environment, 'environment_id'),
        title: fixture.title,
        description: fixture.description,
        severity: fixture.severity,
        priority: fixture.priority,
        status: fixture.status
      },
      expected: {
        service_id: idOf(service, 'service_id'),
        environment_id: idOf(environment, 'environment_id'),
        title: fixture.title,
        description: fixture.description,
        severity: fixture.severity,
        priority: fixture.priority,
        status: fixture.status,
        created_by: idOf(adminUser, 'user_id')
      },
      entity: 'incidents', summary, token
    });
    seededIncidents.push(record);
  }

  const assignmentRecords = requireData(
    await request('GET', '/incident-assignments', { token }),
    'incident assignment list'
  );
  const seededAssignments = [];
  for (let index = 0; index < catalog.incidents.length; index += 1) {
    const incident = seededIncidents[index];
    const fixture = catalog.incidents[index];
    const user = usersByKey.get(fixture.assignedUser.key);
    let assignment = assignmentRecords.find((item) =>
      String(item.incident_id) === idOf(incident, 'incident_id') &&
      String(item.user_id) === idOf(user, 'user_id') &&
      item.assignment_type === 'responder' &&
      item.unassigned_at === null
    );
    if (assignment) {
      count(summary, 'incidentAssignments', false);
    } else {
      const response = await request('POST', '/incident-assignments', {
        token,
        body: {
          incidentId: idOf(incident, 'incident_id'),
          userId: idOf(user, 'user_id'),
          assignmentType: 'responder'
        }
      });
      assignment = response?.data;
      if (!assignment) throw new Error('Creating a demo incident assignment returned no record.');
      assignmentRecords.push(assignment);
      count(summary, 'incidentAssignments', true);
    }
    assertRecordMatches(assignment, {
      incident_id: idOf(incident, 'incident_id'),
      user_id: idOf(user, 'user_id'),
      assignment_type: 'responder'
    }, 'incident assignment');
    seededAssignments.push(assignment);
  }

  const seededUpdates = [];
  for (let index = 0; index < catalog.incidents.length; index += 1) {
    const incident = seededIncidents[index];
    const fixture = catalog.incidents[index];
    const existingUpdates = requireData(
      await request('GET', `/incidents/${idOf(incident, 'incident_id')}/updates`, { token }),
      'incident update list'
    );
    for (const message of fixture.history) {
      let update = existingUpdates.find((item) => item.message === message);
      if (update) {
        assertRecordMatches(update, {
          incident_id: idOf(incident, 'incident_id'),
          user_id: idOf(adminUser, 'user_id'),
          status: null,
          message
        }, 'incident update');
        count(summary, 'incidentUpdates', false);
      } else {
        const response = await request(
          'POST',
          `/incidents/${idOf(incident, 'incident_id')}/updates`,
          { token, body: { status: null, message } }
        );
        update = response?.data;
        if (!update) throw new Error('Creating a demo incident update returned no record.');
        existingUpdates.push(update);
        count(summary, 'incidentUpdates', true);
      }
      seededUpdates.push(update);
    }
  }

  const policyRecords = requireData(
    await request('GET', '/escalation-policies', { token }),
    'escalation policy list'
  );
  const seededPolicies = [];
  const seededPolicyRecords = [];
  const seededLevels = [];
  for (const fixture of catalog.policies) {
    const team = teamByKey.get(fixture.team.key);
    const policy = await ensureListedRecord({
      request, records: policyRecords, keyField: 'name', keyValue: fixture.name,
      route: '/escalation-policies',
      body: {
        name: fixture.name,
        description: fixture.description,
        teamId: idOf(team, 'team_id'),
        isActive: true
      },
      expected: {
        name: fixture.name,
        description: fixture.description,
        team_id: idOf(team, 'team_id'),
        is_active: true
      },
      entity: 'escalationPolicies', summary, token
    });
    seededPolicies.push({ policy, fixture });
    seededPolicyRecords.push(policy);
  }

  for (const { policy, fixture } of seededPolicies) {
    const levels = requireData(
      await request('GET', `/escalation-policies/${idOf(policy, 'policy_id')}/levels`, { token }),
      'escalation level list'
    );
    for (let index = 0; index < fixture.targets.length; index += 1) {
      const target = fixture.targets[index];
      const expected = {
        policy_id: idOf(policy, 'policy_id'),
        level_number: index + 1,
        target_type: target.targetType,
        target_id: idOf(usersByKey.get(target.targetUser.key), 'user_id'),
        wait_minutes: target.waitMinutes
      };
      const level = await ensureListedRecord({
        request, records: levels, keyField: 'level_number', keyValue: index + 1,
        route: `/escalation-policies/${idOf(policy, 'policy_id')}/levels`,
        body: {
          levelNumber: index + 1,
          targetType: target.targetType,
          targetId: expected.target_id,
          waitMinutes: target.waitMinutes
        },
        expected,
        entity: 'escalationLevels', summary, token
      });
      seededLevels.push(level);
    }
  }

  const scheduleRecords = requireData(
    await request('GET', '/on-call-schedules', { token }),
    'on-call schedule list'
  );
  const seededSchedules = [];
  const seededScheduleRecords = [];
  const seededOnCallAssignments = [];
  for (const fixture of catalog.schedules) {
    const team = teamByKey.get(fixture.team.key);
    const schedule = await ensureListedRecord({
      request, records: scheduleRecords, keyField: 'name', keyValue: fixture.name,
      route: '/on-call-schedules',
      body: {
        teamId: idOf(team, 'team_id'),
        name: fixture.name,
        rotationType: fixture.rotationType,
        startDate: fixture.startDate,
        endDate: null
      },
      expected: {
        team_id: idOf(team, 'team_id'),
        name: fixture.name,
        rotation_type: fixture.rotationType
      },
      entity: 'onCallSchedules', summary, token
    });
    seededSchedules.push({ schedule, fixture });
    seededScheduleRecords.push(schedule);
  }

  for (const { schedule, fixture } of seededSchedules) {
    const assignments = requireData(
      await request('GET', `/on-call-schedules/${idOf(schedule, 'schedule_id')}/assignments`, { token }),
      'on-call assignment list'
    );
    for (const userFixture of fixture.assignments) {
      const user = usersByKey.get(userFixture.key);
      let assignment = assignments.find((item) =>
        String(item.user_id) === idOf(user, 'user_id')
      );
      if (assignment) {
        count(summary, 'onCallAssignments', false);
      } else {
        const response = await request(
          'POST',
          `/on-call-schedules/${idOf(schedule, 'schedule_id')}/assignments`,
          {
            token,
            body: {
              userId: idOf(user, 'user_id'),
              startTime: fixture.startTime,
              endTime: fixture.endTime
            }
          }
        );
        assignment = response?.data;
        if (!assignment) throw new Error('Creating a demo on-call assignment returned no record.');
        assignments.push(assignment);
        count(summary, 'onCallAssignments', true);
      }
      assertRecordMatches(assignment, {
        schedule_id: idOf(schedule, 'schedule_id'),
        user_id: idOf(user, 'user_id')
      }, 'on-call assignment');
      seededOnCallAssignments.push(assignment);
    }
  }

  const tagRecords = new Map();
  for (const tag of catalog.tags) {
    tagRecords.set(tag.name, await ensureTag(pool, tag, summary));
  }
  let incidentTagCount = 0;
  for (let index = 0; index < catalog.incidents.length; index += 1) {
    const incident = seededIncidents[index];
    for (const tag of catalog.incidents[index].tags) {
      const tagRecord = tagRecords.get(tag.name);
      await ensureIncidentTag(
        pool,
        idOf(incident, 'incident_id'),
        idOf(tagRecord, 'tag_id'),
        summary
      );
      incidentTagCount += 1;
    }
  }

  await verifyRelationalPersistence({
    pool,
    teams: catalog.teams.map((team) => teamByKey.get(team.key)),
    users: seededUsers,
    services: seededServices,
    environments: seededEnvironments,
    incidents: seededIncidents,
    assignments: seededAssignments,
    updates: seededUpdates,
    policies: seededPolicyRecords,
    levels: seededLevels,
    schedules: seededScheduleRecords,
    onCallAssignments: seededOnCallAssignments,
    tagRecords,
    incidentTagCount
  });
  const { db } = await connectMongo();
  await db.command({ ping: 1 });
  const eventsVerified = await verifyIncidentEvents(db, seededIncidents, seededAssignments, seededUpdates);
  return { summary, eventsVerified };
}

async function createApiRequest(baseUrl) {
  return async (method, route, { token, body } = {}) => {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${baseUrl}/api${route}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    let payload = null;
    if (response.status !== 204) {
      try {
        payload = await response.json();
      } catch {
        throw new Error(`The API returned a non-JSON response for ${method} ${route}.`);
      }
    }
    if (!response.ok) {
      throw new Error(`API ${method} ${route} failed (${response.status}): ${payload?.message || 'request rejected'}`);
    }
    return payload;
  };
}

async function confirmDatabase(databaseName) {
  if (!stdin.isTTY) {
    throw new Error('Demo seeding requires an interactive terminal to confirm the configured database.');
  }
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await terminal.question(
      `Demo data will be written to the configured application database "${databaseName}". Type that name to continue: `
    );
    if (answer !== databaseName) {
      throw new Error('Database confirmation did not match; no demo data was written.');
    }
  } finally {
    terminal.close();
  }
}

async function startSeedApi(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not determine the local API listener address.');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server) {
  if (!server) return;
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function mongoDatabaseName(uri) {
  const parsed = new URL(uri);
  if (!['mongodb:', 'mongodb+srv:'].includes(parsed.protocol)) {
    throw new Error('Unsupported MongoDB URI protocol.');
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  return database || 'test';
}

export function validateIsolatedTestSettings(testSettings, appEnv) {
  const requiredNames = [
    'API_TEST_PG_DATABASE',
    'API_TEST_MONGO_URI',
    'API_TEST_ADMIN_EMAIL',
    'API_TEST_ADMIN_PASSWORD'
  ];
  const missing = requiredNames.filter((name) =>
    typeof testSettings[name] !== 'string' || testSettings[name].trim() === ''
  );
  if (missing.length > 0) {
    throw new Error(`Missing isolated test settings: ${missing.join(', ')}.`);
  }
  if (!databaseNamePattern.test(testSettings.API_TEST_PG_DATABASE)) {
    throw new Error('API_TEST_PG_DATABASE must use a test-only database name.');
  }
  if (testSettings.API_TEST_PG_DATABASE === appEnv.PG.DATABASE) {
    throw new Error('The isolated PostgreSQL target must differ from the configured application database.');
  }

  let testMongoName;
  let applicationMongoName;
  try {
    testMongoName = mongoDatabaseName(testSettings.API_TEST_MONGO_URI);
    applicationMongoName = mongoDatabaseName(appEnv.MONGO_URI);
  } catch {
    throw new Error('A configured MongoDB URI is invalid; isolated seeding was not started.');
  }
  if (!databaseNamePattern.test(testMongoName)) {
    throw new Error('API_TEST_MONGO_URI must select a test-only database name.');
  }
  if (testMongoName === applicationMongoName) {
    throw new Error('The isolated MongoDB target must differ from the configured application database.');
  }
}

const expectedSchemaTables = [
  'app_user',
  'environment',
  'escalation_level',
  'escalation_policy',
  'incident',
  'incident_assignment',
  'incident_tag',
  'incident_update',
  'on_call_assignment',
  'on_call_schedule',
  'service',
  'tag',
  'team'
];

async function assertIsolatedPostgresSchema(pool, expectedDatabase) {
  const current = await pool.query('SELECT current_database() AS database_name');
  if (current.rows[0]?.database_name !== expectedDatabase) {
    throw new Error('PostgreSQL connected to a database other than API_TEST_PG_DATABASE.');
  }
  const result = await pool.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`
  );
  const actual = result.rows.map((row) => row.table_name).sort();
  if (actual.length !== expectedSchemaTables.length ||
      actual.some((name, index) => name !== expectedSchemaTables[index])) {
    throw new Error('The isolated PostgreSQL database must already contain exactly the existing 13 public tables.');
  }
}

async function runCli() {
  const summary = createSummary();
  let server;
  let eventCount = null;
  let succeeded = false;
  let pool;
  let closeMongo;
  let lockClient;
  let lockAcquired = false;

  try {
    validateDemoPassword(processSeedPassword);
    const { env } = await import('../config/env.js');
    const isolatedTest = process.argv.includes('--isolated-test');
    if (isolatedTest) {
      validateIsolatedTestSettings(processTestSettings, env);
      process.env.PG_DATABASE = processTestSettings.API_TEST_PG_DATABASE;
      process.env.MONGO_URI = processTestSettings.API_TEST_MONGO_URI;
      process.env.NODE_ENV = 'test';
      env.PG.DATABASE = processTestSettings.API_TEST_PG_DATABASE;
      env.MONGO_URI = processTestSettings.API_TEST_MONGO_URI;
      env.NODE_ENV = 'test';
    } else {
      await confirmDatabase(env.PG.DATABASE);
    }
    assertSafeApplicationTarget(env, { allowIsolatedTest: isolatedTest });

    const [appModule, postgresModule, mongoModule, userModule] = await Promise.all([
      import('../app.js'),
      import('../config/postgres.js'),
      import('../config/mongodb.js'),
      import('../services/users.service.js')
    ]);

    pool = postgresModule.pgPool;
    closeMongo = mongoModule.closeMongo;
    if (isolatedTest) {
      await assertIsolatedPostgresSchema(pool, processTestSettings.API_TEST_PG_DATABASE);
      const { db } = await mongoModule.connectMongo();
      if (db.databaseName !== mongoDatabaseName(processTestSettings.API_TEST_MONGO_URI)) {
        throw new Error('MongoDB connected to a database other than API_TEST_MONGO_URI.');
      }
      await db.command({ ping: 1 });
    }
    lockClient = await pool.connect();
    await lockClient.query('SELECT pg_advisory_lock($1, $2)', [8421, 20261027]);
    lockAcquired = true;

    const apiServer = await startSeedApi(appModule.default);
    server = apiServer.server;
    const request = await createApiRequest(apiServer.baseUrl);
    if (isolatedTest) {
      const verification = await request('POST', '/auth/login', {
        body: {
          email: processTestSettings.API_TEST_ADMIN_EMAIL,
          password: processTestSettings.API_TEST_ADMIN_PASSWORD
        }
      });
      if (!verification?.accessToken || verification.user?.role !== 'admin') {
        throw new Error('The configured isolated test admin could not authenticate.');
      }
    }
    const seedResult = await seedDemoData({
      request,
      pool,
      password: processSeedPassword,
      createUserRecord: userModule.createUser,
      connectMongo: mongoModule.connectMongo,
      preserveAdmin: isolatedTest ? null : undefined,
      summary
    });
    eventCount = seedResult.eventsVerified;
    if (isolatedTest) {
      const repeatSummary = createSummary();
      const repeated = await seedDemoData({
        request,
        pool,
        password: processSeedPassword,
        createUserRecord: userModule.createUser,
        connectMongo: mongoModule.connectMongo,
        preserveAdmin: null,
        summary: repeatSummary
      });
      assertNoSeedCreates(repeatSummary);
      if (repeated.eventsVerified !== seedResult.eventsVerified) {
        throw new Error('The idempotent repeat run did not verify the same MongoDB incident events.');
      }
      console.log('PASS isolated demo seeder idempotency: repeat run created no duplicate records');
    }
    succeeded = true;
  } finally {
    logSummary(summary, eventCount, succeeded);
    try {
      if (server) await closeServer(server);
    } finally {
      try {
        if (lockAcquired) {
          await lockClient.query('SELECT pg_advisory_unlock($1, $2)', [8421, 20261027]);
        }
      } finally {
        if (lockClient) lockClient.release();
        try {
          if (closeMongo) await closeMongo();
        } finally {
          if (pool) await pool.end();
        }
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error(`Demo data seeding failed: ${error.message}`);
    process.exitCode = 1;
  });
}
