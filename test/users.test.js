import assert from 'node:assert/strict';
import { test } from 'node:test';
import bcrypt from 'bcryptjs';
import { env } from '../src/config/env.js';
import { pgPool } from '../src/config/postgres.js';
import { createAccessToken } from '../src/services/auth.service.js';
import { bootstrapInitialAdmin } from '../src/services/users.service.js';
import app from '../src/app.js';

const initialUsers = [
  {
    user_id: '1',
    team_id: null,
    name: 'Admin User',
    email: 'admin@example.com',
    role: 'admin',
    is_active: true,
    created_at: '2026-01-01T00:00:00.000Z'
  },
  {
    user_id: '2',
    team_id: '7',
    name: 'Team Manager',
    email: 'manager@example.com',
    role: 'manager',
    is_active: true,
    created_at: '2026-01-01T00:00:00.000Z'
  },
  {
    user_id: '3',
    team_id: '7',
    name: 'Engineer User',
    email: 'engineer@example.com',
    role: 'engineer',
    is_active: true,
    created_at: '2026-01-01T00:00:00.000Z'
  },
  {
    user_id: '4',
    team_id: '8',
    name: 'Outside User',
    email: 'outside@example.com',
    role: 'engineer',
    is_active: true,
    created_at: '2026-01-01T00:00:00.000Z'
  },
  {
    user_id: '5',
    team_id: null,
    name: 'Unassigned Manager',
    email: 'unassigned-manager@example.com',
    role: 'manager',
    is_active: true,
    created_at: '2026-01-01T00:00:00.000Z'
  }
];

