import bcrypt from 'bcryptjs';
import { pgPool } from '../config/postgres.js';
import { HttpError } from '../utils/httpError.js';

const USER_COLUMNS = 'user_id, team_id, name, email, role, is_active, created_at';
const BCRYPT_ROUNDS = 12;

function mapDatabaseError(error) {
  if (error.code === '23505') {
    return new HttpError(409, 'A user with this email address already exists.');
  }
  if (error.code === '23503') {
    return new HttpError(400, 'The specified team does not exist.');
  }
  return error;
}

export async function listUsers({ teamId = null } = {}) {
  const result = teamId === null
    ? await pgPool.query(`SELECT ${USER_COLUMNS} FROM app_user ORDER BY name, user_id`)
    : await pgPool.query(
      `SELECT ${USER_COLUMNS} FROM app_user WHERE team_id = $1 ORDER BY name, user_id`,
      [teamId]
    );
  return result.rows;
}

export async function getUser(userId) {
  const result = await pgPool.query(
    `SELECT ${USER_COLUMNS} FROM app_user WHERE user_id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

export async function createUser({ name, email, password, role, teamId }) {
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  try {
    const duplicate = await pgPool.query(
      'SELECT 1 FROM app_user WHERE LOWER(email) = $1 LIMIT 1',
      [email]
    );
    if (duplicate.rowCount > 0) {
      throw new HttpError(409, 'A user with this email address already exists.');
    }

    const result = await pgPool.query(
      `INSERT INTO app_user (name, email, password_hash, role, team_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${USER_COLUMNS}`,
      [name, email, passwordHash, role, teamId]
    );
    return result.rows[0];
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

export async function updateUser(userId, fields) {
  const updates = [];
  const values = [];

  if (Object.hasOwn(fields, 'name')) {
    values.push(fields.name);
    updates.push(`name = $${values.length}`);
  }
  if (Object.hasOwn(fields, 'email')) {
    const duplicate = await pgPool.query(
      'SELECT 1 FROM app_user WHERE LOWER(email) = $1 AND user_id <> $2 LIMIT 1',
      [fields.email, userId]
    );
    if (duplicate.rowCount > 0) {
      throw new HttpError(409, 'A user with this email address already exists.');
    }
    values.push(fields.email);
    updates.push(`email = $${values.length}`);
  }
  if (Object.hasOwn(fields, 'teamId')) {
    values.push(fields.teamId);
    updates.push(`team_id = $${values.length}`);
  }
  if (Object.hasOwn(fields, 'role')) {
    values.push(fields.role);
    updates.push(`role = $${values.length}`);
  }
  if (Object.hasOwn(fields, 'isActive')) {
    values.push(fields.isActive);
    updates.push(`is_active = $${values.length}`);
  }
  if (Object.hasOwn(fields, 'password')) {
    values.push(await bcrypt.hash(fields.password, BCRYPT_ROUNDS));
    updates.push(`password_hash = $${values.length}`);
  }

  values.push(userId);

  try {
    const result = await pgPool.query(
      `UPDATE app_user
       SET ${updates.join(', ')}
       WHERE user_id = $${values.length}
       RETURNING ${USER_COLUMNS}`,
      values
    );
    return result.rows[0] || null;
  } catch (error) {
    throw mapDatabaseError(error);
  }
}

export async function assertTeamExists(teamId) {
  if (teamId === null || teamId === undefined) return;

  const result = await pgPool.query(
    'SELECT team_id FROM team WHERE team_id = $1',
    [teamId]
  );
  if (result.rowCount === 0) {
    throw new HttpError(400, 'The specified team does not exist.');
  }
}

export async function bootstrapInitialAdmin({ name, email, password }) {
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [8421, 20261025]);

    const existingUsers = await client.query('SELECT 1 FROM app_user LIMIT 1');
    if (existingUsers.rowCount > 0) {
      throw new HttpError(409, 'Admin bootstrap is only allowed when no users exist.');
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const result = await client.query(
      `INSERT INTO app_user (name, email, password_hash, role, team_id)
       VALUES ($1, $2, $3, 'admin', NULL)
       RETURNING ${USER_COLUMNS}`,
      [name, email, passwordHash]
    );
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[Admin bootstrap] Transaction rollback failed:', rollbackError.message);
    }
    throw mapDatabaseError(error);
  } finally {
    client.release();
  }
}
