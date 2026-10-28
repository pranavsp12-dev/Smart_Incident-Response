import assert from 'node:assert/strict';
import { test } from 'node:test';
import { env } from '../src/config/env.js';
import { pgPool } from '../src/config/postgres.js';
import { createAccessToken } from '../src/services/auth.service.js';
import app from '../src/app.js';

const initialServices = [
  {
    service_id: '11',
    team_id: '7',
    name: 'Checkout',
    description: 'Payment checkout',
    criticality: 'high',
    is_active: true,
    created_at: '2026-01-01T00:00:00.000Z'
  },
  {
    service_id: '12',
    team_id: '8',
    name: 'Identity',
    description: null,
    criticality: 'critical',
    is_active: true,
    created_at: '2026-01-01T00:00:00.000Z'
  },
  {
    service_id: '13',
    team_id: '7',
    name: 'Legacy',
    description: 'Deactivated service with historical incidents',
    criticality: 'medium',
    is_active: true,
    created_at: '2026-01-01T00:00:00.000Z'
  },
  {
    service_id: '14',
    team_id: '7',
    name: 'Retired',
    description: 'Previously deactivated service',
    criticality: 'low',
    is_active: false,
    created_at: '2026-01-01T00:00:00.000Z'
  }
];

const users = {
  '1': { role: 'admin', team_id: null },
  '2': { role: 'manager', team_id: '7' },
  '3': { role: 'engineer', team_id: '7' },
  '4': { role: 'engineer', team_id: '8' },
  '5': { role: 'manager', team_id: null },
  '6': { role: 'engineer', team_id: null }
};