test('Users APIs validate input, enforce scope, and never expose plaintext or hashes', async (t) => {
  env.JWT_SECRET = 'test-only-secret-that-is-long-enough-for-jwt';
  const originalQuery = pgPool.query;
  const users = new Map(initialUsers.map((user) => [user.user_id, { ...user, password_hash: 'stored-hash' }]));
  const capturedSql = [];
  let duplicateEmail = false;

  pgPool.query = async (sql, values = []) => {
    capturedSql.push({ sql, values });
    if (sql.includes('SELECT user_id, role, team_id, is_active') &&
        sql.includes('FROM app_user')) {
      const user = users.get(String(values[0]));
      return {
        rows: user ? [{
          user_id: user.user_id,
          role: user.role,
          team_id: user.team_id,
          is_active: user.is_active
        }] : [],
        rowCount: user ? 1 : 0
      };
    }
    if (sql.includes('SELECT 1 FROM app_user WHERE LOWER(email)')) {
      return {
        rows: duplicateEmail ? [{ '?column?': 1 }] : [],
        rowCount: duplicateEmail ? 1 : 0
      };
    }
    if (sql.includes('FROM app_user') && sql.includes('ORDER BY')) {
      const filtered = sql.includes('WHERE team_id = $1')
        ? [...users.values()].filter((user) => user.team_id === String(values[0]))
        : [...users.values()];
      return { rows: filtered.map(({ password_hash, ...user }) => user), rowCount: filtered.length };
    }
    if (sql.includes('SELECT user_id, team_id, name, email, role, is_active, created_at') &&
        sql.includes('FROM app_user') && sql.includes('WHERE user_id = $1')) {
      const user = users.get(String(values[0]));
      if (!user) return { rows: [], rowCount: 0 };
      const { password_hash, ...publicUser } = user;
      return { rows: [publicUser], rowCount: 1 };
    }
    if (sql.includes('FROM team')) {
      const found = ['7', '8'].includes(String(values[0]));
      return { rows: found ? [{ team_id: values[0] }] : [], rowCount: found ? 1 : 0 };
    }
    if (sql.includes('INSERT INTO app_user')) {
      const [name, email, passwordHash, role, teamId] = values;
      assert.notEqual(passwordHash, 'Secure-Password-123!');
      const inserted = {
        user_id: '10',
        team_id: teamId,
        name,
        email,
        role,
        is_active: true,
        created_at: '2026-01-01T00:00:00.000Z',
        password_hash: passwordHash
      };
      users.set(inserted.user_id, inserted);
      return { rows: [{ ...inserted, password_hash: undefined }], rowCount: 1 };
    }
    if (sql.includes('UPDATE app_user')) {
      const assignments = sql.split('SET ')[1].split(' WHERE ')[0];
      const id = String(values[values.length - 1]);
      const current = users.get(id);
      if (!current) return { rows: [], rowCount: 0 };
      const updated = { ...current };
      for (const match of assignments.matchAll(/([a-z_]+) = \$(\d+)/g)) {
        const column = match[1];
        const parameterIndex = Number(match[2]) - 1;
        const property = {
          team_id: 'team_id',
          is_active: 'is_active',
          password_hash: 'password_hash'
        }[column] || column;
        updated[property] = values[parameterIndex];
      }
      users.set(id, updated);
      const { password_hash, ...publicUser } = updated;
      return { rows: [publicUser], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL in test: ${sql}`);
  };

  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    pgPool.query = originalQuery;
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve) => server.once('listening', resolve));

  const baseUrl = `http://127.0.0.1:${server.address().port}/api/users`;
  const tokens = Object.fromEntries(['1', '2', '3', '5'].map((id) => {
    const user = users.get(id);
    return [id, createAccessToken({
      user_id: user.user_id,
      role: user.role,
      team_id: user.team_id
    })];
  }));
  const headers = (id) => ({ authorization: `Bearer ${tokens[id]}` });
  const jsonHeaders = (id) => ({ ...headers(id), 'content-type': 'application/json' });

  const unauthenticated = await fetch(baseUrl);
  assert.equal(unauthenticated.status, 401);

  const list = await fetch(baseUrl, { headers: headers('1') });
  assert.equal(list.status, 200);
  const listedUsers = (await list.json()).data;
  assert.equal(listedUsers.length, 5);
  assert.equal(JSON.stringify(listedUsers).includes('password_hash'), false);
  assert.equal(JSON.stringify(listedUsers).includes('stored-hash'), false);
  assert.ok(capturedSql.some(({ sql }) => sql.includes('ORDER BY name, user_id') &&
    !sql.includes('password_hash')));

  const managerList = await fetch(baseUrl, { headers: headers('2') });
  assert.equal(managerList.status, 200);
  assert.deepEqual((await managerList.json()).data.map((user) => user.user_id), ['2', '3']);

  const engineerList = await fetch(baseUrl, { headers: headers('3') });
  assert.equal(engineerList.status, 403);

  const unassignedManagerList = await fetch(baseUrl, { headers: headers('5') });
  assert.equal(unassignedManagerList.status, 403);

  const hiddenOutside = await fetch(`${baseUrl}/4`, { headers: headers('2') });
  assert.equal(hiddenOutside.status, 404);
  const ownRecord = await fetch(`${baseUrl}/3`, { headers: headers('3') });
  assert.equal(ownRecord.status, 200);
  assert.equal(Object.hasOwn((await ownRecord.json()).data, 'password_hash'), false);

  const invalidInput = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('1'),
    body: JSON.stringify({
      name: 'New Person',
      email: 'new@example.com',
      password: 'short'
    })
  });
  assert.equal(invalidInput.status, 400);

  const selfPrivilegeGrant = await fetch(`${baseUrl}/3`, {
    method: 'PATCH',
    headers: jsonHeaders('3'),
    body: JSON.stringify({ role: 'admin' })
  });
  assert.equal(selfPrivilegeGrant.status, 403);

  const managerPrivilegeGrant = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({
      name: 'Admin Attempt',
      email: 'admin-attempt@example.com',
      password: 'Secure-Password-123!',
      role: 'admin'
    })
  });
  assert.equal(managerPrivilegeGrant.status, 403);

  const managerOutsideTeam = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('2'),
    body: JSON.stringify({
      name: 'Wrong Team',
      email: 'wrong-team@example.com',
      password: 'Secure-Password-123!',
      teamId: '8'
    })
  });
  assert.equal(managerOutsideTeam.status, 403);

  const invalidTeam = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('1'),
    body: JSON.stringify({
      name: 'Unknown Team User',
      email: 'unknown-team@example.com',
      password: 'Secure-Password-123!',
      teamId: '999'
    })
  });
  assert.equal(invalidTeam.status, 400);

  duplicateEmail = true;
  const duplicate = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('1'),
    body: JSON.stringify({
      name: 'Duplicate',
      email: 'admin@example.com',
      password: 'Secure-Password-123!'
    })
  });
  assert.equal(duplicate.status, 409);
  duplicateEmail = false;

  const created = await fetch(baseUrl, {
    method: 'POST',
    headers: jsonHeaders('1'),
    body: JSON.stringify({
      name: 'New Person',
      email: 'NEW@example.com',
      password: 'Secure-Password-123!',
      teamId: '7'
    })
  });
  assert.equal(created.status, 201);
  const createdUser = (await created.json()).data;
  assert.equal(createdUser.password_hash, undefined);
  assert.equal(createdUser.password, undefined);
  const storedHash = users.get('10').password_hash;
  assert.notEqual(storedHash, 'Secure-Password-123!');
  assert.equal(await bcrypt.compare('Secure-Password-123!', storedHash), true);

  const updatePassword = 'Another-Secure-Password-456!';
  const updated = await fetch(`${baseUrl}/3`, {
    method: 'PATCH',
    headers: jsonHeaders('3'),
    body: JSON.stringify({ name: 'Updated Engineer', password: updatePassword })
  });
  assert.equal(updated.status, 200);
  const updatedUser = (await updated.json()).data;
  assert.equal(updatedUser.name, 'Updated Engineer');
  assert.equal(updatedUser.password_hash, undefined);
  assert.equal(await bcrypt.compare(updatePassword, users.get('3').password_hash), true);

  const managerDeactivate = await fetch(`${baseUrl}/3/deactivate`, {
    method: 'PATCH',
    headers: headers('2')
  });
  assert.equal(managerDeactivate.status, 200);
  assert.equal((await managerDeactivate.json()).data.is_active, false);

  const revokedToken = await fetch(`${baseUrl}/3`, { headers: headers('3') });
  assert.equal(revokedToken.status, 401);

  const managerCannotChangeStatus = await fetch(`${baseUrl}/4`, {
    method: 'PATCH',
    headers: jsonHeaders('2'),
    body: JSON.stringify({ isActive: false })
  });
  assert.equal(managerCannotChangeStatus.status, 404);

  const invalidToken = await fetch(baseUrl, {
    headers: { authorization: 'Bearer not-a-valid-token' }
  });
  assert.equal(invalidToken.status, 401);
});

