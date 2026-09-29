import { Router } from 'express';
import { z } from 'zod';
import type { PoolConnection } from 'mysql2/promise';
import { execute, pool, query, transaction } from '../db.js';
import { intParam, SessionRow, viewerForGroup, viewerForSession } from '../access.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { subscribe } from '../events.js';
import { formMatch, MatchType, playerSetKey, playersNeeded, rulesForGame, sortByPriority } from '../engine/queue.js';
import {
  clampTimestamp,
  CourtRow,
  courtType,
  engineInput,
  GroupRow,
  insertMatch,
  loadContext,
  MatchRow,
  mutateSession,
  RefreshMode,
  SessionContext,
  sessionState,
  startedCount,
  wallClock,
} from '../services/session.js';

export const sessionsRouter = Router();

const time = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'expected HH:MM');
const levelEvery = z.number().int().min(2).max(10).nullable();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const matchType = z.enum(['singles', 'doubles']);
const courtLabel = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,4}$/, 'use a neutral label like A, B, C');
const courtInput = z.object({
  label: courtLabel,
  availableFrom: time,
  availableUntil: time,
  matchType: matchType.nullable().optional(),
});

function assertWindow(from: string, until: string) {
  if (from >= until) throw badRequest('Start time must be before end time');
}

// --- Schedule (FR-5 – FR-9) ----------------------------------------------

sessionsRouter.get('/groups/:gid/sessions', async (req, res) => {
  const groupId = intParam(req.params.gid);
  const viewer = await viewerForGroup(req, groupId);
  const rows = await query<SessionRow & { present: number; invited: number; courts: number; court_types: number; mine: number }>(
    pool,
    `SELECT s.*,
       (SELECT COUNT(*) FROM attendance a WHERE a.session_id = s.id AND a.status IN ('present','departed')) AS present,
       (SELECT COUNT(*) FROM attendance a WHERE a.session_id = s.id) AS invited,
       (SELECT COUNT(*) FROM courts c WHERE c.session_id = s.id) AS courts,
       (SELECT COUNT(DISTINCT COALESCE(c.match_type, s.match_type)) FROM courts c WHERE c.session_id = s.id) AS court_types,
       (SELECT COUNT(*) FROM attendance a WHERE a.session_id = s.id AND a.member_id = ?) AS mine
     FROM sessions s WHERE s.group_id = ? ORDER BY s.date DESC, s.start_time DESC`,
    [viewer.memberId, groupId],
  );
  res.json(
    rows.map((s) => ({
      id: s.id,
      venue: s.venue,
      date: s.date,
      startTime: s.start_time.slice(0, 5),
      endTime: s.end_time.slice(0, 5),
      matchType: s.match_type,
      /** 'mixed' when some courts play singles and others doubles. */
      format: Number(s.court_types) > 1 ? 'mixed' : s.match_type,
      status: s.status,
      presentCount: Number(s.present),
      participantCount: Number(s.invited),
      courtCount: Number(s.courts),
      isParticipant: Number(s.mine) > 0,
    })),
  );
});

sessionsRouter.post('/groups/:gid/sessions', async (req, res) => {
  const groupId = intParam(req.params.gid);
  await viewerForGroup(req, groupId, { admin: true });
  const body = z
    .object({
      /** Defaults to the group's venue. */
      venue: z.string().trim().max(150).optional(),
      date,
      startTime: time,
      endTime: time,
      matchType: matchType.default('doubles'),
      levelEvery: levelEvery.optional(),
      courts: z.array(courtInput).max(12).optional(),
      /** Omit to invite the whole active group (FR-6). */
      participantIds: z.array(z.number().int()).optional(),
    })
    .parse(req.body);
  assertWindow(body.startTime, body.endTime);
  const courts = body.courts?.length
    ? body.courts
    : ['A', 'B'].map((label) => ({ label, availableFrom: body.startTime, availableUntil: body.endTime, matchType: null }));
  for (const c of courts) assertWindow(c.availableFrom, c.availableUntil);
  if (new Set(courts.map((c) => c.label)).size !== courts.length) throw badRequest('Court labels must be unique');

  const id = await transaction(async (conn) => {
    const [group] = await query<GroupRow>(conn, 'SELECT * FROM `groups` WHERE id = ?', [groupId]);
    const venue = body.venue || group.venue;
    const s = await execute(
      conn,
      'INSERT INTO sessions (group_id, venue, date, start_time, end_time, match_type, level_every) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [groupId, venue, body.date, body.startTime, body.endTime, body.matchType, body.levelEvery === undefined ? 3 : body.levelEvery],
    );
    await execute(conn, 'INSERT INTO courts (session_id, label, available_from, available_until, match_type) VALUES ?', [
      courts.map((c) => [s.insertId, c.label, c.availableFrom, c.availableUntil, c.matchType ?? null]),
    ]);
    const members = await query<{ id: number }>(
      conn,
      `SELECT id FROM members WHERE group_id = ? AND active = 1 AND is_guest = 0
       ${body.participantIds ? 'AND id IN (?)' : ''}`,
      body.participantIds ? [groupId, body.participantIds.length ? body.participantIds : [0]] : [groupId],
    );
    if (members.length) {
      await execute(conn, 'INSERT INTO attendance (session_id, member_id) VALUES ?', [
        members.map((m) => [s.insertId, m.id]),
      ]);
    }
    return s.insertId;
  });
  res.status(201).json({ id });
});

