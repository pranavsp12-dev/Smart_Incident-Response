import {
  createEscalationLevel as createLevelRecord,
  createEscalationPolicy as createPolicyRecord,
  deleteEscalationLevel as deleteLevelRecord,
  deleteEscalationPolicy as deletePolicyRecord,
  getEscalationLevel as getLevelRecord,
  getEscalationPolicy as getPolicyRecord,
  listEscalationLevels as listLevelRecords,
  listEscalationPolicies as listPolicyRecords,
  updateEscalationLevel as updateLevelRecord,
  updateEscalationPolicy as updatePolicyRecord
} from '../services/escalationPolicies.service.js';
import { pgPool } from '../config/postgres.js';
import { HttpError } from '../utils/httpError.js';
import { parsePositiveId, rejectUnknownFields, requireObject } from '../utils/validation.js';

const POLICY_CREATE_FIELDS = ['name', 'description', 'teamId', 'isActive'];
const POLICY_UPDATE_FIELDS = ['name', 'description', 'teamId', 'isActive'];
const LEVEL_CREATE_FIELDS = ['levelNumber', 'targetType', 'targetId', 'waitMinutes'];
const LEVEL_UPDATE_FIELDS = LEVEL_CREATE_FIELDS;
const MAX_INT = 2147483647;

function assertKnownRole(actor) {
  if (!['admin', 'manager', 'engineer'].includes(actor.role)) {
    throw new HttpError(403, 'You do not have permission to access escalation policies.');
  }
}

function assertCanManage(actor) {
  assertKnownRole(actor);
  if (actor.role !== 'admin' && actor.role !== 'manager') {
    throw new HttpError(403, 'Only admins and managers may manage escalation policies.');
  }
  if (actor.role === 'manager' && actor.teamId === null) {
    throw new HttpError(403, 'Managers must belong to a team to manage escalation policies.');
  }
}

function validateName(value, required = false) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 150) {
    throw new HttpError(400, 'name is required and must be 1 to 150 characters.');
  }
  return value.trim();
}

function validateDescription(value) {
  if (value !== null && typeof value !== 'string') {
    throw new HttpError(400, 'description must be a string or null.');
  }
  return value;
}

function validateTeamId(value, required = false) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new HttpError(400, 'teamId must be a positive integer.');
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new HttpError(400, 'teamId must be a safely representable positive integer.');
  }
  return parsePositiveId(String(value), 'teamId');
}

async function assertTeamExists(teamId) {
  const result = await pgPool.query('SELECT team_id FROM team WHERE team_id = $1', [teamId]);
  if (result.rowCount === 0) throw new HttpError(400, 'The specified team does not exist.');
}

function validatePolicyBody(value, { partial = false, actor }) {
  const body = requireObject(value);
  rejectUnknownFields(body, partial ? POLICY_UPDATE_FIELDS : POLICY_CREATE_FIELDS);
  const name = validateName(body.name, !partial);
  const description = Object.hasOwn(body, 'description')
    ? validateDescription(body.description)
    : undefined;
  const requestedTeamId = validateTeamId(body.teamId, !partial && actor.role === 'admin');
  if (Object.hasOwn(body, 'isActive') && typeof body.isActive !== 'boolean') {
    throw new HttpError(400, 'isActive must be a boolean.');
  }
  if (partial && Object.keys(body).length === 0) {
    throw new HttpError(400, 'At least one policy field must be provided.');
  }
  if (actor.role === 'manager') {
    if (Object.hasOwn(body, 'teamId')) {
      throw new HttpError(403, 'Only admins may provide or change a policy team.');
    }
    return {
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(Object.hasOwn(body, 'isActive') ? { isActive: body.isActive } : {}),
      ...(!partial ? { teamId: actor.teamId } : {})
    };
  }
  return {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(requestedTeamId !== undefined ? { teamId: requestedTeamId } : {}),
    ...(Object.hasOwn(body, 'isActive') ? { isActive: body.isActive } : {})
  };
}

function validatePositiveInt(value, label, { minimum = 1, required = true } = {}) {
  if (value === undefined && !required) return undefined;
  if (!Number.isSafeInteger(value) || value < minimum || value > MAX_INT) {
    throw new HttpError(400, `${label} must be an integer from ${minimum} to ${MAX_INT}.`);
  }
  return value;
}

function validateTargetId(value, required = true) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new HttpError(400, 'targetId must be a positive integer.');
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new HttpError(400, 'targetId must be a safely representable positive integer.');
  }
  return parsePositiveId(String(value), 'targetId');
}

function validateTargetType(value, required = true) {
  if (value === undefined && !required) return undefined;
  if (!['user', 'team'].includes(value)) {
    throw new HttpError(400, 'targetType must be user or team.');
  }
  return value;
}

