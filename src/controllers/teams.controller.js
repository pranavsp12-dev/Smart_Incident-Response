import {
  createTeam as createTeamRecord,
  deleteTeam as deleteTeamRecord,
  getTeam as getTeamRecord,
  listTeams as listTeamRecords,
  updateTeam as updateTeamRecord
} from '../services/teams.service.js';
import { HttpError } from '../utils/httpError.js';
import { parsePositiveId, rejectUnknownFields, requireObject } from '../utils/validation.js';

const TEAM_FIELDS = ['name', 'description'];

function validateTeamFields(value, { partial = false } = {}) {
  const body = requireObject(value);
  rejectUnknownFields(body, TEAM_FIELDS);

  if (!partial || Object.hasOwn(body, 'name')) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 100) {
      throw new HttpError(400, 'name is required and must be 1 to 100 characters.');
    }
  }

  if (Object.hasOwn(body, 'description') &&
      body.description !== null &&
      typeof body.description !== 'string') {
    throw new HttpError(400, 'description must be a string or null.');
  }

  if (partial && Object.keys(body).length === 0) {
    throw new HttpError(400, 'At least one team field must be provided.');
  }

  return {
    ...(Object.hasOwn(body, 'name') ? { name: body.name.trim() } : {}),
    ...(Object.hasOwn(body, 'description') ? { description: body.description } : {})
  };
}

export async function listTeams(req, res, next) {
  try {
    res.status(200).json({ data: await listTeamRecords(req.user) });
  } catch (error) {
    next(error);
  }
}

export async function getTeam(req, res, next) {
  try {
    const teamId = parsePositiveId(req.params.teamId, 'teamId');
    const team = await getTeamRecord(teamId, req.user);
    if (!team) {
      throw new HttpError(404, 'Team not found.');
    }
    res.status(200).json({ data: team });
  } catch (error) {
    next(error);
  }
}

export async function createTeam(req, res, next) {
  try {
    const team = await createTeamRecord(validateTeamFields(req.body));
    res.status(201).json({ data: team });
  } catch (error) {
    next(error);
  }
}

export async function updateTeam(req, res, next) {
  try {
    const teamId = parsePositiveId(req.params.teamId, 'teamId');
    const fields = validateTeamFields(req.body, { partial: true });
    const team = await updateTeamRecord(teamId, fields, {
      ...(req.user.role === 'manager' ? { scopedTeamId: req.user.teamId } : {})
    });
    if (!team) {
      throw new HttpError(404, 'Team not found.');
    }
    res.status(200).json({ data: team });
  } catch (error) {
    next(error);
  }
}

export async function deleteTeam(req, res, next) {
  try {
    const teamId = parsePositiveId(req.params.teamId, 'teamId');
    const deleted = await deleteTeamRecord(teamId);
    if (!deleted) {
      throw new HttpError(404, 'Team not found.');
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}
