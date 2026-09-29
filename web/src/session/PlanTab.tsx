import { useState } from 'react';
import { send, SessionState } from '../api';
import { Sheet, XIcon } from '../components/ui';
import { byLevel, idsOf, SortBy, usePlayerSort, useSessionCtx } from './context';

type St = 'live' | 'done' | 'plan' | 'auto';
interface Entry {
  /** Session game number. */
  gameNo: number;
  /** "7A" once it's been played on court A; "7" before that. */
  code: string;
  st: St;
  /** Sort key: started games by start time, then upcoming by game number. */
  order: number;
}
interface Pick {
  memberId: number;
  col: number;
  from: number | null;
}

/**
 * Admin game plan. Rows are players, columns their 1st, 2nd, 3rd… game of the session; a cell reads
 * "7A" = the session's 7th game, played on court A. Tapping + pencils a player into an upcoming game
 * number — it goes on whichever court is free, ahead of the auto queue, and open spots are
 * auto-filled by level.
 */
export function PlanTab() {
  const { state, act, base, busy } = useSessionCtx();
  const [showAuto, setShowAuto] = useState(true);
  const [byCourt, setByCourt] = useState(false);
  const [sort, setSort] = usePlayerSort();
  const [hl, setHl] = useState<number | null>(null);
  const [pick, setPick] = useState<Pick | null>(null);

  if (state.session.status === 'closed') return <div className="col"><p className="muted">This session has finished.</p></div>;

  const courts = state.courts;
  const plan = state.plan ?? [];
  const slot = (gameNo: number) => plan.find((p) => p.gameNo === gameNo)?.memberIds ?? [];
  const current = courts.flatMap((c) => (c.current ? [c.current] : []));
  // Games started so far; the next one to start gets this + 1.
  const started = state.history.length + current.length;

  const per = new Map<number, Entry[]>();
  const push = (id: number, e: Entry) => per.set(id, [...(per.get(id) ?? []), e]);
  // Played games: "7A" (session game 7, on court A), or by court "A3" (court A's 3rd game).
  const courtNo = new Map<number, number>();
  for (const c of courts) {
    [...state.history, ...current]
      .filter((m) => m.courtId === c.id)
      .sort((a, b) => new Date(a.startedAt ?? 0).getTime() - new Date(b.startedAt ?? 0).getTime() || a.id - b.id)
      .forEach((m, i) => courtNo.set(m.id, i + 1));
  }
  const code = (m: { id: number; gameNo: number; courtLabel: string | null }) =>
    byCourt && m.courtLabel ? `${m.courtLabel}${courtNo.get(m.id)}` : `${m.gameNo}${m.courtLabel ?? ''}`;
  for (const m of state.history) for (const id of idsOf(m)) push(id, { gameNo: m.gameNo, code: code(m), st: 'done', order: new Date(m.startedAt ?? 0).getTime() });
  for (const m of current) for (const id of idsOf(m)) push(id, { gameNo: m.gameNo, code: code(m), st: 'live', order: new Date(m.startedAt ?? Date.now()).getTime() });
  const FUTURE = 1e15;
  for (const p of plan) for (const id of p.memberIds) push(id, { gameNo: p.gameNo, code: String(p.gameNo), st: 'plan', order: FUTURE + p.gameNo });
  if (showAuto) {
    // Each player's next game in the queue, unless the plan already puts them somewhere.
    const planned = new Set(plan.flatMap((p) => p.memberIds));
    const seen = new Set<number>();
    for (const m of state.queue) {
      for (const id of idsOf(m)) {
        if (seen.has(id) || planned.has(id)) continue;
        seen.add(id);
        push(id, { gameNo: m.gameNo, code: String(m.gameNo), st: 'auto', order: FUTURE + m.gameNo });
      }
    }
  }
  for (const list of per.values()) list.sort((a, b) => a.order - b.order);

  const plannable = (status: string) => status === 'present' || status === 'late';
  const rows = state.attendance
    .filter((a) => plannable(a.status) || (per.get(a.memberId)?.length ?? 0) > 0)
    .sort((a, b) => (sort === 'level' ? byLevel(a, b) : a.name.localeCompare(b.name)));
  const ncols = Math.max(5, ...rows.map((r) => (per.get(r.memberId)?.length ?? 0) + 1));
  const cols = `132px repeat(${ncols}, 56px)`;

  const hlCount = hl ? rows.filter((r) => per.get(r.memberId)?.some((e) => e.gameNo === hl)).length : 0;
  const nextPlanned = slot(started + 1).length > 0;

  return (
    <div className="col" style={{ maxWidth: 760, gap: 12 }}>
      <p className="body-sm muted" style={{ textWrap: 'pretty' }}>
        {byCourt ? (
          <>
            <b style={{ color: 'var(--color-text)' }}>A3</b> = Court A's 3rd game. Upcoming games show their session game
            number, as they don't have a court yet.
          </>
        ) : (
          <>
            <b style={{ color: 'var(--color-text)' }}>7A</b> = the session's 7th game, played on Court A.
          </>
        )}{' '}
        Games fill in as they're played. Tap <b style={{ color: 'var(--color-text)' }}>+</b> to plan a player into an upcoming game — it
        goes on whichever court is free, ahead of the auto queue, and open spots are auto-filled by level.
      </p>
      <div className="legend">
        <span>
          <i className="sw" style={{ background: 'var(--color-accent)' }} />
          Playing now
        </span>
        <span>
          <i className="sw" style={{ border: '1px solid var(--color-neutral-400)' }} />
          Done
        </span>
        <span>
          <i className="sw" style={{ border: '1px dashed var(--color-accent)' }} />
          Planned
        </span>
        {showAuto && (
          <span>
            <i className="sw" style={{ background: 'var(--color-neutral-200)' }} />
            Next auto
          </span>
        )}
      </div>
      <div className="row" style={{ flexWrap: 'wrap', gap: '8px 12px' }}>
        <button type="button" role="switch" aria-checked={showAuto} className="switch" onClick={() => setShowAuto(!showAuto)}>
          <span className="track">
            <span className="knob" />
          </span>
          Show next auto match
        </button>
        <button type="button" role="switch" aria-checked={byCourt} className="switch" onClick={() => setByCourt(!byCourt)}>
          <span className="track">
            <span className="knob" />
          </span>
          Number by court
        </button>
        <SortBy value={sort} onChange={setSort} />
        {hl && (
          <button type="button" className="btn btn-ghost" style={{ minHeight: 36, fontSize: 13, border: '1px solid var(--color-accent-800)' }} onClick={() => setHl(null)}>
            Showing game {hl} · {hlCount} players
            <XIcon size={14} />
          </button>
        )}
        {nextPlanned && <div className="push small muted">Up next from plan: game {started + 1}</div>}
      </div>

      <div className="plan-scroll">
        <div className="plan" role="grid" aria-label="Game plan">
          <div className="plan-row plan-head" style={{ gridTemplateColumns: cols }} role="row">
            <div className="plan-name caps muted">Player · game no.</div>
            {Array.from({ length: ncols }, (_, i) => (
              <div key={i} className="plan-cell" style={{ fontSize: 15, color: 'var(--color-accent-700)' }} role="columnheader">
                {i + 1}
              </div>
            ))}
          </div>
          {rows.map((r) => {
            const list = per.get(r.memberId) ?? [];
            const played = list.filter((e) => e.st === 'done' || e.st === 'live').length;
            return (
              <div key={r.memberId} className="plan-row" style={{ gridTemplateColumns: cols }} role="row">
                <div className="plan-name">
                  <span className="trunc" style={{ fontSize: 15 }}>
                    {r.name}
                    {sort === 'level' && r.level !== undefined && <span className="faint" style={{ fontSize: 12 }}> {r.level}</span>}
                  </span>
                  <span className="push faint" style={{ fontSize: 11 }}>
                    {played}
                  </span>
                </div>
                {Array.from({ length: ncols }, (_, i) => {
                  const e = list[i];
                  const isNext = i === list.length && plannable(r.status);
                  const st = e ? e.st : isNext ? 'next' : 'empty';
                  const editable = st === 'plan' || st === 'next';
                  return (
                    <button
                      key={i}
                      type="button"
                      className="plan-cell"
                      data-st={st}
                      data-hl={!!e && e.gameNo === hl}
                      data-sel={!!pick && pick.memberId === r.memberId && pick.col === i}
                      disabled={st === 'empty'}
                      aria-label={`${r.name}, game ${i + 1}${e ? `: ${e.code} ${e.st}` : isNext ? ': plan a game' : ''}`}
                      onClick={() => {
                        if (e) setHl(hl === e.gameNo && !editable ? null : e.gameNo);
                        if (editable) setPick({ memberId: r.memberId, col: i, from: e && e.st === 'plan' ? e.gameNo : null });
                      }}
                    >
                      {e ? e.code : isNext ? '+' : ''}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {pick && (
        <PickSheet
          pick={pick}
          setPick={setPick}
          started={started}
          need={courts.some((c) => c.matchType === 'doubles') ? 4 : 2}
          slot={slot}
          busy={busy}
          onChoose={async (gameNo) => {
            const ok = await act(() =>
              send<SessionState>('POST', `${base}/plan`, { gameNo, memberId: pick.memberId, ...(pick.from && { from: { gameNo: pick.from } }) }),
            );
            if (ok) {
              setPick(null);
              setHl(gameNo);
            }
          }}
          onClear={async () => {
            if (await act(() => send<SessionState>('DELETE', `${base}/plan/${pick.from}/${pick.memberId}`))) setPick(null);
          }}
        />
      )}
    </div>
  );
}

function PickSheet({
  pick,
  setPick,
  started,
  need,
  slot,
  busy,
  onChoose,
  onClear,
}: {
  pick: Pick;
  setPick: (p: Pick | null) => void;
  started: number;
  need: number;
  slot: (gameNo: number) => number[];
  busy: boolean;
  onChoose: (gameNo: number) => void;
  onClear: () => void;
}) {
  const { state } = useSessionCtx();
  const name = (id: number) => state.attendance.find((a) => a.memberId === id)?.name ?? '?';
  const plannedNos = (state.plan ?? []).map((p) => p.gameNo);
  // Upcoming game numbers: through the end of the queue, plus one more past the last plan.
  const last = Math.max(started + state.queue.length, ...plannedNos.map((n) => n + 1), started + 1);
  const rows = Array.from({ length: last - started }, (_, i) => started + 1 + i);

  return (
    <Sheet label={pick.from ? 'Move planned game' : 'Plan a game'} onClose={() => setPick(null)}>
      <div className="kicker">
        {name(pick.memberId)} · their game {pick.col + 1}
      </div>
      <div className="sheet-title">{pick.from ? 'Move planned game' : 'Plan a game'}</div>
      <div className="list" style={{ borderTop: '1px solid var(--color-divider)' }}>
        {rows.map((n, i) => {
          const who = slot(n);
          const isCur = pick.from === n;
          const already = who.includes(pick.memberId) && !isCur;
          const off = !isCur && (who.length >= need || already);
          return (
            <button
              key={n}
              type="button"
              className="slot-btn"
              aria-current={isCur}
              disabled={off || busy}
              onClick={() => !isCur && onChoose(n)}
            >
              <span className="heading" style={{ fontSize: 22 }}>
                {n}
              </span>
              <span className="body-sm muted trunc">
                {who.length ? who.map(name).join(', ') : 'Open'}
                {i === 0 && ' · next free court'}
              </span>
              <span className="small muted">{already ? 'Already in' : `${who.length}/${need}`}</span>
            </button>
          );
        })}
      </div>
      <div className="row">
        {pick.from && (
          <button type="button" className="btn btn-ghost" style={{ height: 44, flex: 1, fontSize: 15 }} disabled={busy} onClick={onClear}>
            Clear cell
          </button>
        )}
        <button type="button" className="btn btn-ghost" style={{ height: 44, flex: 1, fontSize: 15, color: 'var(--color-neutral-700)' }} onClick={() => setPick(null)}>
          Cancel
        </button>
      </div>
    </Sheet>
  );
}