sessionsRouter.get('/sessions/:sid', async (req, res) => {
  const sessionId = intParam(req.params.sid);
  const { viewer } = await viewerForSession(req, sessionId);
  res.json(await sessionState(sessionId, viewer));
});

/** Server-sent events: pushes `{version}` whenever anything in the session changes. */
sessionsRouter.get('/sessions/:sid/events', async (req, res) => {
  const sessionId = intParam(req.params.sid);
  await viewerForSession(req, sessionId);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  const unsubscribe = subscribe(sessionId, res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    unsubscribe();
  });
});

/** Every admin write goes through here and responds with the fresh state. */
async function adminWrite(
  req: Parameters<typeof viewerForSession>[0],
  res: import('express').Response,
  fn: (conn: PoolConnection, session: SessionRow) => Promise<{ regenerate?: false | RefreshMode } | void>,
) {
  const sessionId = intParam(req.params.sid);
  const { viewer } = await viewerForSession(req, sessionId, { admin: true });
  await mutateSession(sessionId, async (conn, session) => (await fn(conn, session)) ?? {});
  res.json(await sessionState(sessionId, viewer));
}

sessionsRouter.patch('/sessions/:sid', (req, res) =>
  adminWrite(req, res, async (conn, s) => {
    const body = z
      .object({ venue: z.string().trim().max(150), date, startTime: time, endTime: time, matchType, levelEvery })
      .partial()
      .parse(req.body);
    assertWindow(body.startTime ?? s.start_time, body.endTime ?? s.end_time);
    const cols: Record<string, unknown> = {
      venue: body.venue,
      date: body.date,
      start_time: body.startTime,
      end_time: body.endTime,
      match_type: body.matchType,
      level_every: body.levelEvery,
    };
    const set = Object.entries(cols).filter(([, v]) => v !== undefined);
    if (set.length) {
      await execute(conn, `UPDATE sessions SET ${set.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`, [
        ...set.map(([, v]) => v),
        s.id,
      ]);
    }
    // New matchmaking settings apply to the whole queue.
    return { regenerate: body.levelEvery !== undefined || body.matchType !== undefined ? 'rebuild' : 'keepNext' };
  }),
);

/**
 * Edit a session's setup in one go: details, matchmaking settings and courts (matched by label;
 * courts left out are removed, new labels are added). A court with games played can't be removed.
 */
sessionsRouter.put('/sessions/:sid/setup', (req, res) =>
  adminWrite(req, res, async (conn, s) => {
    if (s.status === 'closed') throw conflict('A finished session can no longer be edited');
    const body = z
      .object({
        venue: z.string().trim().max(150),
        date,
        startTime: time,
        endTime: time,
        matchType,
        levelEvery,
        courts: z.array(courtInput).min(1).max(12),
      })
      .parse(req.body);
    assertWindow(body.startTime, body.endTime);
    for (const c of body.courts) assertWindow(c.availableFrom, c.availableUntil);
    if (new Set(body.courts.map((c) => c.label)).size !== body.courts.length) throw badRequest('Court labels must be unique');

    const courts = await query<CourtRow>(conn, 'SELECT * FROM courts WHERE session_id = ?', [s.id]);
    const byLabel = new Map(courts.map((c) => [c.label, c]));
    const keep = new Set(body.courts.map((c) => c.label));
    const removed = courts.filter((c) => !keep.has(c.label));
    if (removed.length) {
      const [{ n }] = await query<{ n: number }>(
        conn,
        "SELECT COUNT(*) AS n FROM matches WHERE court_id IN (?) AND status IN ('playing','done')",
        [removed.map((c) => c.id)],
      );
      if (Number(n) > 0) {
        throw conflict(`Court ${removed.map((c) => c.label).join(', ')} has games played; shorten its hours instead`);
      }
      await execute(conn, 'DELETE FROM courts WHERE id IN (?)', [removed.map((c) => c.id)]);
    }
    let typesChanged = body.matchType !== s.match_type || removed.length > 0;
    for (const c of body.courts) {
      const cur = byLabel.get(c.label);
      const type = c.matchType ?? null;
      if (!cur) {
        typesChanged = true;
        await execute(
          conn,
          'INSERT INTO courts (session_id, label, available_from, available_until, match_type) VALUES (?, ?, ?, ?, ?)',
          [s.id, c.label, c.availableFrom, c.availableUntil, type],
        );
      } else {
        if (cur.match_type !== type) typesChanged = true;
        await execute(conn, 'UPDATE courts SET available_from = ?, available_until = ?, match_type = ? WHERE id = ?', [
          c.availableFrom,
          c.availableUntil,
          type,
          cur.id,
        ]);
      }
    }
    await execute(
      conn,
      'UPDATE sessions SET venue = ?, date = ?, start_time = ?, end_time = ?, match_type = ?, level_every = ? WHERE id = ?',
      [body.venue, body.date, body.startTime, body.endTime, body.matchType, body.levelEvery, s.id],
    );
    // New matchmaking settings or court formats apply to the whole queue.
    return { regenerate: typesChanged || body.levelEvery !== s.level_every ? 'rebuild' : 'keepNext' };
  }),
);

