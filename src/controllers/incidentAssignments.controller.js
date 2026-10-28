import {
  createIncidentAssignment as createAssignmentRecord,
  getIncidentAssignment as getAssignmentRecord,
  listIncidentAssignments as listAssignmentRecords,
  unassignIncidentAssignment as unassignAssignmentRecord,
  updateIncidentAssignment as updateAssignmentRecord
} from '../services/incidentAssignments.service.js';
import { HttpError } from '../utils/httpError.js';
import { parsePositiveId, rejectUnknownFields, requireObject } from '../utils/validation.js';

const CREATE_FIELDS = ['incidentId', 'userId', 'assignmentType'];
const UPDATE_FIELDS = ['assignmentType'];

function assertAssignmentRole(actor) {
  if (!['admin', 'manager', 'engineer'].includes(actor.role)) {
    throw new HttpError(403, 'You do not have permission to access assignments.');
  }
}

function assertCanManageAssignments(actor) {
  assertAssignmentRole(actor);
  if (actor.role !== 'admin' && actor.role !== 'manager') {
    throw new HttpError(403, 'Only admins and managers may manage incident assignments.');
  }
  if (actor.role === 'manager' && actor.teamId === null) {
    throw new HttpError(403, 'Managers must belong to a team to manage assignments.');
  }
}

function validateAssignmentType(value, { required = false } = {}) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 50) {
    throw new HttpError(400, 'assignmentType must be 1 to 50 characters.');
  }
  return value.trim();
}

function validateCreateBody(value) {
  const body = requireObject(value);
  rejectUnknownFields(body, CREATE_FIELDS);
  const incidentId = parsePositiveId(String(body.incidentId ?? ''), 'incidentId');
  const userId = parsePositiveId(String(body.userId ?? ''), 'userId');
  return {
    incidentId,
    userId,
    assignmentType: validateAssignmentType(body.assignmentType) ?? 'responder'
  };
}

function validateUpdateBody(value) {
  const body = requireObject(value);
  rejectUnknownFields(body, UPDATE_FIELDS);
  return validateAssignmentType(body.assignmentType, { required: true });
}

export async function listIncidentAssignments(req, res, next) {
  try {
    assertAssignmentRole(req.user);
    res.status(200).json({ data: await listAssignmentRecords(req.user) });
  } catch (error) {
    next(error);
  }
}

export async function getIncidentAssignment(req, res, next) {
  try {
    assertAssignmentRole(req.user);
    const assignmentId = parsePositiveId(req.params.assignmentId, 'assignmentId');
    const assignment = await getAssignmentRecord(assignmentId, req.user);
    if (!assignment) throw new HttpError(404, 'Assignment not found.');
    res.status(200).json({ data: assignment });
  } catch (error) {
    next(error);
  }
}

export async function createIncidentAssignment(req, res, next) {
  try {
    assertCanManageAssignments(req.user);
    const assignment = await createAssignmentRecord(
      validateCreateBody(req.body),
      req.user,
      req.app.locals.incidentEventWriter
    );
    res.status(201).json({ data: assignment });
  } catch (error) {
    next(error);
  }
}

export async function updateIncidentAssignment(req, res, next) {
  try {
    assertCanManageAssignments(req.user);
    const assignmentId = parsePositiveId(req.params.assignmentId, 'assignmentId');
    const assignmentType = validateUpdateBody(req.body);
    const assignment = await updateAssignmentRecord(
      assignmentId,
      assignmentType,
      req.user,
      req.app.locals.incidentEventWriter
    );
    res.status(200).json({ data: assignment });
  } catch (error) {
    next(error);
  }
}

export async function unassignIncidentAssignment(req, res, next) {
  try {
    assertCanManageAssignments(req.user);
    const assignmentId = parsePositiveId(req.params.assignmentId, 'assignmentId');
    const assignment = await unassignAssignmentRecord(
      assignmentId,
      req.user,
      req.app.locals.incidentEventWriter
    );
    res.status(200).json({ data: assignment });
  } catch (error) {
    next(error);
  }
}
