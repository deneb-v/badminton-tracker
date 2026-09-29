import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { send, WEEK, Weekday } from '../api';
import { useAuth } from '../auth';
import { BackButton, Btn, DayPicker, Field, XIcon } from '../components/ui';

export const clampLevel = (v: string | number) => Math.max(1, Math.min(100, Math.round(Number(v)) || 1));

export const toggleDay = (days: Weekday[], d: Weekday) =>
  days.includes(d) ? days.filter((x) => x !== d) : WEEK.filter((x) => x === d || days.includes(x));

/** Two steps: details, then the starting roster with levels. */
export function NewGroup() {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState('');
  const [venue, setVenue] = useState('');
  const [days, setDays] = useState<Weekday[]>([]);
  const [members, setMembers] = useState<{ name: string; level: number }[]>([]);
  const [newName, setNewName] = useState('');
  const [newLevel, setNewLevel] = useState('50');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function addMember(e?: FormEvent) {
    e?.preventDefault();
    const n = newName.trim();
    if (!n) return setError('Enter a name.');
    if (members.some((m) => m.name.toLowerCase() === n.toLowerCase())) return setError(`${n} is already on the list.`);
    setMembers([{ name: n, level: clampLevel(newLevel) }, ...members]);
    setNewName('');
    setError(null);
  }

  async function next() {
    if (step === 1) {
      if (!name.trim()) return setError('Give the group a name.');
      setError(null);
      return setStep(2);
    }
    setBusy(true);
    try {
      const { id } = await send<{ id: number }>('POST', '/groups', { name, venue, days, members });
      await refresh();
      navigate(`/g/${id}?tab=members`, { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="screen">
      <div className="head">
        <div className="head-row">
          <BackButton label="Back" onClick={() => (step === 2 ? setStep(1) : navigate('/groups'))} />
          <div className="kicker push">Step {step} of 2</div>
        </div>
        <div className="head-title">
          <div className="title">{step === 1 ? 'New group' : 'Add members'}</div>
          {step === 2 && <div className="push small muted">{members.length} added</div>}
        </div>
      </div>
      <div className="body">
        <div className="col">
          {step === 1 ? (
            <>
              <Field label="Group name">
                <input className="input" placeholder="e.g. Thursday Group" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
              </Field>
              <Field label="Venue">
                <input className="input" placeholder="e.g. Riverside SC" value={venue} onChange={(e) => setVenue(e.target.value)} />
              </Field>
              <div className="stack-sm">
                <div className="label">Usual days</div>
                <DayPicker days={days} week={WEEK} onToggle={(d) => setDays(toggleDay(days, d))} />
              </div>
            </>
          ) : (
            <>
              <p className="body-sm muted">
                Give each member a level from 1–100. It's used to balance matches and is only visible to admins. You can
                also add people later, or share the group's invite code so they join themselves.
              </p>
              <form className="add-grid" onSubmit={addMember}>
                <Field label="Name">
                  <input className="input" placeholder="Member name" value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus />
                </Field>
                <Field label="Level">
                  <input className="input" type="number" inputMode="numeric" min={1} max={100} value={newLevel} onChange={(e) => setNewLevel(e.target.value)} />
                </Field>
                <Btn type="submit" style={{ height: 44 }}>
                  Add
                </Btn>
              </form>
              <div className="list">
                {members.map((m, i) => (
                  <div key={m.name} className="line" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto 44px' }}>
                    <div className="trunc">{m.name}</div>
                    <div className="small muted">Lv {m.level}</div>
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon"
                      aria-label={`Remove ${m.name}`}
                      onClick={() => setMembers(members.filter((_, j) => j !== i))}
                    >
                      <XIcon />
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
          {error && (
            <p className="err" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
      <div className="foot">
        <div className="col">
          <Btn variant="primary" size="lg" disabled={busy} onClick={next}>
            {step === 1 ? 'Next: add members' : 'Create group'}
          </Btn>
        </div>
      </div>
    </div>
  );
}