sessionsRouter.delete('/sessions/:sid', async (req, res) => {
  const sessionId = intParam(req.params.sid);
  const { session } = await viewerForSession(req, sessionId, { admin: true });
  if (session.status !== 'scheduled') throw conflict('Only sessions that have not started can be deleted');
  await execute(pool, 'DELETE FROM sessions WHERE id = ?', [sessionId]);
  res.status(204).end();
});

// --- Courts ---------------------------------------------------------------

sessionsRouter.post('/sessions/:sid/courts', (req, res) =>
  adminWrite(req, res, async (conn, s) => {
    const c = courtInput.parse(req.body);
    assertWindow(c.availableFrom, c.availableUntil);
    await execute(
      conn,
      'INSERT INTO courts (session_id, label, available_from, available_until, match_type) VALUES (?, ?, ?, ?, ?)',
      [s.id, c.label, c.availableFrom, c.availableUntil, c.matchType ?? null],
    );
  }),
);

sessionsRouter.patch('/sessions/:sid/courts/:cid', (req, res) =>
  adminWrite(req, res, async (conn, s) => {
    const courtId = intParam(req.params.cid);
    const [court] = await query<CourtRow>(conn, 'SELECT * FROM courts WHERE id = ? AND session_id = ?', [courtId, s.id]);
    if (!court) throw notFound('Court not found');
    const body = courtInput.partial().parse(req.body);
    assertWindow(body.availableFrom ?? court.available_from, body.availableUntil ?? court.available_until);
    const cols: Record<string, unknown> = {
      label: body.label,
      available_from: body.availableFrom,
      available_until: body.availableUntil,
      match_type: body.matchType,
    };
    const set = Object.entries(cols).filter(([, v]) => v !== undefined);
    if (set.length) {
      await execute(conn, `UPDATE courts SET ${set.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`, [
        ...set.map(([, v]) => v),
        courtId,
      ]);
    }
  }),
);

sessionsRouter.delete('/sessions/:sid/courts/:cid', (req, res) =>
  adminWrite(req, res, async (conn, s) => {
    const courtId = intParam(req.params.cid);
    const [{ n }] = await query<{ n: number }>(
      conn,
      "SELECT COUNT(*) AS n FROM matches WHERE court_id = ? AND status IN ('playing','done')",
      [courtId],
    );
    if (Number(n) > 0) throw conflict('This court has match history; shorten its window instead');
    const r = await execute(conn, 'DELETE FROM courts WHERE id = ? AND session_id = ?', [courtId, s.id]);
    if (!r.affectedRows) throw notFound('Court not found');
  }),
);

// --- Participants & attendance (FR-6, FR-10 – FR-14) ----------------------

sessionsRouter.put('/sessions/:sid/participants', (req, res) =>
  adminWrite(req, res, async (conn, s) => {
    const { memberIds } = z.object({ memberIds: z.array(z.number().int()) }).parse(req.body);
    const valid = memberIds.length
      ? await query<{ id: number }>(conn, 'SELECT id FROM members WHERE group_id = ? AND active = 1 AND id IN (?)', [
          s.group_id,
          memberIds,
        ])
      : [];
    const keep = new Set(valid.map((m) => m.id));
    const current = await query<{ member_id: number }>(conn, 'SELECT member_id FROM attendance WHERE session_id = ?', [s.id]);
    const played = new Set(
      (
        await query<{ member_id: number }>(
          conn,
          `SELECT DISTINCT mp.member_id FROM match_players mp JOIN matches m ON m.id = mp.match_id
           WHERE m.session_id = ? AND m.status IN ('playing','done')`,
          [s.id],
        )
      ).map((r) => r.member_id),
    );
    const remove = current.map((c) => c.member_id).filter((id) => !keep.has(id) && !played.has(id));
    const add = [...keep].filter((id) => !current.some((c) => c.member_id === id));
    if (remove.length) await execute(conn, 'DELETE FROM attendance WHERE session_id = ? AND member_id IN (?)', [s.id, remove]);
    if (add.length) await execute(conn, 'INSERT INTO attendance (session_id, member_id) VALUES ?', [add.map((id) => [s.id, id])]);
  }),
);