test('initial admin bootstrap locks and only runs for an empty user table', async () => {
  const originalConnect = pgPool.connect;
  const commands = [];
  let usersExist = false;
  let insertedHash;

  pgPool.connect = async () => ({
    async query(sql, values = []) {
      commands.push({ sql, values });
      if (sql === 'SELECT 1 FROM app_user LIMIT 1') {
        return { rows: usersExist ? [{ '?column?': 1 }] : [], rowCount: usersExist ? 1 : 0 };
      }
      if (sql.includes('INSERT INTO app_user')) {
        insertedHash = values[2];
        return {
          rows: [{
            user_id: '50',
            team_id: null,
            name: values[0],
            email: values[1],
            role: 'admin',
            is_active: true,
            created_at: '2026-01-01T00:00:00.000Z'
          }],
          rowCount: 1
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {}
  });

  try {
    const admin = await bootstrapInitialAdmin({
      name: 'Bootstrap Admin',
      email: 'bootstrap@example.com',
      password: 'Hidden-Bootstrap-Password!'
    });
    assert.equal(admin.role, 'admin');
    assert.equal(admin.password_hash, undefined);
    assert.notEqual(insertedHash, 'Hidden-Bootstrap-Password!');
    assert.equal(await bcrypt.compare('Hidden-Bootstrap-Password!', insertedHash), true);
    assert.ok(commands.some(({ sql }) => sql.includes('pg_advisory_xact_lock')));

    usersExist = true;
    await assert.rejects(
      bootstrapInitialAdmin({
        name: 'Second Admin',
        email: 'second@example.com',
        password: 'Hidden-Bootstrap-Password!'
      }),
      { status: 409 }
    );
    assert.equal(commands.filter(({ sql }) => sql.includes('INSERT INTO app_user')).length, 1);
    assert.ok(commands.some(({ sql }) => sql === 'ROLLBACK'));
  } finally {
    pgPool.connect = originalConnect;
  }
});
