import assert from 'node:assert/strict';
import { test } from 'node:test';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../src/config/env.js';
import { pgPool } from '../src/config/postgres.js';
import { createAccessToken } from '../src/services/auth.service.js';
import app from '../src/app.js';

const team = {
  team_id: '12',
  name: 'Platform',
  description: 'Platform response team',
  created_at: '2026-01-01T00:00:00.000Z'
};

test('authentication and Teams CRUD enforce validation and role access', async (t) => {
  env.JWT_SECRET = 'test-only-secret-that-is-long-enough-for-jwt';
  const originalQuery = pgPool.query;
  const passwordHash = await bcrypt.hash('correct-horse-battery-staple', 4);
  let capturedInsert;
  let capturedUpdate;
  let inactiveAuthUserActive = true;
  let capturedLoginEmail;

  pgPool.query = async (sql, values = []) => {
    if (sql.includes('password_hash')) {
      capturedLoginEmail = values[0];
      if (!['admin@example.com', 'disabled@example.com'].includes(String(values[0]))) {
        return { rows: [], rowCount: 0 };
      }
      return {
        rows: [{
          user_id: values[0] === 'admin@example.com' ? '1' : '7',
          name: values[0] === 'admin@example.com' ? 'Admin User' : 'Disabled User',
          email: values[0],
          password_hash: passwordHash,
          role: values[0] === 'admin@example.com' ? 'admin' : 'engineer',
          team_id: values[0] === 'admin@example.com' ? null : '12',
          is_active: values[0] === 'admin@example.com'
        }],
        rowCount: 1
      };
    }
    if (sql.includes('FROM app_user')) {
      if (!['1', '2', '3', '4', '5', '6'].includes(String(values[0]))) {
        return { rows: [], rowCount: 0 };
      }
      return {
        rows: [{
          user_id: values[0],
          role: values[0] === '1' ? 'admin' : values[0] === '2' || values[0] === '3' || values[0] === '6'
            ? 'engineer'
            : 'manager',
          team_id: ['2', '3', '4'].includes(String(values[0])) ? '12' : null,
          is_active: values[0] === '3' ? inactiveAuthUserActive : true
        }],
        rowCount: 1
      };
    }
    if (sql.includes('INSERT INTO team')) {
      capturedInsert = { sql, values };
      if (values[0] === 'Duplicate') {
        throw Object.assign(new Error('unique violation'), { code: '23505' });
      }
      return { rows: [{ ...team, name: values[0], description: values[1] }], rowCount: 1 };
    }
    if (sql.includes('UPDATE team')) {
      capturedUpdate = { sql, values };
      if (sql.includes('AND team_id = $3') && values[1] !== values[2]) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [{ ...team, name: values[0] }], rowCount: 1 };
    }
    if (sql.includes('DELETE FROM team')) {
      throw Object.assign(new Error('foreign key violation'), { code: '23503' });
    }
    if (sql.includes('WHERE team_id = $1')) {
      return values[0] !== '12' || (values.length > 1 && values[1] !== '12')
        ? { rows: [], rowCount: 0 }
        : { rows: [team], rowCount: 1 };
    }
    if (sql.includes('FROM team') && sql.includes('ORDER BY')) {
      return values.length && values[0] !== '12'
        ? { rows: [], rowCount: 0 }
        : { rows: [team], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL in test: ${sql}`);
  };

  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    pgPool.query = originalQuery;
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve) => server.once('listening', resolve));

  const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
  const adminToken = createAccessToken({ user_id: '1', role: 'admin', team_id: null });
  const engineerToken = createAccessToken({ user_id: '2', role: 'engineer', team_id: '12' });
  const inactiveToken = createAccessToken({ user_id: '3', role: 'engineer', team_id: '12' });
  const managerToken = createAccessToken({ user_id: '4', role: 'manager', team_id: '12' });
  const unteamedManagerToken = createAccessToken({ user_id: '5', role: 'manager', team_id: null });
  const unteamedEngineerToken = createAccessToken({ user_id: '6', role: 'engineer', team_id: null });
  const missingUserToken = createAccessToken({ user_id: '404', role: 'admin', team_id: null });
  const forgedAdminToken = jwt.sign(
    { role: 'admin', teamId: null },
    env.JWT_SECRET,
    {
      algorithm: 'HS256',
      subject: '2',
      issuer: 'smart-incident-api',
      audience: 'smart-incident-api',
      expiresIn: '1h'
    }
  );
  const expiredToken = jwt.sign(
    { role: 'admin', teamId: null },
    env.JWT_SECRET,
    {
      algorithm: 'HS256',
      subject: '1',
      issuer: 'smart-incident-api',
      audience: 'smart-incident-api',
      expiresIn: -1
    }
  );
  const headers = (token) => ({ authorization: `Bearer ${token}` });

  const unauthorized = await fetch(`${baseUrl}/teams`);
  assert.equal(unauthorized.status, 401);

  const invalidToken = await fetch(`${baseUrl}/teams`, {
    headers: { authorization: 'Bearer invalid.token.value' }
  });
  assert.equal(invalidToken.status, 401);
  assert.deepEqual((await invalidToken.json()).error, {
    message: 'Invalid or expired access token.',
    status: 401
  });

  const expiredAuthorization = await fetch(`${baseUrl}/teams`, {
    headers: headers(expiredToken)
  });
  assert.equal(expiredAuthorization.status, 401);
  assert.deepEqual((await expiredAuthorization.json()).error, {
    message: 'Invalid or expired access token.',
    status: 401
  });

  const bearerWithoutToken = await fetch(`${baseUrl}/teams`, {
    headers: { authorization: 'Bearer ' }
  });
  assert.equal(bearerWithoutToken.status, 401);
  assert.deepEqual((await bearerWithoutToken.json()).error, {
    message: 'A bearer access token is required.',
    status: 401
  });

  const forgedRole = await fetch(`${baseUrl}/teams`, {
    method: 'POST',
    headers: {
      ...headers(forgedAdminToken),
      'content-type': 'application/json'
    },
    body: JSON.stringify({ name: 'Forged Admin Team' })
  });
  assert.equal(forgedRole.status, 403);
  assert.deepEqual((await forgedRole.json()).error, {
    message: 'You do not have permission to perform this action.',
    status: 403
  });

  const missingUser = await fetch(`${baseUrl}/teams`, {
    headers: headers(missingUserToken)
  });
  assert.equal(missingUser.status, 401);

  inactiveAuthUserActive = false;
  const inactiveUser = await fetch(`${baseUrl}/teams`, {
    headers: headers(inactiveToken)
  });
  assert.equal(inactiveUser.status, 401);

  const forbidden = await fetch(`${baseUrl}/teams`, {
    method: 'POST',
    headers: { ...headers(engineerToken), 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'New Team' })
  });
  assert.equal(forbidden.status, 403);

  const managerCreateForbidden = await fetch(`${baseUrl}/teams`, {
    method: 'POST',
    headers: { ...headers(managerToken), 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Manager Team' })
  });
  assert.equal(managerCreateForbidden.status, 403);

  const login = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ' ADMIN@example.com ', password: 'correct-horse-battery-staple' })
  });
  assert.equal(login.status, 200);
  const loginResult = await login.json();
  assert.equal(loginResult.user.email, 'admin@example.com');
  assert.equal(Object.hasOwn(loginResult.user, 'password_hash'), false);
  assert.equal(Object.hasOwn(loginResult.user, 'password'), false);
  assert.equal(Object.hasOwn(loginResult, 'password_hash'), false);
  assert.equal(Object.hasOwn(loginResult, 'password'), false);
  assert.equal(loginResult.tokenType, 'Bearer');
  assert.equal(loginResult.expiresIn, 60 * 60);
  assert.equal(capturedLoginEmail, 'admin@example.com');

  for (const input of [
    {},
    { email: 'admin@example.com' },
    { password: 'correct-horse-battery-staple' },
    { email: '', password: 'correct-horse-battery-staple' },
    { email: 'admin@example.com', password: '' },
    { email: 'admin@example.com', password: 'x'.repeat(73) },
    [],
    { email: 'admin@example.com', password: 'correct-horse-battery-staple', extra: true }
  ]) {
    const invalidLogin = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input)
    });
    assert.equal(invalidLogin.status, 400);
    assert.equal((await invalidLogin.json()).error.status, 400);
  }

  const badPasswordLogin = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'incorrect-password' })
  });
  assert.equal(badPasswordLogin.status, 401);
  assert.deepEqual((await badPasswordLogin.json()).error, {
    message: 'Invalid email or password.',
    status: 401
  });

  const unknownUserLogin = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'missing@example.com', password: 'incorrect-password' })
  });
  assert.equal(unknownUserLogin.status, 401);
  assert.deepEqual((await unknownUserLogin.json()).error, {
    message: 'Invalid email or password.',
    status: 401
  });

  const disabledUserLogin = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'disabled@example.com', password: 'correct-horse-battery-staple' })
  });
  assert.equal(disabledUserLogin.status, 401);
  assert.deepEqual((await disabledUserLogin.json()).error, {
    message: 'Invalid email or password.',
    status: 401
  });

  const listed = await fetch(`${baseUrl}/teams`, { headers: headers(loginResult.accessToken) });
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).data, [team]);

  const engineerTeams = await fetch(`${baseUrl}/teams`, { headers: headers(engineerToken) });
  assert.equal(engineerTeams.status, 200);
  assert.deepEqual((await engineerTeams.json()).data, [team]);

  const unteamedEngineerTeams = await fetch(`${baseUrl}/teams`, {
    headers: headers(unteamedEngineerToken)
  });
  assert.equal(unteamedEngineerTeams.status, 200);
  assert.deepEqual((await unteamedEngineerTeams.json()).data, []);

  const unteamedManagerTeams = await fetch(`${baseUrl}/teams`, {
    headers: headers(unteamedManagerToken)
  });
  assert.equal(unteamedManagerTeams.status, 403);

  const invalidId = await fetch(`${baseUrl}/teams/not-an-id`, {
    headers: headers(adminToken)
  });
  assert.equal(invalidId.status, 400);

  const missing = await fetch(`${baseUrl}/teams/404`, { headers: headers(adminToken) });
  assert.equal(missing.status, 404);

  const crossTeamRead = await fetch(`${baseUrl}/teams/13`, { headers: headers(engineerToken) });
  assert.equal(crossTeamRead.status, 404);

  const created = await fetch(`${baseUrl}/teams`, {
    method: 'POST',
    headers: { ...headers(adminToken), 'content-type': 'application/json' },
    body: JSON.stringify({ name: ' New Team ', description: 'Created through API' })
  });
  assert.equal(created.status, 201);
  assert.deepEqual(capturedInsert.values, ['New Team', 'Created through API']);
  assert.match(capturedInsert.sql, /VALUES \(\$1, \$2\)/);

  const invalidBody = await fetch(`${baseUrl}/teams`, {
    method: 'POST',
    headers: { ...headers(adminToken), 'content-type': 'application/json' },
    body: JSON.stringify({ name: '   ' })
  });
  assert.equal(invalidBody.status, 400);

  const duplicate = await fetch(`${baseUrl}/teams`, {
    method: 'POST',
    headers: { ...headers(adminToken), 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Duplicate' })
  });
  assert.equal(duplicate.status, 409);

  const updated = await fetch(`${baseUrl}/teams/12`, {
    method: 'PATCH',
    headers: { ...headers(adminToken), 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Renamed Team' })
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(capturedUpdate.values, ['Renamed Team', '12']);
  assert.match(capturedUpdate.sql, /name = \$1/);

  const managerOwnTeamUpdate = await fetch(`${baseUrl}/teams/12`, {
    method: 'PATCH',
    headers: { ...headers(managerToken), 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Manager Renamed Team' })
  });
  assert.equal(managerOwnTeamUpdate.status, 200);
  assert.deepEqual(capturedUpdate.values, ['Manager Renamed Team', '12', '12']);
  assert.match(capturedUpdate.sql, /team_id = \$3/);

  const managerCrossTeamUpdate = await fetch(`${baseUrl}/teams/13`, {
    method: 'PATCH',
    headers: { ...headers(managerToken), 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Out of scope' })
  });
  assert.equal(managerCrossTeamUpdate.status, 404);

  const unteamedManagerUpdate = await fetch(`${baseUrl}/teams/12`, {
    method: 'PATCH',
    headers: { ...headers(unteamedManagerToken), 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Out of scope' })
  });
  assert.equal(unteamedManagerUpdate.status, 404);

  const blockedDelete = await fetch(`${baseUrl}/teams/12`, {
    method: 'DELETE',
    headers: headers(adminToken)
  });
  assert.equal(blockedDelete.status, 409);
});