/** FR-14: walk-ins. Creates a guest in the group, marked present straight away. */
sessionsRouter.post('/sessions/:sid/guests', (req, res) =>
  adminWrite(req, res, async (conn, s) => {
    const body = z
      .object({ name: z.string().trim().min(1).max(100), level: z.number().int().min(1).max(100) })
      .parse(req.body);
    const m = await execute(conn, 'INSERT INTO members (group_id, name, role, level, is_guest) VALUES (?, ?, ?, ?, 1)', [
      s.group_id,
      body.name,
      'member',
      body.level,
    ]);
    await execute(conn, "INSERT INTO attendance (session_id, member_id, status, checked_in_at) VALUES (?, ?, 'present', ?)", [
      s.id,
      m.insertId,
      new Date(),
    ]);
  }),
);

sessionsRouter.put('/sessions/:sid/attendance/:mid', (req, res) =>
  adminWrite(req, res, async (conn, s) => {
    const memberId = intParam(req.params.mid);
    const body = z
      .object({ status: z.enum(['invited', 'present', 'late', 'absent', 'departed']), at: z.string().optional() })
      .parse(req.body);
    const at = clampTimestamp(body.at);
    const r = await execute(
      conn,
      `UPDATE attendance SET status = ?,
         checked_in_at = CASE WHEN ? = 'present' THEN COALESCE(checked_in_at, ?) ELSE checked_in_at END,
         departed_at = CASE WHEN ? = 'departed' THEN ? ELSE NULL END
       WHERE session_id = ? AND member_id = ?`,
      [body.status, body.status, at, body.status, at, s.id, memberId],
    );
    if (!r.affectedRows) throw notFound('Not a participant of this session');
  }),
);

// --- Lifecycle ------------------------------------------------------------

/**
 * Go live and generate the first queue. With `present` ("Who's playing?"), exactly those members
 * are marked here and everyone else on the list away; ticked members who weren't invited are added.
 */
sessionsRouter.post('/sessions/:sid/start', (req, res) =>
  adminWrite(req, res, async (conn, s) => {
    if (s.status === 'closed') throw conflict('Session is closed');
    const { present } = z.object({ present: z.array(z.number().int()).optional() }).parse(req.body ?? {});
    if (present) {
      const valid = present.length
        ? await query<{ id: number }>(conn, 'SELECT id FROM members WHERE group_id = ? AND active = 1 AND id IN (?)', [s.group_id, present])
        : [];
      if (valid.length < 2) throw badRequest('Pick at least 2 players to start');
      const ids = valid.map((m) => m.id);
      const now = new Date();
      await execute(conn, 'INSERT IGNORE INTO attendance (session_id, member_id) VALUES ?', [ids.map((id) => [s.id, id])]);
      await execute(
        conn,
        `UPDATE attendance SET
           status = CASE WHEN member_id IN (?) THEN 'present' ELSE 'absent' END,
           checked_in_at = CASE WHEN member_id IN (?) THEN COALESCE(checked_in_at, ?) ELSE checked_in_at END
         WHERE session_id = ? AND status IN ('invited', 'present', 'late', 'absent')`,
        [ids, ids, now, s.id],
      );
    }
    await execute(conn, "UPDATE sessions SET status = 'live' WHERE id = ?", [s.id]);
  }),
);

/**
 * Attend → "Add a walk-in". A name that matches someone in the group marks them arrived (adding
 * them to this session if needed); a new name joins the group. Either way they're here now, and
 * start level with the fewest games played among those present so they don't jump the queue.
 */
