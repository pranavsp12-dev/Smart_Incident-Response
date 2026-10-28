import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ACTIVE_STATUSES,
  createEscalationWorker,
  dueEscalationLevels
} from '../src/services/escalations.worker.js';
import { notifyAssignment, notifyEscalation } from '../src/services/notification.service.js';

const NOW = new Date('2026-10-27T12:00:00.000Z');

function createMemoryRepository({
  incidents = [],
  policies = [],
  levels = [],
  schedules = [],
  users = [],
  onCallAssignments = [],
  failCommitCount = 0,
  migrationReady = true
} = {}) {
  const state = {
    incidents: structuredClone(incidents),
    policies: structuredClone(policies),
    levels: structuredClone(levels),
    schedules: structuredClone(schedules),
    users: structuredClone(users),
    onCallAssignments: structuredClone(onCallAssignments),
    assignments: [],
    executions: [],
    nextAssignmentId: 1,
    nextExecutionId: 1
  };
  let transactionTail = Promise.resolve();

  function transaction(operation) {
    const previous = transactionTail;
    let release;
    transactionTail = new Promise((resolve) => { release = resolve; });
    return previous.then(async () => {
      const snapshot = structuredClone(state);
      try {
        const result = await operation(createTransaction());
        if (failCommitCount > 0) {
          failCommitCount -= 1;
          throw new Error('injected commit failure');
        }
        return result;
      } catch (error) {
        Object.assign(state, snapshot);
        throw error;
      } finally {
        release();
      }
    });
  }

  function createTransaction() {
    return {
      async lockIncident(id) {
        return state.incidents.find((item) => item.incident_id === String(id)) ?? null;
      },
      async activePolicies(teamId) {
        return state.policies.filter((item) =>
          item.is_active && String(item.team_id) === String(teamId)
        );
      },
      async levels(policyId) {
        return state.levels
          .filter((item) => String(item.policy_id) === String(policyId))
          .sort((left, right) =>
            left.level_number - right.level_number || left.level_id.localeCompare(right.level_id)
          );
      },
      async execution(incidentId, policyId, levelId) {
        return state.executions.find((item) =>
          item.incident_id === String(incidentId) &&
          item.policy_id === String(policyId) &&
          item.level_id === String(levelId)
        ) ?? null;
      },
      async resolveTarget(level, policy) {
        if (level.target_type === 'user') {
          const user = state.users.find((item) =>
            String(item.user_id) === String(level.target_id) &&
            String(item.team_id) === String(policy.team_id) &&
            item.is_active
          );
          if (!user) {
            const error = new Error('The escalation target user is missing, inactive, or outside the policy team.');
            error.name = 'InvalidEscalationTargetError';
            throw error;
          }
          return String(user.user_id);
        }
        if (level.target_type === 'team') {
          if (String(level.target_id) !== String(policy.team_id)) {
            const error = new Error('The escalation target team must match the policy team.');
            error.name = 'InvalidEscalationTargetError';
            throw error;
          }
          const assignment = state.onCallAssignments
            .filter((item) =>
              String(item.team_id) === String(level.target_id) &&
              new Date(item.start_time) <= NOW &&
              new Date(item.end_time) > NOW &&
              (() => {
                const schedule = state.schedules.find((entry) =>
                  String(entry.schedule_id) === String(item.schedule_id)
                );
                const today = NOW.toISOString().slice(0, 10);
                return schedule &&
                  String(schedule.team_id) === String(level.target_id) &&
                  schedule.start_date <= today &&
                  (schedule.end_date === null || schedule.end_date >= today);
              })() &&
              state.users.some((user) =>
                String(user.user_id) === String(item.user_id) &&
                String(user.team_id) === String(level.target_id) &&
                user.is_active
              )
            )
            .sort((left, right) =>
              new Date(right.start_time) - new Date(left.start_time) ||
              Number(right.assignment_id) - Number(left.assignment_id)
            )[0];
          if (!assignment) {
            const error = new Error('No active on-call responder is available for the escalation team.');
            error.name = 'NoOnCallResponderError';
            throw error;
          }
          return String(assignment.user_id);
        }
        const error = new Error(`Unsupported escalation target type: ${level.target_type}.`);
        error.name = 'InvalidEscalationTargetError';
        throw error;
      },
      async activeAssignment(incidentId, userId) {
        return state.assignments.find((item) =>
          item.incident_id === String(incidentId) &&
          item.user_id === String(userId) &&
          item.unassigned_at === null
        ) ?? null;
      },
      async closePriorEscalations(incidentId, userId) {
        for (const assignment of state.assignments) {
          if (assignment.incident_id === String(incidentId) &&
              assignment.assignment_type === 'escalation' &&
              assignment.unassigned_at === null &&
              assignment.user_id !== String(userId)) {
            assignment.unassigned_at = NOW.toISOString();
          }
        }
      },
      async createAssignment(incidentId, userId) {
        const assignment = {
          assignment_id: String(state.nextAssignmentId++),
          incident_id: String(incidentId),
          user_id: String(userId),
          assignment_type: 'escalation',
          unassigned_at: null
        };
        state.assignments.push(assignment);
        return assignment;
      },
      async recordExecution(fields) {
        let execution = state.executions.find((item) =>
          item.incident_id === String(fields.incidentId) &&
          item.policy_id === String(fields.policyId) &&
          item.level_id === String(fields.levelId)
        );
        if (execution?.status === 'applied') return null;
        if (execution) {
          execution = Object.assign(execution, {
            assignment_id: fields.assignmentId,
            status: fields.status,
            outcome: fields.outcome,
            attempt_count: execution.attempt_count + 1,
            last_error: fields.error,
            completed: fields.completed,
            notification_status: fields.notificationStatus,
            notification_error: null
          });
        } else {
          execution = {
            execution_id: String(state.nextExecutionId++),
            incident_id: String(fields.incidentId),
            policy_id: String(fields.policyId),
            level_id: String(fields.levelId),
            assignment_id: fields.assignmentId,
            status: fields.status,
            outcome: fields.outcome,
            attempt_count: 1,
            last_error: fields.error,
            completed: fields.completed,
            notification_status: fields.notificationStatus,
            notification_attempts: 0,
            notification_error: null
          };
          state.executions.push(execution);
        }
        return execution;
      },
      async pendingNotification(excludedIds) {
        return state.executions.find((item) =>
          ['pending', 'failed'].includes(item.notification_status) &&
          !excludedIds.includes(String(item.execution_id))
        ) ?? null;
      },
      async updateNotification(executionId, status, error = null) {
        const execution = state.executions.find((item) =>
          item.execution_id === String(executionId)
        );
        execution.notification_status = status;
        execution.notification_attempts += 1;
        execution.notification_error = error;
      }
    };
  }

  return {
    state,
    async listCandidateIncidentIds() {
      return state.incidents
        .filter((item) => ACTIVE_STATUSES.includes(item.status))
        .map((item) => item.incident_id);
    },
    withTransaction: transaction,
    async recordFailure(fields) {
      return transaction((tx) => tx.recordExecution({
        ...fields,
        status: 'failed',
        completed: false,
        notificationStatus: 'not_required'
      }));
    },
    async withPendingNotification(excludedIds, operation) {
      return transaction(async (tx) => {
        const item = await tx.pendingNotification(excludedIds);
        if (!item) return false;
        await operation(tx, item);
        return true;
      });
    },
    async hasExecutionTable() {
      return migrationReady;
    }
  };
}

