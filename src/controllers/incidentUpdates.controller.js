import {
  createIncidentUpdate as createUpdateRecord,
  getIncidentUpdate as getUpdateRecord,
  listIncidentUpdates as listUpdateRecords
} from '../services/incidentUpdates.service.js';
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
const UPDATE_FIELDS = ['status', 'message'];
const MAX_MESSAGE_LENGTH = 10_000;

function assertIncidentUpdateRole(actor) {
  if (!['admin', 'manager', 'engineer'].includes(actor.role)) {
    throw new HttpError(403, 'You do not have permission to access incident updates.');
  }
}

function validateBody(value) {
  const body = requireObject(value);
  rejectUnknownFields(body, UPDATE_FIELDS);
  if (typeof body.message !== 'string' ||
      !body.message.trim() ||
      body.message.trim().length > MAX_MESSAGE_LENGTH) {
    throw new HttpError(400, `message is required and must be 1 to ${MAX_MESSAGE_LENGTH} characters.`);
  }
  if (Object.hasOwn(body, 'status') &&
      body.status !== null &&
      (typeof body.status !== 'string' || !STATUSES.includes(body.status))) {
    throw new HttpError(400, `status must be null or one of: ${STATUSES.join(', ')}.`);
  }
  return {
    message: body.message.trim(),
    status: Object.hasOwn(body, 'status') ? body.status : null
  };
}

export async function listIncidentUpdates(req, res, next) {
  try {
    assertIncidentUpdateRole(req.user);
    const incidentId = parsePositiveId(req.params.incidentId, 'incidentId');
    res.status(200).json({
      data: await listUpdateRecords(incidentId, req.user)
    });
  } catch (error) {
    next(error);
  }
}

export async function getIncidentUpdate(req, res, next) {
  try {
    assertIncidentUpdateRole(req.user);
    const incidentId = parsePositiveId(req.params.incidentId, 'incidentId');
    const updateId = parsePositiveId(req.params.updateId, 'updateId');
    const update = await getUpdateRecord(incidentId, updateId, req.user);
    if (!update) throw new HttpError(404, 'Incident update not found.');
    res.status(200).json({ data: update });
  } catch (error) {
    next(error);
  }
}

export async function createIncidentUpdate(req, res, next) {
  try {
    assertIncidentUpdateRole(req.user);
    const incidentId = parsePositiveId(req.params.incidentId, 'incidentId');
    const update = await createUpdateRecord(
      incidentId,
      validateBody(req.body),
      req.user,
      req.app.locals.incidentEventWriter
    );
    res.status(201).json({ data: update });
  } catch (error) {
    next(error);
  }
}
