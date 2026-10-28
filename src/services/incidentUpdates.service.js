import { pgPool } from '../config/postgres.js';
import { recordIncidentEvent } from './incidents.service.js';
import { HttpError } from '../utils/httpError.js';

const UPDATE_COLUMNS = `
  iu.update_id, iu.incident_id, iu.user_id, iu.status, iu.message, iu.created_at`;

function scopedCondition(actor, parameterIndex) {
  if (actor.role === 'admin') return { sql: '', values: [] };
  if (actor.teamId === null) return { sql: 'AND FALSE', values: [] };
  return {
    sql: `AND s.team_id = $${parameterIndex}`,
    values: [actor.teamId]
  };
}

function mapDatabaseError(error) {
  if (error.code === '23503') {
    return new HttpError(400, 'The referenced incident or user does not exist.');
  }
  if (error.code === '22P02') {
    return new HttpError(400, 'An incident update field has an invalid format.');
  }
  return error;
}

async function compensateEvent(eventReference) {
  try {
    const result = await eventReference.db
      .collection('incident_events')
      .deleteOne({ _id: eventReference.eventId });
    if (result.deletedCount !== 1) {
      throw new Error('MongoDB incident update compensation did not remove one event.');
    }
  } catch (error) {
    console.error('[Incident updates] MongoDB event compensation failed:', error.code || error.name);
  }
}

export async function listIncidentUpdates(incidentId, actor) {
  if (actor.role === 'manager' && actor.teamId === null) {
    throw new HttpError(403, 'Managers must belong to a team to view incident updates.');
  }
  const scope = scopedCondition(actor, 2);
  const result = await pgPool.query(
    `SELECT ${UPDATE_COLUMNS}
     FROM incident_update iu
     JOIN incident i ON i.incident_id = iu.incident_id
     JOIN service s ON s.service_id = i.service_id
     WHERE iu.incident_id = $1 ${scope.sql}
     ORDER BY iu.created_at, iu.update_id`,
    [incidentId, ...scope.values]
  );
  if (result.rows.length === 0) {
    const incident = await pgPool.query(
      `SELECT i.incident_id
       FROM incident i
       JOIN service s ON s.service_id = i.service_id
       WHERE i.incident_id = $1 ${scope.sql}`,
      [incidentId, ...scope.values]
    );
    if (incident.rowCount === 0) throw new HttpError(404, 'Incident not found.');
  }
  return result.rows;
}

export async function getIncidentUpdate(incidentId, updateId, actor) {
  if (actor.role === 'manager' && actor.teamId === null) {
    throw new HttpError(403, 'Managers must belong to a team to view incident updates.');
  }
  const scope = scopedCondition(actor, 3);
  const result = await pgPool.query(
    `SELECT ${UPDATE_COLUMNS}
     FROM incident_update iu
     JOIN incident i ON i.incident_id = iu.incident_id
     JOIN service s ON s.service_id = i.service_id
     WHERE iu.incident_id = $1 AND iu.update_id = $2 ${scope.sql}`,
    [incidentId, updateId, ...scope.values]
  );
  return result.rows[0] || null;
}

export async function createIncidentUpdate(
  incidentId,
  fields,
  actor,
  eventWriter = recordIncidentEvent
) {
  if (actor.role === 'manager' && actor.teamId === null) {
    throw new HttpError(403, 'Managers must belong to a team to create incident updates.');
  }
  const client = await pgPool.connect();
  let eventReference = null;
  let committed = false;
  try {
    await client.query('BEGIN');
    const scope = scopedCondition(actor, 2);
    const incidentResult = await client.query(
      `SELECT i.incident_id, i.status, s.team_id
       FROM incident i
       JOIN service s ON s.service_id = i.service_id
       WHERE i.incident_id = $1 ${scope.sql}
       FOR UPDATE OF i, s`,
      [incidentId, ...scope.values]
    );
    if (!incidentResult.rows[0]) throw new HttpError(404, 'Incident not found.');

    const result = await client.query(
      `INSERT INTO incident_update (incident_id, user_id, status, message)
       VALUES ($1, $2, $3, $4)
       RETURNING update_id, incident_id, user_id, status, message, created_at`,
      [incidentId, actor.id, fields.status, fields.message]
    );
    const update = result.rows[0];
    eventReference = await eventWriter({
      incident_id: String(update.incident_id),
      event_type: 'incident.update.created',
      actor_user_id: String(actor.id),
      update_id: String(update.update_id),
      status: update.status,
      message: update.message,
      occurred_at: new Date()
    });
    await client.query('COMMIT');
    committed = true;
    return update;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[Incident updates] PostgreSQL rollback failed:', rollbackError.message);
    }
    if (eventReference && !committed) await compensateEvent(eventReference);
    throw mapDatabaseError(error);
  } finally {
    client.release();
  }
}
