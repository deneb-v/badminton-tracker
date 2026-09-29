import type { PoolConnection } from 'mysql2/promise';
import { Conn, execute, pool, query, transaction } from '../db.js';
import { loadSession, SessionRow, Viewer } from '../access.js';
import { publish } from '../events.js';
import {
  BalanceRules,
  DEFAULT_RULES,
  EngineCourt,
  EnginePlayer,
  FixedMatch,
  generateQueue,
  isLevelGame,
  MatchType,
  pairKey,
  playersNeeded,
  QueueInput,
} from '../engine/queue.js';

const MIN = 60_000;
/** FR-26: someone who came off court less than this long ago sits out while others wait. */
const MIN_REST_MS = 2 * MIN;

export type AttendanceStatus = 'invited' | 'present' | 'late' | 'absent' | 'departed';
export type MatchStatus = 'queued' | 'playing' | 'done' | 'cancelled';
export type Side = 'A' | 'B';

export interface GroupRow {
  id: number;
  name: string;
  singles_max_gap: number;
  doubles_max_gap: number;
  intra_team_max_spread: number;
  default_match_minutes: number;
  venue: string;
  usual_days: string;
  invite_code: string | null;
  owner_user_id: number | null;
}

export interface CourtRow {
  id: number;
  session_id: number;
  label: string;
  available_from: string;
  available_until: string;
  match_type: MatchType | null;
}

export interface AttendanceRow {
  member_id: number;
  status: AttendanceStatus;
  checked_in_at: Date | null;
  departed_at: Date | null;
  games_credit: number;
  name: string;
  level: number;
  is_guest: number;
}

export interface MatchRow {
  id: number;
  session_id: number;
  /** Null while queued: a game takes whichever court is free when it's started. */
  court_id: number | null;
  type: MatchType;
  status: MatchStatus;
  position: number;
  locked: number;
  unbalanced: number;
  level_gap: string;
  started_at: Date | null;
  ended_at: Date | null;
  winner_side: Side | null;
  planned: number;
  /** Game-plan slot (session game number) this queued game was formed from. */
  plan_no: number | null;
  sideA: number[];
  sideB: number[];
}

/** Players pencilled into the session's Nth game. */
export interface PlanSlot {
  gameNo: number;
  memberIds: number[];
}

export interface SessionContext {
  session: SessionRow;
  group: GroupRow;
  courts: CourtRow[];
  attendance: AttendanceRow[];
  matches: MatchRow[];
  plan: PlanSlot[];
  estMatchMs: number;
}

/** Session dates/times are wall-clock values in the server's timezone. */
export function wallClock(date: string, time: string): number {
  return new Date(`${date}T${time.length === 5 ? `${time}:00` : time}`).getTime();
}

export function courtType(court: CourtRow, session: SessionRow): MatchType {
  return court.match_type ?? session.match_type;
}

export function rulesOf(group: GroupRow, session?: SessionRow): BalanceRules {
  return {
    ...DEFAULT_RULES,
    singlesMaxGap: group.singles_max_gap,
    doublesMaxGap: group.doubles_max_gap,
    intraTeamMaxSpread: group.intra_team_max_spread,
    levelEvery: session?.level_every ?? null,
  };
}

/** §4 step 7: seed at the group default, refine from real durations once there are enough. */
export async function estimateMatchMs(conn: Conn, group: GroupRow): Promise<number> {
  const [row] = await query<{ n: number; avg_s: string | null }>(
    conn,
    `SELECT COUNT(*) AS n, AVG(d) AS avg_s FROM (
       SELECT TIMESTAMPDIFF(SECOND, m.started_at, m.ended_at) AS d
       FROM matches m JOIN sessions s ON s.id = m.session_id
       WHERE s.group_id = ? AND m.status = 'done' AND m.started_at IS NOT NULL AND m.ended_at IS NOT NULL
       HAVING d BETWEEN 180 AND 3600
       ORDER BY m.ended_at DESC LIMIT 50
     ) recent`,
    [group.id],
  );
  if (row && Number(row.n) >= 5 && row.avg_s !== null) return Math.round(Number(row.avg_s)) * 1000;
  return group.default_match_minutes * MIN;
}