test('Services API enforces validation, authorization, and deactivation visibility', async (t) => {
  env.JWT_SECRET = 'test-only-secret-that-is-long-enough-for-jwt';
  const originalQuery = pgPool.query;
  const services = new Map(initialServices.map((service) => [
    service.service_id,
    { ...service }
  ]));
  let nextServiceId = 20;
  let failNextUpdateConstraint = false;
  const queries = [];

  pgPool.query = async (sql, values = []) => {
    queries.push({ sql, values });

    if (sql.includes('FROM app_user')) {
      const user = users[String(values[0])];
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
    if (sql.includes('FROM team')) {
      const exists = ['7', '8'].includes(String(values[0]));
      return {
        rows: exists ? [{ team_id: String(values[0]) }] : [],
        rowCount: exists ? 1 : 0
      };
    }
    if (sql.includes('FROM service')) {
      const idCondition = sql.match(/service_id = \$(\d+)/);
      const teamCondition = sql.match(/team_id = \$(\d+)/);
      const activeOnly = sql.includes('is_active = TRUE');
      const rows = [...services.values()].filter((service) => {
        if (idCondition && service.service_id !== String(values[Number(idCondition[1]) - 1])) {
          return false;
        }
        if (teamCondition && service.team_id !== String(values[Number(teamCondition[1]) - 1])) {
          return false;
        }
        return !activeOnly || service.is_active;
      }).sort((a, b) => a.name.localeCompare(b.name));

      return { rows, rowCount: rows.length };
    }
    if (sql.includes('INSERT INTO service')) {
      const [name, description, criticality, teamId] = values;
      if ([...services.values()].some((service) => service.name === name)) {
        throw Object.assign(new Error('duplicate service name'), { code: '23505' });
      }
      if (teamId !== null && !['7', '8'].includes(String(teamId))) {
        throw Object.assign(new Error('invalid team reference'), { code: '23503' });
      }
      const inserted = {
        service_id: String(nextServiceId++),
        team_id: teamId === null ? null : String(teamId),
        name,
        description,
        criticality,
        is_active: true,
        created_at: '2026-01-01T00:00:00.000Z'
      };
      services.set(inserted.service_id, inserted);
      return { rows: [inserted], rowCount: 1 };
    }
    if (sql.includes('UPDATE service')) {
      if (failNextUpdateConstraint) {
        failNextUpdateConstraint = false;
        throw Object.assign(new Error('check constraint violation'), { code: '23514' });
      }
      const assignmentList = sql.split('SET ')[1].split(' WHERE ')[0];
      const assignments = [...assignmentList.matchAll(/([a-z_]+) = \$(\d+)/g)];
      const idCondition = sql.match(/service_id = \$(\d+)/);
      const teamCondition = sql.match(/team_id = \$(\d+)/);
      const activeOnly = sql.includes('is_active = TRUE');
      const id = String(values[Number(idCondition[1]) - 1]);
      const existing = services.get(id);
      if (!existing ||
          (teamCondition && existing.team_id !== String(values[Number(teamCondition[1]) - 1])) ||
          (activeOnly && !existing.is_active)) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('SET is_active = FALSE')) {
        existing.is_active = false;
      }
      for (const [, column, parameter] of assignments) {
        const value = values[Number(parameter) - 1];
        if (column === 'is_active') {
          existing.is_active = value;
        } else if (column === 'team_id') {
          existing.team_id = value === null ? null : String(value);
        } else {
          existing[column] = value;
        }
      }
      return { rows: [existing], rowCount: 1 };
    }

    throw new Error(`Unexpected SQL in test: ${sql}`);
  };

  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    pgPool.query = originalQuery;
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve) => server.once('listening', resolve));

  const baseUrl = `http://127.0.0.1:${server.address().port}/api/services`;
  const tokens = Object.fromEntries(Object.entries(users).map(([id, user]) => [
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
    body: JSON.stringify({ name: 'Unauthenticated' })
  });
  assert.equal(unauthenticatedCreate.status, 401);

  const adminList = await fetch(baseUrl, { headers: headers('1') });
  assert.equal(adminList.status, 200);
  assert.equal((await adminList.json()).data.length, 4);

  const managerList = await fetch(baseUrl, { headers: headers('2') });
  assert.equal(managerList.status, 200);
  assert.deepEqual(
    (await managerList.json()).data.map((service) => service.service_id),
    ['11', '13', '14']
  );

  const engineerList = await fetch(baseUrl, { headers: headers('3') });
  assert.equal(engineerList.status, 200);
  assert.deepEqual(
    (await engineerList.json()).data.map((service) => service.service_id),
    ['11', '13']
  );
  const engineerFromOtherTeam = await fetch(baseUrl, { headers: headers('4') });
  assert.deepEqual(
    (await engineerFromOtherTeam.json()).data.map((service) => service.service_id),
    ['12']
  );
  const unassignedEngineerList = await fetch(baseUrl, { headers: headers('6') });
  assert.equal(unassignedEngineerList.status, 200);
  assert.deepEqual((await unassignedEngineerList.json()).data, []);
  const unassignedManagerList = await fetch(baseUrl, { headers: headers('5') });
  assert.equal(unassignedManagerList.status, 403);

  const missingId = await fetch(`${baseUrl}/999`, { headers: headers('1') });
  assert.equal(missingId.status, 404);
  const invalidId = await fetch(`${baseUrl}/not-an-id`, { headers: headers('1') });
  assert.equal(invalidId.status, 400);
  const engineerCrossTeam = await fetch(`${baseUrl}/12`, { headers: headers('3') });
  assert.equal(engineerCrossTeam.status, 404);
  const managerCrossTeam = await fetch(`${baseUrl}/12`, { headers: headers('2') });
  assert.equal(managerCrossTeam.status, 404);

  const engineerCannotCreate = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('3'),
    body: JSON.stringify({ name: 'Engineer Attempt' })
  });
  assert.equal(engineerCannotCreate.status, 403);
  const invalidName = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('1'),
    body: JSON.stringify({ name: '   ' })
  });
  assert.equal(invalidName.status, 400);
  const invalidCriticality = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('1'),
    body: JSON.stringify({ name: 'Invalid Criticality', criticality: 'urgent' })
  });
  assert.equal(invalidCriticality.status, 400);
  const invalidDescription = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('1'),
    body: JSON.stringify({ name: 'Invalid Description', description: 42 })
  });
  assert.equal(invalidDescription.status, 400);
  const nonExistentTeam = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('1'),
    body: JSON.stringify({ name: 'No Such Team', teamId: '999' })
  });
  assert.equal(nonExistentTeam.status, 400);

  const managerWrongTeamCreate = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ name: 'Manager Other Team', teamId: '8' })
  });
  assert.equal(managerWrongTeamCreate.status, 403);
  const managerCreate = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ name: 'Manager Created Service' })
  });
  assert.equal(managerCreate.status, 201);
  const managerCreated = (await managerCreate.json()).data;
  assert.equal(managerCreated.team_id, '7');
  assert.equal(managerCreated.criticality, 'medium');

  const adminCreate = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('1'),
    body: JSON.stringify({
      name: 'Global Service',
      description: 'Created by admin',
      criticality: 'critical',
      teamId: '8'
    })
  });
  assert.equal(adminCreate.status, 201);
  const created = (await adminCreate.json()).data;
  assert.equal(created.team_id, '8');
  assert.equal(created.criticality, 'critical');
  const duplicateGlobalName = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('1'),
    body: JSON.stringify({ name: 'Checkout', teamId: '8' })
  });
  assert.equal(duplicateGlobalName.status, 409);

  const managerModifyOtherTeam = await fetch(`${baseUrl}/12`, {
    method: 'PATCH',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ description: 'Unauthorized change' })
  });
  assert.equal(managerModifyOtherTeam.status, 404);
  const engineerModify = await fetch(`${baseUrl}/11`, {
    method: 'PATCH',
    headers: jsonHeaders('3'),
    body: JSON.stringify({ name: 'Engineer Change' })
  });
  assert.equal(engineerModify.status, 403);
  const missingUpdate = await fetch(`${baseUrl}/999`, {
    method: 'PATCH',
    headers: jsonHeaders('1'),
    body: JSON.stringify({ name: 'Missing Service' })
  });
  assert.equal(missingUpdate.status, 404);
  const invalidUpdate = await fetch(`${baseUrl}/11`, {
    method: 'PATCH',
    headers: jsonHeaders('1'),
    body: JSON.stringify({ criticality: 'urgent' })
  });
  assert.equal(invalidUpdate.status, 400);

  const updated = await fetch(`${baseUrl}/11`, {
    method: 'PATCH',
    headers: jsonHeaders('1'),
    body: JSON.stringify({ name: 'Checkout API', description: null, criticality: 'medium' })
  });
  assert.equal(updated.status, 200);
  const updatedData = (await updated.json()).data;
  assert.equal(updatedData.name, 'Checkout API');
  assert.equal(updatedData.description, null);
  assert.equal(updatedData.criticality, 'medium');

  failNextUpdateConstraint = true;
  const constraintViolation = await fetch(`${baseUrl}/11`, {
    method: 'PATCH',
    headers: jsonHeaders('1'),
    body: JSON.stringify({ criticality: 'high' })
  });
  assert.equal(constraintViolation.status, 400);

  const managerDeactivateOtherTeam = await fetch(`${baseUrl}/12/deactivate`, {
    method: 'PATCH',
    headers: headers('2')
  });
  assert.equal(managerDeactivateOtherTeam.status, 404);
  const engineerDeactivate = await fetch(`${baseUrl}/11/deactivate`, {
    method: 'PATCH',
    headers: headers('3')
  });
  assert.equal(engineerDeactivate.status, 403);

  const deactivate = await fetch(`${baseUrl}/13/deactivate`, {
    method: 'PATCH',
    headers: headers('2')
  });
  assert.equal(deactivate.status, 200);
  const deactivatedData = (await deactivate.json()).data;
  assert.equal(deactivatedData.is_active, false);
  assert.ok(services.has('13'));

  const engineerCannotSeeInactive = await fetch(`${baseUrl}/13`, {
    headers: headers('3')
  });
  assert.equal(engineerCannotSeeInactive.status, 404);
  const engineerListAfterDeactivate = await fetch(baseUrl, {
    headers: headers('3')
  });
  assert.deepEqual(
    (await engineerListAfterDeactivate.json()).data.map((service) => service.service_id),
    ['11', managerCreated.service_id]
  );
  const adminCanSeeInactive = await fetch(`${baseUrl}/13`, {
    headers: headers('1')
  });
  assert.equal(adminCanSeeInactive.status, 200);
  assert.equal((await adminCanSeeInactive.json()).data.is_active, false);

  const repeatedDeactivate = await fetch(`${baseUrl}/13/deactivate`, {
    method: 'PATCH',
    headers: headers('1')
  });
  assert.equal(repeatedDeactivate.status, 404);

  assert.ok(queries.some(({ sql, values }) =>
    sql.includes('team_id = $1') && values[0] === '7'
  ));
  assert.ok(queries.every(({ sql }) => !sql.includes('DELETE FROM service')));
  assert.ok(queries.some(({ sql }) => sql.includes('SET is_active = FALSE')));
});
