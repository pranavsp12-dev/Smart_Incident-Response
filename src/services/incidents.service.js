import { pgPool } from '../config/postgres.js';
import { connectMongo } from '../config/mongodb.js';
import { HttpError } from '../utils/httpError.js';

const INCIDENT_COLUMNS = `
  i.incident_id, i.service_id, i.environment_id, i.title, i.description,
  i.severity, i.priority, i.status, i.detected_at, i.acknowledged_at,
  i.resolved_at, i.created_by, i.resolved_by, i.created_at, i.updated_at`;

function mapDatabaseError(error) {
  if (error.code === '23505') {
    return new HttpError(409, 'The incident conflicts with an existing record.');
  }
  if (error.code === '23503') {
    return new HttpError(400, 'A referenced service, environment, or user does not exist.');
  }
  if (error.code === '23514') {
    return new HttpError(400, 'The incident violates a database constraint.');
  }
  if (error.code === '22P02' || error.code === '22007' || error.code === '22008') {
    return new HttpError(400, 'An incident field has an invalid format.');
  }
  return error;
}

export async function recordIncidentEvent(event, mongoConnector = connectMongo) {
  try {
    const { db } = await mongoConnector();
    const result = await db.collection('incident_events').insertOne(event);
    return { db, eventId: result.insertedId };
  } catch (error) {
    console.error('[Incidents] MongoDB event write failed:', error.code || error.name);
    throw new HttpError(
      503,
      'Incident event logging is unavailable; the incident change was not confirmed.'
    );
  }
}

async function removeIncidentEvent(eventReference) {
  try {
    const result = await eventReference.db
      .collection('incident_events')
      .deleteOne({ _id: eventReference.eventId });
    if (result.deletedCount !== 1) {
      throw new Error('MongoDB incident event compensation did not remove one event.');
    }
  } catch (error) {
    console.error('[Incidents] MongoDB event compensation failed:', error.code || error.name);
  }
}

function scopedQueryParts({ role, teamId }, startIndex = 1) {
  if (role === 'admin') {
    return { condition: '', values: [] };
  }
  if (teamId === null) {
    return { condition: 'AND FALSE', values: [] };
  }

  return {
    condition: `AND s.team_id = $${startIndex}`,
    values: [teamId]
  };
}

export async function listIncidents(actor) {
  if (actor.role === 'manager' && actor.teamId === null) {
    throw new HttpError(403, 'Managers must belong to a team to list incidents.');
  }
  const scope = scopedQueryParts(actor);
  const result = await pgPool.query(
    `SELECT ${INCIDENT_COLUMNS}
     FROM incident i
     JOIN service s ON s.service_id = i.service_id
     WHERE TRUE ${scope.condition}
     ORDER BY i.detected_at DESC, i.incident_id DESC`,
    scope.values
  );
  return result.rows;
}

export async function getIncident(incidentId, actor, client = pgPool, forUpdate = false) {
  if (actor.role === 'manager' && actor.teamId === null) {
    throw new HttpError(403, 'Managers must belong to a team to view incidents.');
  }
  const scope = scopedQueryParts(actor, 2);
  const result = await client.query(
    `SELECT ${INCIDENT_COLUMNS}
     FROM incident i
     JOIN service s ON s.service_id = i.service_id
     WHERE i.incident_id = $1 ${scope.condition}
     ${forUpdate ? 'FOR UPDATE OF i, s' : 'FOR SHARE OF s'}`,
    [incidentId, ...scope.values]
  );
  return result.rows[0] || null;
}

function deriveStatusTimestamps(status) {
  return {
    acknowledgedAt: status === 'open' ? null : 'CURRENT_TIMESTAMP',
    resolvedAt: ['resolved', 'closed'].includes(status) ? 'CURRENT_TIMESTAMP' : null,
    resolvedBy: ['resolved', 'closed'].includes(status)
  };
}

