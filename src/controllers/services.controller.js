import {
  assertTeamExists,
  createService as createServiceRecord,
  deactivateService as deactivateServiceRecord,
  getService as getServiceRecord,
  listServices as listServiceRecords,
  updateService as updateServiceRecord
} from '../services/services.service.js';
import { HttpError } from '../utils/httpError.js';
import { parsePositiveId, rejectUnknownFields, requireObject } from '../utils/validation.js';

const CRITICALITIES = ['low', 'medium', 'high', 'critical'];
const CREATE_FIELDS = ['name', 'description', 'criticality', 'teamId'];
const UPDATE_FIELDS = ['name', 'description', 'criticality', 'teamId'];

function validateName(name, { required = false } = {}) {
  if (name === undefined && !required) return;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 150) {
    throw new HttpError(400, 'name must be 1 to 150 characters.');
  }
}

function validateDescription(description) {
  if (description !== null && typeof description !== 'string') {
    throw new HttpError(400, 'description must be a string or null.');
  }
}

function validateCriticality(criticality, { required = false } = {}) {
  if (criticality === undefined && !required) return;
  if (!CRITICALITIES.includes(criticality)) {
    throw new HttpError(400, `criticality must be one of: ${CRITICALITIES.join(', ')}.`);
  }
}

function validateTeamId(teamId) {
  if (teamId === null) return null;
  if (typeof teamId === 'number' && !Number.isSafeInteger(teamId)) {
    throw new HttpError(400, 'teamId must be a positive integer or null.');
  }
  if (typeof teamId !== 'string' && typeof teamId !== 'number') {
    throw new HttpError(400, 'teamId must be a positive integer or null.');
  }
  return parsePositiveId(String(teamId), 'teamId');
}

function validateFields(value, { partial = false, role, teamId: actorTeamId } = {}) {
  const body = requireObject(value);
  rejectUnknownFields(body, partial ? UPDATE_FIELDS : CREATE_FIELDS);

  validateName(body.name, { required: !partial });
  if (Object.hasOwn(body, 'description')) validateDescription(body.description);
  validateCriticality(body.criticality);

  if (partial && Object.keys(body).length === 0) {
    throw new HttpError(400, 'At least one service field must be provided.');
  }

  const requestedTeamId = Object.hasOwn(body, 'teamId')
    ? validateTeamId(body.teamId)
    : undefined;

  if (role === 'manager') {
    if (actorTeamId === null) {
      throw new HttpError(403, 'Managers must belong to a team to manage services.');
    }
    if (requestedTeamId !== undefined && requestedTeamId !== actorTeamId) {
      throw new HttpError(403, 'Managers can only manage services in their own team.');
    }
  }

  return {
    ...(Object.hasOwn(body, 'name') ? { name: body.name.trim() } : {}),
    ...(Object.hasOwn(body, 'description') ? { description: body.description } : {}),
    ...(Object.hasOwn(body, 'criticality') ? { criticality: body.criticality } : {}),
    ...(Object.hasOwn(body, 'teamId')
      ? { teamId: requestedTeamId }
      : role === 'manager'
        ? { teamId: actorTeamId }
        : !partial
          ? { teamId: null }
          : {})
  };
}

function assertCanManage(req) {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    throw new HttpError(403, 'You do not have permission to manage services.');
  }
  if (req.user.role === 'manager' && req.user.teamId === null) {
    throw new HttpError(403, 'Managers must belong to a team to manage services.');
  }
}

function serviceScope(req, { forManagement = false } = {}) {
  if (req.user.role === 'admin') {
    return { includeInactive: true };
  }
  if (req.user.role === 'manager' && req.user.teamId !== null) {
    return { teamId: req.user.teamId, includeInactive: true };
  }
  if (forManagement && req.user.role === 'manager') {
    throw new HttpError(403, 'Managers must belong to a team to manage services.');
  }
  return { teamId: req.user.teamId };
}

export async function listServices(req, res, next) {
  try {
    if (req.user.role === 'manager' && req.user.teamId === null) {
      throw new HttpError(403, 'Managers must belong to a team to view services.');
    }
    res.status(200).json({
      data: await listServiceRecords(serviceScope(req))
    });
  } catch (error) {
    next(error);
  }
}

export async function getService(req, res, next) {
  try {
    const serviceId = parsePositiveId(req.params.serviceId, 'serviceId');
    const service = await getServiceRecord(serviceId, serviceScope(req));
    if (!service) {
      throw new HttpError(404, 'Service not found.');
    }
    res.status(200).json({ data: service });
  } catch (error) {
    next(error);
  }
}

export async function createService(req, res, next) {
  try {
    assertCanManage(req);
    const fields = validateFields(req.body, {
      role: req.user.role,
      teamId: req.user.teamId
    });
    await assertTeamExists(fields.teamId);
    const service = await createServiceRecord({
      ...fields,
      criticality: fields.criticality ?? 'medium'
    });
    res.status(201).json({ data: service });
  } catch (error) {
    next(error);
  }
}

export async function updateService(req, res, next) {
  try {
    assertCanManage(req);
    const serviceId = parsePositiveId(req.params.serviceId, 'serviceId');
    const scope = serviceScope(req, { forManagement: true });
    const existing = await getServiceRecord(serviceId, scope);
    if (!existing) {
      throw new HttpError(404, 'Service not found.');
    }

    const fields = validateFields(req.body, {
      partial: true,
      role: req.user.role,
      teamId: req.user.teamId
    });
    if (Object.hasOwn(fields, 'teamId')) {
      await assertTeamExists(fields.teamId);
    }

    const service = await updateServiceRecord(serviceId, fields, {
      ...(req.user.role === 'manager' ? { teamId: req.user.teamId } : {})
    });
    if (!service) {
      throw new HttpError(404, 'Service not found.');
    }
    res.status(200).json({ data: service });
  } catch (error) {
    next(error);
  }
}

export async function deactivateService(req, res, next) {
  try {
    assertCanManage(req);
    const serviceId = parsePositiveId(req.params.serviceId, 'serviceId');
    const service = await deactivateServiceRecord(serviceId, {
      ...(req.user.role === 'manager' ? { teamId: req.user.teamId } : {})
    });
    if (!service) {
      throw new HttpError(404, 'Service not found or already inactive.');
    }
    res.status(200).json({ data: service });
  } catch (error) {
    next(error);
  }
}