function validateLevelBody(value, { partial = false } = {}) {
  const body = requireObject(value);
  rejectUnknownFields(body, partial ? LEVEL_UPDATE_FIELDS : LEVEL_CREATE_FIELDS);
  if (partial && Object.keys(body).length === 0) {
    throw new HttpError(400, 'At least one level field must be provided.');
  }
  return {
    ...(Object.hasOwn(body, 'levelNumber')
      ? { levelNumber: validatePositiveInt(body.levelNumber, 'levelNumber') }
      : !partial
        ? { levelNumber: validatePositiveInt(undefined, 'levelNumber') }
        : {}),
    ...(Object.hasOwn(body, 'targetType')
      ? { targetType: validateTargetType(body.targetType) }
      : !partial
        ? { targetType: validateTargetType(undefined) }
        : {}),
    ...(Object.hasOwn(body, 'targetId')
      ? { targetId: validateTargetId(body.targetId) }
      : !partial
        ? { targetId: validateTargetId(undefined) }
        : {}),
    ...(Object.hasOwn(body, 'waitMinutes')
      ? { waitMinutes: validatePositiveInt(body.waitMinutes, 'waitMinutes', { minimum: 0 }) }
      : !partial
        ? { waitMinutes: 5 }
        : {})
  };
}

export async function listEscalationPolicies(req, res, next) {
  try {
    assertKnownRole(req.user);
    res.status(200).json({ data: await listPolicyRecords(req.user) });
  } catch (error) {
    next(error);
  }
}

export async function getEscalationPolicy(req, res, next) {
  try {
    assertKnownRole(req.user);
    const policyId = parsePositiveId(req.params.policyId, 'policyId');
    const policy = await getPolicyRecord(policyId, req.user);
    if (!policy) throw new HttpError(404, 'Escalation policy not found.');
    res.status(200).json({ data: policy });
  } catch (error) {
    next(error);
  }
}

export async function createEscalationPolicy(req, res, next) {
  try {
    assertCanManage(req.user);
    const fields = validatePolicyBody(req.body, { actor: req.user });
    if (req.user.role === 'admin') {
      if (fields.teamId === undefined) {
        throw new HttpError(400, 'teamId is required.');
      }
      await assertTeamExists(fields.teamId);
    }
    const policy = await createPolicyRecord({
      name: fields.name,
      description: fields.description ?? null,
      teamId: fields.teamId ?? req.user.teamId,
      isActive: fields.isActive ?? true
    });
    res.status(201).json({ data: policy });
  } catch (error) {
    next(error);
  }
}

export async function updateEscalationPolicy(req, res, next) {
  try {
    assertCanManage(req.user);
    const policyId = parsePositiveId(req.params.policyId, 'policyId');
    const fields = validatePolicyBody(req.body, { partial: true, actor: req.user });
    if (Object.hasOwn(fields, 'teamId')) await assertTeamExists(fields.teamId);
    const policy = await updatePolicyRecord(policyId, fields, req.user);
    res.status(200).json({ data: policy });
  } catch (error) {
    next(error);
  }
}

export async function deleteEscalationPolicy(req, res, next) {
  try {
    assertCanManage(req.user);
    const policyId = parsePositiveId(req.params.policyId, 'policyId');
    await deletePolicyRecord(policyId, req.user);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}

export async function listEscalationLevels(req, res, next) {
  try {
    assertKnownRole(req.user);
    const policyId = parsePositiveId(req.params.policyId, 'policyId');
    res.status(200).json({ data: await listLevelRecords(policyId, req.user) });
  } catch (error) {
    next(error);
  }
}

export async function getEscalationLevel(req, res, next) {
  try {
    assertKnownRole(req.user);
    const policyId = parsePositiveId(req.params.policyId, 'policyId');
    const levelId = parsePositiveId(req.params.levelId, 'levelId');
    const level = await getLevelRecord(policyId, levelId, req.user);
    if (!level) throw new HttpError(404, 'Escalation level not found.');
    res.status(200).json({ data: level });
  } catch (error) {
    next(error);
  }
}

export async function createEscalationLevel(req, res, next) {
  try {
    assertCanManage(req.user);
    const policyId = parsePositiveId(req.params.policyId, 'policyId');
    const level = await createLevelRecord(
      policyId,
      validateLevelBody(req.body),
      req.user
    );
    res.status(201).json({ data: level });
  } catch (error) {
    next(error);
  }
}

export async function updateEscalationLevel(req, res, next) {
  try {
    assertCanManage(req.user);
    const policyId = parsePositiveId(req.params.policyId, 'policyId');
    const levelId = parsePositiveId(req.params.levelId, 'levelId');
    const level = await updateLevelRecord(
      policyId,
      levelId,
      validateLevelBody(req.body, { partial: true }),
      req.user
    );
    res.status(200).json({ data: level });
  } catch (error) {
    next(error);
  }
}

export async function deleteEscalationLevel(req, res, next) {
  try {
    assertCanManage(req.user);
    const policyId = parsePositiveId(req.params.policyId, 'policyId');
    const levelId = parsePositiveId(req.params.levelId, 'levelId');
    await deleteLevelRecord(policyId, levelId, req.user);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}
