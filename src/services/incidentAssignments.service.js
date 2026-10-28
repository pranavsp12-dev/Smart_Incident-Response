import { pgPool } from '../config/postgres.js';
import { recordIncidentEvent } from './incidents.service.js';
import { notifyAssignment } from './notification.service.js';
import { HttpError } from '../utils/httpError.js';

const ASSIGNMENT_COLUMNS = `
  ia.assignment_id, ia.incident_id, ia.user_id, ia.assigned_at,
  ia.unassigned_at, ia.assignment_type,
  i.title AS incident_title, i.service_id, s.team_id AS incident_team_id,
  u.name AS user_name, u.email AS user_email, u.role AS user_role,
  u.team_id AS user_team_id`;

function mapDatabaseError(error) {
  if (error.code === '23503') {
    return new HttpError(400, 'A referenced incident or user does not exist.');
  }
  if (error.code === '23514') {
    return new HttpError(400, 'The assignment violates a database constraint.');
  }
  if (error.code === '22P02' || error.code === '22007' || error.code === '22008') {
    return new HttpError(400, 'An assignment field has an invalid format.');
  }
  return error;
}

function assertManagerHasTeam(actor) {
  if (actor.role === 'manager' && actor.teamId === null) {
    throw new HttpError(403, 'Managers must belong to a team to manage assignments.');
  }
}

function scopePredicate(actor, incidentTeamColumn, parameterIndex) {
  if (actor.role === 'admin') return { sql: '', values: [] };
  if (actor.teamId === null) return { sql: 'AND FALSE', values: [] };
  return {
    sql: `AND ${incidentTeamColumn} = $${parameterIndex}`,
    values: [actor.teamId]
  };
}

async function writeEvent(eventWriter, event) {
  return eventWriter({
    ...event,
    occurred_at: new Date()
  });
}

async function compensateEvent(eventReference) {
  try {
    const result = await eventReference.db
      .collection('incident_events')
      .deleteOne({ _id: eventReference.eventId });
    if (result.deletedCount !== 1) {
      throw new Error('MongoDB assignment event compensation did not remove one event.');
    }
  } catch (error) {
    console.error('[Incident assignments] MongoDB event compensation failed:', error.code || error.name);
  }
}

async function reportAssignment(eventType, assignment, actorId = null) {
  try {
    await notifyAssignment({
      idempotencyKey: `incident-assignment-${assignment.assignment_id}-${eventType}`,
      eventType,
      incidentId: String(assignment.incident_id),
      assignmentId: String(assignment.assignment_id),
      recipientUserId: String(assignment.user_id),
      actorUserId: actorId === null ? null : String(actorId),
      assignmentType: assignment.assignment_type
    });
  } catch (error) {
    console.error('[Incident assignments] Development notification failed:', error.code || error.name);
  }
}

export async function listIncidentAssignments(actor) {
  assertManagerHasTeam(actor);
  const scope = scopePredicate(actor, 's.team_id', 1);
  const result = await pgPool.query(
    `SELECT ${ASSIGNMENT_COLUMNS}
     FROM incident_assignment ia
     JOIN incident i ON i.incident_id = ia.incident_id
     JOIN service s ON s.service_id = i.service_id
     JOIN app_user u ON u.user_id = ia.user_id
     WHERE TRUE ${scope.sql}
     ORDER BY ia.assigned_at DESC, ia.assignment_id DESC`,
    scope.values
  );
  return result.rows;
}

export async function getIncidentAssignment(assignmentId, actor, client = pgPool, forUpdate = false) {
  assertManagerHasTeam(actor);
  const scope = scopePredicate(actor, 's.team_id', 2);
  const result = await client.query(
    `SELECT ${ASSIGNMENT_COLUMNS}
     FROM incident_assignment ia
     JOIN incident i ON i.incident_id = ia.incident_id
     JOIN service s ON s.service_id = i.service_id
     JOIN app_user u ON u.user_id = ia.user_id
     WHERE ia.assignment_id = $1 ${scope.sql}
     ${forUpdate ? 'FOR UPDATE OF ia, i, s' : 'FOR SHARE OF s'}`,
    [assignmentId, ...scope.values]
  );
  return result.rows[0] || null;
}

