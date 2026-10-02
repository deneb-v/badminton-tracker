import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { execute, pool, query, transaction } from '../db.js';
import { requireAuth, signToken, userIdOf } from '../auth.js';
import { HttpError } from '../errors.js';
import { groupForCode, joinGroup } from '../services/invites.js';

export const authRouter = Router();

const email = z.string().trim().toLowerCase().email().max(190);
const password = z.string().min(8).max(200);

/**
 * Public: a page load the web app sends the browser to when an API call was redirected to a login
 * page by a proxy in front of the app (Cloudflare Access, once its session has expired). Loading it
 * as a page lets the proxy run its login; afterwards it lands here again and is sent back into the
 * app. The PWA's offline cache never serves /api/ URLs, so this always reaches the network.
 */
authRouter.get('/auth/cloudflare', (req, res) => {
  const back = typeof req.query.return === 'string' ? req.query.return : '/';
  // Only paths on this site: "/x", not "//evil.com" or "/\\evil.com".
  res.redirect(302, /^\/(?![/\\])/.test(back) ? back : '/');
});

/** Public: which group an invite code belongs to, so the join screen can name it. */
authRouter.get('/invites/:code', async (req, res) => {
  const g = await groupForCode(pool, String(req.params.code));
  res.json({ groupName: g.name });
});

/**
 * Sign-up is invite-only: a new player creates their login with a group's invite code. An
 * existing account can use this too (it must give the right password) to join another group.
 */
authRouter.post('/auth/join', async (req, res) => {
  const body = z
    .object({ code: z.string().min(1).max(20), name: z.string().trim().min(1).max(100), email, password })
    .parse(req.body);
  const userId = await transaction(async (conn) => {
    const g = await groupForCode(conn, body.code);
    const [user] = await query<{ id: number; password_hash: string }>(
      conn,
      'SELECT id, password_hash FROM users WHERE email = ?',
      [body.email],
    );
    let id: number;
    if (user) {
      if (!(await bcrypt.compare(body.password, user.password_hash))) {
        throw new HttpError(409, 'That email already has an account. Sign in with it, then join from Your groups.');
      }
      id = user.id;
    } else {
      const r = await execute(conn, 'INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)', [
        body.email,
        await bcrypt.hash(body.password, 10),
        body.name,
      ]);
      id = r.insertId;
    }
    await joinGroup(conn, g.id, id, body.name);
    return id;
  });
  res.status(201).json({ token: signToken(userId) });
});

authRouter.post('/auth/login', async (req, res) => {
  const body = z.object({ email, password: z.string() }).parse(req.body);
  const [user] = await query<{ id: number; password_hash: string }>(
    pool,
    'SELECT id, password_hash FROM users WHERE email = ?',
    [body.email],
  );
  if (!user || !(await bcrypt.compare(body.password, user.password_hash))) {
    throw new HttpError(401, 'Wrong email or password');
  }
  res.json({ token: signToken(user.id) });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const userId = userIdOf(req);
  const [user] = await query<{ id: number; email: string; name: string }>(
    pool,
    'SELECT id, email, name FROM users WHERE id = ?',
    [userId],
  );
  if (!user) throw new HttpError(401, 'Not signed in');
  const rows = await query<{
    groupId: number;
    groupName: string;
    memberId: number;
    role: string;
    venue: string;
    usual_days: string;
    memberCount: number;
  }>(
    pool,
    `SELECT g.id AS groupId, g.name AS groupName, m.id AS memberId, m.role, g.venue, g.usual_days,
       (SELECT COUNT(*) FROM members x WHERE x.group_id = g.id AND x.active = 1 AND x.is_guest = 0) AS memberCount
     FROM members m JOIN \`groups\` g ON g.id = m.group_id
     WHERE m.user_id = ? AND m.active = 1 ORDER BY g.name`,
    [userId],
  );
  const groups = rows.map(({ usual_days, memberCount, ...g }) => ({
    ...g,
    days: usual_days ? usual_days.split(',') : [],
    memberCount: Number(memberCount),
  }));
  res.json({ user, groups });
});

authRouter.post('/me/password', requireAuth, async (req, res) => {
  const body = z.object({ current: z.string(), next: password }).parse(req.body);
  const [user] = await query<{ password_hash: string }>(pool, 'SELECT password_hash FROM users WHERE id = ?', [
    userIdOf(req),
  ]);
  if (!user || !(await bcrypt.compare(body.current, user.password_hash))) {
    throw new HttpError(400, 'Current password is wrong');
  }
  await execute(pool, 'UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(body.next, 10), userIdOf(req)]);
  res.status(204).end();
});
