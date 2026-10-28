import {
  createSchedule as createScheduleRecord,
  createScheduleAssignment as createAssignmentRecord,
  deleteSchedule as deleteScheduleRecord,
  deleteScheduleAssignment as deleteAssignmentRecord,
  getSchedule as getScheduleRecord,
  getScheduleAssignment as getAssignmentRecord,
  listScheduleAssignments as listAssignmentRecords,
  listSchedules as listScheduleRecords,
  updateSchedule as updateScheduleRecord,
  updateScheduleAssignment as updateAssignmentRecord
} from '../services/onCallSchedules.service.js';
import { pgPool } from '../config/postgres.js';
import { HttpError } from '../utils/httpError.js';
import { parsePositiveId, rejectUnknownFields, requireObject } from '../utils/validation.js';

const SCHEDULE_FIELDS = ['teamId', 'name', 'rotationType', 'startDate', 'endDate'];
const ASSIGNMENT_FIELDS = ['userId', 'startTime', 'endTime'];
const MAX_BIGINT = 9223372036854775807n;

function assertKnownRole(actor) {
  if (!['admin', 'manager', 'engineer'].includes(actor.role)) {
    throw new HttpError(403, 'You do not have permission to access on-call records.');
  }
}

function assertCanManage(actor) {
  assertKnownRole(actor);
  if (actor.role !== 'admin' && actor.role !== 'manager') {
    throw new HttpError(403, 'Only admins and managers may manage on-call records.');
  }
  if (actor.role === 'manager' && actor.teamId === null) {
    throw new HttpError(403, 'Managers must belong to a team to manage on-call records.');
  }
}

function validatePositiveId(value, label) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new HttpError(400, `${label} must be a positive integer.`);
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new HttpError(400, `${label} must be a positive integer.`);
  }
  const id = String(value);
  if (!/^[0-9]+$/.test(id) || BigInt(id) < 1n || BigInt(id) > MAX_BIGINT) {
    throw new HttpError(400, `${label} must be a positive integer.`);
  }
  return id;
}

function validateTeamId(value) {
  return validatePositiveId(value, 'teamId');
}

function validateName(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw new HttpError(400, `${label} must be 1 to ${maxLength} characters.`);
  }
  return value.trim();
}

function validateDate(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(400, `${label} must be a valid YYYY-MM-DD date${nullable ? ' or null' : ''}.`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysPerMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysPerMonth[month - 1]) {
    throw new HttpError(400, `${label} must be a valid calendar date.`);
  }
  return value;
}

function validateTimestamp(value, label) {
  const timestampPattern =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d{1,6}))?(?:Z|[+-]\d{2}:\d{2})$/;
  if (typeof value !== 'string' || !timestampPattern.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new HttpError(400, `${label} must be an ISO-8601 timestamp with a timezone.`);
  }
  validateDate(value.slice(0, 10), label);
  const [hour, minute, second] = value.slice(11, 19).split(':').map(Number);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new HttpError(400, `${label} must be a valid ISO-8601 timestamp.`);
  }
  return value;
}

function timestampMicroseconds(value) {
  const milliseconds = Date.parse(value);
  const fraction = value.match(/\.(\d{1,6})(?=Z|[+-]\d{2}:\d{2}$)/)?.[1] || '';
  const subMillisecondMicroseconds = BigInt(fraction.padEnd(6, '0').slice(3, 6) || '0');
  return BigInt(milliseconds) * 1000n + subMillisecondMicroseconds;
}

async function assertTeamExists(teamId) {
  const result = await pgPool.query('SELECT team_id FROM team WHERE team_id = $1', [teamId]);
  if (result.rowCount === 0) throw new HttpError(400, 'The specified team does not exist.');
}

function validateScheduleBody(value, { partial = false, actor }) {
  const body = requireObject(value);
  rejectUnknownFields(body, SCHEDULE_FIELDS);
  if (partial && Object.keys(body).length === 0) {
    throw new HttpError(400, 'At least one schedule field must be provided.');
  }
  if (actor.role === 'manager' && Object.hasOwn(body, 'teamId')) {
    throw new HttpError(403, 'Only admins may provide or change a schedule team.');
  }

  const fields = {};
  if (Object.hasOwn(body, 'teamId')) fields.teamId = validateTeamId(body.teamId);
  else if (!partial && actor.role === 'manager') fields.teamId = actor.teamId;
  else if (!partial) throw new HttpError(400, 'teamId is required.');

  if (Object.hasOwn(body, 'name')) fields.name = validateName(body.name, 'name', 150);
  else if (!partial) throw new HttpError(400, 'name is required.');

  if (Object.hasOwn(body, 'rotationType')) {
    fields.rotationType = validateName(body.rotationType, 'rotationType', 50);
  } else if (!partial) {
    throw new HttpError(400, 'rotationType is required.');
  }

  if (Object.hasOwn(body, 'startDate')) fields.startDate = validateDate(body.startDate, 'startDate');
  else if (!partial) throw new HttpError(400, 'startDate is required.');

  if (Object.hasOwn(body, 'endDate')) {
    fields.endDate = validateDate(body.endDate, 'endDate', { nullable: true });
  } else if (!partial) {
    fields.endDate = null;
  }

  if (fields.startDate && fields.endDate && fields.endDate < fields.startDate) {
    throw new HttpError(400, 'endDate must be on or after startDate.');
  }
  return fields;
}

