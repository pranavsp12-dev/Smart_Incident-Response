async function writeDevelopmentNotification(notification, output) {
  const eventTypes = notification.eventTypes ?? [notification.eventType];
  output(JSON.stringify({
    type: 'development.notification',
    idempotencyKey: notification.idempotencyKey,
    eventType: notification.eventType,
    eventTypes,
    incidentId: notification.incidentId,
    assignmentId: notification.assignmentId,
    recipientUserId: notification.recipientUserId,
    actorUserId: notification.actorUserId,
    assignmentType: notification.assignmentType,
    message: 'No delivery provider is configured; this is a development log only.'
  }));
  return { status: 'logged', mode: 'development' };
}

export async function notifyAssignment(notification, output = console.info) {
  return writeDevelopmentNotification({
    ...notification,
    eventType: notification.eventType ?? 'incident.assignment.created'
  }, output);
}

export async function notifyEscalation(notification, output = console.info) {
  return writeDevelopmentNotification({
    ...notification,
    eventType: 'incident.escalation.applied',
    eventTypes: ['incident.assignment.created', 'incident.escalation.applied']
  }, output);
}
