import { pgPool } from '../config/postgres.js';
import { HttpError } from '../utils/httpError.js';

const SCHEDULE_COLUMNS =
  'schedule_id, team_id, name, rotation_type, start_date, end_date';
const ASSIGNMENT_COLUMNS =
  'assignment_id, schedule_id, user_id, start_time, end_time';

function mapDatabaseError(error) {
  if (error.code === '23503') {
    return new HttpError(400, 'A referenced team, schedule, or user does not exist.');
  }
  if (error.code === '23514') {
    return new HttpError(400, 'The schedule or assignment violates a database constraint.');
  }
  if (['22P02', '22007', '22008', '22003'].includes(error.code)) {
    return new HttpError(400, 'A schedule or assignment field has an invalid format.');
  }
  return error;
}

function assertManagerHasTeam(actor) {
  if (actor.role === 'manager' && actor.teamId === null) {
    throw new HttpError(403, 'Managers must belong to a team to access on-call records.');
  }
}

function teamScope(actor, tableAlias = 's', parameterIndex = 1) {
  if (actor.role === 'admin') return { sql: '', values: [] };
  if (actor.teamId === null) return { sql: 'AND FALSE', values: [] };
  return {
    sql: `AND ${tableAlias}.team_id = $${parameterIndex}`,
    values: [actor.teamId]
  };
}

export async function listSchedules(actor) {
  assertManagerHasTeam(actor);
  const scope = teamScope(actor, 's', 1);
  const result = await pgPool.query(
    `SELECT s.${SCHEDULE_COLUMNS.split(', ').join(', s.')}
     FROM on_call_schedule s
     WHERE TRUE ${scope.sql}
     ORDER BY s.start_date DESC, s.schedule_id`,
    scope.values
  );
  return result.rows;
}

export async function getSchedule(scheduleId, actor, client = pgPool, forUpdate = false) {
  assertManagerHasTeam(actor);
  const scope = teamScope(actor, 's', 2);
  const result = await client.query(
    `SELECT s.${SCHEDULE_COLUMNS.split(', ').join(', s.')}
     FROM on_call_schedule s
     WHERE s.schedule_id = $1 ${scope.sql}
     ${forUpdate ? 'FOR UPDATE OF s' : ''}`,
    [scheduleId, ...scope.values]
  );
  return result.rows[0] || null;
}

export async function createSchedule(fields) {
  try {
    const result = await pgPool.query(
      `INSERT INTO on_call_schedule (team_id, name, rotation_type, start_date, end_date)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${SCHEDULE_COLUMNS}`,
      [fields.teamId, fields.name, fields.rotationType, fields.startDate, fields.endDate]
    );
    return result.rows[0];
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

export async function updateSchedule(scheduleId, fields, actor) {
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    const existing = await getSchedule(scheduleId, actor, client, true);
    if (!existing) throw new HttpError(404, 'On-call schedule not found.');

    if (fields.teamId !== undefined && String(fields.teamId) !== String(existing.team_id)) {
      const assignments = await client.query(
        'SELECT assignment_id FROM on_call_assignment WHERE schedule_id = $1 LIMIT 1',
        [scheduleId]
      );
      if (assignments.rowCount > 0) {
        throw new HttpError(409, 'A schedule with assignments cannot be moved to another team.');
      }
    }

    const updates = [];
    const values = [];
    for (const [field, column] of [
      ['teamId', 'team_id'],
      ['name', 'name'],
      ['rotationType', 'rotation_type'],
      ['startDate', 'start_date'],
      ['endDate', 'end_date']
    ]) {
      if (Object.hasOwn(fields, field)) {
        values.push(fields[field]);
        updates.push(`${column} = $${values.length}`);
      }
    }
    values.push(scheduleId);
    const result = await client.query(
      `UPDATE on_call_schedule
       SET ${updates.join(', ')}
       WHERE schedule_id = $${values.length}
       RETURNING ${SCHEDULE_COLUMNS}`,
      values
    );
    if (!result.rows[0]) throw new HttpError(404, 'On-call schedule not found.');
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[On-call schedules] PostgreSQL rollback failed:', rollbackError.message);
    }
    throw mapDatabaseError(error);
  } finally {
    client.release();
  }
}

export async function deleteSchedule(scheduleId, actor) {
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    const existing = await getSchedule(scheduleId, actor, client, true);
    if (!existing) throw new HttpError(404, 'On-call schedule not found.');
    const result = await client.query(
      'DELETE FROM on_call_schedule WHERE schedule_id = $1 RETURNING schedule_id',
      [scheduleId]
    );
    if (!result.rows[0]) throw new HttpError(404, 'On-call schedule not found.');
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[On-call schedules] PostgreSQL rollback failed:', rollbackError.message);
    }
    throw mapDatabaseError(error);
  } finally {
    client.release();
  }
}

