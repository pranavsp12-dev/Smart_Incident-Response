import {
  assertTeamExists,
  createUser as createUserRecord,
  getUser as getUserRecord,
  listUsers as listUserRecords,
  updateUser as updateUserRecord
} from '../services/users.service.js';
import { HttpError } from '../utils/httpError.js';
import { parsePositiveId, rejectUnknownFields, requireObject } from '../utils/validation.js';

const USER_ROLES = ['admin', 'manager', 'engineer'];
const CREATE_FIELDS = ['name', 'email', 'password', 'role', 'teamId'];
const UPDATE_FIELDS = ['name', 'email', 'password', 'role', 'teamId', 'isActive'];

function validateName(name, { required = false } = {}) {
  if (name === undefined && !required) return;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
    throw new HttpError(400, 'name must be 1 to 100 characters.');
  }
}

function validateEmail(email, { required = false } = {}) {
  if (email === undefined && !required) return;
  if (typeof email !== 'string' || email.length > 255 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    throw new HttpError(400, 'A valid email address of at most 255 characters is required.');
  }
}

function validatePassword(password, { required = false } = {}) {
  if (password === undefined && !required) return;
  if (typeof password !== 'string' || password.length < 12 ||
      Buffer.byteLength(password, 'utf8') > 72) {
    throw new HttpError(400, 'password must be at least 12 characters and at most 72 UTF-8 bytes.');
  }
}

function validateTeamId(teamId) {
  if (teamId === null) return null;
  if (typeof teamId !== 'string' && typeof teamId !== 'number') {
    throw new HttpError(400, 'teamId must be a positive integer or null.');
  }
  return parsePositiveId(String(teamId), 'teamId');
}

function validateRole(role) {
  if (!USER_ROLES.includes(role)) {
    throw new HttpError(400, `role must be one of: ${USER_ROLES.join(', ')}.`);
  }
}

function validateCreateBody(value, req) {
  const body = requireObject(value);
  rejectUnknownFields(body, CREATE_FIELDS);
  validateName(body.name, { required: true });
  validateEmail(body.email, { required: true });
  validatePassword(body.password, { required: true });

  const role = body.role ?? 'engineer';
  validateRole(role);
  if (req.user.role !== 'admin' && role !== 'engineer') {
    throw new HttpError(403, 'Only admins may assign elevated roles.');
  }
  if (req.user.role !== 'admin') {
    if (req.user.teamId === null) {
      throw new HttpError(403, 'Managers must belong to a team to create users.');
    }
    if (Object.hasOwn(body, 'teamId') && validateTeamId(body.teamId) !== req.user.teamId) {
      throw new HttpError(403, 'Managers can only create users in their own team.');
    }
  }

  const teamId = req.user.role === 'admin'
    ? (Object.hasOwn(body, 'teamId') ? validateTeamId(body.teamId) : null)
    : req.user.teamId;

  return {
    name: body.name.trim(),
    email: body.email.trim().toLowerCase(),
    password: body.password,
    role,
    teamId
  };
}

