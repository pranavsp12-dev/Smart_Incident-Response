import { pgPool } from '../config/postgres.js';
import { HttpError } from '../utils/httpError.js';

const TEAM_COLUMNS = 'team_id, name, description, created_at';

function getReadScope(actor) {
  if (actor.role === 'admin') {
    return { isAdmin: true, teamId: null };
  }
  if (actor.role === 'manager' && actor.teamId === null) {
    throw new HttpError(403, 'Managers must belong to a team to access team records.');
  }
  return { isAdmin: false, teamId: actor.teamId };
}

function mapDatabaseError(error) {
  if (error.code === '23505') {
    return new HttpError(409, 'A team with this name already exists.');
  }
  if (error.code === '23503') {
    return new HttpError(409, 'This team is referenced by existing records and cannot be deleted.');
  }
  return error;
}

export async function listTeams(actor) {
  const scope = getReadScope(actor);
  if (scope.isAdmin) {
    const result = await pgPool.query(
      `SELECT ${TEAM_COLUMNS} FROM team ORDER BY name, team_id`
    );
    return result.rows;
  }

  const result = await pgPool.query(
    `SELECT ${TEAM_COLUMNS} FROM team WHERE team_id = $1 ORDER BY name, team_id`,
    [scope.teamId]
  );
  return result.rows;
}

export async function getTeam(teamId, actor) {
  const scope = getReadScope(actor);
  if (scope.isAdmin) {
    const result = await pgPool.query(
      `SELECT ${TEAM_COLUMNS} FROM team WHERE team_id = $1`,
      [teamId]
    );
    return result.rows[0] || null;
  }

  const result = await pgPool.query(
    `SELECT ${TEAM_COLUMNS} FROM team WHERE team_id = $1 AND team_id = $2`,
    [teamId, scope.teamId]
  );
  return result.rows[0] || null;
}

export async function createTeam({ name, description }) {
  try {
    const result = await pgPool.query(
      `INSERT INTO team (name, description)
       VALUES ($1, $2)
       RETURNING ${TEAM_COLUMNS}`,
      [name, description]
    );
    return result.rows[0];
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

export async function updateTeam(teamId, fields, { scopedTeamId } = {}) {
  const updates = [];
  const values = [];

  if (Object.hasOwn(fields, 'name')) {
    values.push(fields.name);
    updates.push(`name = $${values.length}`);
  }
  if (Object.hasOwn(fields, 'description')) {
    values.push(fields.description);
    updates.push(`description = $${values.length}`);
  }

  values.push(teamId);
  const conditions = [`team_id = $${values.length}`];
  if (scopedTeamId !== undefined) {
    values.push(scopedTeamId);
    conditions.push(`team_id = $${values.length}`);
  }

  try {
    const result = await pgPool.query(
      `UPDATE team
       SET ${updates.join(', ')}
       WHERE ${conditions.join(' AND ')}
       RETURNING ${TEAM_COLUMNS}`,
      values
    );
    return result.rows[0] || null;
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

export async function deleteTeam(teamId) {
  try {
    const result = await pgPool.query(
      'DELETE FROM team WHERE team_id = $1 RETURNING team_id',
      [teamId]
    );
    return result.rowCount > 0;
  } catch (error) {
    throw mapDatabaseError(error);
  }
}
