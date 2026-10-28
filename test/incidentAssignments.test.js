import assert from 'node:assert/strict';
import { test } from 'node:test';
import { env } from '../src/config/env.js';
import { pgPool } from '../src/config/postgres.js';
import { createAccessToken } from '../src/services/auth.service.js';
import { recordIncidentEvent } from '../src/services/incidents.service.js';
import app from '../src/app.js';

const users = {
  '1': { role: 'admin', team_id: null, name: 'Admin', is_active: true },
  '2': { role: 'manager', team_id: '7', name: 'Manager A', is_active: true },
  '3': { role: 'engineer', team_id: '7', name: 'Engineer A', is_active: true },
  '4': { role: 'engineer', team_id: '8', name: 'Engineer B', is_active: true },
  '5': { role: 'manager', team_id: null, name: 'Manager no team', is_active: true },
  '6': { role: 'engineer', team_id: null, name: 'Engineer no team', is_active: true },
  '7': { role: 'engineer', team_id: '7', name: 'Inactive Engineer', is_active: false }
};

const services = {
  '10': { service_id: '10', team_id: '7' },
  '11': { service_id: '11', team_id: '8' },
  '12': { service_id: '12', team_id: null }
};

const incidents = {
  '100': { incident_id: '100', service_id: '10', title: 'Incident A' },
  '101': { incident_id: '101', service_id: '11', title: 'Incident B' },
  '102': { incident_id: '102', service_id: '12', title: 'Unassigned incident' }
};

function joinedAssignment(assignment) {
  const incident = incidents[assignment.incident_id];
  const service = incident && services[incident.service_id];
  const user = users[assignment.user_id];
  if (!incident || !service || !user) return null;
  return {
    ...assignment,
    incident_title: incident.title,
    service_id: incident.service_id,
    incident_team_id: service.team_id,
    user_name: user.name,
    user_email: `${assignment.user_id}@example.test`,
    user_role: user.role,
    user_team_id: user.team_id
  };
}

function makeAssignment(id, incidentId, userId, overrides = {}) {
  return {
    assignment_id: String(id),
    incident_id: String(incidentId),
    user_id: String(userId),
    assigned_at: '2026-01-01T00:00:00.000Z',
    unassigned_at: null,
    assignment_type: 'responder',
    ...overrides
  };
}

