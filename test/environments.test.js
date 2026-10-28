import assert from 'node:assert/strict';
import { test } from 'node:test';
import { env } from '../src/config/env.js';
import { pgPool } from '../src/config/postgres.js';
import { createAccessToken } from '../src/services/auth.service.js';
import app from '../src/app.js';

const users = {
  '1': { role: 'admin', team_id: null },
  '2': { role: 'manager', team_id: '7' },
  '3': { role: 'engineer', team_id: '7' }
};

test('Environments API validates input and enforces authenticated role permissions', async (t) => {
  env.JWT_SECRET = 'test-only-secret-that-is-long-enough-for-jwt';
  const originalQuery = pgPool.query;
  const environments = new Map([
    ['1', {
      environment_id: '1',
      name: 'Production',
      description: 'Live production environment',
      created_at: '2026-01-01T00:00:00.000Z'
    }],
    ['2', {
      environment_id: '2',
      name: 'Staging',
      description: null,
      created_at: '2026-01-01T00:00:00.000Z'
    }]
  ]);
  const capturedQueries = [];
  let nextEnvironmentId = 3;

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
            is_active: true
          }]
          : [],
        rowCount: user ? 1 : 0
      };
    }
    if (sql.includes('FROM environment')) {
      if (sql.includes('WHERE environment_id = $1')) {
        const environment = environments.get(String(values[0]));
        return {
          rows: environment ? [{ ...environment }] : [],
          rowCount: environment ? 1 : 0
        };
      }
      return {
        rows: [...environments.values()]
          .sort((left, right) => left.name.localeCompare(right.name))
          .map((environment) => ({ ...environment })),
        rowCount: environments.size
      };
    }
    if (sql.includes('INSERT INTO environment')) {
      const [name, description] = values;
      if ([...environments.values()].some((environment) => environment.name === name)) {
        throw Object.assign(new Error('duplicate environment name'), { code: '23505' });
      }
      const environment = {
        environment_id: String(nextEnvironmentId++),
        name,
        description,
        created_at: '2026-01-01T00:00:00.000Z'
      };
      environments.set(environment.environment_id, environment);
      return { rows: [{ ...environment }], rowCount: 1 };
    }
    if (sql.includes('UPDATE environment')) {
      const assignments = [...sql.split('SET ')[1]
        .split(' WHERE ')[0]
        .matchAll(/([a-z_]+) = \$(\d+)/g)];
      const environmentId = String(values[values.length - 1]);
      const environment = environments.get(environmentId);
      if (!environment) return { rows: [], rowCount: 0 };

      const updated = { ...environment };
      for (const [, column, parameter] of assignments) {
        const value = values[Number(parameter) - 1];
        if (column === 'name' &&
            [...environments.values()].some((other) =>
              other.environment_id !== environmentId && other.name === value)) {
          throw Object.assign(new Error('duplicate environment name'), { code: '23505' });
        }
        updated[column] = value;
      }
      environments.set(environmentId, updated);
      return { rows: [{ ...updated }], rowCount: 1 };
    }

    throw new Error(`Unexpected SQL in test: ${sql}`);
  };

  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    pgPool.query = originalQuery;
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve) => server.once('listening', resolve));

  const baseUrl = `http://127.0.0.1:${server.address().port}/api/environments`;
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
    body: JSON.stringify({ name: 'No Token' })
  });
  assert.equal(unauthenticatedCreate.status, 401);
  const invalidToken = await fetch(baseUrl, {
    headers: { authorization: 'Bearer invalid-token' }
  });
  assert.equal(invalidToken.status, 401);

  const adminList = await fetch(baseUrl, { headers: headers('1') });
  assert.equal(adminList.status, 200);
  assert.equal((await adminList.json()).data.length, 2);

  const managerList = await fetch(`${baseUrl}/`, { headers: headers('2') });
  assert.equal(managerList.status, 200);
  assert.equal((await managerList.json()).data.length, 2);

  const engineerList = await fetch(baseUrl, { headers: headers('3') });
  assert.equal(engineerList.status, 200);
  assert.equal((await engineerList.json()).data.length, 2);

  const retrieve = await fetch(`${baseUrl}/1`, { headers: headers('3') });
  assert.equal(retrieve.status, 200);
  assert.equal((await retrieve.json()).data.name, 'Production');

  const invalidId = await fetch(`${baseUrl}/not-an-id`, { headers: headers('1') });
  assert.equal(invalidId.status, 400);
  const missing = await fetch(`${baseUrl}/999`, { headers: headers('1') });
  assert.equal(missing.status, 404);

  const engineerCreate = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('3'),
    body: JSON.stringify({ name: 'Engineer Created' })
  });
  assert.equal(engineerCreate.status, 403);
  const engineerUpdate = await fetch(`${baseUrl}/1`, {
    method: 'PATCH',
    headers: jsonHeaders('3'),
    body: JSON.stringify({ name: 'Engineer Updated' })
  });
  assert.equal(engineerUpdate.status, 403);

  const emptyName = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('1'),
    body: JSON.stringify({ name: '   ' })
  });
  assert.equal(emptyName.status, 400);
  const overlongName = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('1'),
    body: JSON.stringify({ name: 'x'.repeat(101) })
  });
  assert.equal(overlongName.status, 400);
  const invalidDescription = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('1'),
    body: JSON.stringify({ name: 'Invalid Description', description: 42 })
  });
  assert.equal(invalidDescription.status, 400);
  const unknownField = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('1'),
    body: JSON.stringify({ name: 'Unexpected Field', isActive: false })
  });
  assert.equal(unknownField.status, 400);

  const duplicateCreate = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('1'),
    body: JSON.stringify({ name: 'Production' })
  });
  assert.equal(duplicateCreate.status, 409);

  const created = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ name: '  Development  ', description: 'Developer environment' })
  });
  assert.equal(created.status, 201);
  const createdEnvironment = (await created.json()).data;
  assert.equal(createdEnvironment.name, 'Development');
  assert.equal(createdEnvironment.description, 'Developer environment');
  assert.ok(capturedQueries.some(({ sql, values }) =>
    sql.includes('VALUES ($1, $2)') && values[0] === 'Development'
  ));

  const update = await fetch(`${baseUrl}/${createdEnvironment.environment_id}`, {
    method: 'PATCH',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ description: null })
  });
  assert.equal(update.status, 200);
  assert.equal((await update.json()).data.description, null);

  const duplicateUpdate = await fetch(`${baseUrl}/${createdEnvironment.environment_id}`, {
    method: 'PATCH',
    headers: jsonHeaders('1'),
    body: JSON.stringify({ name: 'Production' })
  });
  assert.equal(duplicateUpdate.status, 409);

  const emptyUpdate = await fetch(`${baseUrl}/1`, {
    method: 'PATCH',
    headers: jsonHeaders('1'),
    body: JSON.stringify({})
  });
  assert.equal(emptyUpdate.status, 400);
  const missingUpdate = await fetch(`${baseUrl}/999`, {
    method: 'PATCH',
    headers: jsonHeaders('1'),
    body: JSON.stringify({ name: 'Missing Environment' })
  });
  assert.equal(missingUpdate.status, 404);

  const deactivationUnsupported = await fetch(`${baseUrl}/1/deactivate`, {
    method: 'PATCH',
    headers: headers('1')
  });
  assert.equal(deactivationUnsupported.status, 404);
  assert.ok(capturedQueries.every(({ sql }) => !sql.includes('UPDATE environment SET is_active')));
});
