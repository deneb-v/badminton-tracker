import type { Request } from 'express';
import { pool, query, Conn } from './db.js';
import { forbidden, notFound } from './errors.js';
import { userIdOf } from './auth.js';

export type Role = 'admin' | 'member';

export interface Viewer {
  memberId: number;
  groupId: number;
  role: Role;
}

export interface SessionRow {
  id: number;
  group_id: number;
  venue: string;
  date: string;
  start_time: string;
  end_time: string;
  match_type: 'singles' | 'doubles';
  status: 'scheduled' | 'live' | 'closed';
  version: number;
  level_every: number | null;
}

export async function viewerForGroup(req: Request, groupId: number, opts: { admin?: boolean } = {}): Promise<Viewer> {
  const userId = userIdOf(req);
  const [m] = await query<{ id: number; role: Role }>(
    pool,
    'SELECT id, role FROM members WHERE group_id = ? AND user_id = ? AND active = 1',
    [groupId, userId],
  );
  if (!m) throw forbidden('You are not a member of this group');
  if (opts.admin && m.role !== 'admin') throw forbidden('Admins only');
  return { memberId: m.id, groupId, role: m.role };
}

export async function loadSession(conn: Conn, sessionId: number, forUpdate = false): Promise<SessionRow> {
  const [s] = await query<SessionRow>(
    conn,
    `SELECT * FROM sessions WHERE id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
    [sessionId],
  );
  if (!s) throw notFound('Session not found');
  return s;
}

export async function viewerForSession(
  req: Request,
  sessionId: number,
  opts: { admin?: boolean } = {},
): Promise<{ viewer: Viewer; session: SessionRow }> {
  const session = await loadSession(pool, sessionId);
  const viewer = await viewerForGroup(req, session.group_id, opts);
  return { viewer, session };
}

export function intParam(value: unknown): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw notFound();
  return n;
}