function createFixture(options = {}) {
  const repository = createMemoryRepository({
    incidents: [{
      incident_id: '100',
      status: 'open',
      detected_at: '2026-10-27T11:00:00.000Z',
      service_team_id: '7'
    }],
    policies: [{ policy_id: '10', team_id: '7', is_active: true }],
    schedules: [{ schedule_id: '1', team_id: '7', start_date: '2026-10-01', end_date: null }],
    levels: [
      { level_id: '20', policy_id: '10', level_number: 1, target_type: 'user', target_id: '2', wait_minutes: 0 },
      { level_id: '21', policy_id: '10', level_number: 2, target_type: 'user', target_id: '3', wait_minutes: 5 }
    ],
    users: [
      { user_id: '2', team_id: '7', is_active: true },
      { user_id: '3', team_id: '7', is_active: true }
    ],
    ...options
  });
  const events = [];
  const notifications = [];
  const errors = [];
  const eventWriter = async (event) => {
    const eventId = String(events.length + 1);
    events.push({ ...event, eventId });
    return {
      eventId,
      db: {
        collection() {
          return {
            async deleteOne(filter) {
              const index = events.findIndex((entry) => entry.eventId === filter._id);
              if (index >= 0) events.splice(index, 1);
              return { deletedCount: index >= 0 ? 1 : 0 };
            }
          };
        }
      }
    };
  };
  const logger = { error: (...args) => errors.push(args.join(' ')) };
  const worker = createEscalationWorker({
    repository,
    eventWriter,
    notifier: async (notification) => {
      notifications.push(notification);
      return { status: 'logged', mode: 'development' };
    },
    logger,
    clock: () => NOW
  });
  return { repository, worker, events, notifications, errors, eventWriter };
}

