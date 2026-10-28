import { pgPool } from '../config/postgres.js';
import { HttpError } from '../utils/httpError.js';

const ENVIRONMENT_COLUMNS = 'environment_id, name, description, created_at';

function mapDatabaseError(error) {
  if (error.code === '23505') {
    return new HttpError(409, 'An environment with this name already exists.');
  }
  if (error.code === '23514') {
    return new HttpError(400, 'The environment violates a database constraint.');
  }
  return error;
}

export async function listEnvironments() {
  const result = await pgPool.query(
    `SELECT ${ENVIRONMENT_COLUMNS}
     FROM environment
     ORDER BY name, environment_id`
  );
  return result.rows;
}

export async function getEnvironment(environmentId) {
  const result = await pgPool.query(
    `SELECT ${ENVIRONMENT_COLUMNS}
     FROM environment
     WHERE environment_id = $1`,
    [environmentId]
  );
  return result.rows[0] || null;
}

export async function createEnvironment({ name, description }) {
  try {
    const result = await pgPool.query(
      `INSERT INTO environment (name, description)
       VALUES ($1, $2)
       RETURNING ${ENVIRONMENT_COLUMNS}`,
      [name, description]
    );
    return result.rows[0];
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

export async function updateEnvironment(environmentId, fields) {
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

  values.push(environmentId);

  try {
    const result = await pgPool.query(
      `UPDATE environment
       SET ${updates.join(', ')}
       WHERE environment_id = $${values.length}
       RETURNING ${ENVIRONMENT_COLUMNS}`,
      values
    );
    return result.rows[0] || null;
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

export { mapDatabaseError };
