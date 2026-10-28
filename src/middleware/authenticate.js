import { verifyAccessToken } from '../services/auth.service.js';
import { pgPool } from '../config/postgres.js';
import { HttpError } from '../utils/httpError.js';

export async function authenticate(req, res, next) {
  const authorization = req.get('authorization') || '';
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);

  if (!match) {
    return next(new HttpError(401, 'A bearer access token is required.'));
  }

  let claims;
  try {
    claims = verifyAccessToken(match[1]);
    if (typeof claims === 'string' || typeof claims.sub !== 'string' ||
        !/^[0-9]+$/.test(claims.sub)) {
      throw new HttpError(401, 'Invalid access token.');
    }
  } catch (error) {
    if (error instanceof HttpError) {
      return next(error);
    }
    return next(new HttpError(401, 'Invalid or expired access token.'));
  }

  try {
    const result = await pgPool.query(
      `SELECT user_id, role, team_id, is_active
       FROM app_user
       WHERE user_id = $1`,
      [claims.sub]
    );
    const user = result.rows[0];
    if (!user || !user.is_active) {
      throw new HttpError(401, 'User is inactive or no longer exists.');
    }

    req.user = {
      id: String(user.user_id),
      role: user.role,
      teamId: user.team_id === null ? null : String(user.team_id)
    };
    next();
  } catch (error) {
    if (error instanceof HttpError) {
      return next(error);
    }
    return next(error);
  }
}

export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return next(new HttpError(401, 'Authentication is required.'));
    }
    if (!allowedRoles.includes(req.user.role)) {
      return next(new HttpError(403, 'You do not have permission to perform this action.'));
    }

    next();
  };
}
