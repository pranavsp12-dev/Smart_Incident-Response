import { authenticateCredentials, createAccessToken, TOKEN_TTL_SECONDS } from '../services/auth.service.js';
import { HttpError } from '../utils/httpError.js';
import { rejectUnknownFields, requireObject } from '../utils/validation.js';

export async function login(req, res, next) {
  try {
    const body = requireObject(req.body);
    rejectUnknownFields(body, ['email', 'password']);

    if (typeof body.email !== 'string' || !body.email.trim() ||
        typeof body.password !== 'string' || !body.password ||
        Buffer.byteLength(body.password, 'utf8') > 72) {
      throw new HttpError(400, 'A valid email and password are required.');
    }

    const email = body.email.trim().toLowerCase();
    const user = await authenticateCredentials(email, body.password);
    if (!user) {
      throw new HttpError(401, 'Invalid email or password.');
    }

    res.status(200).json({
      accessToken: createAccessToken(user),
      tokenType: 'Bearer',
      expiresIn: TOKEN_TTL_SECONDS,
      user: {
        id: String(user.user_id),
        name: user.name,
        email: user.email,
        role: user.role,
        teamId: user.team_id === null ? null : String(user.team_id)
      }
    });
  } catch (error) {
    next(error);
  }
}
