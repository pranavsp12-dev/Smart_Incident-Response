import { pgPool } from '../config/postgres.js';
import { HttpError } from '../utils/httpError.js';

const SERVICE_COLUMNS =
  'service_id, team_id, name, description, criticality, is_active, created_at';

function mapDatabaseError(error) {
  if (error.code === '23505') {
    return new HttpError(409, 'A service with this name already exists.');
  }
  if (error.code === '23503') {
    return new HttpError(400, 'The specified team does not exist.');
  }
  if (error.code === '23514') {
    return new HttpError(400, 'The service violates a database constraint.');
  }
  return error;
}

export async function listServices({ teamId, includeInactive = false } = {}) {
  const conditions = [];
  const values = [];

  if (teamId !== undefined) {
    values.push(teamId);
    conditions.push(`team_id = $${values.length}`);
  }
  if (!includeInactive) {
    conditions.push('is_active = TRUE');
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await pgPool.query(
    `SELECT ${SERVICE_COLUMNS}
     FROM service
     ${where}
     ORDER BY name, service_id`,
    values
  );
  return result.rows;
}

export async function getService(serviceId, { teamId, includeInactive = false } = {}) {
  const conditions = [`service_id = $1`];
  const values = [serviceId];

  if (teamId !== undefined) {
    values.push(teamId);
    conditions.push(`team_id = $${values.length}`);
  }
  if (!includeInactive) {
    conditions.push('is_active = TRUE');
  }

  const result = await pgPool.query(
    `SELECT ${SERVICE_COLUMNS}
     FROM service
     WHERE ${conditions.join(' AND ')}`,
    values
  );
  return result.rows[0] || null;
}

export async function createService({ name, description, criticality, teamId }) {
  try {
    const result = await pgPool.query(
      `INSERT INTO service (name, description, criticality, team_id)
       VALUES ($1, $2, $3, $4)
       RETURNING ${SERVICE_COLUMNS}`,
      [name, description, criticality, teamId]
    );
    return result.rows[0];
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

export async function updateService(serviceId, fields, { teamId } = {}) {
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
  if (Object.hasOwn(fields, 'criticality')) {
    values.push(fields.criticality);
    updates.push(`criticality = $${values.length}`);
  }
  if (Object.hasOwn(fields, 'teamId')) {
    values.push(fields.teamId);
    updates.push(`team_id = $${values.length}`);
  }

  values.push(serviceId);
  const idParameter = values.length;
  const conditions = [`service_id = $${idParameter}`];
  if (teamId !== undefined) {
    values.push(teamId);
    conditions.push(`team_id = $${values.length}`);
  }

  try {
    const result = await pgPool.query(
      `UPDATE service
       SET ${updates.join(', ')}
       WHERE ${conditions.join(' AND ')}
       RETURNING ${SERVICE_COLUMNS}`,
      values
    );
    return result.rows[0] || null;
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

export async function deactivateService(serviceId, { teamId } = {}) {
  const values = [serviceId];
  const conditions = ['service_id = $1', 'is_active = TRUE'];
  if (teamId !== undefined) {
    values.push(teamId);
    conditions.push(`team_id = $${values.length}`);
  }

  try {
    const result = await pgPool.query(
      `UPDATE service
       SET is_active = FALSE
       WHERE ${conditions.join(' AND ')}
       RETURNING ${SERVICE_COLUMNS}`,
      values
    );
    return result.rows[0] || null;
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

export async function assertTeamExists(teamId) {
  if (teamId === null) return;

  const result = await pgPool.query(
    'SELECT team_id FROM team WHERE team_id = $1',
    [teamId]
  );
  if (result.rowCount === 0) {
    throw new HttpError(400, 'The specified team does not exist.');
  }
}

export { mapDatabaseError };
