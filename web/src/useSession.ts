import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cacheWrite,
  flushOutbox,
  get,
  getLastSyncError,
  getToken,
  onOutboxChange,
  OutboxOp,
  readOutbox,
  SessionState,
} from './api';

/** Overlay writes still waiting in the outbox so offline taps show up immediately. */
function applyPending(state: SessionState, ops: OutboxOp[]): SessionState {
  if (!ops.length) return state;
  const s: SessionState = structuredClone(state);
  for (const op of ops) {
    if (op.kind === 'attendance') {
      const a = s.attendance.find((x) => x.memberId === op.memberId);
      if (a) Object.assign(a, { status: op.body.status, pending: true });
    } else if (op.kind === 'start') {
      const i = s.queue.findIndex((m) => m.id === op.matchId);
      if (i < 0) continue;
      const [m] = s.queue.splice(i, 1);
      const court = s.courts.find((c) => c.id === op.body.courtId);
      if (court && !court.current) {
        court.current = { ...m, courtId: court.id, courtLabel: court.label, status: 'playing', startedAt: op.body.at as string, pending: true };
      }
    } else if (op.kind === 'finish') {
      const court = s.courts.find((c) => c.current?.id === op.matchId);
      if (!court?.current) continue;
      s.history.unshift({
        ...court.current,
        status: 'done',
        endedAt: op.body.at as string,
        winnerSide: (op.body.winnerSide as 'A' | 'B' | null) ?? null,
        pending: true,
      });
      court.current = null;
    }
  }
  return s;
}

export function useSession(sessionId: number) {
  const url = `/sessions/${sessionId}`;
  const [state, setState] = useState<SessionState | null>(null);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outbox, setOutbox] = useState(readOutbox);
  const versionRef = useRef(-1);

  const apply = useCallback(
    (next: SessionState | null) => {
      if (!next || next.session.version < versionRef.current) return;
      versionRef.current = next.session.version;
      setState(next);
      setStale(false);
      cacheWrite(url, next);
    },
    [url],
  );

  const load = useCallback(async () => {
    try {
      const r = await get<SessionState>(url);
      if (r.stale) {
        setState((cur) => cur ?? r.data);
        setStale(true);
      } else {
        versionRef.current = -1;
        apply(r.data);
      }
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [url, apply]);

  useEffect(() => {
    void load();
    const es = new EventSource(`/api${url}/events?token=${encodeURIComponent(getToken() ?? '')}`);
    es.addEventListener('changed', (ev) => {
      const { version } = JSON.parse((ev as MessageEvent).data);
      if (version > versionRef.current) void load();
    });
    // Reconnected after a drop: we may have missed events.
    es.addEventListener('open', () => void load());
    return () => es.close();
  }, [url, load]);

  useEffect(
    () =>
      onOutboxChange(() => {
        const ops = readOutbox();
        setOutbox(ops);
        if (ops.length === 0) void load();
      }),
    [load],
  );

  useEffect(() => {
    void flushOutbox();
  }, []);

  const mine = useMemo(() => outbox.filter((o) => o.sessionId === sessionId), [outbox, sessionId]);
  const view = useMemo(() => (state ? applyPending(state, mine) : null), [state, mine]);

  return { state: view, stale, error, reload: load, apply, pending: mine.length, syncError: getLastSyncError() };
}
