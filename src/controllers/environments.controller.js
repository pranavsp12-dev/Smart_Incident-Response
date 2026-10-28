import {
  createEnvironment as createEnvironmentRecord,
  getEnvironment as getEnvironmentRecord,
  listEnvironments as listEnvironmentRecords,
  updateEnvironment as updateEnvironmentRecord
} from '../services/environments.service.js';
import { HttpError } from '../utils/httpError.js';
import { parsePositiveId, rejectUnknownFields, requireObject } from '../utils/validation.js';

const ENVIRONMENT_FIELDS = ['name', 'description'];

function validateEnvironmentFields(value, { partial = false } = {}) {
  const body = requireObject(value);
  rejectUnknownFields(body, ENVIRONMENT_FIELDS);

  if (!partial || Object.hasOwn(body, 'name')) {
    if (typeof body.name !== 'string' ||
        !body.name.trim() ||
        body.name.trim().length > 100) {
      throw new HttpError(400, 'name is required and must be 1 to 100 characters.');
    }
  }

  if (Object.hasOwn(body, 'description') &&
      body.description !== null &&
      typeof body.description !== 'string') {
    throw new HttpError(400, 'description must be a string or null.');
  }

  if (partial && Object.keys(body).length === 0) {
    throw new HttpError(400, 'At least one environment field must be provided.');
  }

  return {
    ...(Object.hasOwn(body, 'name') ? { name: body.name.trim() } : {}),
    ...(Object.hasOwn(body, 'description') ? { description: body.description } : {})
  };
}

function assertCanManageEnvironments(req) {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    throw new HttpError(403, 'You do not have permission to manage environments.');
  }
}

export async function listEnvironments(req, res, next) {
  try {
    res.status(200).json({ data: await listEnvironmentRecords() });
  } catch (error) {
    next(error);
  }
}

export async function getEnvironment(req, res, next) {
  try {
    const environmentId = parsePositiveId(req.params.environmentId, 'environmentId');
    const environment = await getEnvironmentRecord(environmentId);
    if (!environment) {
      throw new HttpError(404, 'Environment not found.');
    }
    res.status(200).json({ data: environment });
  } catch (error) {
    next(error);
  }
}

export async function createEnvironment(req, res, next) {
  try {
    assertCanManageEnvironments(req);
    const environment = await createEnvironmentRecord(
      validateEnvironmentFields(req.body)
    );
    res.status(201).json({ data: environment });
  } catch (error) {
    next(error);
  }
}

export async function updateEnvironment(req, res, next) {
  try {
    assertCanManageEnvironments(req);
    const environmentId = parsePositiveId(req.params.environmentId, 'environmentId');
    const fields = validateEnvironmentFields(req.body, { partial: true });
    const environment = await updateEnvironmentRecord(environmentId, fields);
    if (!environment) {
      throw new HttpError(404, 'Environment not found.');
    }
    res.status(200).json({ data: environment });
  } catch (error) {
    next(error);
  }
}