test('cumulative waits preserve configured level order and due times', () => {
  const due = dueEscalationLevels([
    { level_number: 1, wait_minutes: 5 },
    { level_number: 2, wait_minutes: 15 },
    { level_number: 3, wait_minutes: 10 }
  ], '2026-10-27T11:00:00.000Z', '2026-10-27T11:21:00.000Z');

  assert.deepEqual(due.map(({ dueAt, isDue }) => ({
    dueAt: dueAt.toISOString(),
    isDue
  })), [
    { dueAt: '2026-10-27T11:05:00.000Z', isDue: true },
    { dueAt: '2026-10-27T11:20:00.000Z', isDue: true },
    { dueAt: '2026-10-27T11:30:00.000Z', isDue: false }
  ]);
});

test('development notification adapter reports assignments and escalation without claiming delivery', async () => {
  const messages = [];
  const output = (message) => messages.push(JSON.parse(message));
  await notifyAssignment({
    idempotencyKey: 'assignment-1',
    incidentId: '100',
    recipientUserId: '2'
  }, output);
  await notifyEscalation({
    idempotencyKey: 'escalation-1',
    incidentId: '100',
    recipientUserId: '3'
  }, output);

  assert.deepEqual(messages.map((message) => message.eventTypes), [
    ['incident.assignment.created'],
    ['incident.assignment.created', 'incident.escalation.applied']
  ]);
  assert.ok(messages.every((message) => message.message.includes('No delivery provider is configured')));
});

test('worker applies due levels in order, advances assignment, and logs notifications', async () => {
  const fixture = createFixture();
  await fixture.worker.tick();

  assert.deepEqual(fixture.events.map((event) => event.level_number), [1, 2]);
  assert.equal(fixture.repository.state.executions.length, 2);
  assert.equal(fixture.repository.state.executions.every((item) => item.status === 'applied'), true);
  assert.equal(fixture.repository.state.assignments.length, 2);
  assert.ok(fixture.repository.state.assignments[0].unassigned_at);
  assert.equal(fixture.repository.state.assignments[1].unassigned_at, null);
  assert.equal(fixture.notifications.length, 2);
  assert.equal(fixture.repository.state.executions.every((item) =>
    item.notification_status === 'logged'
  ), true);
});

test('resolved incidents and not-yet-due levels are not assigned', async () => {
  const resolved = createFixture({
    incidents: [{
      incident_id: '100',
      status: 'resolved',
      detected_at: '2026-10-27T10:00:00.000Z',
      service_team_id: '7'
    }]
  });
  await resolved.worker.tick();
  assert.equal(resolved.repository.state.executions.length, 0);

  const waiting = createFixture({
    levels: [
      { level_id: '20', policy_id: '10', level_number: 1, target_type: 'user', target_id: '2', wait_minutes: 90 }
    ]
  });
  await waiting.worker.tick();
  assert.equal(waiting.repository.state.assignments.length, 0);
  assert.equal(waiting.repository.state.executions.length, 0);
});