sessionsRouter.post('/sessions/:sid/walk-ins', (req, res) =>
  adminWrite(req, res, async (conn, s) => {
    if (s.status === 'closed') throw conflict('Session is closed');
    const body = z
      .object({ name: z.string().trim().min(1).max(100), level: z.number().int().min(1).max(100) })
      .parse(req.body);
    const [existing] = await query<{ id: number }>(
      conn,
      'SELECT id FROM members WHERE group_id = ? AND LOWER(name) = LOWER(?) ORDER BY active DESC, is_guest, id LIMIT 1',
      [s.group_id, body.name],
    );
    let memberId: number;
    if (existing) {
      memberId = existing.id;
      await execute(conn, 'UPDATE members SET active = 1 WHERE id = ?', [memberId]);
    } else {
      const m = await execute(conn, 'INSERT INTO members (group_id, name, role, level) VALUES (?, ?, ?, ?)', [
        s.group_id,
        body.name,
        'member',
        body.level,
      ]);
      memberId = m.insertId;
    }
    const ctx = await loadContext(conn, s.id);
    const already = ctx.attendance.find((a) => a.member_id === memberId);
    if (already?.status === 'present') return { regenerate: false };
    // Level with the least-played player who's here (games done or in progress, plus their own credit).
    const played = new Map<number, number>();
    for (const m of ctx.matches) {
      if (m.status !== 'done' && m.status !== 'playing') continue;
      for (const id of [...m.sideA, ...m.sideB]) played.set(id, (played.get(id) ?? 0) + 1);
    }
    const here = ctx.attendance.filter((a) => a.status === 'present');
    const mine = played.get(memberId) ?? 0;
    const floor = here.length ? Math.min(...here.map((a) => (played.get(a.member_id) ?? 0) + a.games_credit)) : 0;
    const credit = Math.max(0, floor - mine);
    await execute(
      conn,
      `INSERT INTO attendance (session_id, member_id, status, checked_in_at, games_credit) VALUES (?, ?, 'present', ?, ?)
       ON DUPLICATE KEY UPDATE status = 'present', departed_at = NULL, checked_in_at = COALESCE(checked_in_at, VALUES(checked_in_at)),
         games_credit = GREATEST(games_credit, VALUES(games_credit))`,
      [s.id, memberId, new Date(), credit],
    );
  }),
);

/** FR-18 on demand. `reset` also discards manual overrides. */
sessionsRouter.post('/sessions/:sid/regenerate', (req, res) =>
  adminWrite(req, res, async (conn, s) => {
    if (s.status !== 'live') throw conflict('Start the session first');
    if (req.body?.reset) await execute(conn, "UPDATE matches SET locked = 0 WHERE session_id = ? AND status = 'queued'", [s.id]);
    return { regenerate: 'rebuild' };
  }),
);

sessionsRouter.post('/sessions/:sid/close', (req, res) =>
  adminWrite(req, res, async (conn, s) => {
    const now = new Date();
    await execute(conn, "UPDATE matches SET status = 'done', ended_at = ? WHERE session_id = ? AND status = 'playing'", [
      now,
      s.id,
    ]);
    await execute(conn, "DELETE FROM matches WHERE session_id = ? AND status = 'queued'", [s.id]);
    await execute(conn, 'DELETE FROM planned_slots WHERE session_id = ?', [s.id]);
    await execute(conn, "UPDATE attendance SET status = 'departed', departed_at = ? WHERE session_id = ? AND status = 'present'", [
      now,
      s.id,
    ]);
    await execute(conn, "UPDATE sessions SET status = 'closed' WHERE id = ?", [s.id]);
    return { regenerate: false };
  }),
);

// --- Matches (FR-20 – FR-22) ----------------------------------------------

function findMatch(ctx: SessionContext, matchId: number): MatchRow {
  const m = ctx.matches.find((x) => x.id === matchId);
  if (!m) throw notFound('Match not found');
  return m;
}

function assertLive(s: SessionRow) {
  if (s.status !== 'live') throw conflict('Session is not live');
}

/** Warnings the admin can override with `force` (§4 step 7). */
function windowWarning(ctx: SessionContext, court: CourtRow, at: number): string | null {
  const from = wallClock(ctx.session.date, court.available_from);
  const until = wallClock(ctx.session.date, court.available_until);
  if (at < from) return `Court ${court.label} isn't available until ${court.available_from.slice(0, 5)}`;
  if (at + ctx.estMatchMs > until) {
    const left = Math.max(0, Math.round((until - at) / 60_000));
    return `Only ${left} min left on court ${court.label} (a game usually takes ~${Math.round(ctx.estMatchMs / 60_000)} min)`;
  }
  return null;
}

/** Start a queued game on a free court. It becomes the session's next game number. */
async function startMatch(conn: PoolConnection, ctx: SessionContext, m: MatchRow, courtId: number, at: Date, force: boolean) {
  if (m.status !== 'queued') throw conflict('Match is not in the queue');
  const court = ctx.courts.find((c) => c.id === courtId);
  if (!court) throw notFound('Court not found');
  if (ctx.matches.some((x) => x.court_id === court.id && x.status === 'playing')) {
    throw conflict(`Court ${court.label} is still in use`);
  }
  if (courtType(court, ctx.session) !== m.type) throw conflict(`Court ${court.label} is set up for ${courtType(court, ctx.session)}`);
  const busy = new Set(ctx.matches.filter((x) => x.status === 'playing').flatMap((x) => [...x.sideA, ...x.sideB]));
  if ([...m.sideA, ...m.sideB].some((id) => busy.has(id))) throw conflict('A player in this match is still on another court');
  const warning = windowWarning(ctx, court, at.getTime());
  if (warning && !force) throw conflict(warning, 'WINDOW_WARNING');
  await execute(conn, "UPDATE matches SET status = 'playing', court_id = ?, started_at = ? WHERE id = ?", [court.id, at, m.id]);
  // The plan slot this game came from is used up.
  if (m.plan_no !== null) {
    await execute(conn, 'DELETE FROM planned_slots WHERE session_id = ? AND game_no = ?', [ctx.session.id, m.plan_no]);
  }
}