test('Incident assignment APIs enforce authentication, scope, permissions, and transaction behavior', async (t) => {
  env.JWT_SECRET = 'test-only-secret-that-is-long-enough-for-jwt';
  const originalQuery = pgPool.query;
  const originalConnect = pgPool.connect;
  const originalEventWriter = app.locals.incidentEventWriter;
  const originalConsoleInfo = console.info;
  const assignments = new Map([
    ['500', makeAssignment('500', '100', '3')],
    ['501', makeAssignment('501', '101', '4')],
    ['502', makeAssignment('502', '102', '1')],
    ['503', makeAssignment('503', '100', '3', {
      unassigned_at: '2026-01-02T00:00:00.000Z'
    })]
  ]);
  const events = [];
  const compensatedEvents = [];
  let nextId = 600;
  let snapshot;
  let failEventWrite = false;
  let failCommit = false;
  let failInsert = false;
  let failConstraint = false;
  let failNotificationLog = false;
  const capturedQueries = [];
  const notifications = [];
  console.info = (message) => {
    if (failNotificationLog) throw new Error('Development notification output failed');
    assert.equal(capturedQueries.at(-1)?.sql, 'COMMIT');
    notifications.push(JSON.parse(message));
  };

  app.locals.incidentEventWriter = async (event) => {
    if (failEventWrite) {
      return recordIncidentEvent(event, async () => {
        throw Object.assign(new Error('MongoDB offline'), { code: 'ECONNREFUSED' });
      });
    }
    events.push(event);
    const eventId = `assignment-event-${events.length}`;
    return {
      db: {
        collection(name) {
          assert.equal(name, 'incident_events');
          return {
            async deleteOne(filter) {
              compensatedEvents.push(filter._id);
              return { deletedCount: 1 };
            }
          };
        }
      },
      eventId
    };
  };

  function filterByTeam(rows, sql, values) {
    if (sql.includes('AND FALSE')) return [];
    const teamMatch = sql.match(/s\.team_id = \$(\d+)/);
    if (!teamMatch) return rows;
    const teamId = String(values[Number(teamMatch[1]) - 1]);
    return rows.filter((row) => String(row.incident_team_id) === teamId);
  }

  function listRows(sql, values) {
    let rows = [...assignments.values()].map(joinedAssignment).filter(Boolean);
    rows = filterByTeam(rows, sql, values);
    return rows.sort((left, right) =>
      right.assigned_at.localeCompare(left.assigned_at) ||
      (BigInt(right.assignment_id) > BigInt(left.assignment_id) ? 1 : -1)
    );
  }

  pgPool.query = async (sql, values = []) => {
    capturedQueries.push({ sql, values });
    if (sql.includes('FROM app_user')) {
      const user = users[String(values[0])];
      return {
        rows: user
          ? [{
            user_id: String(values[0]),
            role: user.role,
            team_id: user.team_id,
            is_active: user.is_active
          }]
          : [],
        rowCount: user ? 1 : 0
      };
    }
    if (sql.includes('FROM incident_assignment ia')) {
      let rows = listRows(sql, values);
      const assignmentIdMatch = sql.match(/ia\.assignment_id = \$(\d+)/);
      if (assignmentIdMatch) {
        const id = String(values[Number(assignmentIdMatch[1]) - 1]);
        rows = rows.filter((row) => row.assignment_id === id);
      }
      return { rows, rowCount: rows.length };
    }
    throw new Error(`Unexpected pool SQL in test: ${sql}`);
  };

  pgPool.connect = async () => ({
    async query(sql, values = []) {
      capturedQueries.push({ sql, values });
      if (sql === 'BEGIN') {
        snapshot = new Map([...assignments].map(([id, row]) => [id, { ...row }]));
        return { rows: [], rowCount: 0 };
      }
      if (sql === 'COMMIT') {
        if (failCommit) {
          failCommit = false;
          throw Object.assign(new Error('PostgreSQL commit failed'), { code: '08006' });
        }
        snapshot = null;
        return { rows: [], rowCount: 0 };
      }
      if (sql === 'ROLLBACK') {
        if (snapshot) {
          assignments.clear();
          for (const [id, row] of snapshot) assignments.set(id, row);
        }
        snapshot = null;
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM incident i') && sql.includes('FOR UPDATE OF i, s')) {
        const incident = incidents[String(values[0])];
        if (!incident) return { rows: [], rowCount: 0 };
        const service = services[incident.service_id];
        return {
          rows: [{
            ...incident,
            team_id: service.team_id
          }],
          rowCount: 1
        };
      }
      if (sql.includes('FROM app_user') && sql.includes('FOR SHARE')) {
        const user = users[String(values[0])];
        return { rows: user ? [{ user_id: String(values[0]), ...user }] : [], rowCount: user ? 1 : 0 };
      }
      if (sql.includes('FROM incident_assignment ia')) {
        let rows = listRows(sql, values);
        const idMatch = sql.match(/ia\.assignment_id = \$(\d+)/);
        if (idMatch) {
          const id = String(values[Number(idMatch[1]) - 1]);
          rows = rows.filter((row) => row.assignment_id === id);
        }
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('INSERT INTO incident_assignment')) {
        if (failInsert) {
          failInsert = false;
          throw Object.assign(new Error('PostgreSQL insert failed'), { code: '08006' });
        }
        if (failConstraint) {
          failConstraint = false;
          throw Object.assign(new Error('assignment foreign key failure'), { code: '23503' });
        }
        const [incidentId, userId, assignmentType] = values;
        const assignment = makeAssignment(nextId++, incidentId, userId, { assignment_type: assignmentType });
        assignments.set(assignment.assignment_id, assignment);
        return { rows: [{ ...assignment }], rowCount: 1 };
      }
      if (sql.includes('UPDATE incident_assignment')) {
        const assignment = assignments.get(String(values[1] ?? values[0]));
        if (!assignment || assignment.unassigned_at !== null) return { rows: [], rowCount: 0 };
        if (sql.includes('assignment_type =')) {
          assignment.assignment_type = values[0];
        } else {
          assignment.unassigned_at = '2026-01-03T00:00:00.000Z';
        }
        return { rows: [{ ...assignment }], rowCount: 1 };
      }
      throw new Error(`Unexpected client SQL in test: ${sql}`);
    },
    release() {}
  });

  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    pgPool.query = originalQuery;
    pgPool.connect = originalConnect;
    app.locals.incidentEventWriter = originalEventWriter;
    console.info = originalConsoleInfo;
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve) => server.once('listening', resolve));

  const baseUrl = `http://127.0.0.1:${server.address().port}/api/incident-assignments`;
  const tokens = Object.fromEntries(Object.entries(users).map(([id, user]) => [
    id,
    createAccessToken({ user_id: id, role: user.role, team_id: user.team_id })
  ]));
  const headers = (id) => ({ authorization: `Bearer ${tokens[id]}` });
  const jsonHeaders = (id) => ({ ...headers(id), 'content-type': 'application/json' });

  assert.equal((await fetch(baseUrl)).status, 401);
  assert.equal((await fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  })).status, 401);

  const adminList = await fetch(baseUrl, { headers: headers('1') });
  assert.equal(adminList.status, 200);
  assert.equal((await adminList.json()).data.length, 4);
  const managerList = await fetch(baseUrl, { headers: headers('2') });
  assert.deepEqual((await managerList.json()).data.map((row) => row.assignment_id), ['503', '500']);
  const engineerList = await fetch(baseUrl, { headers: headers('3') });
  assert.deepEqual((await engineerList.json()).data.map((row) => row.assignment_id), ['503', '500']);
  const otherTeamList = await fetch(baseUrl, { headers: headers('4') });
  assert.deepEqual((await otherTeamList.json()).data.map((row) => row.assignment_id), ['501']);
  assert.equal((await fetch(baseUrl, { headers: headers('5') })).status, 403);
  assert.deepEqual((await (await fetch(baseUrl, { headers: headers('6') })).json()).data, []);

  assert.equal((await fetch(`${baseUrl}/500`, { headers: headers('2') })).status, 200);
  assert.equal((await fetch(`${baseUrl}/501`, { headers: headers('2') })).status, 404);
  assert.equal((await fetch(`${baseUrl}/501`, { headers: headers('3') })).status, 404);
  assert.equal((await fetch(`${baseUrl}/502`, { headers: headers('3') })).status, 404);
  assert.equal((await fetch(`${baseUrl}/bad-id`, { headers: headers('1') })).status, 400);
  assert.equal((await fetch(`${baseUrl}/999`, { headers: headers('1') })).status, 404);

  const noIncidentId = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ userId: '3' })
  });
  assert.equal(noIncidentId.status, 400);
  const noUserId = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ incidentId: '100' })
  });
  assert.equal(noUserId.status, 400);
  const malformedId = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ incidentId: '1.5', userId: '3' })
  });
  assert.equal(malformedId.status, 400);
  const missingIncident = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ incidentId: '999', userId: '3' })
  });
  assert.equal(missingIncident.status, 404);
  const missingUser = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ incidentId: '100', userId: '999' })
  });
  assert.equal(missingUser.status, 404);
  const inactiveUser = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ incidentId: '100', userId: '7' })
  });
  assert.equal(inactiveUser.status, 404);
  const managerCrossTeamIncident = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ incidentId: '101', userId: '4' })
  });
  assert.equal(managerCrossTeamIncident.status, 404);
  const managerCrossTeamUser = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ incidentId: '100', userId: '4' })
  });
  assert.equal(managerCrossTeamUser.status, 404);
  const managerUnassignedIncident = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ incidentId: '102', userId: '3' })
  });
  assert.equal(managerUnassignedIncident.status, 404);

  const engineerCreate = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('3'),
    body: JSON.stringify({ incidentId: '100', userId: '4' })
  });
  assert.equal(engineerCreate.status, 403);
  assert.equal((await fetch(baseUrl, { headers: headers('6') })).status, 200);
  assert.equal((await fetch(`${baseUrl}/500`, { headers: headers('6') })).status, 404);
  assert.equal((await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('6'),
    body: JSON.stringify({ incidentId: '100', userId: '3' })
  })).status, 403);
  assert.equal((await fetch(baseUrl, { headers: headers('5') })).status, 403);
  assert.equal((await fetch(`${baseUrl}/500`, { headers: headers('5') })).status, 403);
  assert.equal((await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('5'),
    body: JSON.stringify({ incidentId: '100', userId: '3' })
  })).status, 403);

  const managerCreated = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ incidentId: '100', userId: '3' })
  });
  assert.equal(managerCreated.status, 201);
  const managerAssignment = (await managerCreated.json()).data;
  assert.equal(managerAssignment.assignment_type, 'responder');
  assert.equal(managerAssignment.user_id, '3');
  assert.deepEqual(assignments.get(managerAssignment.assignment_id), managerAssignment);
  const managerAssignmentGet = await fetch(`${baseUrl}/${managerAssignment.assignment_id}`, {
    headers: headers('2')
  });
  assert.equal(managerAssignmentGet.status, 200);
  assert.deepEqual((await managerAssignmentGet.json()).data, {
    ...managerAssignment,
    incident_title: incidents[managerAssignment.incident_id].title,
    service_id: incidents[managerAssignment.incident_id].service_id,
    incident_team_id: '7',
    user_name: users[managerAssignment.user_id].name,
    user_email: `${managerAssignment.user_id}@example.test`,
    user_role: users[managerAssignment.user_id].role,
    user_team_id: users[managerAssignment.user_id].team_id
  });
  assert.equal(events.at(-1).event_type, 'incident.assignment.created');
  assert.equal(notifications.at(-1).eventType, 'incident.assignment.created');
  assert.equal(notifications.at(-1).assignmentId, managerAssignment.assignment_id);

  const adminCrossTeamCreated = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('1'),
    body: JSON.stringify({ incidentId: '101', userId: '4', assignmentType: 'observer' })
  });
  assert.equal(adminCrossTeamCreated.status, 201);
  assert.equal((await adminCrossTeamCreated.json()).data.assignment_type, 'observer');
  const duplicateAllowed = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ incidentId: '100', userId: '3' })
  });
  assert.equal(duplicateAllowed.status, 201);

  const engineerUpdate = await fetch(`${baseUrl}/500`, {
    method: 'PATCH',
    headers: jsonHeaders('3'),
    body: JSON.stringify({ assignmentType: 'lead' })
  });
  assert.equal(engineerUpdate.status, 403);
  const engineerUnassign = await fetch(`${baseUrl}/500/unassign`, {
    method: 'PATCH',
    headers: jsonHeaders('3'),
    body: '{}'
  });
  assert.equal(engineerUnassign.status, 403);
  const managerCrossTeamUpdate = await fetch(`${baseUrl}/501`, {
    method: 'PATCH',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ assignmentType: 'lead' })
  });
  assert.equal(managerCrossTeamUpdate.status, 404);
  const managerCrossTeamUnassign = await fetch(`${baseUrl}/501/unassign`, {
    method: 'PATCH',
    headers: jsonHeaders('2'),
    body: '{}'
  });
  assert.equal(managerCrossTeamUnassign.status, 404);

  const invalidAssignmentType = await fetch(`${baseUrl}/500`, {
    method: 'PATCH',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ assignmentType: '' })
  });
  assert.equal(invalidAssignmentType.status, 400);
  const protectedField = await fetch(`${baseUrl}/500`, {
    method: 'PATCH',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ assignmentType: 'lead', userId: '4' })
  });
  assert.equal(protectedField.status, 400);
  const managerUpdate = await fetch(`${baseUrl}/500`, {
    method: 'PATCH',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ assignmentType: 'lead' })
  });
  assert.equal(managerUpdate.status, 200);
  assert.equal((await managerUpdate.json()).data.assignment_type, 'lead');
  assert.equal(notifications.at(-1).eventType, 'incident.assignment.updated');
  const adminUpdate = await fetch(`${baseUrl}/501`, {
    method: 'PATCH',
    headers: jsonHeaders('1'),
    body: JSON.stringify({ assignmentType: 'observer' })
  });
  assert.equal(adminUpdate.status, 200);

  const managerUnassign = await fetch(`${baseUrl}/500/unassign`, {
    method: 'PATCH',
    headers: jsonHeaders('2'),
    body: '{}'
  });
  assert.equal(managerUnassign.status, 200);
  assert.ok((await managerUnassign.json()).data.unassigned_at);
  assert.equal(notifications.at(-1).eventType, 'incident.assignment.unassigned');
  assert.equal((await fetch(`${baseUrl}/500/unassign`, {
    method: 'PATCH',
    headers: jsonHeaders('2'),
    body: '{}'
  })).status, 409);
  assert.equal((await fetch(`${baseUrl}/999/unassign`, {
    method: 'PATCH',
    headers: jsonHeaders('2'),
    body: '{}'
  })).status, 404);
  assert.ok(assignments.get('500').unassigned_at);
  assert.equal((await fetch(`${baseUrl}/500`, { headers: headers('2') })
    .then(async (response) => (await response.json()).data.unassigned_at)), assignments.get('500').unassigned_at);
  assert.equal((await fetch(`${baseUrl}/bad-id/unassign`, {
    method: 'PATCH',
    headers: jsonHeaders('1'),
    body: '{}'
  })).status, 400);

  failInsert = true;
  const postgresFailure = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ incidentId: '100', userId: '3' })
  });
  assert.equal(postgresFailure.status, 500);
  assert.ok(capturedQueries.some(({ sql }) => sql === 'ROLLBACK'));

  failConstraint = true;
  const countBeforeConstraintFailure = assignments.size;
  const constraintFailure = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ incidentId: '100', userId: '3' })
  });
  assert.equal(constraintFailure.status, 400);
  assert.equal(assignments.size, countBeforeConstraintFailure);
  assert.ok(capturedQueries.some(({ sql }) => sql === 'ROLLBACK'));

  failEventWrite = true;
  const countBeforeMongoFailure = assignments.size;
  const mongoFailure = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ incidentId: '100', userId: '3' })
  });
  failEventWrite = false;
  assert.equal(mongoFailure.status, 503);
  assert.equal(assignments.size, countBeforeMongoFailure);

  failCommit = true;
  const eventCountBeforeCommitError = events.length;
  const countBeforeCommitError = assignments.size;
  const commitFailure = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ incidentId: '100', userId: '3' })
  });
  assert.equal(commitFailure.status, 500);
  assert.equal(assignments.size, countBeforeCommitError);
  assert.equal(events.length, eventCountBeforeCommitError + 1);
  assert.ok(compensatedEvents.includes(`assignment-event-${events.length}`));

  failNotificationLog = true;
  const countBeforeNotificationFailure = assignments.size;
  const notificationFailure = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ incidentId: '100', userId: '3' })
  });
  failNotificationLog = false;
  assert.equal(notificationFailure.status, 201);
  assert.equal(assignments.size, countBeforeNotificationFailure + 1);

  assert.ok(capturedQueries.every(({ sql }) => !sql.includes('DELETE FROM incident_assignment')));
});