test('invalid or inactive user targets fail durably and retry after correction', async () => {
  const fixture = createFixture({
    levels: [
      { level_id: '20', policy_id: '10', level_number: 1, target_type: 'user', target_id: '99', wait_minutes: 0 }
    ]
  });
  await fixture.worker.tick();
  assert.equal(fixture.repository.state.executions[0].status, 'failed');
  assert.equal(fixture.repository.state.executions[0].attempt_count, 1);
  assert.match(fixture.repository.state.executions[0].last_error, /target user/);
  assert.equal(fixture.repository.state.assignments.length, 0);

  fixture.repository.state.users.push({ user_id: '99', team_id: '7', is_active: true });
  await fixture.worker.tick();
  assert.equal(fixture.repository.state.executions[0].status, 'applied');
  assert.equal(fixture.repository.state.executions[0].attempt_count, 2);
  assert.equal(fixture.repository.state.assignments.length, 1);
});

test('inactive and cross-team user targets are rejected', async (t) => {
  for (const [name, targetUser] of [
    ['inactive', { user_id: '2', team_id: '7', is_active: false }],
    ['outside the policy team', { user_id: '2', team_id: '8', is_active: true }]
  ]) {
    await t.test(name, async () => {
      const fixture = createFixture({
        levels: [
          { level_id: '20', policy_id: '10', level_number: 1, target_type: 'user', target_id: '2', wait_minutes: 0 }
        ],
        users: [targetUser]
      });
      await fixture.worker.tick();
      assert.equal(fixture.repository.state.executions[0].status, 'failed');
      assert.equal(fixture.repository.state.assignments.length, 0);
    });
  }
});

test('team targets require an active current on-call responder', async () => {
  const fixture = createFixture({
    levels: [
      { level_id: '20', policy_id: '10', level_number: 1, target_type: 'team', target_id: '7', wait_minutes: 0 }
    ]
  });
  await fixture.worker.tick();
  assert.equal(fixture.repository.state.executions[0].status, 'failed');
  assert.match(fixture.repository.state.executions[0].last_error, /No active on-call responder/);

  fixture.repository.state.onCallAssignments.push({
    assignment_id: '8',
    schedule_id: '1',
    team_id: '7',
    user_id: '3',
    start_time: '2026-10-27T11:00:00.000Z',
    end_time: '2026-10-27T13:00:00.000Z'
  });
  await fixture.worker.tick();
  assert.equal(fixture.repository.state.executions[0].status, 'applied');
  assert.equal(fixture.repository.state.assignments[0].user_id, '3');
});

test('team targets reject future and expired schedules but accept a current schedule', async (t) => {
  const today = NOW.toISOString().slice(0, 10);
  for (const scenario of [
    { name: 'future schedule', startDate: '2026-10-28', endDate: null, expected: 'failed' },
    { name: 'expired schedule', startDate: '2026-10-01', endDate: '2026-10-26', expected: 'failed' },
    { name: 'current schedule', startDate: today, endDate: today, expected: 'applied' }
  ]) {
    await t.test(scenario.name, async () => {
      const fixture = createFixture({
        levels: [
          { level_id: '20', policy_id: '10', level_number: 1, target_type: 'team', target_id: '7', wait_minutes: 0 }
        ],
        schedules: [{
          schedule_id: '1',
          team_id: '7',
          start_date: scenario.startDate,
          end_date: scenario.endDate
        }],
        onCallAssignments: [{
          assignment_id: '8',
          schedule_id: '1',
          team_id: '7',
          user_id: '3',
          start_time: '2026-10-27T11:00:00.000Z',
          end_time: '2026-10-27T13:00:00.000Z'
        }]
      });
      await fixture.worker.tick();
      assert.equal(fixture.repository.state.executions[0].status, scenario.expected);
      assert.equal(fixture.repository.state.assignments.length, scenario.expected === 'applied' ? 1 : 0);
    });
  }
});

