import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, MemberView, send } from '../api';
import { Btn, Field, Stepper, XIcon } from '../components/ui';
import { clampLevel } from '../pages/NewGroup';
import { useToast } from '../toast';

/** Admin roster: add, search, nudge levels, and remove (tap × twice). */
export function MembersTab({ gid, onCount }: { gid: number; onCount: (n: number) => void }) {
  const toast = useToast();
  const [members, setMembers] = useState<MemberView[] | null>(null);
  const [query, setQuery] = useState('');
  const [newName, setNewName] = useState('');
  const [newLevel, setNewLevel] = useState('50');
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState<number | null>(null);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const load = useCallback(() => {
    get<MemberView[]>(`/groups/${gid}/members`).then((r) => {
      setMembers(r.data);
      onCount(r.data.length);
    });
  }, [gid, onCount]);
  useEffect(load, [load]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  async function add(e: FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return setError('Enter a name.');
    if (members?.some((m) => m.name.toLowerCase() === name.toLowerCase())) return setError(`${name} is already in this group.`);
    try {
      await send('POST', `/groups/${gid}/members`, { name, level: clampLevel(newLevel) });
      setNewName('');
      setQuery('');
      setError(null);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // Level taps update at once and save after a short pause, so a run of taps is one request.
  function setLevel(m: MemberView, level: number) {
    setMembers((list) => list!.map((x) => (x.id === m.id ? { ...x, level } : x)));
    clearTimeout(timers.current.get(m.id));
    timers.current.set(
      m.id,
      setTimeout(() => {
        send('PATCH', `/groups/${gid}/members/${m.id}`, { level }).catch((e) => {
          toast((e as Error).message, 'error');
          load();
        });
      }, 600),
    );
  }

  async function remove(m: MemberView) {
    if (armed !== m.id) return setArmed(m.id);
    setArmed(null);
    try {
      await send('PATCH', `/groups/${gid}/members/${m.id}`, { active: false });
      load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  const q = query.trim().toLowerCase();
  const rows = (members ?? []).filter((m) => m.name.toLowerCase().includes(q));

  return (
    <>
      <form className="add-grid" onSubmit={add}>
        <Field label="Add member">
          <input className="input" placeholder="Name" value={newName} onChange={(e) => (setNewName(e.target.value), setError(null))} />
        </Field>
        <Field label="Level">
          <input className="input" type="number" inputMode="numeric" min={1} max={100} value={newLevel} onChange={(e) => setNewLevel(e.target.value)} />
        </Field>
        <Btn type="submit" style={{ height: 44 }}>
          Add
        </Btn>
      </form>
      {error && <p className="err">{error}</p>}
      <input
        className="input"
        type="search"
        aria-label="Search members"
        placeholder={`Search ${members?.length ?? ''} members`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="list">
        <div className="member-grid member-head caps muted">
          <span>Member</span>
          <span style={{ textAlign: 'center' }}>Level</span>
          <span />
        </div>
        {!members && <p className="muted" style={{ padding: '12px 0' }}>Loading…</p>}
        {rows.map((m) => (
          <div key={m.id} className="member-grid line">
            <Link to={`/g/${gid}/members/${m.id}`} className="trunc" style={{ color: 'inherit', textDecoration: 'none', fontSize: 15 }}>
              {m.name}
              {m.role === 'admin' && <span className="small faint"> · admin</span>}
            </Link>
            <Stepper label={`${m.name}'s level`} value={m.level ?? 50} min={1} max={100} onChange={(v) => setLevel(m, v)} />
            {m.isOwner ? (
              <span />
            ) : (
              <button
                type="button"
                className="btn btn-ghost btn-icon"
                aria-label={armed === m.id ? `Tap again to remove ${m.name}` : `Remove ${m.name}`}
                title={armed === m.id ? 'Tap again to remove' : 'Remove'}
                style={{ color: armed === m.id ? 'var(--color-accent-800)' : 'var(--color-neutral-700)' }}
                onClick={() => remove(m)}
              >
                <XIcon />
              </button>
            )}
          </div>
        ))}
        {members && q && rows.length === 0 && (
          <p className="body-sm muted" style={{ padding: '12px 0' }}>
            No members match “{query.trim()}”.
          </p>
        )}
      </div>
      <p className="small muted">
        Levels steer match balancing and are only visible to admins. Tap × twice to remove — past results are kept.
      </p>
    </>
  );
}
