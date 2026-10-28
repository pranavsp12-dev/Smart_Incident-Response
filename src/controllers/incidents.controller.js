import {
  createIncident as createIncidentRecord,
  getIncident as getIncidentRecord,
  listIncidents as listIncidentRecords,
  updateIncident as updateIncidentRecord
} from '../services/incidents.service.js';
import { HttpError } from '../utils/httpError.js';
import { parsePositiveId, rejectUnknownFields, requireObject } from '../utils/validation.js';

const STATUSES = [
  'open',
  'acknowledged',
  'investigating',
  'mitigated',
  'resolved',
  'closed'
];
const SEVERITIES = ['SEV1', 'SEV2', 'SEV3', 'SEV4', 'SEV5'];
const PRIORITIES = ['P1', 'P2', 'P3', 'P4', 'P5'];
const CREATE_FIELDS = [
  'serviceId',
  'environmentId',
  'title',
  'description',
  'severity',
  'priority',
  'status'
];
const UPDATE_FIELDS = ['title', 'description', 'severity', 'priority', 'status'];
const ENGINEER_UPDATE_FIELDS = ['status'];

function validateTitle(title, { required = false } = {}) {
  if (title === undefined && !required) return;
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 255) {
    throw new HttpError(400, 'title is required and must be 1 to 255 characters.');
  }
}

function validateDescription(description) {
  if (description !== null && typeof description !== 'string') {
    throw new HttpError(400, 'description must be a string or null.');
  }
}

function validateEnum(value, values, field) {
  if (!values.includes(value)) {
    throw new HttpError(400, `${field} must be one of: ${values.join(', ')}.`);
  }
}

function validateCreateBody(value) {
  const body = requireObject(value);
  rejectUnknownFields(body, CREATE_FIELDS);

  validateTitle(body.title, { required: true });
  if (Object.hasOwn(body, 'description')) validateDescription(body.description);

  const status = body.status ?? 'open';
  const severity = body.severity ?? 'SEV3';
  const priority = body.priority ?? 'P3';
  validateEnum(status, STATUSES, 'status');
  validateEnum(severity, SEVERITIES, 'severity');
  validateEnum(priority, PRIORITIES, 'priority');

  return {
    serviceId: parsePositiveId(String(body.serviceId ?? ''), 'serviceId'),
    environmentId: parsePositiveId(String(body.environmentId ?? ''), 'environmentId'),
    title: body.title.trim(),
    description: Object.hasOwn(body, 'description') ? body.description : null,
    severity,
    priority,
    status
  };
}

function validateUpdateBody(value, actor) {
  const body = requireObject(value);
  const allowedFields = actor.role === 'engineer'
    ? ENGINEER_UPDATE_FIELDS
    : UPDATE_FIELDS;
  rejectUnknownFields(body, allowedFields);
  if (Object.keys(body).length === 0) {
    throw new HttpError(400, 'At least one permitted incident field must be provided.');
  }

  validateTitle(body.title);
  if (Object.hasOwn(body, 'description')) validateDescription(body.description);
  if (Object.hasOwn(body, 'status')) validateEnum(body.status, STATUSES, 'status');
  if (Object.hasOwn(body, 'severity')) validateEnum(body.severity, SEVERITIES, 'severity');
  if (Object.hasOwn(body, 'priority')) validateEnum(body.priority, PRIORITIES, 'priority');

  return {
    ...(Object.hasOwn(body, 'title') ? { title: body.title.trim() } : {}),
    ...(Object.hasOwn(body, 'description') ? { description: body.description } : {}),
    ...(Object.hasOwn(body, 'severity') ? { severity: body.severity } : {}),
    ...(Object.hasOwn(body, 'priority') ? { priority: body.priority } : {}),
    ...(Object.hasOwn(body, 'status') ? { status: body.status } : {})
  };
}

function assertIncidentRole(actor) {
  if (!['admin', 'manager', 'engineer'].includes(actor.role)) {
    throw new HttpError(403, 'You do not have permission to access incidents.');
  }
}

export async function listIncidents(req, res, next) {
  try {
    assertIncidentRole(req.user);
    res.status(200).json({ data: await listIncidentRecords(req.user) });
  } catch (error) {
    next(error);
  }
}

export async function getIncident(req, res, next) {
  try {
    assertIncidentRole(req.user);
    const incidentId = parsePositiveId(req.params.incidentId, 'incidentId');
    const incident = await getIncidentRecord(incidentId, req.user);
    if (!incident) {
      throw new HttpError(404, 'Incident not found.');
    }
    res.status(200).json({ data: incident });
  } catch (error) {
    next(error);
  }
}

export async function createIncident(req, res, next) {
  try {
    assertIncidentRole(req.user);
    if (req.user.role !== 'admin' && req.user.teamId === null) {
      throw new HttpError(403, 'Users must belong to a team to create incidents.');
    }
    const fields = validateCreateBody(req.body);
    const incident = await createIncidentRecord(
      fields,
      req.user,
      req.app.locals.incidentEventWriter
    );
    res.status(201).json({ data: incident });
  } catch (error) {
    next(error);
  }
}

export async function updateIncident(req, res, next) {
  try {
    assertIncidentRole(req.user);
    if (req.user.role === 'manager' && req.user.teamId === null) {
      throw new HttpError(403, 'Managers must belong to a team to update incidents.');
    }
    const incidentId = parsePositiveId(req.params.incidentId, 'incidentId');
    const fields = validateUpdateBody(req.body, req.user);
    const incident = await updateIncidentRecord(
      incidentId,
      fields,
      req.user,
      req.app.locals.incidentEventWriter
    );
    res.status(200).json({ data: incident });
  } catch (error) {
    next(error);
  }
}