/** A hand-edited match replaces whatever the game plan had pencilled in for it. */
async function dropPlanFor(conn: PoolConnection, ctx: SessionContext, m: MatchRow) {
  if (m.plan_no === null) return;
  await execute(conn, 'DELETE FROM planned_slots WHERE session_id = ? AND game_no = ?', [ctx.session.id, m.plan_no]);
  await execute(conn, 'UPDATE matches SET planned = 0, plan_no = NULL WHERE id = ?', [m.id]);
}

async function setLineup(conn: PoolConnection, m: MatchRow, sideA: number[], sideB: number[]) {
  await execute(conn, 'DELETE FROM match_players WHERE match_id = ?', [m.id]);
  await execute(conn, 'INSERT INTO match_players (match_id, member_id, side) VALUES ?', [
    [...sideA.map((id) => [m.id, id, 'A']), ...sideB.map((id) => [m.id, id, 'B'])],
  ]);
}

sessionsRouter.post('/sessions/:sid/matches/:mid/start', (req, res) =>
  adminWrite(req, res, async (conn, s) => {
    assertLive(s);
    const body = z
      .object({ courtId: z.number().int(), force: z.boolean().optional(), at: z.string().optional() })
      .parse(req.body ?? {});
    const ctx = await loadContext(conn, s.id);
    const m = findMatch(ctx, intParam(req.params.mid));
    await startMatch(conn, ctx, m, body.courtId, clampTimestamp(body.at), !!body.force);
  }),
);

/**
 * FR-21: "done" + optional winner. Idempotent so offline replays are safe. The court is then free
 * for the admin to call the next game with Start.
 */
sessionsRouter.post('/sessions/:sid/matches/:mid/finish', (req, res) =>
  adminWrite(req, res, async (conn, s) => {
    const body = z
      .object({ winnerSide: z.enum(['A', 'B']).nullable().optional(), at: z.string().optional() })
      .parse(req.body ?? {});
    const ctx = await loadContext(conn, s.id);
    const m = findMatch(ctx, intParam(req.params.mid));
    if (m.status === 'done') {
      if (body.winnerSide && !m.winner_side) {
        await execute(conn, 'UPDATE matches SET winner_side = ? WHERE id = ?', [body.winnerSide, m.id]);
      }
      return { regenerate: false };
    }
    if (m.status !== 'playing') throw conflict('Match is not being played');
    await execute(conn, "UPDATE matches SET status = 'done', ended_at = ?, winner_side = ? WHERE id = ?", [
      clampTimestamp(body.at, m.started_at),
      body.winnerSide ?? null,
      m.id,
    ]);
    if (s.status !== 'live') return { regenerate: false };
  }),
);

sessionsRouter.post('/sessions/:sid/matches/:mid/cancel', (req, res) =>
  adminWrite(req, res, async (conn, s) => {
    const ctx = await loadContext(conn, s.id);
    const m = findMatch(ctx, intParam(req.params.mid));
    if (m.status !== 'playing') throw conflict('Only a match in progress can be cancelled');
    await execute(conn, "UPDATE matches SET status = 'cancelled', ended_at = ? WHERE id = ?", [new Date(), m.id]);
  }),
);

const side = z.array(z.number().int()).min(1).max(2);

/** Singles or doubles, from the lineup; some court must play that type. */
function lineupType(ctx: SessionContext, sideA: number[], sideB: number[]): MatchType {
  if (sideA.length !== sideB.length) throw badRequest('Both sides need the same number of players');
  const type: MatchType = sideA.length === 1 ? 'singles' : 'doubles';
  if (!ctx.courts.some((c) => courtType(c, ctx.session) === type)) throw badRequest(`No court is set up for ${type}`);
  return type;
}

function validateLineup(ctx: SessionContext, type: MatchType, sideA: number[], sideB: number[]) {
  const all = [...sideA, ...sideB];
  if (sideA.length !== sideB.length || all.length !== playersNeeded(type)) {
    throw badRequest(`This is a ${type} game`);
  }
  if (new Set(all).size !== all.length) throw badRequest('A player appears twice');
  const present = new Set(ctx.attendance.filter((a) => a.status === 'present').map((a) => a.member_id));
  if (!all.every((id) => present.has(id))) throw badRequest('Everyone in the match must be marked present');
}