function validateAssignmentBody(value, { partial = false } = {}) {
  const body = requireObject(value);
  rejectUnknownFields(body, ASSIGNMENT_FIELDS);
  if (partial && Object.keys(body).length === 0) {
    throw new HttpError(400, 'At least one assignment field must be provided.');
  }
  const fields = {};
  if (Object.hasOwn(body, 'userId')) fields.userId = validatePositiveId(body.userId, 'userId');
  else if (!partial) throw new HttpError(400, 'userId is required.');
  if (Object.hasOwn(body, 'startTime')) fields.startTime = validateTimestamp(body.startTime, 'startTime');
  else if (!partial) throw new HttpError(400, 'startTime is required.');
  if (Object.hasOwn(body, 'endTime')) fields.endTime = validateTimestamp(body.endTime, 'endTime');
  else if (!partial) throw new HttpError(400, 'endTime is required.');
  if (fields.startTime && fields.endTime &&
      timestampMicroseconds(fields.endTime) <= timestampMicroseconds(fields.startTime)) {
    throw new HttpError(400, 'endTime must be later than startTime.');
  }
  return fields;
}

export async function listSchedules(req, res, next) {
  try {
    assertKnownRole(req.user);
    res.status(200).json({ data: await listScheduleRecords(req.user) });
  } catch (error) {
    next(error);
  }
}

export async function getSchedule(req, res, next) {
  try {
    assertKnownRole(req.user);
    const scheduleId = parsePositiveId(req.params.scheduleId, 'scheduleId');
    const schedule = await getScheduleRecord(scheduleId, req.user);
    if (!schedule) throw new HttpError(404, 'On-call schedule not found.');
    res.status(200).json({ data: schedule });
  } catch (error) {
    next(error);
  }
}

export async function createSchedule(req, res, next) {
  try {
    assertCanManage(req.user);
    const fields = validateScheduleBody(req.body, { actor: req.user });
    await assertTeamExists(fields.teamId);
    const schedule = await createScheduleRecord(fields);
    res.status(201).json({ data: schedule });
  } catch (error) {
    next(error);
  }
}

export async function updateSchedule(req, res, next) {
  try {
    assertCanManage(req.user);
    const scheduleId = parsePositiveId(req.params.scheduleId, 'scheduleId');
    const fields = validateScheduleBody(req.body, { partial: true, actor: req.user });
    if (fields.teamId !== undefined) await assertTeamExists(fields.teamId);
    const schedule = await updateScheduleRecord(scheduleId, fields, req.user);
    res.status(200).json({ data: schedule });
  } catch (error) {
    next(error);
  }
}

export async function deleteSchedule(req, res, next) {
  try {
    assertCanManage(req.user);
    const scheduleId = parsePositiveId(req.params.scheduleId, 'scheduleId');
    await deleteScheduleRecord(scheduleId, req.user);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}

export async function listScheduleAssignments(req, res, next) {
  try {
    assertKnownRole(req.user);
    const scheduleId = parsePositiveId(req.params.scheduleId, 'scheduleId');
    res.status(200).json({ data: await listAssignmentRecords(scheduleId, req.user) });
  } catch (error) {
    next(error);
  }
}

export async function getScheduleAssignment(req, res, next) {
  try {
    assertKnownRole(req.user);
    const scheduleId = parsePositiveId(req.params.scheduleId, 'scheduleId');
    const assignmentId = parsePositiveId(req.params.assignmentId, 'assignmentId');
    const assignment = await getAssignmentRecord(scheduleId, assignmentId, req.user);
    if (!assignment) throw new HttpError(404, 'On-call assignment not found.');
    res.status(200).json({ data: assignment });
  } catch (error) {
    next(error);
  }
}

export async function createScheduleAssignment(req, res, next) {
  try {
    assertCanManage(req.user);
    const scheduleId = parsePositiveId(req.params.scheduleId, 'scheduleId');
    const assignment = await createAssignmentRecord(
      scheduleId,
      validateAssignmentBody(req.body),
      req.user
    );
    res.status(201).json({ data: assignment });
  } catch (error) {
    next(error);
  }
}

export async function updateScheduleAssignment(req, res, next) {
  try {
    assertCanManage(req.user);
    const scheduleId = parsePositiveId(req.params.scheduleId, 'scheduleId');
    const assignmentId = parsePositiveId(req.params.assignmentId, 'assignmentId');
    const assignment = await updateAssignmentRecord(
      scheduleId,
      assignmentId,
      validateAssignmentBody(req.body, { partial: true }),
      req.user
    );
    res.status(200).json({ data: assignment });
  } catch (error) {
    next(error);
  }
}

export async function deleteScheduleAssignment(req, res, next) {
  try {
    assertCanManage(req.user);
    const scheduleId = parsePositiveId(req.params.scheduleId, 'scheduleId');
    const assignmentId = parsePositiveId(req.params.assignmentId, 'assignmentId');
    await deleteAssignmentRecord(scheduleId, assignmentId, req.user);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}
