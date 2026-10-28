import assert from 'node:assert/strict';
import { test } from 'node:test';
import { env } from '../src/config/env.js';
import { pgPool } from '../src/config/postgres.js';
import { createAccessToken } from '../src/services/auth.service.js';
import app from '../src/app.js';

test('On-call schedule and assignment APIs validate input and enforce team scope', async (t) => {
  env.JWT_SECRET = 'on-call-test-secret-that-is-long-enough-for-jwt';
  const originalQuery = pgPool.query;
  const originalConnect = pgPool.connect;
  const users = new Map([
    ['1', { role: 'admin', team_id: null, is_active: true }],
    ['2', { role: 'manager', team_id: '7', is_active: true }],
    ['3', { role: 'engineer', team_id: '7', is_active: true }],
    ['4', { role: 'manager', team_id: '8', is_active: true }],
    ['5', { role: 'manager', team_id: null, is_active: true }],
    ['6', { role: 'engineer', team_id: null, is_active: true }],
    ['7', { role: 'engineer', team_id: '7', is_active: false }],
    ['8', { role: 'engineer', team_id: '8', is_active: true }]
  ]);
  const teams = new Set(['7', '8']);
  const schedules = new Map([
    ['100', {
      schedule_id: '100', team_id: '7', name: 'Team 7 rota', rotation_type: 'weekly',
      start_date: '2026-01-01', end_date: null
    }],
    ['101', {
      schedule_id: '101', team_id: '8', name: 'Team 8 rota', rotation_type: 'daily',
      start_date: '2026-02-01', end_date: '2026-02-28'
    }]
  ]);
  const assignments = new Map([
    ['200', {
      assignment_id: '200', schedule_id: '100', user_id: '3',
      start_time: '2026-01-01T00:00:00.000Z', end_time: '2026-01-08T00:00:00.000Z'
    }],
    ['201', {
      assignment_id: '201', schedule_id: '101', user_id: '8',
      start_time: '2026-02-01T00:00:00.000Z', end_time: '2026-02-02T00:00:00.000Z'
    }]
  ]);
  const capturedQueries = [];
  let nextScheduleId = 102;
  let nextAssignmentId = 202;
  let snapshot;
  let failScheduleInsert = false;
  let scheduleInsertCode = '08006';
  let failAssignmentConstraint = false;
  let failCommit = false;

  const cloneMap = (map) => new Map([...map].map(([id, record]) => [id, { ...record }]));

  function scheduleInScope(schedule, sql, values) {
    if (sql.includes('AND FALSE')) return false;
    const match = sql.match(/s\.team_id = \$(\d+)/);
    return !match || schedule.team_id === String(values[Number(match[1]) - 1]);
  }

  function timestampMicros(value) {
    const fraction = value.match(/\.(\d{1,6})(?=Z|[+-]\d{2}:\d{2}$)/)?.[1] || '';
    return BigInt(Date.parse(value)) * 1000n +
      BigInt(fraction.padEnd(6, '0').slice(3, 6) || '0');
  }

  function runQuery(sql, values = []) {
    capturedQueries.push({ sql, values });
    if (sql.startsWith('SELECT') && sql.includes('FROM app_user') && sql.includes('FOR SHARE')) {
      const user = users.get(String(values[0]));
      const eligible = user && user.is_active && user.team_id === String(values[1]);
      const rows = eligible ? [{ user_id: String(values[0]) }] : [];
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('FROM app_user')) {
      const user = users.get(String(values[0]));
      return { rows: user ? [{ user_id: String(values[0]), ...user }] : [], rowCount: user ? 1 : 0 };
    }
    if (sql.includes('FROM team WHERE')) {
      const row = teams.has(String(values[0])) ? [{ team_id: String(values[0]) }] : [];
      return { rows: row, rowCount: row.length };
    }
    if (sql.startsWith('SELECT') && sql.includes('FROM on_call_schedule s')) {
      let rows = [...schedules.values()].filter((schedule) => scheduleInScope(schedule, sql, values));
      const idMatch = sql.match(/s\.schedule_id = \$(\d+)/);
      if (idMatch) {
        const id = String(values[Number(idMatch[1]) - 1]);
        rows = rows.filter((schedule) => schedule.schedule_id === id);
      }
      if (sql.includes('ORDER BY s.start_date DESC')) {
        rows.sort((left, right) =>
          right.start_date.localeCompare(left.start_date) ||
          left.schedule_id.localeCompare(right.schedule_id)
        );
      }
      return { rows: rows.map((row) => ({ ...row })), rowCount: rows.length };
    }
    if (sql.startsWith('SELECT') && sql.includes('FROM on_call_assignment oa')) {
      let rows = [...assignments.values()].filter((row) =>
        row.schedule_id === String(values[0]) &&
        row.assignment_id === String(values[1])
      );
      rows = rows.filter((assignment) => {
        const schedule = schedules.get(assignment.schedule_id);
        return schedule && scheduleInScope(schedule, sql, values);
      });
      return { rows: rows.map((row) => ({ ...row })), rowCount: rows.length };
    }
    if (sql.startsWith('SELECT') && sql.includes('FROM on_call_assignment')) {
      if (/assignment_id = \$2/.test(sql)) {
        const assignment = assignments.get(String(values[1]));
        const rows = assignment && assignment.schedule_id === String(values[0])
          ? [{ assignment_id: assignment.assignment_id, user_id: assignment.user_id }]
          : [];
        return { rows, rowCount: rows.length };
      }
      const rows = [...assignments.values()]
        .filter((assignment) => assignment.schedule_id === String(values[0]))
        .sort((a, b) => a.start_time.localeCompare(b.start_time));
      return { rows: rows.map((row) => ({ ...row })), rowCount: rows.length };
    }
    if (sql.startsWith('INSERT INTO on_call_schedule')) {
      if (failScheduleInsert) {
        failScheduleInsert = false;
        throw Object.assign(new Error('schedule insert error'), { code: scheduleInsertCode });
      }
      const [teamId, name, rotationType, startDate, endDate] = values;
      if (!teams.has(String(teamId))) throw Object.assign(new Error('missing team'), { code: '23503' });
      const schedule = {
        schedule_id: String(nextScheduleId++), team_id: String(teamId), name, rotation_type: rotationType,
        start_date: startDate, end_date: endDate
      };
      schedules.set(schedule.schedule_id, schedule);
      return { rows: [{ ...schedule }], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE on_call_schedule')) {
      const id = String(values[values.length - 1]);
      const current = schedules.get(id);
      if (!current) return { rows: [], rowCount: 0 };
      const updated = { ...current };
      const columnFields = {
        team_id: 'team_id', name: 'name', rotation_type: 'rotation_type',
        start_date: 'start_date', end_date: 'end_date'
      };
      for (const [, column, parameter] of sql.matchAll(/(\w+) = \$(\d+)/g)) {
        if (columnFields[column]) updated[column] = values[Number(parameter) - 1];
      }
      if (!teams.has(String(updated.team_id))) throw Object.assign(new Error('missing team'), { code: '23503' });
      if (updated.end_date && updated.end_date < updated.start_date) {
        throw Object.assign(new Error('schedule date check'), { code: '23514' });
      }
      schedules.set(id, updated);
      return { rows: [{ ...updated }], rowCount: 1 };
    }
    if (sql.startsWith('DELETE FROM on_call_schedule')) {
      const id = String(values[0]);
      const schedule = schedules.get(id);
      if (!schedule) return { rows: [], rowCount: 0 };
      schedules.delete(id);
      for (const [assignmentId, assignment] of assignments) {
        if (assignment.schedule_id === id) assignments.delete(assignmentId);
      }
      return { rows: [{ schedule_id: id }], rowCount: 1 };
    }
    if (sql.startsWith('SELECT assignment_id FROM on_call_assignment')) {
      const rows = [...assignments.values()]
        .filter((assignment) => assignment.schedule_id === String(values[0]))
        .slice(0, 1)
        .map(({ assignment_id }) => ({ assignment_id }));
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith('INSERT INTO on_call_assignment')) {
      if (failAssignmentConstraint) {
        failAssignmentConstraint = false;
        throw Object.assign(new Error('assignment time constraint'), { code: '23514' });
      }
      const [scheduleId, userId, startTime, endTime] = values;
      if (!schedules.has(String(scheduleId)) || !users.has(String(userId))) {
        throw Object.assign(new Error('foreign key violation'), { code: '23503' });
      }
      if (timestampMicros(endTime) <= timestampMicros(startTime)) {
        throw Object.assign(new Error('time check'), { code: '23514' });
      }
      const assignment = {
        assignment_id: String(nextAssignmentId++), schedule_id: String(scheduleId),
        user_id: String(userId), start_time: startTime, end_time: endTime
      };
      assignments.set(assignment.assignment_id, assignment);
      return { rows: [{ ...assignment }], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE on_call_assignment')) {
      const scheduleId = String(values[values.length - 2]);
      const assignmentId = String(values[values.length - 1]);
      const current = assignments.get(assignmentId);
      if (!current || current.schedule_id !== scheduleId) return { rows: [], rowCount: 0 };
      const updated = { ...current };
      const mapping = { user_id: 'user_id', start_time: 'start_time', end_time: 'end_time' };
      for (const [, column, parameter] of sql.matchAll(/(\w+) = \$(\d+)/g)) {
        if (mapping[column]) updated[column] = values[Number(parameter) - 1];
      }
      if (timestampMicros(updated.end_time) <= timestampMicros(updated.start_time)) {
        throw Object.assign(new Error('time check'), { code: '23514' });
      }
      assignments.set(assignmentId, updated);
      return { rows: [{ ...updated }], rowCount: 1 };
    }
    if (sql.startsWith('DELETE FROM on_call_assignment')) {
      const assignment = assignments.get(String(values[1]));
      if (!assignment || assignment.schedule_id !== String(values[0])) return { rows: [], rowCount: 0 };
      assignments.delete(assignment.assignment_id);
      return { rows: [{ assignment_id: assignment.assignment_id }], rowCount: 1 };
    }
    throw new Error(`Unexpected on-call test SQL: ${sql}`);
  }

  pgPool.query = async (sql, values = []) => runQuery(sql, values);
  pgPool.connect = async () => ({
    async query(sql, values = []) {
      capturedQueries.push({ sql, values });
      if (sql === 'BEGIN') {
        snapshot = { schedules: cloneMap(schedules), assignments: cloneMap(assignments) };
        return { rows: [], rowCount: 0 };
      }
      if (sql === 'COMMIT') {
        if (failCommit) {
          failCommit = false;
          throw Object.assign(new Error('commit error'), { code: '08006' });
        }
        snapshot = null;
        return { rows: [], rowCount: 0 };
      }
      if (sql === 'ROLLBACK') {
        if (snapshot) {
          schedules.clear();
          assignments.clear();
          for (const [id, row] of snapshot.schedules) schedules.set(id, row);
          for (const [id, row] of snapshot.assignments) assignments.set(id, row);
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

  const base = `http://127.0.0.1:${server.address().port}/api/on-call-schedules`;
  const tokens = Object.fromEntries([...users].map(([id, user]) => [
    id,
    createAccessToken({ user_id: id, role: user.role, team_id: user.team_id })
  ]));
  const request = async (path, userId, options = {}) => {
    const response = await fetch(`${base}${path}`, {
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
  const validSchedule = {
    name: 'Night shift',
    rotationType: 'weekly',
    startDate: '2026-05-01'
  };
  const validAssignment = {
    userId: 3,
    startTime: '2026-05-01T00:00:00Z',
    endTime: '2026-05-02T00:00:00Z'
  };

  assert.equal((await fetch(base)).status, 401);
  assert.deepEqual((await request('', '2')).body.data.map((row) => row.schedule_id), ['100']);
  assert.equal((await request('/101', '2')).status, 404);
  assert.equal((await request('/101', '3')).status, 404);
  assert.equal((await request('/100', '3')).status, 200);
  assert.deepEqual((await request('', '1')).body.data.map((row) => row.schedule_id), ['101', '100']);
  assert.equal((await request('', '5')).status, 403);
  assert.deepEqual((await request('', '6')).body.data, []);
  assert.equal((await request('/100', '6')).status, 404);
  assert.equal((await request('/bad', '1')).status, 400);

  assert.equal((await send('', '3', 'POST', { ...validSchedule, teamId: 7 })).status, 403);
  assert.equal((await send('', '5', 'POST', validSchedule)).status, 403);
  assert.equal((await send('', '1', 'POST', validSchedule)).status, 400);
  assert.equal((await send('', '1', 'POST', { ...validSchedule, teamId: 999 })).status, 400);
  const createdSchedule = await send('', '2', 'POST', validSchedule);
  assert.equal(createdSchedule.status, 201);
  const newScheduleId = String(createdSchedule.body.data.schedule_id);
  assert.equal(String(createdSchedule.body.data.team_id), '7');
  assert.equal(createdSchedule.body.data.name, validSchedule.name);
  assert.deepEqual(schedules.get(newScheduleId), createdSchedule.body.data);
  assert.deepEqual((await request(`/${newScheduleId}`, '2')).body.data, createdSchedule.body.data);
  assert.ok((await request('', '2')).body.data.some((row) => row.schedule_id === newScheduleId));
  assert.equal((await send('', '2', 'POST', { rotationType: 'weekly', startDate: '2026-05-01' })).status, 400);
  assert.equal((await send('', '2', 'POST', { name: 'Missing rotation', startDate: '2026-05-01' })).status, 400);
  assert.equal((await send('', '2', 'POST', { name: 'Missing start', rotationType: 'weekly' })).status, 400);
  const adminSchedule = await send('', '1', 'POST', { ...validSchedule, teamId: 8 });
  assert.equal(adminSchedule.status, 201);
  const adminScheduleId = String(adminSchedule.body.data.schedule_id);
  assert.equal((await send(`/${adminScheduleId}`, '1', 'PATCH', { teamId: 7 })).status, 200);
  assert.equal((await request(`/${adminScheduleId}`, '1', { method: 'DELETE' })).status, 204);
  assert.equal((await send('/100', '1', 'PATCH', { teamId: 8 })).status, 409);
  assert.equal((await send('', '1', 'POST', { ...validSchedule, teamId: 7, endDate: '2026-04-30' })).status, 400);
  assert.equal((await send('', '1', 'POST', { ...validSchedule, teamId: 7, startDate: '2026-02-30' })).status, 400);
  assert.equal((await send('', '1', 'POST', { ...validSchedule, teamId: 7, extra: true })).status, 400);
  assert.equal((await send('', '1', 'POST', { ...validSchedule, teamId: 7, name: 'x'.repeat(151) })).status, 400);
  assert.equal((await send('/999', '1', 'PATCH', { name: 'missing' })).status, 404);
  assert.equal((await send('/bad', '1', 'PATCH', { name: 'bad id' })).status, 400);
  assert.equal((await send('/100', '4', 'PATCH', { name: 'outside' })).status, 404);
  assert.equal((await send('/100', '3', 'PATCH', { name: 'engineer' })).status, 403);
  assert.equal((await send(`/${newScheduleId}`, '2', 'PATCH', { name: 'Updated shift' })).status, 200);
  assert.equal((await send(`/${newScheduleId}`, '2', 'PATCH', { teamId: 7 })).status, 403);

  assert.deepEqual((await request('/100/assignments', '2')).body.data.map((row) => row.assignment_id), ['200']);
  assert.equal((await request('/100/assignments/200', '3')).status, 200);
  assert.equal((await request('/101/assignments/201', '2')).status, 404);
  assert.equal((await request('/100/assignments/201', '1')).status, 404);
  assert.equal((await request('/101/assignments/201', '3')).status, 404);
  assert.equal((await request('/999/assignments', '1')).status, 404);
  assert.equal((await request('/bad/assignments', '1')).status, 400);
  assert.equal((await request('/100/assignments/bad', '1')).status, 400);
  assert.equal((await request('/100/assignments', '6')).status, 404);
  assert.equal((await request('/100/assignments/200', '6')).status, 404);
  assert.equal((await send('/100/assignments', '3', 'POST', validAssignment)).status, 403);
  assert.equal((await send('/101/assignments', '2', 'POST', { ...validAssignment, userId: 8 })).status, 404);
  assert.equal((await send('/100/assignments', '2', 'POST', { ...validAssignment, userId: 8 })).status, 400);
  assert.equal((await send('/100/assignments', '1', 'POST', { ...validAssignment, userId: 7 })).status, 400);
  assert.equal((await send('/100/assignments', '2', 'POST', { ...validAssignment, userId: 999 })).status, 400);
  assert.equal((await send('/100/assignments', '2', 'POST', {})).status, 400);
  assert.equal((await send('/100/assignments', '2', 'POST', {
    userId: 3, startTime: validAssignment.startTime
  })).status, 400);
  assert.equal((await send('/100/assignments', '2', 'POST', {
    userId: 3, endTime: validAssignment.endTime
  })).status, 400);
  assert.equal((await send('/bad/assignments', '2', 'POST', validAssignment)).status, 400);
  assert.equal((await send('/100/assignments', '2', 'POST', { ...validAssignment, extra: true })).status, 400);
  assert.equal((await send('/100/assignments', '2', 'POST', {
    ...validAssignment, endTime: validAssignment.startTime
  })).status, 400);
  assert.equal((await send('/100/assignments', '2', 'POST', {
    ...validAssignment, endTime: '2026-04-30T23:59:59Z'
  })).status, 400);
  const subMillisecondAssignment = await send('/100/assignments', '2', 'POST', {
    ...validAssignment,
    startTime: '2026-05-01T00:00:00.000000Z',
    endTime: '2026-05-01T00:00:00.000001Z'
  });
  assert.equal(subMillisecondAssignment.status, 201);
  const subMillisecondAssignmentId = String(subMillisecondAssignment.body.data.assignment_id);
  assert.equal((await send('/100/assignments', '2', 'POST', {
    ...validAssignment, startTime: '2026-02-30T00:00:00Z'
  })).status, 400);
  assert.equal((await send('/100/assignments', '2', 'POST', {
    ...validAssignment, startTime: '2026-05-01T00:00:00'
  })).status, 400);
  const createdAssignment = await send('/100/assignments', '2', 'POST', validAssignment);
  assert.equal(createdAssignment.status, 201);
  const newAssignmentId = String(createdAssignment.body.data.assignment_id);
  assert.deepEqual(assignments.get(newAssignmentId), createdAssignment.body.data);
  assert.deepEqual(
    (await request(`/100/assignments/${newAssignmentId}`, '2')).body.data,
    createdAssignment.body.data
  );
  assert.ok((await request('/100/assignments', '2')).body.data.some(
    (assignment) => assignment.assignment_id === newAssignmentId
  ));
  const overlappingAssignment = await send('/100/assignments', '2', 'POST', validAssignment);
  assert.equal(overlappingAssignment.status, 201);
  assert.deepEqual(assignments.get(String(overlappingAssignment.body.data.assignment_id)), overlappingAssignment.body.data);
  assert.equal((await send(`/100/assignments/${newAssignmentId}`, '2', 'PATCH', {
    endTime: '2026-05-03T00:00:00Z'
  })).status, 200);
  assert.equal((await send(`/100/assignments/${newAssignmentId}`, '2', 'PATCH', {
    userId: 8
  })).status, 400);
  assert.equal((await send(`/100/assignments/${newAssignmentId}`, '2', 'PATCH', {
    endTime: '2026-05-01T00:00:00Z'
  })).status, 400);
  assert.equal((await send('/100/assignments/999', '2', 'PATCH', {
    endTime: '2026-05-03T00:00:00Z'
  })).status, 404);
  assert.equal((await send('/100/assignments/200', '3', 'PATCH', {
    endTime: '2026-05-03T00:00:00Z'
  })).status, 403);
  assert.equal((await request('/100/assignments/201', '2', { method: 'DELETE' })).status, 404);
  assert.equal(assignments.has('201'), true);
  assert.equal((await request(`/100/assignments/${subMillisecondAssignmentId}`, '2', { method: 'DELETE' })).status, 204);
  const adminAssignment = await send('/101/assignments', '1', 'POST', {
    ...validAssignment,
    userId: 8
  });
  assert.equal(adminAssignment.status, 201);
  assert.equal(
    (await request(`/101/assignments/${adminAssignment.body.data.assignment_id}`, '1', {
      method: 'DELETE'
    })).status,
    204
  );

  failAssignmentConstraint = true;
  const assignmentCount = assignments.size;
  assert.equal((await send('/100/assignments', '2', 'POST', validAssignment)).status, 400);
  assert.equal(assignments.size, assignmentCount);
  assert.ok(capturedQueries.some(({ sql }) => sql === 'ROLLBACK'));

  failScheduleInsert = true;
  assert.equal((await send('', '1', 'POST', { ...validSchedule, teamId: 7 })).status, 500);
  scheduleInsertCode = '23514';
  failScheduleInsert = true;
  assert.equal((await send('', '1', 'POST', { ...validSchedule, teamId: 7 })).status, 400);
  scheduleInsertCode = '08006';

  failCommit = true;
  const oldEndTime = assignments.get(newAssignmentId).end_time;
  assert.equal((await send(`/100/assignments/${newAssignmentId}`, '2', 'PATCH', {
    endTime: '2026-05-04T00:00:00Z'
  })).status, 500);
  assert.equal(assignments.get(newAssignmentId).end_time, oldEndTime);
  assert.ok(capturedQueries.some(({ sql }) => sql === 'ROLLBACK'));

  assert.equal((await request('/100/assignments/200', '1', { method: 'DELETE' })).status, 204);
  assert.equal(assignments.has('200'), false);
  assert.equal((await request('/100', '1', { method: 'DELETE' })).status, 204);
  assert.equal(schedules.has('100'), false);
  assert.equal(assignments.has('200'), false);
  assert.equal(await request(`/${newScheduleId}`, '1', { method: 'DELETE' }).then((result) => result.status), 204);
  assert.equal(schedules.has(newScheduleId), false);

  assert.ok(capturedQueries.every(({ sql }) =>
    !/INSERT INTO on_call_(?:schedule|assignment)/.test(sql) ||
    /\$[1-9]/.test(sql)
  ));
});
