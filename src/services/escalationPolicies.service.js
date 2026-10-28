import { pgPool } from '../config/postgres.js';
import { HttpError } from '../utils/httpError.js';

const POLICY_COLUMNS =
  'policy_id, team_id, name, description, is_active';
const LEVEL_COLUMNS =
  'level_id, policy_id, level_number, target_type, target_id, wait_minutes';

function mapPolicyError(error) {
  if (error.code === '23505') {
    return new HttpError(409, 'The requested escalation policy or level conflicts with an existing record.');
  }
  if (error.code === '23503') {
    return new HttpError(400, 'The specified team or policy does not exist.');
  }
  if (error.code === '23514') {
    return new HttpError(400, 'The escalation policy or level violates a database constraint.');
  }
  if (error.code === '22P02') {
    return new HttpError(400, 'An escalation policy or level field has an invalid format.');
  }
  return error;
}

function assertManagerHasTeam(actor) {
  if (actor.role === 'manager' && actor.teamId === null) {
    throw new HttpError(403, 'Managers must belong to a team to access escalation policies.');
  }
}

function scopeForPolicy(actor, parameterIndex) {
  if (actor.role === 'admin') return { sql: '', values: [] };
  if (actor.teamId === null) return { sql: 'AND FALSE', values: [] };
  return {
    sql: `AND ep.team_id = $${parameterIndex}${actor.role === 'engineer' ? ' AND ep.is_active = TRUE' : ''}`,
    values: [actor.teamId]
  };
}

export async function listEscalationPolicies(actor) {
  assertManagerHasTeam(actor);
  const scope = scopeForPolicy(actor, 1);
  const result = await pgPool.query(
    `SELECT ep.${POLICY_COLUMNS.split(', ').join(', ep.')}
     FROM escalation_policy ep
     WHERE TRUE ${scope.sql}
     ORDER BY ep.name, ep.policy_id`,
    scope.values
  );
  return result.rows;
}

export async function getEscalationPolicy(policyId, actor, client = pgPool, forUpdate = false) {
  assertManagerHasTeam(actor);
  const scope = scopeForPolicy(actor, 2);
  const result = await client.query(
    `SELECT ep.${POLICY_COLUMNS.split(', ').join(', ep.')}
     FROM escalation_policy ep
     WHERE ep.policy_id = $1 ${scope.sql}
     ${forUpdate ? 'FOR UPDATE OF ep' : ''}`,
    [policyId, ...scope.values]
  );
  return result.rows[0] || null;
}

export async function createEscalationPolicy(fields) {
  try {
    const result = await pgPool.query(
      `INSERT INTO escalation_policy (team_id, name, description, is_active)
       VALUES ($1, $2, $3, $4)
       RETURNING ${POLICY_COLUMNS}`,
      [fields.teamId, fields.name, fields.description, fields.isActive]
    );
    return result.rows[0];
  } catch (error) {
    throw mapPolicyError(error);
  }
}

export async function updateEscalationPolicy(policyId, fields, actor) {
  const updates = [];
  const values = [];
  for (const [field, column] of [
    ['name', 'name'],
    ['description', 'description'],
    ['isActive', 'is_active'],
    ['teamId', 'team_id']
  ]) {
    if (Object.hasOwn(fields, field)) {
      values.push(fields[field]);
      updates.push(`${column} = $${values.length}`);
    }
  }

  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    const existing = await getEscalationPolicy(policyId, actor, client, true);
    if (!existing) throw new HttpError(404, 'Escalation policy not found.');
    values.push(policyId);
    const result = await client.query(
      `UPDATE escalation_policy
       SET ${updates.join(', ')}
       WHERE policy_id = $${values.length}
       RETURNING ${POLICY_COLUMNS}`,
      values
    );
    if (!result.rows[0]) throw new HttpError(404, 'Escalation policy not found.');
    await client.query('COMMIT');
    return result.rows[0] || null;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[Escalation policies] PostgreSQL rollback failed:', rollbackError.message);
    }
    throw mapPolicyError(error);
  } finally {
    client.release();
  }
}

export async function deleteEscalationPolicy(policyId, actor) {
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    const existing = await getEscalationPolicy(policyId, actor, client, true);
    if (!existing) throw new HttpError(404, 'Escalation policy not found.');
    await client.query(
      'DELETE FROM escalation_policy WHERE policy_id = $1',
      [policyId]
    );
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[Escalation policies] PostgreSQL rollback failed:', rollbackError.message);
    }
    throw mapPolicyError(error);
  } finally {
    client.release();
  }
}

