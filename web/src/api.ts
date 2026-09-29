// API client: auth token, cached GETs for offline reads, and an outbox that queues
// courtside writes (attendance, start/finish) while the venue wifi is down.

export type Role = 'admin' | 'member';
export type MatchType = 'singles' | 'doubles';
export type AttendanceStatus = 'invited' | 'present' | 'late' | 'absent' | 'departed';
export type Side = 'A' | 'B';
export type Weekday = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';
export const WEEK: Weekday[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export interface Me {
  user: { id: number; email: string; name: string };
  groups: {
    groupId: number;
    groupName: string;
    memberId: number;
    role: Role;
    venue: string;
    days: Weekday[];
    memberCount: number;
  }[];
}

export interface PlayerRef {
  id: number;
  name: string;
}

export interface MatchView {
  id: number;
  /** Null while queued: a game takes whichever court is free when it's started. */
  courtId: number | null;
  courtLabel: string | null;
  /** Per-court game number: 3 + court A = "3A". */
  gameNo: number;
  type: MatchType;
  status: 'queued' | 'playing' | 'done';
  position: number;
  startedAt: string | null;
  endedAt: string | null;
  sideA: PlayerRef[];
  sideB: PlayerRef[];
  // Admin-only
  locked?: boolean;
  /** Formed from the game plan. */
  planned?: boolean;
  unbalanced?: boolean;
  gap?: number;
  winnerSide?: Side | null;
  // Client-only: waiting in the outbox
  pending?: boolean;
}

export interface CourtView {
  id: number;
  label: string;
  availableFrom: string;
  availableUntil: string;
  matchType: MatchType;
  matchTypeOverride: MatchType | null;
  current: MatchView | null;
}

export interface AttendanceView {
  memberId: number;
  name: string;
  isGuest: boolean;
  status: AttendanceStatus;
  checkedInAt: string | null;
  departedAt: string | null;
  gamesPlayed: number;
  onCourt: boolean;
  lastEndedAt: string | null;
  level?: number;
  wins?: number;
  losses?: number;
  pending?: boolean;
}

export interface SessionState {
  session: {
    id: number;
    groupId: number;
    venue: string;
    date: string;
    startTime: string;
    endTime: string;
    matchType: MatchType;
    status: 'scheduled' | 'live' | 'closed';
    version: number;
    // Admin-only
    levelEvery?: number | null;
    doublesMaxGap?: number;
  };
  group: { id: number; name: string };
  viewer: { memberId: number; role: Role };
  /** Admin-only game plan: players pencilled into a court's Nth game. */
  plan?: PlanSlot[];
  courts: CourtView[];
  queue: MatchView[];
  history: MatchView[];
  attendance: AttendanceView[];
}

/** Players pencilled into the session's Nth game. */
export interface PlanSlot {
  gameNo: number;
  memberIds: number[];
}

export interface SessionSummary {
  id: number;
  venue: string;
  date: string;
  startTime: string;
  endTime: string;
  matchType: MatchType;
  format: MatchType | 'mixed';
  status: 'scheduled' | 'live' | 'closed';
  presentCount: number;
  participantCount: number;
  courtCount: number;
  isParticipant: boolean;
}

export interface MemberView {
  id: number;
  name: string;
  role: Role;
  isGuest: boolean;
  isOwner: boolean;
  level?: number;
  active?: boolean;
  email?: string | null;
  hasLogin?: boolean;
}

export interface GroupView {
  id: number;
  name: string;
  venue: string;
  days: Weekday[];
  viewer: { memberId: number; role: Role };
  // Admin-only
  inviteCode?: string;
  ownerUserId?: number | null;
  settings?: {
    singlesMaxGap: number;
    doublesMaxGap: number;
    intraTeamMaxSpread: number;
    defaultMatchMinutes: number;
  };
}

export interface MemberStats {
  member: { id: number; name: string; level?: number };
  totals: { sessionsAttended: number; gamesPlayed: number; wins?: number; losses?: number };
  sessions: {
    sessionId: number;
    date: string;
    venue: string;
    attendance: AttendanceStatus;
    gamesPlayed: number;
    wins?: number;
    losses?: number;
  }[];
}

/** Admin-only: one member's record across all sessions. */
export interface HistoryRow {
  memberId: number;
  name: string;
  sessions: number;
  played: number;
  wins: number;
  losses: number;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

// --- token ---------------------------------------------------------------

const TOKEN_KEY = 'bt.token';
const listeners = new Set<() => void>();

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private mode): the app still works online.
  }
}

