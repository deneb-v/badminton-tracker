import type { RequestHandler, Request } from 'express';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { HttpError } from './errors.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: number;
    }
  }
}

export function signToken(userId: number): string {
  return jwt.sign({ sub: String(userId) }, config.jwtSecret, { expiresIn: '30d' });
}

export function verifyToken(token: string): number | null {
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const id = Number(typeof payload === 'object' ? payload.sub : NaN);
    return Number.isInteger(id) ? id : null;
  } catch {
    return null;
  }
}

/** Accepts `Authorization: Bearer <token>`; EventSource can't set headers, so SSE passes `?token=`. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : (req.query.token as string | undefined);
  const userId = token ? verifyToken(token) : null;
  if (!userId) throw new HttpError(401, 'Not signed in');
  req.userId = userId;
  next();
};

export function userIdOf(req: Request): number {
  if (!req.userId) throw new HttpError(401, 'Not signed in');
  return req.userId;
}
