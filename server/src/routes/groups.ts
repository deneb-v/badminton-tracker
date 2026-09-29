import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { execute, pool, query, transaction } from '../db.js';
import { userIdOf } from '../auth.js';
import { intParam, viewerForGroup } from '../access.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import type { GroupRow } from '../services/session.js';
import { groupForCode, joinGroup, resetInviteCode } from '../services/invites.js';

export const groupsRouter = Router();

const level = z.number().int().min(1).max(100);
const role = z.enum(['admin', 'member']);
const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const days = z.array(z.enum(WEEK)).max(7);
const venue = z.string().trim().max(150);

/** Stored as 'Thu,Sat' in week order. */
const daysToCsv = (d: string[]) => WEEK.filter((x) => d.includes(x)).join(',');
const csvToDays = (csv: string) => (csv ? csv.split(',') : []);

groupsRouter.post('/groups', async (req, res) => {
  const body = z
    .object({
      name: z.string().trim().min(1).max(100),
      level: level.default(50),
      venue: venue.default(''),
      days: days.default([]),
      /** The starting roster (the creator is added as admin on top). */
      members: z.array(z.object({ name: z.string().trim().min(1).max(100), level })).max(200).default([]),
    })
    .parse(req.body);
  const userId = userIdOf(req);
  const groupId = await transaction(async (conn) => {
    const [user] = await query<{ name: string }>(conn, 'SELECT name FROM users WHERE id = ?', [userId]);
    const g = await execute(conn, 'INSERT INTO `groups` (name, venue, usual_days, owner_user_id) VALUES (?, ?, ?, ?)', [
      body.name,
      body.venue,
      daysToCsv(body.days),
      userId,
    ]);
    await resetInviteCode(conn, g.insertId);
    await execute(conn, 'INSERT INTO members (group_id, user_id, name, role, level) VALUES (?, ?, ?, ?, ?)', [
      g.insertId,
      userId,
      user.name,
      'admin',
      body.level,
    ]);
    if (body.members.length) {
      await execute(conn, 'INSERT INTO members (group_id, name, role, level) VALUES ?', [
        body.members.map((m) => [g.insertId, m.name, 'member', m.level]),
      ]);
    }
    return g.insertId;
  });
  res.status(201).json({ id: groupId });
});

/** Join another group with its invite code while signed in. */
groupsRouter.post('/groups/join', async (req, res) => {
  const { code } = z.object({ code: z.string().min(1).max(20) }).parse(req.body);
  const userId = userIdOf(req);
  const groupId = await transaction(async (conn) => {
    const g = await groupForCode(conn, code);
    const [user] = await query<{ name: string }>(conn, 'SELECT name FROM users WHERE id = ?', [userId]);
    await joinGroup(conn, g.id, userId, user.name);
    return g.id;
  });
  res.status(201).json({ id: groupId });
});

groupsRouter.get('/groups/:gid', async (req, res) => {
  const groupId = intParam(req.params.gid);
  const viewer = await viewerForGroup(req, groupId);
  const [g] = await query<GroupRow>(pool, 'SELECT * FROM `groups` WHERE id = ?', [groupId]);
  if (!g) throw notFound();
  const isAdmin = viewer.role === 'admin';
  // Groups from before invites existed get a code the first time an admin looks.
  const inviteCode = isAdmin ? (g.invite_code ?? (await resetInviteCode(pool, groupId))) : undefined;
  res.json({
    id: g.id,
    name: g.name,
    venue: g.venue,
    days: csvToDays(g.usual_days),
    viewer,
    ...(isAdmin && {
      inviteCode,
      ownerUserId: g.owner_user_id,
      settings: {
        singlesMaxGap: g.singles_max_gap,
        doublesMaxGap: g.doubles_max_gap,
        intraTeamMaxSpread: g.intra_team_max_spread,
        defaultMatchMinutes: g.default_match_minutes,
      },
    }),
  });
});

groupsRouter.patch('/groups/:gid', async (req, res) => {
  const groupId = intParam(req.params.gid);
  await viewerForGroup(req, groupId, { admin: true });
  const body = z
    .object({
      name: z.string().trim().min(1).max(100),
      singlesMaxGap: z.number().int().min(0).max(99),
      doublesMaxGap: z.number().int().min(0).max(99),
      intraTeamMaxSpread: z.number().int().min(0).max(99),
      defaultMatchMinutes: z.number().int().min(3).max(90),
      venue,
      days,
    })
    .partial()
    .parse(req.body);
  const cols: Record<string, unknown> = {
    name: body.name,
    venue: body.venue,
    usual_days: body.days && daysToCsv(body.days),
    singles_max_gap: body.singlesMaxGap,
    doubles_max_gap: body.doublesMaxGap,
    intra_team_max_spread: body.intraTeamMaxSpread,
    default_match_minutes: body.defaultMatchMinutes,
  };
  const set = Object.entries(cols).filter(([, v]) => v !== undefined);
  if (set.length) {
    await execute(pool, `UPDATE \`groups\` SET ${set.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`, [
      ...set.map(([, v]) => v),
      groupId,
    ]);
  }
  res.status(204).end();
});