test('unsupported targets and ambiguous team policies are not guessed', async (t) => {
  await t.test('unsupported target', async () => {
    const fixture = createFixture({
      levels: [
        { level_id: '20', policy_id: '10', level_number: 1, target_type: 'service', target_id: '9', wait_minutes: 0 }
      ]
    });
    await fixture.worker.tick();
    assert.equal(fixture.repository.state.executions[0].status, 'failed');
    assert.match(fixture.repository.state.executions[0].last_error, /Unsupported escalation target type/);
  });

  await t.test('ambiguous active policies', async () => {
    const fixture = createFixture({
      policies: [
        { policy_id: '10', team_id: '7', is_active: true },
        { policy_id: '11', team_id: '7', is_active: true }
      ]
    });
    await fixture.worker.tick();
    assert.equal(fixture.repository.state.executions.length, 0);
    assert.equal(fixture.repository.state.assignments.length, 0);
    assert.match(fixture.errors.join(' '), /multiple active policies/);
  });
});

test('an already-active manual assignment is not duplicated', async () => {
  const fixture = createFixture({
    levels: [
      { level_id: '20', policy_id: '10', level_number: 1, target_type: 'user', target_id: '2', wait_minutes: 0 }
    ]
  });
  fixture.repository.state.assignments.push({
    assignment_id: 'manual-1',
    incident_id: '100',
    user_id: '2',
    assignment_type: 'responder',
    unassigned_at: null
  });
  await fixture.worker.tick();
  assert.equal(fixture.repository.state.assignments.length, 1);
  assert.equal(fixture.repository.state.executions[0].outcome, 'already_assigned');
  assert.equal(fixture.notifications.length, 0);
});

test('multiple workers do not duplicate a concurrent escalation step', async () => {
  const fixture = createFixture({
    levels: [
      { level_id: '20', policy_id: '10', level_number: 1, target_type: 'user', target_id: '2', wait_minutes: 0 }
    ]
  });
  const secondWorker = createEscalationWorker({
    repository: fixture.repository,
    eventWriter: fixture.eventWriter,
    notifier: async (notification) => fixture.notifications.push(notification),
    logger: { error: (...args) => fixture.errors.push(args.join(' ')) },
    clock: () => NOW
  });

  await Promise.all([fixture.worker.tick(), secondWorker.tick()]);
  assert.equal(fixture.repository.state.assignments.length, 1);
  assert.equal(fixture.repository.state.executions.length, 1);
  assert.equal(fixture.events.length, 1);
  assert.equal(fixture.notifications.length, 1);
});

test('a fresh worker recovers failed pending work after a responder becomes available', async () => {
  const fixture = createFixture({
    levels: [
      { level_id: '20', policy_id: '10', level_number: 1, target_type: 'team', target_id: '7', wait_minutes: 0 }
    ]
  });
  await fixture.worker.tick();
  assert.equal(fixture.repository.state.executions[0].status, 'failed');

  fixture.repository.state.onCallAssignments.push({
    assignment_id: '9',
    schedule_id: '1',
    team_id: '7',
    user_id: '2',
    start_time: '2026-10-27T11:00:00.000Z',
    end_time: '2026-10-27T13:00:00.000Z'
  });
  const restartedWorker = createEscalationWorker({
    repository: fixture.repository,
    eventWriter: fixture.eventWriter,
    notifier: async (notification) => fixture.notifications.push(notification),
    logger: { error: (...args) => fixture.errors.push(args.join(' ')) },
    clock: () => NOW
  });
  await restartedWorker.tick();
  assert.equal(fixture.repository.state.executions[0].status, 'applied');
  assert.equal(fixture.repository.state.executions[0].attempt_count, 2);
  assert.equal(fixture.repository.state.assignments.length, 1);
});