export async function listScheduleAssignments(scheduleId, actor) {
  const schedule = await getSchedule(scheduleId, actor);
  if (!schedule) throw new HttpError(404, 'On-call schedule not found.');
  const result = await pgPool.query(
    `SELECT ${ASSIGNMENT_COLUMNS}
     FROM on_call_assignment
     WHERE schedule_id = $1
     ORDER BY start_time, assignment_id`,
    [scheduleId]
  );
  return result.rows;
}

export async function getScheduleAssignment(scheduleId, assignmentId, actor) {
  assertManagerHasTeam(actor);
  const scope = teamScope(actor, 's', 3);
  const result = await pgPool.query(
    `SELECT oa.${ASSIGNMENT_COLUMNS.split(', ').join(', oa.')}
     FROM on_call_assignment oa
     JOIN on_call_schedule s ON s.schedule_id = oa.schedule_id
     WHERE oa.schedule_id = $1 AND oa.assignment_id = $2 ${scope.sql}`,
    [scheduleId, assignmentId, ...scope.values]
  );
  return result.rows[0] || null;
}

async function lockSchedule(scheduleId, actor, client) {
  const schedule = await getSchedule(scheduleId, actor, client, true);
  if (!schedule) throw new HttpError(404, 'On-call schedule not found.');
  return schedule;
}

async function assertEligibleUser(userId, teamId, client) {
  const result = await client.query(
    `SELECT user_id
     FROM app_user
     WHERE user_id = $1 AND team_id = $2 AND is_active = TRUE
     FOR SHARE`,
    [userId, teamId]
  );
  if (!result.rows[0]) {
    throw new HttpError(400, 'The assigned user must be active and belong to the schedule team.');
  }
}

export async function createScheduleAssignment(scheduleId, fields, actor) {
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    const schedule = await lockSchedule(scheduleId, actor, client);
    await assertEligibleUser(fields.userId, schedule.team_id, client);
    const result = await client.query(
      `INSERT INTO on_call_assignment (schedule_id, user_id, start_time, end_time)
       VALUES ($1, $2, $3, $4)
       RETURNING ${ASSIGNMENT_COLUMNS}`,
      [scheduleId, fields.userId, fields.startTime, fields.endTime]
    );
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[On-call schedules] PostgreSQL rollback failed:', rollbackError.message);
    }
    throw mapDatabaseError(error);
  } finally {
    client.release();
  }
}

export async function updateScheduleAssignment(scheduleId, assignmentId, fields, actor) {
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    const schedule = await lockSchedule(scheduleId, actor, client);
    const existing = await client.query(
      `SELECT assignment_id, user_id
       FROM on_call_assignment
       WHERE schedule_id = $1 AND assignment_id = $2
       FOR UPDATE`,
      [scheduleId, assignmentId]
    );
    if (!existing.rows[0]) throw new HttpError(404, 'On-call assignment not found.');
    if (fields.userId !== undefined) {
      await assertEligibleUser(fields.userId, schedule.team_id, client);
    }

    const updates = [];
    const values = [];
    for (const [field, column] of [
      ['userId', 'user_id'],
      ['startTime', 'start_time'],
      ['endTime', 'end_time']
    ]) {
      if (Object.hasOwn(fields, field)) {
        values.push(fields[field]);
        updates.push(`${column} = $${values.length}`);
      }
    }
    values.push(scheduleId, assignmentId);
    const result = await client.query(
      `UPDATE on_call_assignment
       SET ${updates.join(', ')}
       WHERE schedule_id = $${values.length - 1}
         AND assignment_id = $${values.length}
       RETURNING ${ASSIGNMENT_COLUMNS}`,
      values
    );
    if (!result.rows[0]) throw new HttpError(404, 'On-call assignment not found.');
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[On-call schedules] PostgreSQL rollback failed:', rollbackError.message);
    }
    throw mapDatabaseError(error);
  } finally {
    client.release();
  }
}

export async function deleteScheduleAssignment(scheduleId, assignmentId, actor) {
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    await lockSchedule(scheduleId, actor, client);
    const result = await client.query(
      `DELETE FROM on_call_assignment
       WHERE schedule_id = $1 AND assignment_id = $2
       RETURNING assignment_id`,
      [scheduleId, assignmentId]
    );
    if (!result.rows[0]) throw new HttpError(404, 'On-call assignment not found.');
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[On-call schedules] PostgreSQL rollback failed:', rollbackError.message);
    }
    throw mapDatabaseError(error);
  } finally {
    client.release();
  }
}