groupsRouter.post('/groups/:gid/invite-code', async (req, res) => {
  const groupId = intParam(req.params.gid);
  await viewerForGroup(req, groupId, { admin: true });
  res.json({ inviteCode: await resetInviteCode(pool, groupId) });
});

/** Removes the group with all its members, sessions and match history. Owner only (if it has one). */
groupsRouter.delete('/groups/:gid', async (req, res) => {
  const groupId = intParam(req.params.gid);
  await viewerForGroup(req, groupId, { admin: true });
  const [g] = await query<GroupRow>(pool, 'SELECT * FROM `groups` WHERE id = ?', [groupId]);
  if (g.owner_user_id !== null && g.owner_user_id !== userIdOf(req)) {
    throw forbidden('Only the group owner can delete it');
  }
  await execute(pool, 'DELETE FROM `groups` WHERE id = ?', [groupId]);
  res.status(204).end();
});

/** Admin-only: every member's record across all sessions, including results. */
groupsRouter.get('/groups/:gid/history', async (req, res) => {
  const groupId = intParam(req.params.gid);
  await viewerForGroup(req, groupId, { admin: true });
  const rows = await query<{ id: number; name: string; sessions: number; played: number; wins: number; losses: number }>(
    pool,
    `SELECT m.id, m.name,
       (SELECT COUNT(*) FROM attendance a WHERE a.member_id = m.id AND a.status IN ('present','departed')) AS sessions,
       COUNT(x.id) AS played,
       COALESCE(SUM(x.winner_side = mp.side), 0) AS wins,
       COALESCE(SUM(x.winner_side IS NOT NULL AND x.winner_side <> mp.side), 0) AS losses
     FROM members m
     LEFT JOIN match_players mp ON mp.member_id = m.id
     LEFT JOIN matches x ON x.id = mp.match_id AND x.status = 'done'
     WHERE m.group_id = ? AND m.active = 1 AND m.is_guest = 0
     GROUP BY m.id, m.name
     ORDER BY m.name`,
    [groupId],
  );
  res.json(
    rows.map((r) => ({
      memberId: r.id,
      name: r.name,
      sessions: Number(r.sessions),
      played: Number(r.played),
      wins: Number(r.wins),
      losses: Number(r.losses),
    })),
  );
});

// --- Members --------------------------------------------------------------

interface MemberRow {
  id: number;
  name: string;
  role: 'admin' | 'member';
  level: number;
  is_guest: number;
  active: number;
  user_id: number | null;
  email: string | null;
}

groupsRouter.get('/groups/:gid/members', async (req, res) => {
  const groupId = intParam(req.params.gid);
  const viewer = await viewerForGroup(req, groupId);
  const isAdmin = viewer.role === 'admin';
  // Members only ever see the active, non-guest roster — and never levels.
  const includeInactive = isAdmin && req.query.includeInactive === '1';
  const includeGuests = isAdmin && req.query.includeGuests === '1';
  const [g] = await query<GroupRow>(pool, 'SELECT owner_user_id FROM `groups` WHERE id = ?', [groupId]);
  const rows = await query<MemberRow>(
    pool,
    `SELECT m.id, m.name, m.role, m.level, m.is_guest, m.active, m.user_id, u.email
     FROM members m LEFT JOIN users u ON u.id = m.user_id
     WHERE m.group_id = ? ${includeInactive ? '' : 'AND m.active = 1'} ${includeGuests ? '' : 'AND m.is_guest = 0'}
     ORDER BY m.name`,
    [groupId],
  );
  res.json(
    rows.map((m) => ({
      id: m.id,
      name: m.name,
      role: m.role,
      isGuest: !!m.is_guest,
      isOwner: m.user_id !== null && m.user_id === g.owner_user_id,
      ...(isAdmin && { level: m.level, active: !!m.active, email: m.email, hasLogin: m.user_id !== null }),
    })),
  );
});

const loginFields = {
  email: z.string().trim().toLowerCase().email().max(190).optional(),
  password: z.string().min(8).max(200).optional(),
};

/** Links (or creates) a login for a member. Existing accounts are linked by email, password ignored. */
async function resolveUser(conn: Parameters<typeof query>[0], email?: string, password?: string, name?: string) {
  if (!email) return null;
  const [existing] = await query<{ id: number }>(conn, 'SELECT id FROM users WHERE email = ?', [email]);
  if (existing) return existing.id;
  if (!password) throw badRequest('A new login needs an initial password (8+ characters)');
  const r = await execute(conn, 'INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)', [
    email,
    await bcrypt.hash(password, 10),
    name ?? email,
  ]);
  return r.insertId;
}