export async function loadContext(conn: Conn, sessionId: number, forUpdate = false): Promise<SessionContext> {
  const session = await loadSession(conn, sessionId, forUpdate);
  const [group] = await query<GroupRow>(conn, 'SELECT * FROM `groups` WHERE id = ?', [session.group_id]);
  const courts = await query<CourtRow>(conn, 'SELECT * FROM courts WHERE session_id = ? ORDER BY label', [sessionId]);
  const attendance = await query<AttendanceRow>(
    conn,
    `SELECT a.member_id, a.status, a.checked_in_at, a.departed_at, a.games_credit, m.name, m.level, m.is_guest
     FROM attendance a JOIN members m ON m.id = a.member_id
     WHERE a.session_id = ? ORDER BY m.name`,
    [sessionId],
  );
  const rows = await query<Omit<MatchRow, 'sideA' | 'sideB'>>(
    conn,
    'SELECT * FROM matches WHERE session_id = ? AND status <> ? ORDER BY position, id',
    [sessionId, 'cancelled'],
  );
  const players = await query<{ match_id: number; member_id: number; side: Side }>(
    conn,
    `SELECT mp.match_id, mp.member_id, mp.side FROM match_players mp
     JOIN matches m ON m.id = mp.match_id WHERE m.session_id = ? AND m.status <> 'cancelled'
     ORDER BY mp.member_id`,
    [sessionId],
  );
  const byMatch = new Map<number, { A: number[]; B: number[] }>();
  for (const p of players) {
    const entry = byMatch.get(p.match_id) ?? { A: [], B: [] };
    entry[p.side].push(p.member_id);
    byMatch.set(p.match_id, entry);
  }
  const matches = rows.map((r) => ({
    ...r,
    sideA: byMatch.get(r.id)?.A ?? [],
    sideB: byMatch.get(r.id)?.B ?? [],
  }));
  const slots = await query<{ game_no: number; member_id: number }>(
    conn,
    'SELECT game_no, member_id FROM planned_slots WHERE session_id = ? ORDER BY game_no, created_at',
    [sessionId],
  );
  const plan: PlanSlot[] = [];
  for (const r of slots) {
    let slot = plan.find((p) => p.gameNo === r.game_no);
    if (!slot) plan.push((slot = { gameNo: r.game_no, memberIds: [] }));
    slot.memberIds.push(r.member_id);
  }
  return { session, group, courts, attendance, matches, plan, estMatchMs: await estimateMatchMs(conn, group) };
}

/** Games started this session so far (playing + done); the next one to start gets this + 1. */
export function startedCount(ctx: SessionContext): number {
  return ctx.matches.filter((m) => m.status === 'playing' || m.status === 'done').length;
}

function playersOf(m: { sideA: number[]; sideB: number[] }): number[] {
  return [...m.sideA, ...m.sideB];
}

