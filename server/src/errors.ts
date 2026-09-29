import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Not found') => new HttpError(404, what);
export const forbidden = (what = 'Forbidden') => new HttpError(403, what);
export const conflict = (what: string, code?: string) => new HttpError(409, what, code);
export const badRequest = (what: string) => new HttpError(400, what);

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  if (err?.code === 'ER_DUP_ENTRY') {
    res.status(409).json({ error: 'Already exists' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
};
