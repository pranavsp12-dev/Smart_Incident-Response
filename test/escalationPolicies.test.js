import assert from 'node:assert/strict';
import { test } from 'node:test';
import { env } from '../src/config/env.js';
import { pgPool } from '../src/config/postgres.js';
import { createAccessToken } from '../src/services/auth.service.js';
import app from '../src/app.js';

test('Escalation policies and levels enforce validation, team scope, permissions, and constraints', async (t) => {
  env.JWT_SECRET = 'test-only-secret-that-is-long-enough-for-jwt';
  const originalQuery = pgPool.query;
  const originalConnect = pgPool.connect;
  const users = new Map([
    ['1', { role: 'admin', team_id: null, is_active: true }],
    ['2', { role: 'manager', team_id: '7', is_active: true }],
    ['3', { role: 'engineer', team_id: '7', is_active: true }],
    ['4', { role: 'manager', team_id: '8', is_active: true }],
    ['5', { role: 'manager', team_id: null, is_active: true }],
    ['6', { role: 'engineer', team_id: null, is_active: true }]
  ]);
  const teams = new Set(['7', '8']);
  const policies = new Map([
    ['10', { policy_id: '10', team_id: '7', name: 'Primary', description: null, is_active: true }],
    ['11', { policy_id: '11', team_id: '8', name: 'Secondary', description: 'Other team', is_active: true }]
  ]);
  const levels = new Map([
    ['20', { level_id: '20', policy_id: '10', level_number: 1, target_type: 'user', target_id: '2', wait_minutes: 5 }],
    ['21', { level_id: '21', policy_id: '11', level_number: 1, target_type: 'team', target_id: '8', wait_minutes: 0 }]
  ]);
  const capturedQueries = [];
  let nextPolicyId = 12;
  let nextLevelId = 22;
  let snapshot;
  let failPolicyInsert = false;
  let policyInsertFailureCode = '08006';
  let failLevelConstraint = false;
  let failCommit = false;

  function scoped(sql, values, row) {
    if (sql.includes('AND FALSE')) return false;
    if (sql.includes('ep.is_active = TRUE') && !row.is_active) return false;
    const match = sql.match(/ep\.team_id = \$(\d+)/);
    return !match || String(row.team_id ?? row.policy_team_id) === String(values[Number(match[1]) - 1]);
  }

  function runQuery(sql, values = []) {
    capturedQueries.push({ sql, values });
    if (sql.includes('FROM app_user')) {
      const candidate = users.get(String(values[0]));
      const user = candidate &&
        (!sql.includes('team_id = $2 AND is_active = TRUE') ||
          (String(candidate.team_id) === String(values[1]) && candidate.is_active))
        ? candidate
        : null;
      return {
        rows: user ? [{ user_id: String(values[0]), ...user }] : [],
        rowCount: user ? 1 : 0
      };
    }
    if (sql.includes('FROM team WHERE')) {
      const exists = teams.has(String(values[0]));
      return { rows: exists ? [{ team_id: String(values[0]) }] : [], rowCount: exists ? 1 : 0 };
    }
    if (sql.includes('FROM escalation_policy ep')) {
      let rows = [...policies.values()].filter((policy) => scoped(sql, values, policy));
      const idMatch = sql.match(/ep\.policy_id = \$(\d+)/);
      if (idMatch) {
        const id = String(values[Number(idMatch[1]) - 1]);
        rows = rows.filter((policy) => policy.policy_id === id);
      }
      rows.sort((left, right) => left.name.localeCompare(right.name));
      return { rows: rows.map((row) => ({ ...row })), rowCount: rows.length };
    }
    if (sql.startsWith('SELECT') && sql.includes('FROM escalation_level el')) {
      let rows = [...levels.values()].filter((level) => level.policy_id === String(values[0]));
      if (sql.includes('el.level_id = $2')) {
        rows = rows.filter((level) => level.level_id === String(values[1]));
      }
      rows = rows.filter((level) => {
        const policy = policies.get(level.policy_id);
        return policy && scoped(sql, values, {
          ...level,
          policy_team_id: policy.team_id,
          is_active: policy.is_active
        });
      });
      return { rows: rows.map((row) => ({ ...row })), rowCount: rows.length };
    }
    if (sql.startsWith('SELECT') && sql.includes('FROM escalation_level') && sql.includes('level_id = $2')) {
      const level = levels.get(String(values[1]));
      const rows = level && level.policy_id === String(values[0]) ? [{ ...level }] : [];
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith('SELECT') && sql.includes('FROM escalation_level')) {
      const rows = [...levels.values()]
        .filter((level) => level.policy_id === String(values[0]))
        .sort((a, b) => a.level_number - b.level_number);
      return { rows: rows.map((row) => ({ ...row })), rowCount: rows.length };
    }
    if (sql.includes('INSERT INTO escalation_policy')) {
      if (failPolicyInsert) {
        failPolicyInsert = false;
        throw Object.assign(new Error('database insert failure'), {
          code: policyInsertFailureCode
        });
      }
      const [teamId, name, description, isActive] = values;
      if (!teams.has(String(teamId))) {
        throw Object.assign(new Error('missing team'), { code: '23503' });
      }
      const policy = {
        policy_id: String(nextPolicyId++),
        team_id: String(teamId),
        name,
        description,
        is_active: isActive
      };
      policies.set(policy.policy_id, policy);
      return { rows: [{ ...policy }], rowCount: 1 };
    }
    if (sql.includes('UPDATE escalation_policy')) {
      const id = String(values[values.length - 1]);
      const policy = policies.get(id);
      if (!policy) return { rows: [], rowCount: 0 };
      const updated = { ...policy };
      for (const [, column, index] of sql.matchAll(/(\w+) = \$(\d+)/g)) {
        const fields = { name: 'name', description: 'description', is_active: 'isActive', team_id: 'teamId' };
        const field = fields[column];
        if (field) updated[column] = values[Number(index) - 1];
      }
      if (!teams.has(String(updated.team_id))) {
        throw Object.assign(new Error('missing team'), { code: '23503' });
      }
      policies.set(id, updated);
      return { rows: [{ ...updated }], rowCount: 1 };
    }
    if (sql.includes('DELETE FROM escalation_policy')) {
      const id = String(values[0]);
      policies.delete(id);
      for (const [levelId, level] of levels) {
        if (level.policy_id === id) levels.delete(levelId);
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO escalation_level')) {
      if (failLevelConstraint) {
        failLevelConstraint = false;
        throw Object.assign(new Error('check constraint failure'), { code: '23514' });
      }
      const [policyId, levelNumber, targetType, targetId, waitMinutes] = values;
      if ([...levels.values()].some((level) =>
        level.policy_id === String(policyId) && level.level_number === levelNumber
      )) {
        throw Object.assign(new Error('duplicate level number'), {
          code: '23505',
          constraint: 'uq_escalation_policy_level'
        });
      }
      const level = {
        level_id: String(nextLevelId++),
        policy_id: String(policyId),
        level_number: levelNumber,
        target_type: targetType,
        target_id: String(targetId),
        wait_minutes: waitMinutes
      };
      levels.set(level.level_id, level);
      return { rows: [{ ...level }], rowCount: 1 };
    }
    if (sql.includes('UPDATE escalation_level')) {
      const policyId = String(values[values.length - 2]);
      const levelId = String(values[values.length - 1]);
      const existing = levels.get(levelId);
      if (!existing || existing.policy_id !== policyId) return { rows: [], rowCount: 0 };
      const updated = { ...existing };
      const columns = {
        level_number: 'level_number',
        target_type: 'target_type',
        target_id: 'target_id',
        wait_minutes: 'wait_minutes'
      };
      for (const [, column, index] of sql.matchAll(/(\w+) = \$(\d+)/g)) {
        if (columns[column]) updated[column] = values[Number(index) - 1];
      }
      if ([...levels.values()].some((level) =>
        level.level_id !== levelId &&
        level.policy_id === policyId &&
        level.level_number === updated.level_number
      )) {
        throw Object.assign(new Error('duplicate level number'), {
          code: '23505',
          constraint: 'uq_escalation_policy_level'
        });
      }
      levels.set(levelId, updated);
      return { rows: [{ ...updated }], rowCount: 1 };
    }
    if (sql.includes('DELETE FROM escalation_level')) {
      const level = levels.get(String(values[1]));
      if (!level || level.policy_id !== String(values[0])) return { rows: [], rowCount: 0 };
      levels.delete(level.level_id);
      return { rows: [{ level_id: level.level_id }], rowCount: 1 };
    }
    throw new Error(`Unexpected escalation test SQL: ${sql}`);
  }

  pgPool.query = async (sql, values = []) => runQuery(sql, values);
  pgPool.connect = async () => ({
    async query(sql, values = []) {
      capturedQueries.push({ sql, values });
      if (sql === 'BEGIN') {
        snapshot = {
          policies: new Map([...policies].map(([id, row]) => [id, { ...row }])),
          levels: new Map([...levels].map(([id, row]) => [id, { ...row }]))
        };
        return { rows: [], rowCount: 0 };
      }
      if (sql === 'COMMIT') {
        if (failCommit) {
          failCommit = false;
          throw Object.assign(new Error('commit failed'), { code: '08006' });
        }
        snapshot = null;
        return { rows: [], rowCount: 0 };
      }
      if (sql === 'ROLLBACK') {
        if (snapshot) {
          policies.clear();
          levels.clear();
          for (const [id, row] of snapshot.policies) policies.set(id, row);
          for (const [id, row] of snapshot.levels) levels.set(id, row);
        }
        snapshot = null;
        return { rows: [], rowCount: 0 };
      }
      return runQuery(sql, values);
    },
    release() {}
  });

  const server = app.listen(0, '127.0.0.1');
  t.after(async () => {
    pgPool.query = originalQuery;
    pgPool.connect = originalConnect;
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve) => server.once('listening', resolve));

  const baseUrl = `http://127.0.0.1:${server.address().port}/api/escalation-policies`;
  const tokens = Object.fromEntries([...users].map(([id, user]) => [
    id,
    createAccessToken({ user_id: id, role: user.role, team_id: user.team_id })
  ]));
  const request = async (path, userId, options = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        authorization: `Bearer ${tokens[userId]}`,
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...options.headers
      }
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json()
    };
  };
  const send = (path, userId, method, body) =>
    request(path, userId, { method, body: JSON.stringify(body) });

  assert.equal((await fetch(baseUrl)).status, 401);
  assert.deepEqual((await request('', '2')).body.data.map((policy) => policy.policy_id), ['10']);
  assert.equal((await request('/11', '2')).status, 404);
  assert.equal((await request('/11', '3')).status, 404);
  assert.equal((await request('/10', '3')).status, 200);
  assert.equal((await request('/bad', '1')).status, 400);
  assert.deepEqual((await request('', '1')).body.data.map((policy) => policy.policy_id), ['10', '11']);
  assert.equal((await request('', '5')).status, 403);
  assert.equal((await request('/10', '6')).status, 404);

  assert.equal((await send('', '3', 'POST', { name: 'Engineer policy' })).status, 403);
  const managerPolicy = await send('', '2', 'POST', { name: 'Missing team' });
  assert.equal(managerPolicy.status, 201);
  assert.equal(managerPolicy.body.data.team_id, '7');
  assert.equal(managerPolicy.body.data.name, 'Missing team');
  assert.equal(policies.get(managerPolicy.body.data.policy_id).name, 'Missing team');
  assert.equal((await request(`/${managerPolicy.body.data.policy_id}`, '2')).body.data.name, 'Missing team');
  assert.equal((await send('', '1', 'POST', { teamId: 7 })).status, 400);
  assert.equal((await send('', '2', 'POST', { name: 'Explicit own team', teamId: 7 })).status, 403);
  assert.equal((await send('', '1', 'POST', { name: 'Bad team', teamId: 999 })).status, 400);
  assert.equal((await send('', '2', 'POST', { name: 'Cross team', teamId: 8 })).status, 403);
  assert.equal((await send('', '1', 'POST', { name: 'Admin policy', teamId: 8 })).status, 201);
  assert.equal((await send('', '1', 'POST', { name: 'Duplicate names allowed', teamId: 8 })).status, 201);
  const inactivePolicy = await send('', '2', 'POST', {
    name: 'Inactive policy', isActive: false
  });
  assert.equal(inactivePolicy.status, 201);
  const inactivePolicyId = String(inactivePolicy.body.data.policy_id);
  assert.equal((await request(`/${inactivePolicyId}`, '3')).status, 404);
  assert.equal(
    (await request('', '3')).body.data.some((policy) => policy.policy_id === inactivePolicyId),
    false
  );
  assert.equal((await request(`/${inactivePolicyId}`, '2')).status, 200);
  assert.equal((await send('', '1', 'POST', { name: '  ', teamId: 7 })).status, 400);
  assert.equal((await send('', '1', 'POST', { name: 'x'.repeat(151), teamId: 7 })).status, 400);
  assert.equal((await send('', '1', 'POST', { name: 'Invalid field', teamId: 7, extra: true })).status, 400);
  assert.equal((await send('/10', '4', 'PATCH', { teamId: 7 })).status, 403);
  assert.equal((await send('/10', '4', 'PATCH', { name: 'Out of scope' })).status, 404);
  assert.equal((await send('/10', '2', 'PATCH', { teamId: 8 })).status, 403);
  assert.equal((await send('/10', '2', 'PATCH', { teamId: 7 })).status, 403);
  assert.equal((await send('/bad', '1', 'PATCH', { name: 'bad id' })).status, 400);
  assert.equal((await send('/999', '1', 'PATCH', { name: 'Missing' })).status, 404);
  assert.equal((await send('/10', '2', 'PATCH', { description: 'Updated description' })).status, 200);
  assert.equal(policies.get('10').description, 'Updated description');

  assert.equal((await request('/10/levels', '2')).status, 200);
  assert.equal((await request('/10/levels/20', '3')).status, 200);
  assert.equal((await request('/10/levels/21', '1')).status, 404);
  assert.equal((await request('/10/levels/21', '2')).status, 404);
  assert.equal((await request('/10/levels/not-an-id', '1')).status, 400);
  assert.equal((await request('/11/levels/21', '3')).status, 404);
  assert.equal((await request('/11/levels', '6')).status, 404);
  assert.equal((await request('/11/levels/21', '6')).status, 404);
  assert.equal((await send('/10/levels', '3', 'POST', {
    levelNumber: 2, targetType: 'user', targetId: 3
  })).status, 403);
  assert.equal((await send('/10/levels', '2', 'POST', {
    levelNumber: 2, targetType: 'user', targetId: 3
  })).status, 201);
  const defaultTimingLevel = levels.get('22');
  assert.deepEqual(defaultTimingLevel, {
    level_id: '22',
    policy_id: '10',
    level_number: 2,
    target_type: 'user',
    target_id: '3',
    wait_minutes: 5
  });
  assert.equal((await request('/10/levels/22', '2')).body.data.wait_minutes, 5);
  assert.equal((await send('/10/levels', '2', 'POST', {
    levelNumber: 2, targetType: 'team', targetId: 7
  })).status, 409);
  assert.equal((await send('/10/levels', '2', 'POST', {
    targetType: 'user', targetId: 3
  })).status, 400);
  assert.equal((await send('/10/levels', '2', 'POST', {
    levelNumber: 3, targetId: 3
  })).status, 400);
  assert.equal((await send('/10/levels', '2', 'POST', {
    levelNumber: 3, targetType: 'user'
  })).status, 400);
  assert.equal((await send('/10/levels', '2', 'POST', {
    levelNumber: 0, targetType: 'user', targetId: 3
  })).status, 400);
  assert.equal((await send('/10/levels', '2', 'POST', {
    levelNumber: 2147483648, targetType: 'user', targetId: 3
  })).status, 400);
  assert.equal((await send('/10/levels', '2', 'POST', {
    levelNumber: 3, targetType: 'user', targetId: 3, waitMinutes: -1
  })).status, 400);
  assert.equal((await send('/10/levels', '2', 'POST', {
    levelNumber: 3, targetType: '', targetId: 3
  })).status, 400);
  assert.equal((await send('/10/levels', '2', 'POST', {
    levelNumber: 3, targetType: 'x'.repeat(51), targetId: 3
  })).status, 400);
  assert.equal((await send('/10/levels', '2', 'POST', {
    levelNumber: 3, targetType: 'service', targetId: 3
  })).status, 400);
  assert.equal((await send('/10/levels', '2', 'POST', {
    levelNumber: 3, targetType: 'user', targetId: 'not-an-id'
  })).status, 400);
  assert.equal((await send('/10/levels', '2', 'POST', {
    levelNumber: 3, targetType: 'user', targetId: 99
  })).status, 400);
  assert.equal((await send('/10/levels', '2', 'POST', {
    levelNumber: 3, targetType: 'user', targetId: 4
  })).status, 400);
  assert.equal((await send('/10/levels', '2', 'POST', {
    levelNumber: 3, targetType: 'team', targetId: 8
  })).status, 400);
  assert.equal((await send('/10/levels', '2', 'POST', {
    levelNumber: 3, targetType: 'user', targetId: 3, extra: true
  })).status, 400);
  assert.equal((await send('/999/levels', '1', 'POST', {
    levelNumber: 1, targetType: 'user', targetId: 2
  })).status, 404);
  assert.equal((await send('/10/levels', '2', 'POST', {})).status, 400);
  assert.equal((await send('/10/levels/20', '2', 'PATCH', {
    levelNumber: 2
  })).status, 409);
  assert.equal((await send('/10/levels/20', '3', 'PATCH', {
    waitMinutes: 0
  })).status, 403);
  assert.equal((await send('/10/levels/999', '2', 'PATCH', {
    waitMinutes: 10
  })).status, 404);
  assert.equal((await send('/10/levels/not-an-id', '2', 'PATCH', {
    waitMinutes: 10
  })).status, 400);
  assert.equal((await send('/10/levels/21', '2', 'PATCH', {
    waitMinutes: 10
  })).status, 404);
  assert.equal((await request('/10/levels/21', '2', { method: 'DELETE' })).status, 404);
  assert.equal(levels.has('21'), true);
  assert.equal((await request('/bad/levels/20', '1', { method: 'DELETE' })).status, 400);
  const levelUpdated = await send('/10/levels/20', '2', 'PATCH', { waitMinutes: 10 });
  assert.equal(levelUpdated.status, 200);
  assert.equal(levelUpdated.body.data.wait_minutes, 10);
  const customTimingLevel = await send('/10/levels', '2', 'POST', {
    levelNumber: 3,
    targetType: 'team',
    targetId: 7,
    waitMinutes: 15
  });
  assert.equal(customTimingLevel.status, 201);
  assert.deepEqual(customTimingLevel.body.data, {
    level_id: '23',
    policy_id: '10',
    level_number: 3,
    target_type: 'team',
    target_id: '7',
    wait_minutes: 15
  });
  assert.deepEqual(levels.get('23'), customTimingLevel.body.data);
  assert.deepEqual(
    (await request('/10/levels', '2')).body.data.map(({ level_id, level_number, target_type, target_id, wait_minutes }) => ({
      level_id,
      level_number,
      target_type,
      target_id,
      wait_minutes
    })),
    [
      { level_id: '20', level_number: 1, target_type: 'user', target_id: '2', wait_minutes: 10 },
      { level_id: '22', level_number: 2, target_type: 'user', target_id: '3', wait_minutes: 5 },
      { level_id: '23', level_number: 3, target_type: 'team', target_id: '7', wait_minutes: 15 }
    ]
  );
  assert.equal((await send('/bad/levels', '1', 'POST', {
    levelNumber: 1, targetType: 'user', targetId: 2
  })).status, 400);

  failLevelConstraint = true;
  const levelCountBeforeConstraint = levels.size;
  assert.equal((await send('/10/levels', '2', 'POST', {
    levelNumber: 3, targetType: 'user', targetId: 3
  })).status, 400);
  assert.equal(levels.size, levelCountBeforeConstraint);
  assert.ok(capturedQueries.some(({ sql }) => sql === 'ROLLBACK'));

  failPolicyInsert = true;
  const beforeFailure = policies.size;
  assert.equal((await send('', '1', 'POST', {
    name: 'DB failure', teamId: 7
  })).status, 500);
  assert.equal(policies.size, beforeFailure);

  failPolicyInsert = true;
  policyInsertFailureCode = '23503';
  assert.equal((await send('', '1', 'POST', {
    name: 'Concurrent team deletion', teamId: 7
  })).status, 400);
  assert.equal(policies.size, beforeFailure);
  policyInsertFailureCode = '08006';

  failCommit = true;
  assert.equal((await send('/10/levels/20', '2', 'PATCH', {
    waitMinutes: 25
  })).status, 500);
  assert.equal(levels.get('20').wait_minutes, 10);
  assert.ok(capturedQueries.some(({ sql }) => sql === 'ROLLBACK'));

  assert.equal((await request('/11/levels', '4')).status, 200);
  assert.equal((await request('/10/levels', '4')).status, 404);
  assert.equal((await request('/10/levels/20', '6')).status, 404);
  assert.equal((await request('/10/levels', '5')).status, 403);

  assert.equal((await request('/10/levels/20', '1', { method: 'DELETE' })).status, 204);
  assert.equal(levels.has('20'), false);
  assert.equal((await request('/10', '1', { method: 'DELETE' })).status, 204);
  assert.equal(policies.has('10'), false);
  assert.equal([...levels.values()].some((level) => level.policy_id === '10'), false);
  assert.ok(capturedQueries.some(({ sql, values }) =>
    sql.includes('INSERT INTO escalation_level') &&
    sql.includes('VALUES ($1, $2, $3, $4, $5)') &&
    values[1] === 2
  ));
});