export async function insertMatch(
  conn: Conn,
  sessionId: number,
  m: {
    type: MatchType;
    sideA: number[];
    sideB: number[];
    position: number;
    locked: boolean;
    unbalanced?: boolean;
    gap?: number;
    planNo?: number | null;
  },
): Promise<number> {
  const res = await execute(
    conn,
    `INSERT INTO matches (session_id, type, status, position, locked, planned, plan_no, unbalanced, level_gap)
     VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
    [sessionId, m.type, m.position, m.locked, m.planNo != null, m.planNo ?? null, m.unbalanced ?? false, m.gap ?? 0],
  );
  const values = [
    ...m.sideA.map((id) => [res.insertId, id, 'A']),
    ...m.sideB.map((id) => [res.insertId, id, 'B']),
  ];
  await execute(conn, 'INSERT INTO match_players (match_id, member_id, side) VALUES ?', [values]);
  return res.insertId;
}

/**
 * Everything the engine needs from a session, as of `now`, in turns (see engine/queue.ts). Present
 * players only; players on court are busy for the first turn. Courts whose hours are over are left out.
 */
export function engineInput(ctx: SessionContext, now: number, keep: MatchRow[] = []): QueueInput {
  const { session, courts, attendance, matches } = ctx;
  const present = new Set(attendance.filter((a) => a.status === 'present').map((a) => a.member_id));

  const partnerCounts = new Map<string, number>();
  const opponentCounts = new Map<string, number>();
  const games = new Map<number, number>();
  const lastEnded = new Map<number, number>();
  const onCourt = new Set<number>();
  for (const m of matches) {
    if (m.status !== 'done' && m.status !== 'playing') continue;
    for (const side of [m.sideA, m.sideB]) {
      if (side.length === 2) {
        const key = pairKey(side[0], side[1]);
        partnerCounts.set(key, (partnerCounts.get(key) ?? 0) + 1);
      }
    }
    for (const a of m.sideA) {
      for (const b of m.sideB) opponentCounts.set(pairKey(a, b), (opponentCounts.get(pairKey(a, b)) ?? 0) + 1);
    }
    for (const id of playersOf(m)) {
      games.set(id, (games.get(id) ?? 0) + 1);
      if (m.status === 'playing') onCourt.add(id);
      else lastEnded.set(id, Math.max(lastEnded.get(id) ?? 0, m.ended_at?.getTime() ?? now));
    }
  }

  // When each player last went straight back on court (started within the rest window of their
  // previous game ending), counted in games — the engine won't do it to them again too soon.
  const lastBackToBack = new Map<number, number>();
  const started = matches
    .filter((m) => (m.status === 'done' || m.status === 'playing') && m.started_at)
    .sort((a, b) => a.started_at!.getTime() - b.started_at!.getTime());
  const seen = new Map<number, { n: number; endedAt: number | null }>();
  // Games since each player's last level game, for the level rotation.
  const levelOf = new Map(attendance.map((a) => [a.member_id, a.level]));
  const sinceLevel = new Map<number, number>();
  for (const m of started) {
    const level = isLevelGame(playersOf(m).map((id) => levelOf.get(id) ?? 0));
    for (const id of playersOf(m)) sinceLevel.set(id, level ? 0 : (sinceLevel.get(id) ?? 0) + 1);
  }
  // …and how many games in a row each has played without a rest, up to their latest one.
  const streak = new Map<number, number>();
  for (const m of started) {
    for (const id of playersOf(m)) {
      const prev = seen.get(id) ?? { n: 0, endedAt: null };
      const straightOn = prev.endedAt !== null && m.started_at!.getTime() - prev.endedAt < MIN_REST_MS;
      if (straightOn) lastBackToBack.set(id, prev.n);
      streak.set(id, straightOn ? (streak.get(id) ?? 1) + 1 : 1);
      seen.set(id, { n: prev.n + 1, endedAt: m.ended_at?.getTime() ?? null });
    }
  }

  // Last game as a turn: on court now = 1, came off just now = 0, earlier games -1, -2, … by recency.
  const earlier = [...new Set(lastEnded.values())].filter((t) => now - t >= MIN_REST_MS).sort((a, b) => b - a);
  const lastTurn = (id: number): number | null => {
    if (onCourt.has(id)) return 1;
    const t = lastEnded.get(id);
    if (t === undefined) return null;
    return now - t < MIN_REST_MS ? 0 : -1 - earlier.indexOf(t);
  };

  const players: EnginePlayer[] = attendance
    .filter((a) => present.has(a.member_id))
    .map((a) => ({
      id: a.member_id,
      level: a.level,
      // A walk-in's credit puts them level with the least-played, not ahead of everyone.
      gamesPlayed: (games.get(a.member_id) ?? 0) + a.games_credit,
      lastTurn: lastTurn(a.member_id),
      freeTurn: onCourt.has(a.member_id) ? 1 : 0,
      sinceLevel: (sinceLevel.get(a.member_id) ?? 0) + a.games_credit,
      lastBackToBackGame: lastBackToBack.get(a.member_id) ?? null,
      streak: streak.get(a.member_id) ?? 0,
    }));

  const engineCourts: EngineCourt[] = courts
    .filter((c) => now < wallClock(session.date, c.available_until))
    .map((c) => ({
      id: c.id,
      type: courtType(c, session),
      busy: matches.some((m) => m.court_id === c.id && m.status === 'playing'),
    }));

  const fixed: FixedMatch[] = keep.map((m) => ({
    type: m.type,
    sideA: m.sideA,
    sideB: m.sideB,
    locked: !!m.locked,
    planNo: m.plan_no,
  }));
  const usedSlots = new Set(keep.map((m) => m.plan_no));
  return {
    players,
    courts: engineCourts,
    fixed,
    planned: ctx.plan.filter((p) => !usedSlots.has(p.gameNo)).map((p) => ({ gameNo: p.gameNo, ids: p.memberIds })),
    nextGameNo: startedCount(ctx) + 1,
    rules: rulesOf(ctx.group, session),
    partnerCounts,
    opponentCounts,
    seed: session.id,
  };
}

/**
 * How the queue is refreshed after a change:
 * - `keepNext` (default): the next games (one per court) stay exactly as they are, so what players
 *   see as "up next" doesn't change under them. The rest is planned again, after them.
 * - `rebuild` (Regenerate, game-plan edits): everything is planned again.
 * Hand-edited (locked) games are kept either way. A kept game is dropped if it's become impossible,
 * e.g. a player left or no open court plays its type any more.
 */
export type RefreshMode = 'keepNext' | 'rebuild';

/** Rebuild the upcoming queue (FR-18, FR-23). */
export async function regenerate(conn: PoolConnection, sessionId: number, mode: RefreshMode = 'keepNext'): Promise<void> {
  const ctx = await loadContext(conn, sessionId);
  const { session, attendance, matches } = ctx;
  if (session.status !== 'live') return;

  const now = Date.now();
  const present = new Set(attendance.filter((a) => a.status === 'present').map((a) => a.member_id));
  const openTypes = new Set(engineInput(ctx, now).courts.map((c) => c.type));
  const possible = (m: MatchRow) =>
    openTypes.has(m.type) &&
    playersOf(m).length === playersNeeded(m.type) &&
    playersOf(m).every((id) => present.has(id));

  const queued = matches.filter((m) => m.status === 'queued');
  const next = queued.filter(possible).slice(0, mode === 'keepNext' ? ctx.courts.length : 0);
  const keep = queued.filter((m) => possible(m) && (m.locked || next.includes(m)));
  // Other rows are reused when the new plan contains the same game, so ids stay stable for another
  // admin who is about to tap on them.
  const stale = queued.filter((m) => !keep.includes(m));

  const plan = generateQueue(engineInput(ctx, now, keep));
  const kept = [...keep];
  for (const [position, p] of plan.entries()) {
    const update = (id: number) =>
      execute(
        conn,
        'UPDATE matches SET position = ?, planned = ?, plan_no = ?, unbalanced = ?, level_gap = ? WHERE id = ?',
        [position, p.planNo != null, p.planNo, p.unbalanced, p.gap, id],
      );
    if (p.kept) {
      await update(kept.shift()!.id);
      continue;
    }
    const key = lineupKey(p.sideA, p.sideB);
    const i = stale.findIndex((m) => m.type === p.type && lineupKey(m.sideA, m.sideB) === key);
    if (i >= 0) {
      await update(stale.splice(i, 1)[0].id);
    } else {
      await insertMatch(conn, sessionId, { ...p, position });
    }
  }
  if (stale.length) await execute(conn, 'DELETE FROM matches WHERE id IN (?)', [stale.map((m) => m.id)]);
}

function lineupKey(sideA: number[], sideB: number[]): string {
  const side = (ids: number[]) => [...ids].sort((a, b) => a - b).join(',');
  return [side(sideA), side(sideB)].sort().join('|');
}

export async function touch(conn: Conn, sessionId: number): Promise<number> {
  await execute(conn, 'UPDATE sessions SET version = version + 1 WHERE id = ?', [sessionId]);
  const [row] = await query<{ version: number }>(conn, 'SELECT version FROM sessions WHERE id = ?', [sessionId]);
  return row.version;
}

/**
 * Serialises every write to a session: row lock → change → optional regenerate → version bump.
 * Concurrent admins queue up behind the lock instead of clobbering each other; subscribers are
 * notified after commit.
 */
export async function mutateSession<T>(
  sessionId: number,
  fn: (conn: PoolConnection, session: SessionRow) => Promise<T & { regenerate?: false | RefreshMode }>,
): Promise<T> {
  const { result, version } = await transaction(async (conn) => {
    const session = await loadSession(conn, sessionId, true);
    const result = await fn(conn, session);
    if (result?.regenerate !== false) await regenerate(conn, sessionId, result?.regenerate);
    return { result, version: await touch(conn, sessionId) };
  });
  publish(sessionId, version);
  return result;
}

/** Accepts a client timestamp (offline replays) within sane bounds, else "now". */
export function clampTimestamp(at: string | undefined, notBefore?: Date | null): Date {
  const now = Date.now();
  let t = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t) || t > now + MIN || t < now - 24 * 60 * MIN) t = now;
  if (notBefore && t < notBefore.getTime()) t = notBefore.getTime();
  return new Date(t);
}

// ---------------------------------------------------------------------------
// Serialisation. Anything level-derived (level, gap, unbalanced flag, wins) is
// admin-only (§2.2, FR-30) and is never sent to members.
// ---------------------------------------------------------------------------

export function serializeState(ctx: SessionContext, viewer: Viewer) {
  const isAdmin = viewer.role === 'admin';
  const { session, courts, attendance, matches } = ctx;
  const names = new Map(attendance.map((a) => [a.member_id, a.name]));
  const courtLabel = new Map(courts.map((c) => [c.id, c.label]));

  // Session game numbers (7A = the session's 7th game, played on court A): started games by start
  // time, then the queue in order.
  const gameNo = new Map<number, number>();
  const started = matches
    .filter((m) => m.status === 'playing' || m.status === 'done')
    .sort((a, b) => (a.started_at?.getTime() ?? 0) - (b.started_at?.getTime() ?? 0) || a.id - b.id);
  started.forEach((m, i) => gameNo.set(m.id, i + 1));
  matches.filter((m) => m.status === 'queued').forEach((m, i) => gameNo.set(m.id, started.length + i + 1));

  const matchView = (m: MatchRow) => ({
    id: m.id,
    courtId: m.court_id,
    courtLabel: m.court_id === null ? null : (courtLabel.get(m.court_id) ?? '?'),
    gameNo: gameNo.get(m.id) ?? 0,
    type: m.type,
    status: m.status,
    position: m.position,
    startedAt: m.started_at,
    endedAt: m.ended_at,
    sideA: m.sideA.map((id) => ({ id, name: names.get(id) ?? 'Unknown' })),
    sideB: m.sideB.map((id) => ({ id, name: names.get(id) ?? 'Unknown' })),
    ...(isAdmin && {
      locked: !!m.locked,
      planned: !!m.planned,
      unbalanced: !!m.unbalanced,
      gap: Number(m.level_gap),
      winnerSide: m.winner_side,
    }),
  });

  const stats = new Map<number, { games: number; wins: number; losses: number; lastEndedAt: Date | null; playing: boolean }>();
  for (const a of attendance) stats.set(a.member_id, { games: 0, wins: 0, losses: 0, lastEndedAt: null, playing: false });
  for (const m of matches) {
    if (m.status !== 'done' && m.status !== 'playing') continue;
    for (const side of ['A', 'B'] as const) {
      for (const id of side === 'A' ? m.sideA : m.sideB) {
        const s = stats.get(id);
        if (!s) continue;
        if (m.status === 'playing') {
          s.playing = true;
          continue;
        }
        s.games += 1;
        if (!s.lastEndedAt || (m.ended_at && m.ended_at > s.lastEndedAt)) s.lastEndedAt = m.ended_at;
        if (m.winner_side === side) s.wins += 1;
        else if (m.winner_side) s.losses += 1;
      }
    }
  }

  return {
    session: {
      id: session.id,
      groupId: session.group_id,
      venue: session.venue,
      date: session.date,
      startTime: session.start_time.slice(0, 5),
      endTime: session.end_time.slice(0, 5),
      matchType: session.match_type,
      status: session.status,
      version: session.version,
      ...(isAdmin && { levelEvery: session.level_every, doublesMaxGap: ctx.group.doubles_max_gap }),
    },
    group: { id: ctx.group.id, name: ctx.group.name },
    viewer: { memberId: viewer.memberId, role: viewer.role },
    ...(isAdmin && { plan: ctx.plan }),
    courts: courts.map((c) => {
      const current = matches.find((m) => m.court_id === c.id && m.status === 'playing');
      return {
        id: c.id,
        label: c.label,
        availableFrom: c.available_from.slice(0, 5),
        availableUntil: c.available_until.slice(0, 5),
        matchType: courtType(c, session),
        matchTypeOverride: c.match_type,
        current: current ? matchView(current) : null,
      };
    }),
    queue: matches.filter((m) => m.status === 'queued').map(matchView),
    history: matches
      .filter((m) => m.status === 'done')
      .sort((a, b) => (b.ended_at?.getTime() ?? 0) - (a.ended_at?.getTime() ?? 0))
      .map(matchView),
    attendance: attendance.map((a) => {
      const s = stats.get(a.member_id)!;
      return {
        memberId: a.member_id,
        name: a.name,
        isGuest: !!a.is_guest,
        status: a.status,
        checkedInAt: a.checked_in_at,
        departedAt: a.departed_at,
        gamesPlayed: s.games,
        onCourt: s.playing,
        lastEndedAt: s.lastEndedAt,
        ...(isAdmin && { level: a.level, wins: s.wins, losses: s.losses }),
      };
    }),
  };
}

export async function sessionState(sessionId: number, viewer: Viewer) {
  return serializeState(await loadContext(pool, sessionId), viewer);
}