export async function createIncident(fields, actor, eventWriter = recordIncidentEvent) {
  const client = await pgPool.connect();
  let eventReference = null;
  let committed = false;
  try {
    await client.query('BEGIN');

    const serviceResult = await client.query(
      `SELECT service_id, team_id, is_active
       FROM service
       WHERE service_id = $1
       FOR SHARE`,
      [fields.serviceId]
    );
    const service = serviceResult.rows[0];
    if (!service || !service.is_active) {
      throw new HttpError(400, 'The specified service does not exist or is inactive.');
    }
    if (actor.role !== 'admin' &&
        (actor.teamId === null || String(service.team_id) !== actor.teamId)) {
      throw new HttpError(404, 'Service not found.');
    }

    const environmentResult = await client.query(
      `SELECT environment_id
       FROM environment
       WHERE environment_id = $1
       FOR KEY SHARE`,
      [fields.environmentId]
    );
    if (environmentResult.rowCount === 0) {
      throw new HttpError(400, 'The specified environment does not exist.');
    }

    const timestamps = deriveStatusTimestamps(fields.status);
    const result = await client.query(
      `INSERT INTO incident (
         service_id, environment_id, title, description, severity,
         priority, status, acknowledged_at, resolved_at, created_by, resolved_by
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         ${timestamps.acknowledgedAt ? 'CURRENT_TIMESTAMP' : 'NULL'},
         ${timestamps.resolvedAt ?? 'NULL'},
         $8,
         ${timestamps.resolvedBy ? '$8' : 'NULL'}
       )
       RETURNING
         incident_id, service_id, environment_id, title, description,
         severity, priority, status, detected_at, acknowledged_at,
         resolved_at, created_by, resolved_by, created_at, updated_at`,
      [
        fields.serviceId,
        fields.environmentId,
        fields.title,
        fields.description,
        fields.severity,
        fields.priority,
        fields.status,
        actor.id
      ]
    );

    const incident = result.rows[0];
    eventReference = await eventWriter({
      incident_id: String(incident.incident_id),
      event_type: 'incident.created',
      actor_user_id: String(actor.id),
      occurred_at: new Date(),
      snapshot: {
        service_id: incident.service_id,
        environment_id: incident.environment_id,
        title: incident.title,
        description: incident.description,
        severity: incident.severity,
        priority: incident.priority,
        status: incident.status
      }
    });
    await client.query('COMMIT');
    committed = true;
    return incident;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[Incidents] Transaction rollback failed:', rollbackError.message);
    }
    if (eventReference && !committed) {
      await removeIncidentEvent(eventReference);
    }
    throw mapDatabaseError(error);
  } finally {
    client.release();
  }
}

export async function updateIncident(incidentId, fields, actor, eventWriter = recordIncidentEvent) {
  const client = await pgPool.connect();
  let eventReference = null;
  let committed = false;
  try {
    await client.query('BEGIN');

    const existing = await getIncident(incidentId, actor, client, true);
    if (!existing) {
      throw new HttpError(404, 'Incident not found.');
    }

    const updates = [];
    const values = [];
    for (const field of ['title', 'description', 'severity', 'priority']) {
      if (Object.hasOwn(fields, field)) {
        values.push(fields[field]);
        updates.push(`${field} = $${values.length}`);
      }
    }
    if (Object.hasOwn(fields, 'status')) {
      values.push(fields.status);
      const statusParameter = `$${values.length}::varchar(30)`;
      updates.push(`status = ${statusParameter}`);
      updates.push(
        `acknowledged_at = CASE
           WHEN ${statusParameter} = 'open' THEN NULL
           ELSE COALESCE(i.acknowledged_at, CURRENT_TIMESTAMP)
         END`
      );
      updates.push(
        `resolved_at = CASE
           WHEN ${statusParameter} IN ('resolved', 'closed') THEN COALESCE(i.resolved_at, CURRENT_TIMESTAMP)
           ELSE NULL
         END`
      );
      updates.push(
        `resolved_by = CASE
           WHEN ${statusParameter} IN ('resolved', 'closed') THEN $${values.length + 1}::bigint
           ELSE NULL
         END`
      );
      values.push(actor.id);
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(incidentId);
    const conditions = [`i.incident_id = $${values.length}`];
    if (actor.role !== 'admin') {
      values.push(actor.teamId);
      conditions.push(
        `EXISTS (
          SELECT 1
          FROM service scoped_service
          WHERE scoped_service.service_id = i.service_id
            AND scoped_service.team_id = $${values.length}
        )`
      );
    }

    const result = await client.query(
      `UPDATE incident i
       SET ${updates.join(', ')}
       WHERE ${conditions.join(' AND ')}
       RETURNING
         i.incident_id, i.service_id, i.environment_id, i.title, i.description,
         i.severity, i.priority, i.status, i.detected_at, i.acknowledged_at,
         i.resolved_at, i.created_by, i.resolved_by, i.created_at, i.updated_at`,
      values
    );
    if (!result.rows[0]) {
      throw new HttpError(404, 'Incident not found.');
    }

    const incident = result.rows[0];
    const changes = Object.fromEntries(
      Object.keys(fields).map((field) => [
        field,
        { from: existing[field], to: incident[field] }
      ])
    );
    eventReference = await eventWriter({
      incident_id: String(incident.incident_id),
      event_type: 'incident.updated',
      actor_user_id: String(actor.id),
      occurred_at: new Date(),
      changes
    });
    await client.query('COMMIT');
    committed = true;
    return incident;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[Incidents] Transaction rollback failed:', rollbackError.message);
    }
    if (eventReference && !committed) {
      await removeIncidentEvent(eventReference);
    }
    throw mapDatabaseError(error);
  } finally {
    client.release();
  }
}
