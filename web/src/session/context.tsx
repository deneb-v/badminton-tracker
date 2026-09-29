import { createContext, useContext, useEffect, useState } from 'react';
import { Seg } from '../components/ui';
import type { CourtView, MatchView, PlayerRef, SessionState } from '../api';

export interface SessionCtx {
  state: SessionState;
  gid: number;
  isAdmin: boolean;
  busy: boolean;
  now: number;
  /** Admin-only: member id → level (members never receive levels). */
  levels: Map<number, number>;
  /** Runs a write; applies the returned state; toasts errors. Returns false on failure. */
  act: (fn: () => Promise<SessionState | null | void>) => Promise<boolean>;
  /** Start a queued game on a court, with the court-window warning flow (§4 step 7). */
  startMatch: (m: MatchView, court: CourtView) => void;
  finishMatch: (m: MatchView) => void;
  goTo: (tab: string) => void;
  base: string;
}

export const Ctx = createContext<SessionCtx | null>(null);

export function useSessionCtx(): SessionCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('no session ctx');
  return c;
}

export function useNow(intervalMs = 20_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatches(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return matches;
}

export type PlayerSort = 'name' | 'level';
const SORT_KEY = 'bt.playerSort';

/** Admin lists (Attend, Plan) sort players by name or level; the choice is remembered on this device. */
export function usePlayerSort(): [PlayerSort, (s: PlayerSort) => void] {
  const [sort, setSort] = useState<PlayerSort>(() => {
    try {
      return localStorage.getItem(SORT_KEY) === 'level' ? 'level' : 'name';
    } catch {
      return 'name';
    }
  });
  const set = (s: PlayerSort) => {
    setSort(s);
    try {
      localStorage.setItem(SORT_KEY, s);
    } catch {
      // Storage unavailable: the choice just isn't remembered.
    }
  };
  return [sort, set];
}

/** "Sort by  [Name | Level]" for the admin player lists. */
export function SortBy({ value, onChange }: { value: PlayerSort; onChange: (s: PlayerSort) => void }) {
  return (
    <div className="row" style={{ gap: 10, alignItems: 'center' }}>
      <span className="small muted">Sort by</span>
      <Seg
        className="seg-sm"
        label="Sort by"
        value={value}
        onChange={onChange}
        options={[
          { value: 'name', label: 'Name' },
          { value: 'level', label: 'Level' },
        ]}
      />
    </div>
  );
}

/** Highest level first (players without one last), then by name. */
export function byLevel(a: { name: string; level?: number }, b: { name: string; level?: number }): number {
  return (b.level ?? -1) - (a.level ?? -1) || a.name.localeCompare(b.name);
}

export const idsOf = (m: { sideA: PlayerRef[]; sideB: PlayerRef[] }) => [...m.sideA, ...m.sideB].map((p) => p.id);

/** Team average level, rounded (admin views only). */
export function teamAvg(levels: Map<number, number>, side: PlayerRef[]): number | null {
  const ls = side.map((p) => levels.get(p.id)).filter((l): l is number => l !== undefined);
  return ls.length === side.length && ls.length ? Math.round(ls.reduce((a, b) => a + b, 0) / ls.length) : null;
}

/** "7A": the session's 7th game, played on court A. Queued games have no court yet: "7". */
export const gameCode = (m: { gameNo: number; courtLabel: string | null }) => `${m.gameNo}${m.courtLabel ?? ''}`;

/** Matches the server's rest window: someone who came off court less than this long ago just played. */
const REST_MS = 2 * 60_000;

/** Players who just came off court after two or more games in a row without a rest. */
function tiredPlayers(state: SessionState, now: number): Set<number> {
  const started = [...state.history, ...state.courts.flatMap((c) => (c.current ? [c.current] : []))].sort(
    (a, b) => new Date(a.startedAt ?? 0).getTime() - new Date(b.startedAt ?? 0).getTime(),
  );
  const last = new Map<number, { run: number; endedAt: number | null }>();
  for (const m of started) {
    const start = new Date(m.startedAt ?? 0).getTime();
    for (const id of idsOf(m)) {
      const prev = last.get(id);
      const straightOn = !!prev && prev.endedAt !== null && start - prev.endedAt < REST_MS;
      last.set(id, { run: straightOn ? prev!.run + 1 : 1, endedAt: m.endedAt ? new Date(m.endedAt).getTime() : null });
    }
  }
  const tired = new Set<number>();
  for (const [id, { run, endedAt }] of last) if (run >= 2 && endedAt !== null && now - endedAt < REST_MS) tired.add(id);
  return tired;
}

/**
 * The game a free court would call: the first in the queue of its type with nobody still on
 * another court, preferring one where nobody would be on their 3rd game in a row.
 */
export function nextFor(state: SessionState, court: CourtView, now = Date.now()): MatchView | undefined {
  const onCourt = new Set(state.courts.flatMap((c) => (c.current ? idsOf(c.current) : [])));
  const tired = tiredPlayers(state, now);
  const startable = state.queue.filter((m) => m.type === court.matchType && !idsOf(m).some((id) => onCourt.has(id)));
  return startable.find((m) => !idsOf(m).some((id) => tired.has(id))) ?? startable[0];
}