function validateUpdateBody(value, req, targetUserId) {
  const body = requireObject(value);
  rejectUnknownFields(body, UPDATE_FIELDS);
  if (Object.keys(body).length === 0) {
    throw new HttpError(400, 'At least one user field must be provided.');
  }

  const isAdmin = req.user.role === 'admin';
  const isSelf = req.user.id === targetUserId;
  const isManager = req.user.role === 'manager';

  if (!isAdmin && Object.hasOwn(body, 'role')) {
    throw new HttpError(403, 'Only admins may change user roles.');
  }
  if (!isAdmin && Object.hasOwn(body, 'isActive')) {
    throw new HttpError(403, 'Only admins may change user activation status.');
  }
  if (!isAdmin && Object.hasOwn(body, 'teamId')) {
    throw new HttpError(403, 'Only admins may change a user team.');
  }
  if (!isAdmin && !isSelf && !isManager) {
    throw new HttpError(403, 'You may only update your own user profile.');
  }

  validateName(body.name);
  validateEmail(body.email);
  validatePassword(body.password);

  if (Object.hasOwn(body, 'role')) validateRole(body.role);
  if (Object.hasOwn(body, 'isActive') && typeof body.isActive !== 'boolean') {
    throw new HttpError(400, 'isActive must be a boolean.');
  }

  if (isSelf && req.user.role === 'admin' &&
      ((Object.hasOwn(body, 'role') && body.role !== 'admin') ||
       (Object.hasOwn(body, 'isActive') && body.isActive === false))) {
    throw new HttpError(400, 'Admins cannot demote or deactivate their own account.');
  }
  if (Object.hasOwn(body, 'teamId')) validateTeamId(body.teamId);

  return {
    ...(Object.hasOwn(body, 'name') ? { name: body.name.trim() } : {}),
    ...(Object.hasOwn(body, 'email') ? { email: body.email.trim().toLowerCase() } : {}),
    ...(Object.hasOwn(body, 'password') ? { password: body.password } : {}),
    ...(Object.hasOwn(body, 'role') ? { role: body.role } : {}),
    ...(Object.hasOwn(body, 'isActive') ? { isActive: body.isActive } : {}),
    ...(Object.hasOwn(body, 'teamId') ? { teamId: validateTeamId(body.teamId) } : {})
  };
}

function canAccessUser(req, user) {
  if (req.user.role === 'admin' || req.user.id === String(user.user_id)) return true;
  return req.user.role === 'manager' &&
    user.team_id !== null &&
    String(user.team_id) === req.user.teamId;
}

function assertManagerTeamTarget(req, user) {
  if (req.user.role === 'manager' &&
      (user.team_id === null || String(user.team_id) !== req.user.teamId)) {
    throw new HttpError(404, 'User not found.');
  }
}

export async function listUsers(req, res, next) {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'manager') {
      throw new HttpError(403, 'You do not have permission to list users.');
    }
    if (req.user.role === 'manager' && req.user.teamId === null) {
      throw new HttpError(403, 'Managers must belong to a team to list users.');
    }
    const users = await listUserRecords({
      teamId: req.user.role === 'manager' ? req.user.teamId : null
    });
    res.status(200).json({ data: users });
  } catch (error) {
    next(error);
  }
}

export async function getUser(req, res, next) {
  try {
    const userId = parsePositiveId(req.params.userId, 'userId');
    const user = await getUserRecord(userId);
    if (!user || !canAccessUser(req, user)) {
      throw new HttpError(404, 'User not found.');
    }
    res.status(200).json({ data: user });
  } catch (error) {
    next(error);
  }
}

export async function createUser(req, res, next) {
  try {
    const fields = validateCreateBody(req.body, req);
    await assertTeamExists(fields.teamId);
    const user = await createUserRecord(fields);
    res.status(201).json({ data: user });
  } catch (error) {
    next(error);
  }
}

export async function updateUser(req, res, next) {
  try {
    const userId = parsePositiveId(req.params.userId, 'userId');
    const existingUser = await getUserRecord(userId);
    if (!existingUser || !canAccessUser(req, existingUser)) {
      throw new HttpError(404, 'User not found.');
    }
    assertManagerTeamTarget(req, existingUser);

    const fields = validateUpdateBody(req.body, req, userId);
    await assertTeamExists(fields.teamId);
    const user = await updateUserRecord(userId, fields);
    if (!user) {
      throw new HttpError(404, 'User not found.');
    }
    res.status(200).json({ data: user });
  } catch (error) {
    next(error);
  }
}

export async function deactivateUser(req, res, next) {
  try {
    const userId = parsePositiveId(req.params.userId, 'userId');
    if (req.user.id === userId) {
      throw new HttpError(400, 'You cannot deactivate your own account.');
    }
    const user = await getUserRecord(userId);
    if (!user || !canAccessUser(req, user)) {
      throw new HttpError(404, 'User not found.');
    }
    assertManagerTeamTarget(req, user);

    const deactivated = await updateUserRecord(userId, { isActive: false });
    if (!deactivated) {
      throw new HttpError(404, 'User not found.');
    }
    res.status(200).json({ data: deactivated });
  } catch (error) {
    next(error);
  }
}