test('notification failures are recorded and retried with a stable idempotency key', async () => {
  const fixture = createFixture({
    levels: [
      { level_id: '20', policy_id: '10', level_number: 1, target_type: 'user', target_id: '2', wait_minutes: 0 }
    ]
  });
  const keys = [];
  let shouldFail = true;
  const worker = createEscalationWorker({
    repository: fixture.repository,
    eventWriter: fixture.eventWriter,
    notifier: async ({ idempotencyKey }) => {
      keys.push(idempotencyKey);
      if (shouldFail) throw new Error('development logger unavailable');
    },
    logger: { error: (...args) => fixture.errors.push(args.join(' ')) },
    clock: () => NOW
  });

  await worker.tick();
  assert.equal(fixture.repository.state.executions[0].notification_status, 'failed');
  shouldFail = false;
  await worker.tick();
  assert.equal(fixture.repository.state.executions[0].notification_status, 'logged');
  assert.equal(fixture.repository.state.assignments.length, 1);
  assert.deepEqual(keys, ['incident-escalation-1', 'incident-escalation-1']);
});

test('Mongo event failure rolls back assignment and persists retryable failure', async () => {
  const fixture = createFixture({
    levels: [
      { level_id: '20', policy_id: '10', level_number: 1, target_type: 'user', target_id: '2', wait_minutes: 0 }
    ]
  });
  let failEvent = true;
  const worker = createEscalationWorker({
    repository: fixture.repository,
    eventWriter: async (event) => {
      if (failEvent) throw new Error('Mongo unavailable');
      return fixture.eventWriter(event);
    },
    notifier: async (notification) => fixture.notifications.push(notification),
    logger: { error: (...args) => fixture.errors.push(args.join(' ')) },
    clock: () => NOW
  });

  await worker.tick();
  assert.equal(fixture.repository.state.assignments.length, 0);
  assert.equal(fixture.repository.state.executions[0].status, 'failed');
  failEvent = false;
  await worker.tick();
  assert.equal(fixture.repository.state.assignments.length, 1);
  assert.equal(fixture.repository.state.executions[0].status, 'applied');
});

test('commit failure compensates Mongo event and leaves retryable execution state', async () => {
  const fixture = createFixture({
    levels: [
      { level_id: '20', policy_id: '10', level_number: 1, target_type: 'user', target_id: '2', wait_minutes: 0 }
    ],
    failCommitCount: 1
  });
  await fixture.worker.tick();
  assert.equal(fixture.events.length, 0);
  assert.equal(fixture.repository.state.assignments.length, 0);
  assert.equal(fixture.repository.state.executions[0].status, 'failed');
  await fixture.worker.tick();
  assert.equal(fixture.repository.state.assignments.length, 1);
  assert.equal(fixture.repository.state.executions[0].status, 'applied');
});

test('worker refuses to start until its additive migration has been applied', async () => {
  const fixture = createFixture();
  const unavailable = createMemoryRepository({ migrationReady: false });
  const worker = createEscalationWorker({
    repository: unavailable,
    logger: { error() {} },
    intervalMs: 60_000
  });
  await assert.rejects(worker.start(), /migration is not applied/);
  await worker.stop();
  assert.equal(fixture.repository.state.assignments.length, 0);
});

test('shutdown during the initial worker cycle prevents polling timer installation', async () => {
  const fixture = createFixture();
  let releaseCandidateLoad;
  let candidateLoadStarted;
  const loadStarted = new Promise((resolve) => { candidateLoadStarted = resolve; });
  const candidateLoad = new Promise((resolve) => { releaseCandidateLoad = resolve; });
  fixture.repository.listCandidateIncidentIds = async () => {
    candidateLoadStarted();
    return candidateLoad;
  };
  let timerInstallations = 0;
  let timerClears = 0;
  const worker = createEscalationWorker({
    repository: fixture.repository,
    eventWriter: fixture.eventWriter,
    notifier: async () => {},
    logger: { error: (...args) => fixture.errors.push(args.join(' ')) },
    clock: () => NOW,
    setIntervalFn: () => {
      timerInstallations += 1;
      return 1;
    },
    clearIntervalFn: () => { timerClears += 1; }
  });

  const starting = worker.start();
  await loadStarted;
  const stopping = worker.stop();
  releaseCandidateLoad([]);
  await Promise.all([starting, stopping]);

  assert.equal(timerInstallations, 0);
  assert.equal(timerClears, 0);
  await assert.rejects(worker.start(), /worker is stopping/);
});