export async function createIncidentAssignment(fields, actor, eventWriter = recordIncidentEvent) {
  assertManagerHasTeam(actor);
  const client = await pgPool.connect();
  let eventReference = null;
  let committed = false;
  try {
    await client.query('BEGIN');
    const incidentResult = await client.query(
      `SELECT i.incident_id, i.service_id, i.title, s.team_id
       FROM incident i
       JOIN service s ON s.service_id = i.service_id
       WHERE i.incident_id = $1
       FOR UPDATE OF i, s`,
      [fields.incidentId]
    );
    const incident = incidentResult.rows[0];
    if (!incident) throw new HttpError(404, 'Incident not found.');
    if (actor.role !== 'admin' &&
        (actor.teamId === null || String(incident.team_id) !== actor.teamId)) {
      throw new HttpError(404, 'Incident not found.');
    }

    const userResult = await client.query(
      `SELECT user_id, name, role, team_id, is_active
       FROM app_user
       WHERE user_id = $1
       FOR SHARE`,
      [fields.userId]
    );
    const user = userResult.rows[0];
    if (!user || !user.is_active) throw new HttpError(404, 'User not found.');
    if (actor.role !== 'admin' && String(user.team_id) !== actor.teamId) {
      throw new HttpError(404, 'User not found.');
    }

    const result = await client.query(
      `INSERT INTO incident_assignment (incident_id, user_id, assignment_type)
       VALUES ($1, $2, $3)
       RETURNING assignment_id, incident_id, user_id, assigned_at, unassigned_at, assignment_type`,
      [fields.incidentId, fields.userId, fields.assignmentType]
    );
    const assignment = result.rows[0];
    eventReference = await writeEvent(eventWriter, {
      incident_id: String(assignment.incident_id),
      event_type: 'incident.assignment.created',
      actor_user_id: String(actor.id),
      assignment_id: String(assignment.assignment_id),
      assigned_user_id: String(assignment.user_id),
      assignment_type: assignment.assignment_type
    });
    await client.query('COMMIT');
    committed = true;
    await reportAssignment('incident.assignment.created', assignment, actor.id);
    return assignment;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[Incident assignments] PostgreSQL rollback failed:', rollbackError.message);
    }
    if (eventReference && !committed) await compensateEvent(eventReference);
    throw mapDatabaseError(error);
  } finally {
    client.release();
  }
}

export async function updateIncidentAssignment(
  assignmentId,
  assignmentType,
  actor,
  eventWriter = recordIncidentEvent
) {
  assertManagerHasTeam(actor);
  const client = await pgPool.connect();
  let eventReference = null;
  let committed = false;
  try {
    await client.query('BEGIN');
    const existing = await getIncidentAssignment(assignmentId, actor, client, true);
    if (!existing) throw new HttpError(404, 'Assignment not found.');
    if (existing.unassigned_at !== null) {
      throw new HttpError(409, 'An unassigned record cannot be changed.');
    }
    const result = await client.query(
      `UPDATE incident_assignment
       SET assignment_type = $1
       WHERE assignment_id = $2 AND unassigned_at IS NULL
       RETURNING assignment_id, incident_id, user_id, assigned_at, unassigned_at, assignment_type`,
      [assignmentType, assignmentId]
    );
    if (!result.rows[0]) throw new HttpError(404, 'Assignment not found.');
    const assignment = result.rows[0];
    eventReference = await writeEvent(eventWriter, {
      incident_id: String(assignment.incident_id),
      event_type: 'incident.assignment.updated',
      actor_user_id: String(actor.id),
      assignment_id: String(assignment.assignment_id),
      changes: { assignment_type: { from: existing.assignment_type, to: assignment.assignment_type } }
    });
    await client.query('COMMIT');
    committed = true;
    await reportAssignment('incident.assignment.updated', assignment, actor.id);
    return assignment;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[Incident assignments] PostgreSQL rollback failed:', rollbackError.message);
    }
    if (eventReference && !committed) await compensateEvent(eventReference);
    throw mapDatabaseError(error);
  } finally {
    client.release();
  }
}

export async function unassignIncidentAssignment(
  assignmentId,
  actor,
  eventWriter = recordIncidentEvent
) {
  assertManagerHasTeam(actor);
  const client = await pgPool.connect();
  let eventReference = null;
  let committed = false;
  try {
    await client.query('BEGIN');
    const existing = await getIncidentAssignment(assignmentId, actor, client, true);
    if (!existing) throw new HttpError(404, 'Assignment not found.');
    if (existing.unassigned_at !== null) {
      throw new HttpError(409, 'Assignment has already been unassigned.');
    }
    const result = await client.query(
      `UPDATE incident_assignment
       SET unassigned_at = GREATEST(CURRENT_TIMESTAMP, assigned_at)
       WHERE assignment_id = $1 AND unassigned_at IS NULL
       RETURNING assignment_id, incident_id, user_id, assigned_at, unassigned_at, assignment_type`,
      [assignmentId]
    );
    if (!result.rows[0]) throw new HttpError(404, 'Assignment not found.');
    const assignment = result.rows[0];
    eventReference = await writeEvent(eventWriter, {
      incident_id: String(assignment.incident_id),
      event_type: 'incident.assignment.unassigned',
      actor_user_id: String(actor.id),
      assignment_id: String(assignment.assignment_id),
      assigned_user_id: String(assignment.user_id),
      unassigned_at: assignment.unassigned_at
    });
    await client.query('COMMIT');
    committed = true;
    await reportAssignment('incident.assignment.unassigned', assignment, actor.id);
    return assignment;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[Incident assignments] PostgreSQL rollback failed:', rollbackError.message);
    }
    if (eventReference && !committed) await compensateEvent(eventReference);
    throw mapDatabaseError(error);
  } finally {
    client.release();
  }
}