export const getToken = () => safeGet(TOKEN_KEY);
export function setToken(token: string | null) {
  safeSet(TOKEN_KEY, token);
  if (!token) {
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith('bt.')) localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  }
  listeners.forEach((l) => l());
}
export function onAuthChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// --- requests ------------------------------------------------------------

async function raw<T>(method: string, url: string, body?: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api${url}`, {
    method,
    headers: {
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && token) setToken(null);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new ApiError(res.status, err.error ?? `Request failed (${res.status})`, err.code);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

/** fetch() rejects with a TypeError only when the network itself failed. */
export const isNetworkError = (e: unknown) => e instanceof TypeError;

const cacheKey = (url: string) => `bt.cache:${url}`;

/** GET with a last-known-good fallback so screens still render offline. */
export async function get<T>(url: string): Promise<{ data: T; stale: boolean }> {
  try {
    const data = await raw<T>('GET', url);
    safeSet(cacheKey(url), JSON.stringify(data));
    return { data, stale: false };
  } catch (e) {
    const cached = isNetworkError(e) ? safeGet(cacheKey(url)) : null;
    if (cached) return { data: JSON.parse(cached) as T, stale: true };
    throw e;
  }
}

export function cacheWrite(url: string, data: unknown) {
  safeSet(cacheKey(url), JSON.stringify(data));
}

export const send = <T = void>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown) =>
  raw<T>(method, url, body);

// --- outbox --------------------------------------------------------------

export interface OutboxOp {
  id: string;
  sessionId: number;
  kind: 'attendance' | 'start' | 'finish';
  method: 'POST' | 'PUT';
  url: string;
  body: Record<string, unknown>;
  /** For optimistic rendering. */
  memberId?: number;
  matchId?: number;
}

const OUTBOX_KEY = 'bt.outbox';
const outboxListeners = new Set<() => void>();
let lastSyncError: string | null = null;

export function readOutbox(): OutboxOp[] {
  try {
    return JSON.parse(safeGet(OUTBOX_KEY) ?? '[]');
  } catch {
    return [];
  }
}
function writeOutbox(ops: OutboxOp[]) {
  safeSet(OUTBOX_KEY, JSON.stringify(ops));
  outboxListeners.forEach((l) => l());
}
export function onOutboxChange(fn: () => void): () => void {
  outboxListeners.add(fn);
  return () => {
    outboxListeners.delete(fn);
  };
}
export const getLastSyncError = () => lastSyncError;

/**
 * Sends an offline-capable write. Online: behaves like send(). If the network is down, the op is
 * stored (with the tap's real timestamp) and replayed later; returns null in that case.
 */
export async function sendOrQueue<T>(op: Omit<OutboxOp, 'id'>): Promise<T | null> {
  const body = { ...op.body, at: new Date().toISOString() };
  // Keep ordering: if anything is already waiting, queue behind it.
  if (readOutbox().length === 0 && navigator.onLine) {
    try {
      return await raw<T>(op.method, op.url, body);
    } catch (e) {
      if (!isNetworkError(e)) throw e;
    }
  }
  writeOutbox([...readOutbox(), { ...op, body, id: crypto.randomUUID() }]);
  return null;
}

let flushing = false;
/** Replays queued ops in order. Stops at the first network failure; drops ops the server rejects. */
export async function flushOutbox(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    for (;;) {
      const [op] = readOutbox();
      if (!op) break;
      try {
        await raw(op.method, op.url, op.body);
        lastSyncError = null;
      } catch (e) {
        if (isNetworkError(e)) break;
        lastSyncError = `A change made offline couldn't be applied: ${(e as Error).message}`;
      }
      writeOutbox(readOutbox().filter((x) => x.id !== op.id));
    }
  } finally {
    flushing = false;
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => void flushOutbox());
  setInterval(() => void flushOutbox(), 15_000);
}
