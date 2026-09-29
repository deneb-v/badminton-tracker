import { FormEvent, useState } from 'react';
import { AttendanceStatus, AttendanceView, send, sendOrQueue, SessionState } from '../api';
import { Btn } from '../components/ui';
import { formatTime, plural } from '../format';
import { clampLevel } from '../pages/NewGroup';
import { byLevel, idsOf, SortBy, usePlayerSort, useSessionCtx } from './context';

const COUNTS: [AttendanceStatus, string][] = [
  ['present', 'Here'],
  ['late', 'Late'],
  ['absent', 'Away'],
  ['departed', 'Left'],
];
const OPTIONS: [AttendanceStatus, string][] = [
  ['present', 'Here'],
  ['late', 'Late'],
  ['departed', 'Left'],
];
const RANK: Record<AttendanceStatus, number> = { present: 0, late: 1, invited: 2, departed: 3, absent: 4 };

/**
 * Arrivals and walk-ins during a session. People who weren't ticked in "Who's playing?" (away) are
 * hidden; typing their name in "Add a walk-in" brings them in.
 */
export function AttendanceTab() {
  const { state, isAdmin, act, base, busy } = useSessionCtx();
  const [query, setQuery] = useState('');
  const [addName, setAddName] = useState('');
  const [addLevel, setAddLevel] = useState('50');
  const [addMsg, setAddMsg] = useState<string | null>(null);
  const [sort, setSort] = usePlayerSort();
  const closed = state.session.status === 'closed';

  const count = (s: AttendanceStatus) => state.attendance.filter((a) => a.status === s).length;
  const q = query.trim().toLowerCase();
  const rows = state.attendance
    .filter((a) => a.status !== 'absent' && a.name.toLowerCase().includes(q))
    .sort((a, b) => RANK[a.status] - RANK[b.status] || (sort === 'level' ? byLevel(a, b) : a.name.localeCompare(b.name)));

  const where = (a: AttendanceView) => {
    const court = state.courts.find((c) => c.current && idsOf(c.current).includes(a.memberId));
    if (court) return `on Court ${court.label}`;
    const i = state.queue.findIndex((m) => idsOf(m).includes(a.memberId));
    if (i >= 0 && a.status === 'present') return `queued #${i + 1}`;
    return {
      present: 'waiting',
      late: 'on the way',
      absent: 'not in pool',
      departed: a.departedAt ? `left ${formatTime(a.departedAt)}` : 'departed',
      invited: 'not marked',
    }[a.status];
  };

  const mark = (a: AttendanceView, status: AttendanceStatus) =>
    a.status !== status &&
    act(() =>
      sendOrQueue<SessionState>({
        sessionId: state.session.id,
        kind: 'attendance',
        memberId: a.memberId,
        method: 'PUT',
        url: `${base}/attendance/${a.memberId}`,
        body: { status },
      }),
    );

  async function addWalkIn(e: FormEvent) {
    e.preventDefault();
    const name = addName.trim();
    if (!name) return setAddMsg('Enter a name.');
    const known = state.attendance.find((a) => a.name.toLowerCase() === name.toLowerCase());
    if (known?.status === 'present') return setAddMsg(`${known.name} is already here.`);
    const ok = await act(() => send<SessionState>('POST', `${base}/walk-ins`, { name, level: clampLevel(addLevel) }));
    if (ok) {
      setAddName('');
      setQuery('');
      setAddMsg(known ? `${known.name} was already on the list — marked as arrived.` : null);
    }
  }

  return (
    <div className="col col-tight">
      <div className="stats">
        {COUNTS.map(([s, label]) => (
          <div key={s}>
            <b>{count(s)}</b>
            <span>{label}</span>
          </div>
        ))}
      </div>

      {isAdmin && !closed && (
        <form className="stack-sm" style={{ paddingBottom: 12, borderBottom: '1px solid var(--color-divider)' }} onSubmit={addWalkIn}>
          <div className="label">Add a walk-in</div>
          <div className="add-grid" style={{ alignItems: 'stretch' }}>
            <input className="input" placeholder="Name" aria-label="Walk-in name" value={addName} onChange={(e) => (setAddName(e.target.value), setAddMsg(null))} />
            <input className="input" type="number" min={1} max={100} aria-label="Level" value={addLevel} onChange={(e) => setAddLevel(e.target.value)} />
            <Btn type="submit" variant="primary" style={{ height: 44 }} disabled={busy}>
              Add
            </Btn>
          </div>
          {addMsg && <p className="err">{addMsg}</p>}
          <p className="small muted">
            Joins the queue now, level with the fewest games played. Group members who weren't ticked are hidden — type
            their name here when they arrive.
          </p>
        </form>
      )}

      <input
        className="input"
        type="search"
        aria-label="Search members"
        placeholder={`Search ${state.attendance.length} members`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {isAdmin && <SortBy value={sort} onChange={setSort} />}
      <div className="list">
        {rows.map((a) => (
          <div key={a.memberId} className="line" style={{ padding: '8px 0' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="trunc" style={{ fontSize: 15 }}>
                {a.name}
                {a.isGuest && <span className="small faint"> · guest</span>}
                {a.pending && <span className="small faint"> · syncing</span>}
              </div>
              <div className="faint" style={{ fontSize: 11 }}>
                {a.level !== undefined && `Lv ${a.level} · `}
                {plural(a.gamesPlayed, 'game')} · {where(a)}
              </div>
            </div>
            {isAdmin && !closed && (
              <div className="seg seg-sm" role="radiogroup" aria-label={`${a.name} attendance`}>
                {OPTIONS.map(([s, label]) => (
                  <button key={s} type="button" role="radio" aria-checked={a.status === s} onClick={() => mark(a, s)}>
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {rows.length === 0 && (
          <p className="body-sm muted" style={{ padding: '12px 0' }}>
            {q ? `No one here matches “${query.trim()}” — add them as a walk-in.` : 'No one marked yet.'}
          </p>
        )}
      </div>
    </div>
  );
}
