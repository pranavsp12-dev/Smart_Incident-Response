import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { pgPool } from '../config/postgres.js';
import { HttpError } from '../utils/httpError.js';

const TOKEN_TTL_SECONDS = 60 * 60;
const JWT_ISSUER = 'smart-incident-api';

function requireJwtSecret() {
  if (env.JWT_SECRET.length < 32) {
    throw new HttpError(500, 'JWT_SECRET must contain at least 32 characters.');
  }

  return env.JWT_SECRET;
}

export async function authenticateCredentials(email, password) {
  const result = await pgPool.query(
    `SELECT user_id, name, email, password_hash, role, team_id, is_active
     FROM app_user
     WHERE LOWER(email) = $1`,
    [email]
  );
  const user = result.rows[0];

  if (!user || !user.is_active || !(await bcrypt.compare(password, user.password_hash))) {
    return null;
  }

  return user;
}

export function createAccessToken(user) {
  const secret = requireJwtSecret();

  return jwt.sign(
    {
      role: user.role,
      teamId: user.team_id === null ? null : String(user.team_id)
    },
    secret,
    {
      algorithm: 'HS256',
      subject: String(user.user_id),
      issuer: JWT_ISSUER,
      audience: JWT_ISSUER,
      expiresIn: TOKEN_TTL_SECONDS
    }
  );
}

export function verifyAccessToken(token) {
  const secret = requireJwtSecret();

  return jwt.verify(token, secret, {
    algorithms: ['HS256'],
    issuer: JWT_ISSUER,
    audience: JWT_ISSUER
  });
}

export { TOKEN_TTL_SECONDS };