groupsRouter.post('/groups/:gid/members', async (req, res) => {
  const groupId = intParam(req.params.gid);
  await viewerForGroup(req, groupId, { admin: true });
  const body = z
    .object({ name: z.string().trim().min(1).max(100), role: role.default('member'), level, ...loginFields })
    .parse(req.body);
  const id = await transaction(async (conn) => {
    const userId = await resolveUser(conn, body.email, body.password, body.name);
    const r = await execute(conn, 'INSERT INTO members (group_id, user_id, name, role, level) VALUES (?, ?, ?, ?, ?)', [
      groupId,
      userId,
      body.name,
      body.role,
      body.level,
    ]);
    return r.insertId;
  });
  res.status(201).json({ id });
});

groupsRouter.patch('/groups/:gid/members/:mid', async (req, res) => {
  const groupId = intParam(req.params.gid);
  const memberId = intParam(req.params.mid);
  const viewer = await viewerForGroup(req, groupId, { admin: true });
  const body = z
    .object({ name: z.string().trim().min(1).max(100), role, level, active: z.boolean(), ...loginFields })
    .partial()
    .parse(req.body);
  const [member] = await query<MemberRow>(pool, 'SELECT * FROM members WHERE id = ? AND group_id = ?', [memberId, groupId]);
  if (!member) throw notFound('Member not found');
  const [g] = await query<GroupRow>(pool, 'SELECT owner_user_id FROM `groups` WHERE id = ?', [groupId]);
  if (member.user_id !== null && member.user_id === g.owner_user_id && (body.role === 'member' || body.active === false)) {
    throw forbidden('The group owner stays an admin');
  }
  if (memberId === viewer.memberId && (body.role === 'member' || body.active === false)) {
    const [{ n }] = await query<{ n: number }>(
      pool,
      "SELECT COUNT(*) AS n FROM members WHERE group_id = ? AND role = 'admin' AND active = 1",
      [groupId],
    );
    if (Number(n) <= 1) throw forbidden('A group needs at least one active admin');
  }
  await transaction(async (conn) => {
    const cols: Record<string, unknown> = {
      name: body.name,
      role: body.role,
      level: body.level,
      active: body.active,
    };
    if (body.email) cols.user_id = await resolveUser(conn, body.email, body.password, body.name ?? member.name);
    const set = Object.entries(cols).filter(([, v]) => v !== undefined);
    if (set.length) {
      await execute(conn, `UPDATE members SET ${set.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`, [
        ...set.map(([, v]) => v),
        memberId,
      ]);
    }
  });
  res.status(204).end();
});

/** FR-29: history across sessions. Members may only view their own, and never see wins/losses. */
groupsRouter.get('/groups/:gid/members/:mid/stats', async (req, res) => {
  const groupId = intParam(req.params.gid);
  const memberId = intParam(req.params.mid);
  const viewer = await viewerForGroup(req, groupId);
  const isAdmin = viewer.role === 'admin';
  if (!isAdmin && viewer.memberId !== memberId) throw forbidden();
  const [member] = await query<MemberRow>(pool, 'SELECT * FROM members WHERE id = ? AND group_id = ?', [memberId, groupId]);
  if (!member) throw notFound('Member not found');
  const sessions = await query<{
    id: number;
    date: string;
    venue: string;
    status: string;
    games: number;
    wins: number;
    losses: number;
  }>(
    pool,
    `SELECT s.id, s.date, s.venue, a.status,
       COUNT(m.id) AS games,
       SUM(m.winner_side = mp.side) AS wins,
       SUM(m.winner_side IS NOT NULL AND m.winner_side <> mp.side) AS losses
     FROM attendance a
     JOIN sessions s ON s.id = a.session_id
     LEFT JOIN match_players mp ON mp.member_id = a.member_id
       AND mp.match_id IN (SELECT id FROM matches WHERE session_id = s.id AND status = 'done')
     LEFT JOIN matches m ON m.id = mp.match_id
     WHERE a.member_id = ?
     GROUP BY s.id, s.date, s.venue, a.status
     ORDER BY s.date DESC`,
    [memberId],
  );
  const rows = sessions.map((s) => ({
    sessionId: s.id,
    date: s.date,
    venue: s.venue,
    attendance: s.status,
    gamesPlayed: Number(s.games),
    ...(isAdmin && { wins: Number(s.wins ?? 0), losses: Number(s.losses ?? 0) }),
  }));
  const total = (k: 'gamesPlayed' | 'wins' | 'losses') =>
    rows.reduce((sum, r) => sum + Number((r as Record<string, unknown>)[k] ?? 0), 0);
  res.json({
    member: { id: member.id, name: member.name, ...(isAdmin && { level: member.level }) },
    totals: {
      sessionsAttended: rows.filter((r) => r.attendance === 'present' || r.attendance === 'departed').length,
      gamesPlayed: total('gamesPlayed'),
      ...(isAdmin && { wins: total('wins'), losses: total('losses') }),
    },
    sessions: rows,
  });
});
