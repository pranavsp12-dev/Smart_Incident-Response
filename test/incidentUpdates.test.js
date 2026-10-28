import assert from 'node:assert/strict';
import { test } from 'node:test';
import { env } from '../src/config/env.js';
import { pgPool } from '../src/config/postgres.js';
import { createAccessToken } from '../src/services/auth.service.js';
import { recordIncidentEvent } from '../src/services/incidents.service.js';
import app from '../src/app.js';

const users = {
  '1': { role: 'admin', team_id: null, is_active: true },
  '2': { role: 'manager', team_id: '7', is_active: true },
  '3': { role: 'engineer', team_id: '7', is_active: true },
  '4': { role: 'manager', team_id: '8', is_active: true },
  '5': { role: 'manager', team_id: null, is_active: true },
  '6': { role: 'engineer', team_id: null, is_active: true }
};

const services = {
  '10': { service_id: '10', team_id: '7' },
  '11': { service_id: '11', team_id: '8' }
};

const incidents = {
  '100': { incident_id: '100', service_id: '10', status: 'open' },
  '101': { incident_id: '101', service_id: '11', status: 'open' }
};

function makeUpdate(id, incidentId, userId, overrides = {}) {
  return {
    update_id: String(id),
    incident_id: String(incidentId),
    user_id: String(userId),
    status: null,
    message: `Update ${id}`,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

test('Incident update history enforces scope, validation, and PostgreSQL/MongoDB failure handling', async (t) => {
  env.JWT_SECRET = 'test-only-secret-that-is-long-enough-for-jwt';
  const originalQuery = pgPool.query;
  const originalConnect = pgPool.connect;
  const originalEventWriter = app.locals.incidentEventWriter;
  const updates = new Map([
    ['200', makeUpdate('200', '100', '3')],
    ['201', makeUpdate('201', '101', '4')]
  ]);
  const mongoEvents = [];
  const compensatedEventIds = [];
  const capturedQueries = [];
  let nextUpdateId = 300;
  let stateSnapshot = null;
  let failMongo = false;
  let failCommit = false;
  let failCompensation = false;
  let failInsert = false;
  let failConstraint = false;

  app.locals.incidentEventWriter = async (event) => {
    if (failMongo) {
      return recordIncidentEvent(event, async () => {
        throw Object.assign(new Error('MongoDB unavailable'), { code: 'ECONNREFUSED' });
      });
    }
    mongoEvents.push(event);
    const eventId = `update-event-${mongoEvents.length}`;
    return {
      db: {
        collection(name) {
          assert.equal(name, 'incident_events');
          return {
            async deleteOne(filter) {
              compensatedEventIds.push(filter._id);
              if (failCompensation) {
                throw Object.assign(new Error('MongoDB compensation unavailable'), {
                  code: 'ECONNREFUSED'
                });
              }
              return { deletedCount: 1 };
            }
          };
        }
      },
      eventId
    };
  };

  const incidentTeam = (incidentId) => {
    const incident = incidents[String(incidentId)];
    return incident ? services[incident.service_id]?.team_id : undefined;
  };
  const inScope = (teamId, actor) =>
    actor.role === 'admin' || (actor.team_id !== null && String(teamId) === actor.team_id);

  pgPool.query = async (sql, values = []) => {
    capturedQueries.push({ sql, values });
    if (sql.includes('FROM app_user')) {
      const user = users[String(values[0])];
      return { rows: user ? [{ user_id: String(values[0]), ...user }] : [], rowCount: user ? 1 : 0 };
    }
    if (sql.includes('FROM incident_update iu')) {
      const incidentId = String(values[0]);
      const actorTeam = sql.match(/s\.team_id = \$(\d+)/);
      const actor = actorTeam
        ? { role: 'manager', team_id: String(values[Number(actorTeam[1]) - 1]) }
        : { role: 'admin', team_id: null };
      if (sql.includes('AND FALSE')) return { rows: [], rowCount: 0 };
      const updateIdMatch = sql.match(/iu\.update_id = \$(\d+)/);
      let rows = [...updates.values()].filter((update) =>
        update.incident_id === incidentId && inScope(incidentTeam(update.incident_id), actor)
      );
      if (updateIdMatch) {
        const updateId = String(values[Number(updateIdMatch[1]) - 1]);
        rows = rows.filter((update) => update.update_id === updateId);
      }
      if (sql.includes('ORDER BY iu.created_at, iu.update_id')) {
        rows.sort((left, right) =>
          left.created_at.localeCompare(right.created_at) ||
          (BigInt(left.update_id) < BigInt(right.update_id) ? -1 : 1)
        );
      }
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('FROM incident i') && sql.includes('JOIN service s')) {
      const incidentId = String(values[0]);
      const teamMatch = sql.match(/s\.team_id = \$(\d+)/);
      if (sql.includes('AND FALSE')) return { rows: [], rowCount: 0 };
      const actor = teamMatch
        ? { role: 'manager', team_id: String(values[Number(teamMatch[1]) - 1]) }
        : { role: 'admin', team_id: null };
      const incident = incidents[incidentId];
      const rows = incident && inScope(incidentTeam(incidentId), actor) ? [{ incident_id: incidentId }] : [];
      return { rows, rowCount: rows.length };
    }
    throw new Error(`Unexpected pool SQL in test: ${sql}`);
  };

  pgPool.connect = async () => ({
    async query(sql, values = []) {
      capturedQueries.push({ sql, values });
      if (sql === 'BEGIN') {
        stateSnapshot = new Map([...updates].map(([id, update]) => [id, { ...update }]));
        return { rows: [], rowCount: 0 };
      }
      if (sql === 'COMMIT') {
        if (failCommit) {
          failCommit = false;
          throw Object.assign(new Error('PostgreSQL commit failed'), { code: '08006' });
        }
        stateSnapshot = null;
        return { rows: [], rowCount: 0 };
      }
      if (sql === 'ROLLBACK') {
        if (stateSnapshot) {
          updates.clear();
          for (const [id, update] of stateSnapshot) updates.set(id, update);
        }
        stateSnapshot = null;
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM incident i') && sql.includes('FOR UPDATE OF i, s')) {
        const incidentId = String(values[0]);
        const incident = incidents[incidentId];
        const teamMatch = sql.match(/s\.team_id = \$(\d+)/);
        const actor = teamMatch
          ? { role: 'manager', team_id: String(values[Number(teamMatch[1]) - 1]) }
          : { role: 'admin', team_id: null };
        return incident && inScope(incidentTeam(incidentId), actor)
          ? { rows: [{ ...incident, team_id: incidentTeam(incidentId) }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (sql.includes('INSERT INTO incident_update')) {
        if (failInsert) {
          failInsert = false;
          throw Object.assign(new Error('PostgreSQL insert failed'), { code: '08006' });
        }
        if (failConstraint) {
          failConstraint = false;
          throw Object.assign(new Error('incident update foreign key failure'), { code: '23503' });
        }
        const [incidentId, userId, status, message] = values;
        const update = makeUpdate(nextUpdateId++, incidentId, userId, { status, message });
        updates.set(update.update_id, update);
        return { rows: [{ ...update }], rowCount: 1 };
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
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve) => server.once('listening', resolve));

  const baseUrl = `http://127.0.0.1:${server.address().port}/api/incidents`;
  const tokens = Object.fromEntries(Object.entries(users).map(([id, user]) => [
    id,
    createAccessToken({ user_id: id, role: user.role, team_id: user.team_id })
  ]));
  const headers = (id) => ({ authorization: `Bearer ${tokens[id]}` });
  const jsonHeaders = (id) => ({ ...headers(id), 'content-type': 'application/json' });
  const request = async (path, options = {}) => {
    const response = await fetch(`${baseUrl}${path}`, options);
    return { status: response.status, body: await response.json() };
  };

  assert.equal((await request('/100/updates')).status, 401);
  assert.equal((await request('/100/updates', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  })).status, 401);

  const managerList = await request('/100/updates', { headers: headers('2') });
  assert.deepEqual(managerList.body.data.map((update) => update.update_id), ['200']);
  const managerGet = await request('/100/updates/200', { headers: headers('2') });
  assert.equal(managerGet.status, 200);
  assert.equal(managerGet.body.data.message, 'Update 200');
  const engineerList = await request('/100/updates', { headers: headers('3') });
  assert.equal(engineerList.status, 200);
  assert.deepEqual(engineerList.body.data.map((update) => update.update_id), ['200']);
  const adminList = await request('/101/updates', { headers: headers('1') });
  assert.deepEqual(adminList.body.data.map((update) => update.update_id), ['201']);
  assert.equal((await request('/101/updates', { headers: headers('2') })).status, 404);
  assert.equal((await request('/101/updates/201', { headers: headers('3') })).status, 404);
  assert.equal((await request('/999/updates', { headers: headers('1') })).status, 404);
  assert.equal((await request('/bad-id/updates', { headers: headers('1') })).status, 400);
  assert.equal((await request('/100/updates/bad-id', { headers: headers('1') })).status, 400);
  assert.equal((await request('/100/updates/999', { headers: headers('1') })).status, 404);
  assert.equal((await request('/100/updates/201', { headers: headers('1') })).status, 404);
  assert.equal((await request('/100/updates', { headers: headers('5') })).status, 403);
  assert.equal((await request('/100/updates', { headers: headers('6') })).status, 404);
  assert.equal((await request('/100/updates/200', { headers: headers('6') })).status, 404);

  const noMessage = await request('/100/updates', {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ status: 'open' })
  });
  assert.equal(noMessage.status, 400);
  const blankMessage = await request('/100/updates', {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ message: '  ' })
  });
  assert.equal(blankMessage.status, 400);
  const emptyMessage = await request('/100/updates', {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ message: '' })
  });
  assert.equal(emptyMessage.status, 400);
  const nonStringMessage = await request('/100/updates', {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ message: 123 })
  });
  assert.equal(nonStringMessage.status, 400);
  const invalidStatus = await request('/100/updates', {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ message: 'Valid message', status: 'pending' })
  });
  assert.equal(invalidStatus.status, 400);
  const oversizedMessage = await request('/100/updates', {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ message: 'x'.repeat(10_001) })
  });
  assert.equal(oversizedMessage.status, 400);
  const protectedField = await request('/100/updates', {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ message: 'Valid message', userId: '4', createdAt: '2026-01-01' })
  });
  assert.equal(protectedField.status, 400);
  const nonexistentIncident = await request('/999/updates', {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ message: 'No parent incident' })
  });
  assert.equal(nonexistentIncident.status, 404);

  const managerCreate = await request('/100/updates', {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ message: '  Manager note  ', status: 'investigating' })
  });
  assert.equal(managerCreate.status, 201);
  assert.equal(managerCreate.body.data.message, 'Manager note');
  assert.equal(managerCreate.body.data.user_id, '2');
  assert.equal(managerCreate.body.data.status, 'investigating');
  assert.deepEqual(updates.get(managerCreate.body.data.update_id), managerCreate.body.data);
  const managerCreatedGet = await request(`/100/updates/${managerCreate.body.data.update_id}`, {
    headers: headers('2')
  });
  assert.equal(managerCreatedGet.status, 200);
  assert.deepEqual(managerCreatedGet.body.data, managerCreate.body.data);
  assert.deepEqual(
    (await request('/100/updates', { headers: headers('2') })).body.data.map((update) => update.update_id),
    ['200', managerCreate.body.data.update_id]
  );
  assert.equal(incidents['100'].status, 'open');
  assert.equal(mongoEvents.at(-1).event_type, 'incident.update.created');
  assert.equal(mongoEvents.at(-1).actor_user_id, '2');

  const engineerCreate = await request('/100/updates', {
    method: 'POST',
    headers: jsonHeaders('3'),
    body: JSON.stringify({ message: 'Engineer note' })
  });
  assert.equal(engineerCreate.status, 201);
  assert.equal(engineerCreate.body.data.user_id, '3');
  assert.deepEqual(updates.get(engineerCreate.body.data.update_id), engineerCreate.body.data);
  assert.deepEqual(
    (await request('/100/updates', { headers: headers('3') })).body.data.map((update) => update.update_id),
    ['200', managerCreate.body.data.update_id, engineerCreate.body.data.update_id]
  );
  const adminCreate = await request('/101/updates', {
    method: 'POST',
    headers: jsonHeaders('1'),
    body: JSON.stringify({ message: 'Admin note', status: null })
  });
  assert.equal(adminCreate.status, 201);
  assert.equal(adminCreate.body.data.status, null);

  const updateCountBeforeFailure = updates.size;
  failInsert = true;
  const postgresFailure = await request('/100/updates', {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ message: 'Database failure' })
  });
  assert.equal(postgresFailure.status, 500);
  assert.equal(updates.size, updateCountBeforeFailure);
  assert.ok(capturedQueries.some(({ sql }) => sql === 'ROLLBACK'));

  failConstraint = true;
  const countBeforeConstraintFailure = updates.size;
  const constraintFailure = await request('/100/updates', {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ message: 'Constraint failure' })
  });
  assert.equal(constraintFailure.status, 400);
  assert.equal(updates.size, countBeforeConstraintFailure);
  assert.ok(capturedQueries.some(({ sql }) => sql === 'ROLLBACK'));

  failMongo = true;
  const mongoFailure = await request('/100/updates', {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ message: 'Mongo failure' })
  });
  failMongo = false;
  assert.equal(mongoFailure.status, 503);
  assert.equal(updates.size, updateCountBeforeFailure);

  failCommit = true;
  const eventsBeforeCommitFailure = mongoEvents.length;
  const commitFailure = await request('/100/updates', {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ message: 'Commit failure' })
  });
  assert.equal(commitFailure.status, 500);
  assert.equal(updates.size, updateCountBeforeFailure);
  assert.equal(mongoEvents.length, eventsBeforeCommitFailure + 1);
  assert.ok(compensatedEventIds.includes(`update-event-${mongoEvents.length}`));

  failCommit = true;
  failCompensation = true;
  const eventsBeforeCompensationFailure = mongoEvents.length;
  const compensationFailure = await request('/100/updates', {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ message: 'Compensation failure' })
  });
  failCompensation = false;
  assert.equal(compensationFailure.status, 500);
  assert.equal(mongoEvents.length, eventsBeforeCompensationFailure + 1);
  assert.ok(compensatedEventIds.includes(`update-event-${mongoEvents.length}`));

  assert.ok(capturedQueries.every(({ sql }) =>
    !sql.includes('UPDATE incident_update') && !sql.includes('DELETE FROM incident_update')
  ));
});
