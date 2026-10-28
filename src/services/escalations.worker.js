import { pgPool } from '../config/postgres.js';
import { recordIncidentEvent } from './incidents.service.js';
import { notifyEscalation } from './notification.service.js';

const ACTIVE_STATUSES = ['open', 'acknowledged', 'investigating', 'mitigated'];
const DEFAULT_INTERVAL_MS = 30_000;

function isTerminalStatus(status) {
  return status === 'resolved' || status === 'closed';
}

export function dueEscalationLevels(levels, detectedAt, now = new Date()) {
  const detectedAtMs = new Date(detectedAt).getTime();
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(detectedAtMs) || !Number.isFinite(nowMs)) {
    throw new TypeError('Escalation dates must be valid timestamps.');
  }

  let cumulativeWaitMs = 0;
  return levels.map((level) => {
    cumulativeWaitMs += Number(level.wait_minutes) * 60_000;
    return {
      ...level,
      dueAt: new Date(detectedAtMs + cumulativeWaitMs),
      isDue: detectedAtMs + cumulativeWaitMs <= nowMs
    };
  });
}

function cleanFailureMessage(error) {
  if (error?.name === 'InvalidEscalationTargetError' ||
      error?.name === 'NoOnCallResponderError') {
    return error.message;
  }
  return 'The escalation attempt failed due to a database or event logging error.';
}

