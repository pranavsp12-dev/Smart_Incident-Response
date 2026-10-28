import assert from 'node:assert/strict';
import { test } from 'node:test';
import { env } from '../src/config/env.js';
import { pgPool } from '../src/config/postgres.js';
import { createAccessToken } from '../src/services/auth.service.js';
import { recordIncidentEvent } from '../src/services/incidents.service.js';
import app from '../src/app.js';

const userRows = {
  '1': { role: 'admin', team_id: null },
  '2': { role: 'manager', team_id: '7' },
  '3': { role: 'engineer', team_id: '7' },
  '4': { role: 'engineer', team_id: '8' },
  '5': { role: 'manager', team_id: null },
  '6': { role: 'engineer', team_id: null }
};

const serviceRows = {
  '10': { service_id: '10', team_id: '7', is_active: true },
  '11': { service_id: '11', team_id: '8', is_active: true },
  '12': { service_id: '12', team_id: null, is_active: true },
  '13': { service_id: '13', team_id: '7', is_active: false }
};

const environmentRows = {
  '20': { environment_id: '20' },
  '21': { environment_id: '21' }
};

function createIncidentRow(id, overrides = {}) {
  return {
    incident_id: String(id),
    service_id: '10',
    environment_id: '20',
    title: `Incident ${id}`,
    description: null,
    severity: 'SEV3',
    priority: 'P3',
    status: 'open',
    detected_at: '2026-01-01T00:00:00.000Z',
    acknowledged_at: null,
    resolved_at: null,
    created_by: '3',
    resolved_by: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

test('Incidents API enforces schema validation, team scope, and field permissions', async (t) => {
  env.JWT_SECRET = 'test-only-secret-that-is-long-enough-for-jwt';
  const originalQuery = pgPool.query;
  const originalConnect = pgPool.connect;
  const incidents = new Map([
    ['100', createIncidentRow('100')],
    ['101', createIncidentRow('101', { service_id: '11', created_by: '4' })],
    ['102', createIncidentRow('102', { service_id: '12', created_by: '1' })]
  ]);
  let nextIncidentId = 200;
  let queryConstraintFailure = null;
  let eventWriteFailure = false;
  let commitFailure = false;
  let pendingIncidentId = null;
  let incidentSnapshot = null;
  const capturedQueries = [];
  const incidentEvents = [];
  const compensatedEventIds = [];
  const originalIncidentEventWriter = app.locals.incidentEventWriter;
  app.locals.incidentEventWriter = async (event) => {
    if (eventWriteFailure) {
      return recordIncidentEvent(event, async () => {
        throw Object.assign(new Error('MongoDB unavailable'), { code: 'ECONNREFUSED' });
      });
    }
    incidentEvents.push(event);
    const eventId = `event-${incidentEvents.length}`;
    return {
      db: {
        collection(name) {
          assert.equal(name, 'incident_events');
          return {
            async deleteOne(filter) {
              compensatedEventIds.push(filter._id);
              return { deletedCount: 1 };
            }
          };
        }
      },
      eventId
    };
  };

  pgPool.query = async (sql, values = []) => {
    capturedQueries.push({ sql, values });
    if (sql.includes('FROM app_user')) {
      const user = userRows[String(values[0])];
      return {
        rows: user
          ? [{
            user_id: String(values[0]),
            role: user.role,
            team_id: user.team_id,
            is_active: true
          }]
          : [],
        rowCount: user ? 1 : 0
      };
    }
    if (sql.includes('FROM incident i') && sql.includes('JOIN service s')) {
      if (sql.includes('AND FALSE')) return { rows: [], rowCount: 0 };
      const teamFilter = sql.match(/s\.team_id = \$(\d+)/);
      const serviceFilterValue = teamFilter
        ? String(values[Number(teamFilter[1]) - 1])
        : null;
      const idFilter = sql.match(/i\.incident_id = \$(\d+)/);
      const incidentRows = [...incidents.values()].filter((incident) => {
        if (idFilter && incident.incident_id !== String(values[Number(idFilter[1]) - 1])) {
          return false;
        }
        const service = serviceRows[incident.service_id];
        return !teamFilter || (service && service.team_id === serviceFilterValue);
      });
      if (sql.includes('ORDER BY i.detected_at DESC, i.incident_id DESC')) {
        incidentRows.sort((left, right) =>
          right.detected_at.localeCompare(left.detected_at) ||
          (BigInt(right.incident_id) > BigInt(left.incident_id) ? 1 : -1)
        );
      }
      return { rows: incidentRows.map((incident) => ({ ...incident })), rowCount: incidentRows.length };
    }
    throw new Error(`Unexpected pool SQL in test: ${sql}`);
  };

  pgPool.connect = async () => {
    const client = {
      async query(sql, values = []) {
        capturedQueries.push({ sql, values });
        if (sql === 'BEGIN') {
          incidentSnapshot = new Map(
            [...incidents].map(([id, incident]) => [id, { ...incident }])
          );
          return { rows: [], rowCount: 0 };
        }
        if (sql === 'COMMIT') {
          if (commitFailure) {
            commitFailure = false;
            throw Object.assign(new Error('PostgreSQL commit failed'), { code: '08006' });
          }
          pendingIncidentId = null;
          incidentSnapshot = null;
          return { rows: [], rowCount: 0 };
        }
        if (sql === 'ROLLBACK') {
          if (incidentSnapshot) {
            incidents.clear();
            for (const [id, incident] of incidentSnapshot) incidents.set(id, incident);
          } else if (pendingIncidentId !== null) {
            incidents.delete(pendingIncidentId);
          }
          pendingIncidentId = null;
          incidentSnapshot = null;
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('FROM service') && sql.includes('FOR SHARE')) {
          const service = serviceRows[String(values[0])];
          return { rows: service ? [{ ...service }] : [], rowCount: service ? 1 : 0 };
        }
        if (sql.includes('FROM environment') && sql.includes('FOR KEY SHARE')) {
          const environment = environmentRows[String(values[0])];
          return {
            rows: environment ? [{ ...environment }] : [],
            rowCount: environment ? 1 : 0
          };
        }
        if (sql.includes('INSERT INTO incident')) {
          if (queryConstraintFailure) {
            const error = queryConstraintFailure;
            queryConstraintFailure = null;
            throw error;
          }
          const [serviceId, environmentId, title, description, severity, priority, status, creatorId] = values;
          const incident = createIncidentRow(nextIncidentId++, {
            service_id: serviceId,
            environment_id: environmentId,
            title,
            description,
            severity,
            priority,
            status,
            created_by: creatorId,
            acknowledged_at: status === 'open' ? null : '2026-01-01T00:00:00.000Z',
            resolved_at: ['resolved', 'closed'].includes(status)
              ? '2026-01-01T00:00:00.000Z'
              : null,
            resolved_by: ['resolved', 'closed'].includes(status) ? creatorId : null
          });
          incidents.set(incident.incident_id, incident);
          pendingIncidentId = incident.incident_id;
          return { rows: [{ ...incident }], rowCount: 1 };
        }
        if (sql.includes('FROM incident i') && sql.includes('JOIN service s')) {
          if (sql.includes('AND FALSE')) return { rows: [], rowCount: 0 };
          const id = String(values[0]);
          const incident = incidents.get(id);
          const teamFilter = sql.match(/s\.team_id = \$(\d+)/);
          const teamId = teamFilter ? String(values[Number(teamFilter[1]) - 1]) : null;
          const service = incident && serviceRows[incident.service_id];
          if (!incident || (teamFilter && (!service || service.team_id !== teamId))) {
            return { rows: [], rowCount: 0 };
          }
          return { rows: [{ ...incident }], rowCount: 1 };
        }
        if (sql.includes('UPDATE incident i')) {
          if (queryConstraintFailure) {
            const error = queryConstraintFailure;
            queryConstraintFailure = null;
            throw error;
          }
          const assignmentList = sql.split('SET ')[1].split(' WHERE ')[0];
          const idFilter = sql.match(/i\.incident_id = \$(\d+)/);
          const teamFilter = sql.match(/scoped_service\.team_id = \$(\d+)/);
          const id = String(values[Number(idFilter[1]) - 1]);
          const incident = incidents.get(id);
          const service = incident && serviceRows[incident.service_id];
          const authorized = !teamFilter ||
            (service && service.team_id === String(values[Number(teamFilter[1]) - 1]));
          if (!incident || !authorized) return { rows: [], rowCount: 0 };

          const statusParameter = assignmentList.match(/status = \$(\d+)/);
          if (statusParameter) {
            const status = values[Number(statusParameter[1]) - 1];
            incident.status = status;
            incident.acknowledged_at = status === 'open' ? null : '2026-01-01T00:00:00.000Z';
            incident.resolved_at = ['resolved', 'closed'].includes(status)
              ? '2026-01-01T00:00:00.000Z'
              : null;
            incident.resolved_by = ['resolved', 'closed'].includes(status)
              ? String(values[Number(statusParameter[1])])
              : null;
          }
          for (const field of ['title', 'description', 'severity', 'priority']) {
            const match = assignmentList.match(new RegExp(`${field} = \\$(\\d+)`));
            if (match) incident[field] = values[Number(match[1]) - 1];
          }
          incident.updated_at = '2026-01-02T00:00:00.000Z';
          return { rows: [{ ...incident }], rowCount: 1 };
        }
        throw new Error(`Unexpected client SQL in test: ${sql}`);
      },
      release() {}
    };
    return client;
  };

  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    pgPool.query = originalQuery;
    pgPool.connect = originalConnect;
    app.locals.incidentEventWriter = originalIncidentEventWriter;
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve) => server.once('listening', resolve));

  const baseUrl = `http://127.0.0.1:${server.address().port}/api/incidents`;
  const tokens = Object.fromEntries(Object.entries(userRows).map(([id, user]) => [
    id,
    createAccessToken({ user_id: id, role: user.role, team_id: user.team_id })
  ]));
  const headers = (id) => ({ authorization: `Bearer ${tokens[id]}` });
  const jsonHeaders = (id) => ({ ...headers(id), 'content-type': 'application/json' });

  const unauthenticatedList = await fetch(baseUrl);
  assert.equal(unauthenticatedList.status, 401);
  const unauthenticatedCreate = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({})
  });
  assert.equal(unauthenticatedCreate.status, 401);

  const adminList = await fetch(baseUrl, { headers: headers('1') });
  assert.equal(adminList.status, 200);
  assert.deepEqual((await adminList.json()).data.map((item) => item.incident_id), ['102', '101', '100']);
  const unfilteredAdminList = await fetch(baseUrl, { headers: headers('1') });
  const nominallyFilteredAdminList = await fetch(`${baseUrl}?status=resolved&severity=SEV1`, {
    headers: headers('1')
  });
  assert.deepEqual(
    (await nominallyFilteredAdminList.json()).data.map((item) => item.incident_id),
    (await unfilteredAdminList.json()).data.map((item) => item.incident_id)
  );
  const managerList = await fetch(baseUrl, { headers: headers('2') });
  assert.equal(managerList.status, 200);
  assert.deepEqual((await managerList.json()).data.map((item) => item.incident_id), ['100']);
  const engineerList = await fetch(baseUrl, { headers: headers('3') });
  assert.deepEqual((await engineerList.json()).data.map((item) => item.incident_id), ['100']);
  const otherTeamList = await fetch(baseUrl, { headers: headers('4') });
  assert.deepEqual((await otherTeamList.json()).data.map((item) => item.incident_id), ['101']);
  const managerWithoutTeamList = await fetch(baseUrl, { headers: headers('5') });
  assert.equal(managerWithoutTeamList.status, 403);
  const engineerWithoutTeamList = await fetch(baseUrl, { headers: headers('6') });
  assert.deepEqual((await engineerWithoutTeamList.json()).data, []);
  const managerWithoutTeamGet = await fetch(`${baseUrl}/100`, { headers: headers('5') });
  assert.equal(managerWithoutTeamGet.status, 403);
  const engineerWithoutTeamGet = await fetch(`${baseUrl}/100`, { headers: headers('6') });
  assert.equal(engineerWithoutTeamGet.status, 404);

  const get = await fetch(`${baseUrl}/100`, { headers: headers('3') });
  assert.equal(get.status, 200);
  const missing = await fetch(`${baseUrl}/999`, { headers: headers('1') });
  assert.equal(missing.status, 404);
  const invalidId = await fetch(`${baseUrl}/not-id`, { headers: headers('1') });
  assert.equal(invalidId.status, 400);
  const crossTeamManager = await fetch(`${baseUrl}/101`, { headers: headers('2') });
  assert.equal(crossTeamManager.status, 404);
  const crossTeamEngineer = await fetch(`${baseUrl}/101`, { headers: headers('3') });
  assert.equal(crossTeamEngineer.status, 404);
  const unassignedServiceIncident = await fetch(`${baseUrl}/102`, { headers: headers('3') });
  assert.equal(unassignedServiceIncident.status, 404);

  const noTitle = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('3'),
    body: JSON.stringify({ serviceId: '10', environmentId: '20' })
  });
  assert.equal(noTitle.status, 400);
  const noServiceId = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('3'),
    body: JSON.stringify({ environmentId: '20', title: 'Missing service ID' })
  });
  assert.equal(noServiceId.status, 400);
  const noEnvironmentId = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('3'),
    body: JSON.stringify({ serviceId: '10', title: 'Missing environment ID' })
  });
  assert.equal(noEnvironmentId.status, 400);
  const invalidServiceId = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('3'),
    body: JSON.stringify({ serviceId: 'nope', environmentId: '20', title: 'Bad ID' })
  });
  assert.equal(invalidServiceId.status, 400);
  const invalidStatus = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('3'),
    body: JSON.stringify({ serviceId: '10', environmentId: '20', title: 'Bad Status', status: 'pending' })
  });
  assert.equal(invalidStatus.status, 400);
  const invalidSeverity = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('3'),
    body: JSON.stringify({ serviceId: '10', environmentId: '20', title: 'Bad Severity', severity: 'critical' })
  });
  assert.equal(invalidSeverity.status, 400);
  const invalidPriority = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('3'),
    body: JSON.stringify({ serviceId: '10', environmentId: '20', title: 'Bad Priority', priority: 'urgent' })
  });
  assert.equal(invalidPriority.status, 400);
  const invalidDescription = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('3'),
    body: JSON.stringify({ serviceId: '10', environmentId: '20', title: 'Bad Description', description: 1 })
  });
  assert.equal(invalidDescription.status, 400);
  const missingService = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('3'),
    body: JSON.stringify({ serviceId: '999', environmentId: '20', title: 'Missing Service' })
  });
  assert.equal(missingService.status, 400);
  const inactiveService = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('3'),
    body: JSON.stringify({ serviceId: '13', environmentId: '20', title: 'Inactive Service' })
  });
  assert.equal(inactiveService.status, 400);
  const crossTeamCreate = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('3'),
    body: JSON.stringify({ serviceId: '11', environmentId: '20', title: 'Cross Team' })
  });
  assert.equal(crossTeamCreate.status, 404);
  const missingEnvironment = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('3'),
    body: JSON.stringify({ serviceId: '10', environmentId: '999', title: 'Missing Environment' })
  });
  assert.equal(missingEnvironment.status, 400);
  const noTeamCreate = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('6'),
    body: JSON.stringify({ serviceId: '10', environmentId: '20', title: 'No Team' })
  });
  assert.equal(noTeamCreate.status, 403);
  const noTeamManagerCreate = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('5'),
    body: JSON.stringify({ serviceId: '10', environmentId: '20', title: 'No Team Manager' })
  });
  assert.equal(noTeamManagerCreate.status, 403);
  const noTeamEngineerUpdate = await fetch(`${baseUrl}/100`, {
    method: 'PATCH',
    headers: jsonHeaders('6'),
    body: JSON.stringify({ status: 'acknowledged' })
  });
  assert.equal(noTeamEngineerUpdate.status, 404);
  const noTeamManagerUpdate = await fetch(`${baseUrl}/100`, {
    method: 'PATCH',
    headers: jsonHeaders('5'),
    body: JSON.stringify({ severity: 'SEV1' })
  });
  assert.equal(noTeamManagerUpdate.status, 403);

  const created = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('3'),
    body: JSON.stringify({
      serviceId: '10',
      environmentId: '20',
      title: '  API outage  ',
      description: 'Checkout requests are failing',
      severity: 'SEV2',
      priority: 'P1'
    })
  });
  assert.equal(created.status, 201);
  const createdIncident = (await created.json()).data;
  assert.equal(createdIncident.title, 'API outage');
  assert.equal(createdIncident.created_by, '3');
  assert.equal(createdIncident.status, 'open');
  assert.equal(createdIncident.severity, 'SEV2');
  assert.equal(createdIncident.priority, 'P1');
  assert.deepEqual(incidents.get(createdIncident.incident_id), createdIncident);
  const createdIncidentGet = await fetch(`${baseUrl}/${createdIncident.incident_id}`, {
    headers: headers('3')
  });
  assert.equal(createdIncidentGet.status, 200);
  assert.deepEqual((await createdIncidentGet.json()).data, createdIncident);
  const createdIncidentList = await fetch(baseUrl, { headers: headers('3') });
  const createdIncidentListBody = (await createdIncidentList.json()).data;
  assert.ok(createdIncidentListBody.some(
    (incident) => incident.incident_id === createdIncident.incident_id
  ));
  assert.ok(createdIncidentListBody.length > 1);
  assert.equal(incidentEvents[0].event_type, 'incident.created');
  assert.equal(incidentEvents[0].incident_id, createdIncident.incident_id);
  assert.equal(incidentEvents[0].actor_user_id, '3');
  assert.equal(incidentEvents[0].snapshot.title, 'API outage');
  assert.ok(capturedQueries.some(({ sql }) =>
    sql.includes('INSERT INTO incident') && sql.includes('created_by')
  ));
  const crossTeamEngineerCreate = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('4'),
    body: JSON.stringify({ serviceId: '10', environmentId: '20', title: 'Cross Team Engineer' })
  });
  assert.equal(crossTeamEngineerCreate.status, 404);

  const adminCrossTeamCreate = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('1'),
    body: JSON.stringify({ serviceId: '11', environmentId: '21', title: 'Admin incident' })
  });
  assert.equal(adminCrossTeamCreate.status, 201);

  queryConstraintFailure = Object.assign(new Error('invalid foreign key'), { code: '23503' });
  const databaseForeignKeyRace = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('3'),
    body: JSON.stringify({ serviceId: '10', environmentId: '20', title: 'FK Race' })
  });
  assert.equal(databaseForeignKeyRace.status, 400);
  const incidentCountBeforeCheckFailure = incidents.size;
  queryConstraintFailure = Object.assign(new Error('incident check constraint'), { code: '23514' });
  const databaseCheckConstraint = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('3'),
    body: JSON.stringify({ serviceId: '10', environmentId: '20', title: 'Check constraint' })
  });
  assert.equal(databaseCheckConstraint.status, 400);
  assert.equal(incidents.size, incidentCountBeforeCheckFailure);

  const incidentCountBeforeMongoFailure = incidents.size;
  eventWriteFailure = true;
  const mongoFailure = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('3'),
    body: JSON.stringify({ serviceId: '10', environmentId: '20', title: 'Mongo failure' })
  });
  eventWriteFailure = false;
  assert.equal(mongoFailure.status, 503);
  assert.equal(incidents.size, incidentCountBeforeMongoFailure);
  assert.ok(capturedQueries.some(({ sql }) => sql === 'ROLLBACK'));

  const incidentCountBeforeCommitFailure = incidents.size;
  const eventCountBeforeCommitFailure = incidentEvents.length;
  commitFailure = true;
  const postgresCommitFailure = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('3'),
    body: JSON.stringify({ serviceId: '10', environmentId: '20', title: 'Commit failure' })
  });
  assert.equal(postgresCommitFailure.status, 500);
  assert.equal(incidents.size, incidentCountBeforeCommitFailure);
  assert.equal(incidentEvents.length, eventCountBeforeCommitFailure + 1);
  assert.ok(compensatedEventIds.includes(`event-${incidentEvents.length}`));

  const engineerCannotEditTitle = await fetch(`${baseUrl}/100`, {
    method: 'PATCH',
    headers: jsonHeaders('3'),
    body: JSON.stringify({ title: 'Unauthorized title' })
  });
  assert.equal(engineerCannotEditTitle.status, 400);
  const engineerInvalidStatus = await fetch(`${baseUrl}/100`, {
    method: 'PATCH',
    headers: jsonHeaders('3'),
    body: JSON.stringify({ status: 'pending' })
  });
  assert.equal(engineerInvalidStatus.status, 400);
  const engineerStatus = await fetch(`${baseUrl}/100`, {
    method: 'PATCH',
    headers: jsonHeaders('3'),
    body: JSON.stringify({ status: 'acknowledged' })
  });
  assert.equal(engineerStatus.status, 200);
  const acknowledgedIncident = (await engineerStatus.json()).data;
  assert.equal(acknowledgedIncident.status, 'acknowledged');
  assert.ok(acknowledgedIncident.acknowledged_at);
  assert.equal(acknowledgedIncident.resolved_at, null);
  const statusEvent = incidentEvents.find((event) =>
    event.event_type === 'incident.updated' &&
    event.changes.status?.to === 'acknowledged'
  );
  assert.ok(statusEvent);
  const statusSql = capturedQueries.findLast(({ sql }) => sql.includes('UPDATE incident i')).sql;
  assert.match(statusSql, /acknowledged_at = CASE/);
  assert.match(statusSql, /resolved_by = CASE/);
  assert.match(statusSql, /scoped_service\.team_id/);

  const managerCrossTeamUpdate = await fetch(`${baseUrl}/101`, {
    method: 'PATCH',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ severity: 'SEV1' })
  });
  assert.equal(managerCrossTeamUpdate.status, 404);
  const engineerCrossTeamUpdate = await fetch(`${baseUrl}/101`, {
    method: 'PATCH',
    headers: jsonHeaders('3'),
    body: JSON.stringify({ status: 'acknowledged' })
  });
  assert.equal(engineerCrossTeamUpdate.status, 404);

  const managerUpdate = await fetch(`${baseUrl}/100`, {
    method: 'PATCH',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ severity: 'SEV1', description: null })
  });
  assert.equal(managerUpdate.status, 200);
  const managerCreate = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ serviceId: '10', environmentId: '20', title: 'Manager incident' })
  });
  assert.equal(managerCreate.status, 201);
  assert.equal((await managerCreate.json()).data.created_by, '2');
  const resolved = await fetch(`${baseUrl}/100`, {
    method: 'PATCH',
    headers: jsonHeaders('1'),
    body: JSON.stringify({ status: 'resolved' })
  });
  assert.equal(resolved.status, 200);
  const resolvedIncident = (await resolved.json()).data;
  assert.equal(resolvedIncident.status, 'resolved');
  assert.equal(resolvedIncident.resolved_by, '1');
  assert.ok(resolvedIncident.resolved_at);
  const resolvedStatusEvent = incidentEvents.findLast((event) =>
    event.event_type === 'incident.updated' &&
    event.changes.status?.to === 'resolved'
  );
  assert.ok(resolvedStatusEvent);
  assert.equal(resolvedStatusEvent.changes.status.from, 'acknowledged');

  const reopened = await fetch(`${baseUrl}/100`, {
    method: 'PATCH',
    headers: jsonHeaders('1'),
    body: JSON.stringify({ status: 'open' })
  });
  assert.equal(reopened.status, 200);
  const reopenedIncident = (await reopened.json()).data;
  assert.equal(reopenedIncident.status, 'open');
  assert.equal(reopenedIncident.acknowledged_at, null);
  assert.equal(reopenedIncident.resolved_at, null);
  assert.equal(reopenedIncident.resolved_by, null);
  assert.equal((await fetch(`${baseUrl}/100`, {
    method: 'PATCH',
    headers: jsonHeaders('1'),
    body: JSON.stringify({ status: 'closed' })
  })).status, 200);
  const titleBeforeUpdateCommitFailure = incidents.get('100').title;
  const eventsBeforeUpdateCommitFailure = incidentEvents.length;
  commitFailure = true;
  const updateCommitFailure = await fetch(`${baseUrl}/100`, {
    method: 'PATCH',
    headers: jsonHeaders('1'),
    body: JSON.stringify({ title: 'Rolled-back title update' })
  });
  assert.equal(updateCommitFailure.status, 500);
  assert.equal(incidents.get('100').title, titleBeforeUpdateCommitFailure);
  assert.equal(incidentEvents.length, eventsBeforeUpdateCommitFailure + 1);
  assert.ok(compensatedEventIds.includes(`event-${incidentEvents.length}`));

  const invalidUpdateStatus = await fetch(`${baseUrl}/100`, {
    method: 'PATCH',
    headers: jsonHeaders('1'),
    body: JSON.stringify({ status: 'pending' })
  });
  assert.equal(invalidUpdateStatus.status, 400);
  const invalidUpdateSeverity = await fetch(`${baseUrl}/100`, {
    method: 'PATCH',
    headers: jsonHeaders('1'),
    body: JSON.stringify({ severity: 'critical' })
  });
  assert.equal(invalidUpdateSeverity.status, 400);
  const invalidUpdatePriority = await fetch(`${baseUrl}/100`, {
    method: 'PATCH',
    headers: jsonHeaders('1'),
    body: JSON.stringify({ priority: 'urgent' })
  });
  assert.equal(invalidUpdatePriority.status, 400);
  const missingUpdate = await fetch(`${baseUrl}/999`, {
    method: 'PATCH',
    headers: jsonHeaders('1'),
    body: JSON.stringify({ status: 'closed' })
  });
  assert.equal(missingUpdate.status, 404);
  const invalidUpdateId = await fetch(`${baseUrl}/bad-id`, {
    method: 'PATCH',
    headers: jsonHeaders('1'),
    body: JSON.stringify({ status: 'closed' })
  });
  assert.equal(invalidUpdateId.status, 400);
  assert.equal((await fetch(`${baseUrl}/100`, {
    method: 'DELETE',
    headers: headers('1')
  })).status, 404);

  const forbiddenField = await fetch(`${baseUrl}/100`, {
    method: 'PATCH',
    headers: jsonHeaders('1'),
    body: JSON.stringify({ serviceId: '11' })
  });
  assert.equal(forbiddenField.status, 400);
  const engineerProtectedField = await fetch(`${baseUrl}/100`, {
    method: 'PATCH',
    headers: jsonHeaders('3'),
    body: JSON.stringify({ status: 'closed', resolved_by: '3' })
  });
  assert.equal(engineerProtectedField.status, 400);
  const engineerAliasField = await fetch(`${baseUrl}/100`, {
    method: 'PATCH',
    headers: jsonHeaders('3'),
    body: JSON.stringify({ status: 'closed', resolvedBy: '3' })
  });
  assert.equal(engineerAliasField.status, 400);
  assert.ok(capturedQueries.every(({ sql }) =>
    !sql.includes('DELETE FROM incident') && !sql.includes('DELETE FROM service')
  ));
});

test('Mongo incident event writer stores events and reports database failures', async () => {
  const event = {
    incident_id: '123',
    event_type: 'incident.created',
    actor_user_id: '7',
    occurred_at: new Date('2026-01-01T00:00:00.000Z'),
    snapshot: { title: 'Example incident' }
  };
  let collectionName;
  let insertedDocument;
  const reference = await recordIncidentEvent(event, async () => ({
    db: {
      collection(name) {
        collectionName = name;
        return {
          async insertOne(document) {
            insertedDocument = document;
            return { insertedId: 'inserted-event' };
          }
        };
      }
    }
  }));
  assert.equal(collectionName, 'incident_events');
  assert.equal(insertedDocument, event);
  assert.equal(reference.eventId, 'inserted-event');

  await assert.rejects(
    recordIncidentEvent(event, async () => {
      throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
    }),
    (error) => error.status === 503 &&
      error.message.includes('incident change was not confirmed')
  );
});