export async function listEscalationLevels(policyId, actor) {
  assertManagerHasTeam(actor);
  const policy = await getEscalationPolicy(policyId, actor);
  if (!policy) throw new HttpError(404, 'Escalation policy not found.');
  const scope = scopeForPolicy(actor, 2);
  const result = await pgPool.query(
    `SELECT el.${LEVEL_COLUMNS.split(', ').join(', el.')}
     FROM escalation_level el
     JOIN escalation_policy ep ON ep.policy_id = el.policy_id
     WHERE ep.policy_id = $1 ${scope.sql}
     ORDER BY el.level_number, el.level_id`,
    [policyId, ...scope.values]
  );
  return result.rows;
}

export async function getEscalationLevel(policyId, levelId, actor) {
  assertManagerHasTeam(actor);
  const scope = scopeForPolicy(actor, 3);
  const result = await pgPool.query(
    `SELECT el.${LEVEL_COLUMNS.split(', ').join(', el.')}
     FROM escalation_level el
     JOIN escalation_policy ep ON ep.policy_id = el.policy_id
     WHERE el.policy_id = $1 AND el.level_id = $2 ${scope.sql}`,
    [policyId, levelId, ...scope.values]
  );
  return result.rows[0] || null;
}

async function lockPolicy(policyId, actor, client) {
  const policy = await getEscalationPolicy(policyId, actor, client, true);
  if (!policy) throw new HttpError(404, 'Escalation policy not found.');
  return policy;
}

async function validateEscalationTarget(policy, targetType, targetId, client) {
  if (targetType === 'user') {
    const result = await client.query(
      `SELECT user_id
       FROM app_user
       WHERE user_id = $1 AND team_id = $2 AND is_active = TRUE
       FOR SHARE`,
      [targetId, policy.team_id]
    );
    if (!result.rows[0]) {
      throw new HttpError(400, 'A user escalation target must be active and belong to the policy team.');
    }
    return;
  }

  if (targetType === 'team') {
    if (String(targetId) !== String(policy.team_id)) {
      throw new HttpError(400, 'A team escalation target must match the policy team.');
    }
    return;
  }

  throw new HttpError(400, 'targetType must be user or team.');
}

export async function createEscalationLevel(policyId, fields, actor) {
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    const policy = await lockPolicy(policyId, actor, client);
    await validateEscalationTarget(policy, fields.targetType, fields.targetId, client);
    const result = await client.query(
      `INSERT INTO escalation_level (
         policy_id, level_number, target_type, target_id, wait_minutes
       )
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${LEVEL_COLUMNS}`,
      [policyId, fields.levelNumber, fields.targetType, fields.targetId, fields.waitMinutes]
    );
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[Escalation policies] PostgreSQL rollback failed:', rollbackError.message);
    }
    throw mapPolicyError(error);
  } finally {
    client.release();
  }
}

export async function updateEscalationLevel(policyId, levelId, fields, actor) {
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    const policy = await lockPolicy(policyId, actor, client);
    const levelResult = await client.query(
      `SELECT ${LEVEL_COLUMNS}
       FROM escalation_level
       WHERE policy_id = $1 AND level_id = $2
       FOR UPDATE`,
      [policyId, levelId]
    );
    const existing = levelResult.rows[0];
    if (!existing) throw new HttpError(404, 'Escalation level not found.');
    await validateEscalationTarget(
      policy,
      fields.targetType ?? existing.target_type,
      fields.targetId ?? existing.target_id,
      client
    );

    const updates = [];
    const values = [];
    for (const [field, column] of [
      ['levelNumber', 'level_number'],
      ['targetType', 'target_type'],
      ['targetId', 'target_id'],
      ['waitMinutes', 'wait_minutes']
    ]) {
      if (Object.hasOwn(fields, field)) {
        values.push(fields[field]);
        updates.push(`${column} = $${values.length}`);
      }
    }
    values.push(policyId, levelId);
    const result = await client.query(
      `UPDATE escalation_level
       SET ${updates.join(', ')}
       WHERE policy_id = $${values.length - 1}
         AND level_id = $${values.length}
       RETURNING ${LEVEL_COLUMNS}`,
      values
    );
    if (!result.rows[0]) throw new HttpError(404, 'Escalation level not found.');
    await client.query('COMMIT');
    return result.rows[0] || null;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[Escalation policies] PostgreSQL rollback failed:', rollbackError.message);
    }
    throw mapPolicyError(error);
  } finally {
    client.release();
  }
}

export async function deleteEscalationLevel(policyId, levelId, actor) {
  const client = await pgPool.connect();
  try {
    await client.query('BEGIN');
    await lockPolicy(policyId, actor, client);
    const result = await client.query(
      `DELETE FROM escalation_level
       WHERE policy_id = $1 AND level_id = $2
       RETURNING level_id`,
      [policyId, levelId]
    );
    if (!result.rows[0]) throw new HttpError(404, 'Escalation level not found.');
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[Escalation policies] PostgreSQL rollback failed:', rollbackError.message);
    }
    throw mapPolicyError(error);
  } finally {
    client.release();
  }
}

export { mapPolicyError };