/** FR-22 insert: an admin-made match goes to the front of the queue. */
sessionsRouter.post('/sessions/:sid/matches', (req, res) =>
  adminWrite(req, res, async (conn, s) => {
    assertLive(s);
    const body = z.object({ sideA: side, sideB: side }).parse(req.body);
    const ctx = await loadContext(conn, s.id);
    const type = lineupType(ctx, body.sideA, body.sideB);
    validateLineup(ctx, type, body.sideA, body.sideB);
    await insertMatch(conn, s.id, { ...body, type, position: -1, locked: true });
  }),
);

/**
 * FR-22 edit: change the players, or record/correct a result.
 * Edited queued matches become locked so regeneration keeps them.
 */
sessionsRouter.patch('/sessions/:sid/matches/:mid', (req, res) =>
  adminWrite(req, res, async (conn, s) => {
    const body = z
      .object({
        sideA: side.optional(),
        sideB: side.optional(),
        winnerSide: z.enum(['A', 'B']).nullable().optional(),
      })
      .parse(req.body);
    const ctx = await loadContext(conn, s.id);
    const m = findMatch(ctx, intParam(req.params.mid));

    if (body.winnerSide !== undefined) {
      if (m.status !== 'done') throw conflict('Results can only be recorded for finished matches');
      await execute(conn, 'UPDATE matches SET winner_side = ? WHERE id = ?', [body.winnerSide, m.id]);
      return { regenerate: false };
    }

    if (m.status !== 'queued') throw conflict('Only queued matches can be edited');
    const sideA = body.sideA ?? m.sideA;
    const sideB = body.sideB ?? m.sideB;
    const type = lineupType(ctx, sideA, sideB);
    validateLineup(ctx, type, sideA, sideB);
    await dropPlanFor(conn, ctx, m);
    await execute(conn, 'UPDATE matches SET type = ?, locked = 1 WHERE id = ?', [type, m.id]);
    await setLineup(conn, m, sideA, sideB);
  }),
);

/**
 * Swap one player out of a queued match. If the incoming player is in another queued match (and
 * the outgoing one isn't), they trade places there, so the swap reads the same on both. Both
 * matches become manual. Players can appear in several queued matches: the queue runs ahead in time.
 */
sessionsRouter.post('/sessions/:sid/matches/:mid/swap', (req, res) =>
  adminWrite(req, res, async (conn, s) => {
    assertLive(s);
    const body = z.object({ out: z.number().int(), in: z.number().int() }).parse(req.body);
    const ctx = await loadContext(conn, s.id);
    const m = findMatch(ctx, intParam(req.params.mid));
    if (m.status !== 'queued') throw conflict('Only queued matches can be edited');
    if (![...m.sideA, ...m.sideB].includes(body.out)) throw badRequest('That player is not in this match');
    if ([...m.sideA, ...m.sideB].includes(body.in)) throw badRequest('That player is already in this match');
    const rep = (ids: number[], x: number, y: number) => ids.map((id) => (id === x ? y : id));
    const other = ctx.matches.find(
      (x) =>
        x.id !== m.id &&
        x.status === 'queued' &&
        [...x.sideA, ...x.sideB].includes(body.in) &&
        ![...x.sideA, ...x.sideB].includes(body.out),
    );
    validateLineup(ctx, m.type, rep(m.sideA, body.out, body.in), rep(m.sideB, body.out, body.in));
    for (const [match, x, y] of [[m, body.out, body.in], ...(other ? [[other, body.in, body.out] as const] : [])] as const) {
      await dropPlanFor(conn, ctx, match);
      await execute(conn, 'UPDATE matches SET locked = 1 WHERE id = ?', [match.id]);
      await setLineup(conn, match, rep(match.sideA, x, y), rep(match.sideB, x, y));
    }
  }),
);

/** Re-draw: replace a queued match with the next-best lineup the engine can find, kept as manual. */
sessionsRouter.post('/sessions/:sid/matches/:mid/redraw', (req, res) =>
  adminWrite(req, res, async (conn, s) => {
    assertLive(s);
    const ctx = await loadContext(conn, s.id);
    const m = findMatch(ctx, intParam(req.params.mid));
    if (m.status !== 'queued') throw conflict('Only queued matches can be re-drawn');
    const input = engineInput(ctx, Date.now());
    // Players already committed elsewhere (on court, or in another manual match) sit this one out.
    const taken = new Set(
      ctx.matches
        .filter((x) => x.status === 'playing' || (x.status === 'queued' && x.locked && x.id !== m.id))
        .flatMap((x) => [...x.sideA, ...x.sideB]),
    );
    const pool = sortByPriority(
      input.players.filter((p) => !taken.has(p.id)),
      input.seed,
    );
    const type = m.type;
    const formed = formMatch(pool, type, rulesForGame(input.rules, pool, type), {
      partnerCounts: input.partnerCounts,
      opponentCounts: input.opponentCounts,
      exclude: new Set([playerSetKey([...m.sideA, ...m.sideB])]),
      salt: Date.now(),
    });
    if (!formed) throw conflict('No other lineup is possible with the players waiting');
    await dropPlanFor(conn, ctx, m);
    await execute(conn, 'UPDATE matches SET locked = 1, unbalanced = ?, level_gap = ? WHERE id = ?', [
      formed.unbalanced,
      formed.gap,
      m.id,
    ]);
    await setLineup(conn, m, formed.sideA, formed.sideB);
  }),
);