function createPostgresRepository(pool) {
  async function withTransaction(operation) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(createTransaction(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('[Escalation worker] PostgreSQL rollback failed:', rollbackError.code || rollbackError.name);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  function createTransaction(client) {
    return {
      async lockIncident(incidentId) {
        const result = await client.query(
          `SELECT i.incident_id, i.status, i.detected_at,
                  s.team_id AS service_team_id
           FROM incident i
           JOIN service s ON s.service_id = i.service_id
           WHERE i.incident_id = $1
           FOR UPDATE OF i`,
          [incidentId]
        );
        return result.rows[0] || null;
      },
      async activePolicies(teamId) {
        const result = await client.query(
          `SELECT policy_id, team_id
           FROM escalation_policy
           WHERE team_id = $1 AND is_active = TRUE
           ORDER BY policy_id
           FOR SHARE`,
          [teamId]
        );
        return result.rows;
      },
      async levels(policyId) {
        const result = await client.query(
          `SELECT level_id, policy_id, level_number, target_type, target_id, wait_minutes
           FROM escalation_level
           WHERE policy_id = $1
           ORDER BY level_number, level_id
           FOR SHARE`,
          [policyId]
        );
        return result.rows;
      },
      async execution(incidentId, policyId, levelId) {
        const result = await client.query(
          `SELECT execution_id, status, assignment_id, notification_status
           FROM incident_escalation_execution
           WHERE incident_id = $1 AND policy_id = $2 AND level_id = $3
           FOR UPDATE`,
          [incidentId, policyId, levelId]
        );
        return result.rows[0] || null;
      },
      async resolveTarget(level, policy) {
        if (level.target_type === 'user') {
          const result = await client.query(
            `SELECT user_id
             FROM app_user
             WHERE user_id = $1 AND team_id = $2 AND is_active = TRUE
             FOR SHARE`,
            [level.target_id, policy.team_id]
          );
          if (!result.rows[0]) {
            const error = new Error('The escalation target user is missing, inactive, or outside the policy team.');
            error.name = 'InvalidEscalationTargetError';
            throw error;
          }
          return String(result.rows[0].user_id);
        }

        if (level.target_type === 'team') {
          if (String(level.target_id) !== String(policy.team_id)) {
            const error = new Error('The escalation target team must match the policy team.');
            error.name = 'InvalidEscalationTargetError';
            throw error;
          }
          const result = await client.query(
            `SELECT oa.user_id
             FROM on_call_assignment oa
             JOIN on_call_schedule os ON os.schedule_id = oa.schedule_id
             JOIN app_user u ON u.user_id = oa.user_id
             WHERE os.team_id = $1
               AND oa.start_time <= CURRENT_TIMESTAMP
               AND oa.end_time > CURRENT_TIMESTAMP
               AND os.start_date <= CURRENT_DATE
               AND (os.end_date IS NULL OR os.end_date >= CURRENT_DATE)
               AND u.team_id = os.team_id
               AND u.is_active = TRUE
             ORDER BY oa.start_time DESC, oa.assignment_id DESC
             LIMIT 1
             FOR SHARE OF oa, os, u`,
            [policy.team_id]
          );
          if (!result.rows[0]) {
            const error = new Error('No active on-call responder is available for the escalation team.');
            error.name = 'NoOnCallResponderError';
            throw error;
          }
          return String(result.rows[0].user_id);
        }

        const error = new Error(`Unsupported escalation target type: ${level.target_type}.`);
        error.name = 'InvalidEscalationTargetError';
        throw error;
      },
      async activeAssignment(incidentId, userId) {
        const result = await client.query(
          `SELECT assignment_id, assignment_type
           FROM incident_assignment
           WHERE incident_id = $1 AND user_id = $2 AND unassigned_at IS NULL
           ORDER BY assigned_at DESC, assignment_id DESC
           LIMIT 1
           FOR UPDATE`,
          [incidentId, userId]
        );
        return result.rows[0] || null;
      },
      async closePriorEscalations(incidentId, userId) {
        return client.query(
          `UPDATE incident_assignment
           SET unassigned_at = CURRENT_TIMESTAMP
           WHERE incident_id = $1
             AND assignment_type = 'escalation'
             AND unassigned_at IS NULL
             AND user_id <> $2
           RETURNING assignment_id`,
          [incidentId, userId]
        );
      },
      async createAssignment(incidentId, userId) {
        const result = await client.query(
          `INSERT INTO incident_assignment (incident_id, user_id, assignment_type)
           VALUES ($1, $2, 'escalation')
           RETURNING assignment_id, incident_id, user_id, assigned_at`,
          [incidentId, userId]
        );
        return result.rows[0];
      },
      async recordExecution(fields) {
        const result = await client.query(
          `INSERT INTO incident_escalation_execution (
             incident_id, policy_id, level_id, assignment_id, status, outcome,
             attempt_count, last_error, attempted_at, completed_at,
             notification_status, updated_at
           )
           VALUES (
             $1, $2, $3, $4, $5, $6, 1, $7, CURRENT_TIMESTAMP, $8, $9,
             CURRENT_TIMESTAMP
           )
           ON CONFLICT (incident_id, policy_id, level_id)
           DO UPDATE SET
             assignment_id = EXCLUDED.assignment_id,
             status = EXCLUDED.status,
             outcome = EXCLUDED.outcome,
             attempt_count = incident_escalation_execution.attempt_count + 1,
             last_error = EXCLUDED.last_error,
             attempted_at = CURRENT_TIMESTAMP,
             completed_at = EXCLUDED.completed_at,
             notification_status = EXCLUDED.notification_status,
             notification_error = NULL,
             updated_at = CURRENT_TIMESTAMP
           WHERE incident_escalation_execution.status <> 'applied'
           RETURNING execution_id, attempt_count`,
          [
            fields.incidentId,
            fields.policyId,
            fields.levelId,
            fields.assignmentId,
            fields.status,
            fields.outcome,
            fields.error,
            fields.completed ? new Date() : null,
            fields.notificationStatus
          ]
        );
        return result.rows[0] || null;
      },
      async pendingNotification(excludedExecutionIds) {
        const result = await client.query(
          `SELECT e.execution_id, e.incident_id, e.assignment_id, e.outcome,
                  (SELECT user_id
                   FROM incident_assignment ia
                   WHERE ia.assignment_id = e.assignment_id) AS recipient_user_id
           FROM incident_escalation_execution e
           WHERE e.notification_status IN ('pending', 'failed')
             AND NOT (e.execution_id = ANY($1::bigint[]))
           ORDER BY e.execution_id
           LIMIT 1
           FOR UPDATE OF e SKIP LOCKED`,
          [excludedExecutionIds]
        );
        return result.rows[0] || null;
      },
      async updateNotification(executionId, status, error = null) {
        await client.query(
          `UPDATE incident_escalation_execution
           SET notification_status = $2,
               notification_attempts = notification_attempts + 1,
               notification_error = $3,
               updated_at = CURRENT_TIMESTAMP
           WHERE execution_id = $1`,
          [executionId, status, error]
        );
      }
    };
  }

  return {
    async listCandidateIncidentIds() {
      const result = await pool.query(
        `SELECT incident_id
         FROM incident
         WHERE status = ANY($1::varchar[])
         ORDER BY detected_at, incident_id`,
        [ACTIVE_STATUSES]
      );
      return result.rows.map((row) => String(row.incident_id));
    },
    withTransaction,
    async recordFailure(fields) {
      return withTransaction((tx) => tx.recordExecution({
        ...fields,
        status: 'failed',
        completed: false,
        notificationStatus: 'not_required'
      }));
    },
    async withPendingNotification(excludedExecutionIds, operation) {
      return withTransaction(async (tx) => {
        const pending = await tx.pendingNotification(excludedExecutionIds);
        if (!pending) return false;
        await operation(tx, pending);
        return true;
      });
    },
    async hasExecutionTable() {
      const result = await pool.query(
        `SELECT to_regclass('public.incident_escalation_execution') IS NOT NULL AS ready`
      );
      return result.rows[0]?.ready === true;
    }
  };
}

export function createEscalationWorker({
  pool = pgPool,
  repository = createPostgresRepository(pool),
  eventWriter = recordIncidentEvent,
  notifier = notifyEscalation,
  logger = console,
  clock = () => new Date(),
  intervalMs = DEFAULT_INTERVAL_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
} = {}) {
  let timer = null;
  let activeCycle = null;
  let startPromise = null;
  let stopping = false;

  async function processIncident(incidentId) {
    const eventReferences = [];
    let result;
    let activePolicyId = null;
    let activeLevelId = null;
    try {
      result = await repository.withTransaction(async (tx) => {
        const incident = await tx.lockIncident(incidentId);
        if (!incident || isTerminalStatus(incident.status) ||
            !ACTIVE_STATUSES.includes(incident.status)) {
          return { outcome: 'ineligible' };
        }

        const policies = await tx.activePolicies(incident.service_team_id);
        if (policies.length === 0) return { outcome: 'no_policy' };
        if (policies.length !== 1) return { outcome: 'ambiguous_policy' };

        const policy = policies[0];
        activePolicyId = policy.policy_id;
        const levels = await tx.levels(policy.policy_id);
        if (levels.length === 0) return { outcome: 'no_levels' };

        const dueLevels = dueEscalationLevels(levels, incident.detected_at, clock());
        let outcome = 'complete';
        for (const level of dueLevels) {
          activeLevelId = level.level_id;
          const existing = await tx.execution(incident.incident_id, policy.policy_id, level.level_id);
          if (existing?.status === 'applied') continue;
          if (!level.isDue) return { outcome: 'waiting' };

          let userId;
          try {
            userId = await tx.resolveTarget(level, policy);
          } catch (error) {
            await tx.recordExecution({
              incidentId: incident.incident_id,
              policyId: policy.policy_id,
              levelId: level.level_id,
              assignmentId: null,
              status: 'failed',
              outcome: 'target_unavailable',
              error: cleanFailureMessage(error),
              completed: false,
              notificationStatus: 'not_required'
            });
            return { outcome: 'failed', error: cleanFailureMessage(error) };
          }

          const activeAssignment = await tx.activeAssignment(incident.incident_id, userId);
          if (activeAssignment) {
            await tx.recordExecution({
              incidentId: incident.incident_id,
              policyId: policy.policy_id,
              levelId: level.level_id,
              assignmentId: activeAssignment.assignment_id,
              status: 'applied',
              outcome: 'already_assigned',
              error: null,
              completed: true,
              notificationStatus: 'not_required'
            });
            continue;
          }

          await tx.closePriorEscalations(incident.incident_id, userId);
          const assignment = await tx.createAssignment(incident.incident_id, userId);
          const execution = await tx.recordExecution({
            incidentId: incident.incident_id,
            policyId: policy.policy_id,
            levelId: level.level_id,
            assignmentId: assignment.assignment_id,
            status: 'applied',
            outcome: 'assigned',
            error: null,
            completed: true,
            notificationStatus: 'pending'
          });
          const eventReference = await eventWriter({
            incident_id: String(incident.incident_id),
            event_type: 'incident.escalation.applied',
            policy_id: String(policy.policy_id),
            level_id: String(level.level_id),
            level_number: level.level_number,
            actor_user_id: null,
            assigned_user_id: userId,
            assignment_id: String(assignment.assignment_id),
            execution_id: String(execution?.execution_id),
            occurred_at: clock()
          });
          eventReferences.push(eventReference);
          outcome = 'assigned';
        }
        return { outcome };
      });
    } catch (error) {
      for (const eventReference of eventReferences) {
        await compensateEvent(eventReference, logger);
      }
      const message = cleanFailureMessage(error);
      if (activePolicyId !== null && activeLevelId !== null) {
        try {
          await repository.recordFailure({
            incidentId,
            policyId: activePolicyId,
            levelId: activeLevelId,
            assignmentId: null,
            outcome: 'processing_failed',
            error: message
          });
        } catch (recordError) {
          logger.error('[Escalation worker] Could not persist failed escalation attempt:', recordError.code || recordError.name);
        }
      }
      logger.error(`[Escalation worker] Incident ${incidentId} processing failed: ${message}`);
      return { outcome: 'failed', error: message };
    }

    if (result.outcome === 'ambiguous_policy') {
      logger.error(`[Escalation worker] Incident ${incidentId} skipped: multiple active policies match its service team.`);
    }
    if (result.outcome === 'failed') {
      logger.error(`[Escalation worker] Incident ${incidentId} escalation failed: ${result.error}`);
    }
    return result;
  }

  async function dispatchPendingNotifications() {
    const processedIds = [];
    while (true) {
      let dispatched = false;
      try {
        dispatched = await repository.withPendingNotification(processedIds, async (tx, notification) => {
          processedIds.push(String(notification.execution_id));
          const idempotencyKey = `incident-escalation-${notification.execution_id}`;
          try {
            await notifier({
              idempotencyKey,
              eventType: 'incident.escalation.applied',
              incidentId: String(notification.incident_id),
              recipientUserId: notification.recipient_user_id === null
                ? null
                : String(notification.recipient_user_id),
              assignmentId: notification.assignment_id === null
                ? null
                : String(notification.assignment_id),
              outcome: notification.outcome
            });
            await tx.updateNotification(notification.execution_id, 'logged');
          } catch (error) {
            await tx.updateNotification(
              notification.execution_id,
              'failed',
              'Development notification logging failed.'
            );
            logger.error('[Escalation worker] Development notification failed:', error.code || error.name);
          }
        });
      } catch (error) {
        logger.error('[Escalation worker] Notification outbox processing failed:', error.code || error.name);
        return;
      }
      if (!dispatched) return;
    }
  }

  async function tick() {
    if (stopping) return;
    if (activeCycle) return activeCycle;
    activeCycle = (async () => {
      let incidentIds;
      try {
        incidentIds = await repository.listCandidateIncidentIds();
      } catch (error) {
        logger.error('[Escalation worker] Could not load eligible incidents:', error.code || error.name);
        return;
      }
      for (const incidentId of incidentIds) await processIncident(incidentId);
      await dispatchPendingNotifications();
    })();
    try {
      await activeCycle;
    } finally {
      activeCycle = null;
    }
  }

  async function start() {
    if (stopping) {
      throw new Error('Escalation worker is stopping and cannot be started.');
    }
    if (timer) return;
    if (startPromise) return startPromise;

    startPromise = (async () => {
      if (!(await repository.hasExecutionTable())) {
        throw new Error('Escalation migration is not applied; automatic escalation worker was not started.');
      }
      if (stopping) return;
      await tick();
      if (stopping) return;
      timer = setIntervalFn(() => {
        tick().catch((error) => {
          logger.error('[Escalation worker] Cycle failed:', error.code || error.name);
        });
      }, intervalMs);
    })();

    try {
      await startPromise;
    } catch (error) {
      startPromise = null;
      throw error;
    }
  }

  async function stop() {
    stopping = true;
    if (timer) {
      clearIntervalFn(timer);
      timer = null;
    }
    if (startPromise) await startPromise.catch(() => {});
    if (activeCycle) await activeCycle;
    if (timer) {
      clearIntervalFn(timer);
      timer = null;
    }
  }

  return { start, stop, tick };
}

async function compensateEvent(eventReference, logger) {
  try {
    const result = await eventReference.db
      .collection('incident_events')
      .deleteOne({ _id: eventReference.eventId });
    if (result.deletedCount !== 1) {
      throw new Error('MongoDB escalation event compensation did not remove one event.');
    }
  } catch (error) {
    logger.error('[Escalation worker] MongoDB event compensation failed:', error.code || error.name);
  }
}

export { ACTIVE_STATUSES, DEFAULT_INTERVAL_MS };
