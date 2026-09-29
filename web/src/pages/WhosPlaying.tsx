import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { get, MemberView, send, SessionState } from '../api';
import { useGroup } from '../App';
import { BackButton, Btn } from '../components/ui';
import { formatDate, plural } from '../format';
import { clampLevel } from './NewGroup';

const MIN_PLAYERS = 4;

/** "Who's playing?" — tick today's players before a session goes live. */
export function WhosPlaying() {
  const { gid, membership } = useGroup();
  const sid = Number(useParams().sid);
  const navigate = useNavigate();
  const [session, setSession] = useState<SessionState | null>(null);
  const [members, setMembers] = useState<MemberView[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState('');
  const [newName, setNewName] = useState('');
  const [newLevel, setNewLevel] = useState('50');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadMembers = useCallback(() => get<MemberView[]>(`/groups/${gid}/members`).then((r) => setMembers(r.data)), [gid]);
  useEffect(() => {
    get<SessionState>(`/sessions/${sid}`).then((r) => {
      setSession(r.data);
      // Anyone already marked here stays ticked.
      setPicked(new Set(r.data.attendance.filter((a) => a.status === 'present').map((a) => a.memberId)));
    });
    void loadMembers();
  }, [sid, loadMembers]);

  if (!session || !members) return <div className="center-msg">Loading…</div>;
  if (session.session.status !== 'scheduled') {
    navigate(`/g/${gid}/s/${sid}`, { replace: true });
    return null;
  }

  const toggle = (id: number) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
    setError(null);
  };
  const allOn = members.length > 0 && members.every((m) => picked.has(m.id));
  const q = query.trim().toLowerCase();
  const rows = members.filter((m) => m.name.toLowerCase().includes(q));
  const need = session.courts.reduce((n, c) => n + (c.matchType === 'singles' ? 2 : 4), 0);
  const count = picked.size;
  const hint =
    count < MIN_PLAYERS
      ? `Pick at least ${MIN_PLAYERS}`
      : count < need
        ? `Fewer than ${need} — some courts will wait`
        : `${count - need} resting per round`;

  async function addSomeone(e: FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return setError('Enter a name.');
    const existing = members!.find((m) => m.name.toLowerCase() === name.toLowerCase());
    try {
      let id = existing?.id;
      if (!id) {
        id = (await send<{ id: number }>('POST', `/groups/${gid}/members`, { name, level: clampLevel(newLevel) })).id;
        await loadMembers();
      }
      setPicked(new Set([...picked, id]));
      setNewName('');
      setQuery('');
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function begin() {
    if (count < MIN_PLAYERS) return setError(`Pick at least ${MIN_PLAYERS} players to start.`);
    setBusy(true);
    try {
      await send('POST', `/sessions/${sid}/start`, { present: [...picked] });
      navigate(`/g/${gid}/s/${sid}`, { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const s = session.session;
  return (
    <div className="screen">
      <div className="head">
        <div className="head-row">
          <BackButton label={membership!.groupName} onClick={() => navigate(`/g/${gid}`)} />
        </div>
        <div className="title">Who's playing?</div>
        <div className="body-sm muted">
          {formatDate(s.date)} · {s.startTime}–{s.endTime} · {plural(session.courts.length, 'court')}
        </div>
      </div>
      <div className="body" style={{ paddingTop: 14 }}>
        <div className="col" style={{ gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 8 }}>
            <input
              className="input"
              type="search"
              aria-label="Search members"
              placeholder={`Search ${members.length} members`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Btn style={{ height: 44, minWidth: 104 }} onClick={() => setPicked(allOn ? new Set() : new Set(members.map((m) => m.id)))}>
              {allOn ? 'Clear all' : 'Select all'}
            </Btn>
          </div>
          <div className="list" style={{ borderTop: '1px solid var(--color-divider)' }}>
            {rows.map((m) => {
              const on = picked.has(m.id);
              return (
                <button key={m.id} type="button" role="checkbox" aria-checked={on} className="check-row" onClick={() => toggle(m.id)}>
                  <span className="check-box" aria-hidden>
                    {on && (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    )}
                  </span>
                  <span className="trunc" style={{ fontSize: 15 }}>
                    {m.name}
                  </span>
                  <span className="small muted">Lv {m.level}</span>
                </button>
              );
            })}
            {q && rows.length === 0 && (
              <p className="body-sm muted" style={{ padding: '12px 0' }}>
                No members match “{query.trim()}”.
              </p>
            )}
          </div>
          <form className="stack-sm" style={{ paddingTop: 6 }} onSubmit={addSomeone}>
            <div className="label">Someone new?</div>
            <div className="add-grid">
              <input className="input" placeholder="Name" aria-label="New player name" value={newName} onChange={(e) => (setNewName(e.target.value), setError(null))} />
              <input className="input" type="number" min={1} max={100} aria-label="Level" value={newLevel} onChange={(e) => setNewLevel(e.target.value)} />
              <Btn type="submit" style={{ height: 44 }}>
                Add
              </Btn>
            </div>
            <p className="small muted">Added to the group and ticked for this session. Late arrivals can be added from Attend during the session.</p>
          </form>
          {error && (
            <p className="err" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
      <div className="foot">
        <div className="col">
          <div className="row small muted" style={{ alignItems: 'baseline' }}>
            <span>
              {count} of {members.length} playing
            </span>
            <span className="push">{hint}</span>
          </div>
          <Btn variant="primary" size="lg" disabled={busy} onClick={begin}>
            {count >= MIN_PLAYERS ? `Start session · ${count} players` : 'Start session'}
          </Btn>
        </div>
      </div>
    </div>
  );
}