// --- Game plan ------------------------------------------------------------

/** Players a planned game holds: 4 if any court plays doubles, else 2. */
function planSize(ctx: SessionContext): number {
  return ctx.courts.some((c) => courtType(c, ctx.session) === 'doubles') ? 4 : 2;
}

const gameNo = z.number().int().min(1).max(999);

/**
 * Pencil a player into the session's Nth game (on whichever court is free then), optionally moving
 * them from another planned game.
 */
sessionsRouter.post('/sessions/:sid/plan', (req, res) =>
  adminWrite(req, res, async (conn, s) => {
    if (s.status === 'closed') throw conflict('Session is closed');
    const body = z.object({ gameNo, memberId: z.number().int(), from: z.object({ gameNo }).optional() }).parse(req.body);
    const ctx = await loadContext(conn, s.id);
    if (body.gameNo <= startedCount(ctx)) throw conflict(`Game ${body.gameNo} has already started`);
    const a = ctx.attendance.find((x) => x.member_id === body.memberId);
    if (!a || a.status === 'absent' || a.status === 'departed') throw badRequest('Only players at the session can be planned');
    const slot = ctx.plan.find((p) => p.gameNo === body.gameNo)?.memberIds ?? [];
    if (slot.includes(body.memberId)) return { regenerate: false };
    if (slot.length >= planSize(ctx)) throw conflict(`Game ${body.gameNo} is full`);
    if (body.from) {
      await execute(conn, 'DELETE FROM planned_slots WHERE session_id = ? AND game_no = ? AND member_id = ?', [
        s.id,
        body.from.gameNo,
        body.memberId,
      ]);
    }
    await execute(conn, 'INSERT INTO planned_slots (session_id, game_no, member_id) VALUES (?, ?, ?)', [
      s.id,
      body.gameNo,
      body.memberId,
    ]);
    return { regenerate: 'rebuild' };
  }),
);

sessionsRouter.delete('/sessions/:sid/plan/:gameNo/:mid', (req, res) =>
  adminWrite(req, res, async (conn, s) => {
    await execute(conn, 'DELETE FROM planned_slots WHERE session_id = ? AND game_no = ? AND member_id = ?', [
      s.id,
      intParam(req.params.gameNo),
      intParam(req.params.mid),
    ]);
    return { regenerate: 'rebuild' };
  }),
);

/**
 * FR-22 reorder. Locks the matches up to the moved one so the new order survives regeneration
 * (locked matches always stay first, in order).
 */
sessionsRouter.post('/sessions/:sid/matches/:mid/move', (req, res) =>
  adminWrite(req, res, async (conn, s) => {
    const { direction } = z.object({ direction: z.enum(['up', 'down']) }).parse(req.body);
    const ctx = await loadContext(conn, s.id);
    const m = findMatch(ctx, intParam(req.params.mid));
    if (m.status !== 'queued') throw conflict('Only queued matches can be moved');
    const queue = ctx.matches.filter((x) => x.status === 'queued');
    const i = queue.findIndex((x) => x.id === m.id);
    const j = direction === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= queue.length) return { regenerate: false };
    const lockThrough = Math.max(i, j);
    // Matches that become manual stop being driven by the game plan.
    for (const x of queue.slice(0, lockThrough + 1)) await dropPlanFor(conn, ctx, x);
    [queue[i], queue[j]] = [queue[j], queue[i]];
    for (const [k, x] of queue.entries()) {
      await execute(conn, 'UPDATE matches SET position = ?, locked = locked OR ? WHERE id = ?', [k, k <= lockThrough, x.id]);
    }
  }),
);

sessionsRouter.delete('/sessions/:sid/matches/:mid', (req, res) =>
  adminWrite(req, res, async (conn, s) => {
    const ctx = await loadContext(conn, s.id);
    const m = findMatch(ctx, intParam(req.params.mid));
    if (m.status !== 'queued') throw conflict('Only queued matches can be removed');
    await execute(conn, 'DELETE FROM matches WHERE id = ?', [m.id]);
  }),
);
