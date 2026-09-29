import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { get, GroupView, MatchType, send, SessionState, WEEK } from '../api';
import { useGroup } from '../App';
import { BackButton, Btn, Field, Seg, Stepper } from '../components/ui';
import { formatDate, plural, weekdayShort, ymd } from '../format';

type Format = MatchType | 'mixed';
interface CourtDraft {
  /** Kept when editing, so existing courts (and their games) stay the same court. */
  label?: string;
  from: string;
  until: string;
  type: MatchType;
}

const LABELS = 'ABCDEF';
const MIN_COURTS = 1;
const MAX_COURTS = 6;
const weekdayOf = (d: Date) => WEEK[(d.getDay() + 6) % 7];

export function NewSession() {
  return <SessionForm />;
}

/** Edit an existing session with the same form. Opened from the session card or the session's Edit tab. */
export function EditSession() {
  const sid = Number(useParams().sid);
  const { gid } = useGroup();
  const [state, setState] = useState<SessionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    get<SessionState>(`/sessions/${sid}`)
      .then((r) => setState(r.data))
      .catch((e) => setError((e as Error).message));
  }, [sid, gid]);
  if (error) return <div className="center-msg err">{error}</div>;
  if (!state) return <div className="center-msg">Loading…</div>;
  if (state.session.status === 'closed') return <div className="center-msg">A finished session can no longer be edited.</div>;
  return <SessionForm existing={state} />;
}

function SessionForm({ existing }: { existing?: SessionState }) {
  const { gid, membership, isAdmin } = useGroup();
  const navigate = useNavigate();
  const location = useLocation();
  const [group, setGroup] = useState<GroupView | null>(null);
  const editing = !!existing;
  const back = (location.state as { back?: string } | null)?.back ?? (editing ? `/g/${gid}/s/${existing.session.id}` : `/g/${gid}`);

  const dates = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => {
        const d = new Date();
        d.setDate(d.getDate() + i);
        return d;
      }),
    [],
  );
  // New: start on the next of the group's usual days, if it has any. Edit: the session's own values.
  const usual = membership!.days;
  const cur = existing?.session;
  const [date, setDate] = useState(() => cur?.date ?? ymd(dates.find((d) => usual.includes(weekdayOf(d))) ?? dates[0]));
  const [otherDate, setOtherDate] = useState(() => !!cur && !dates.some((d) => ymd(d) === cur.date));
  const [start, setStart] = useState(cur?.startTime ?? '19:00');
  const [end, setEnd] = useState(cur?.endTime ?? '21:00');
  const [count, setCount] = useState(existing?.courts.length ?? 2);
  const [courts, setCourts] = useState<CourtDraft[]>(() => {
    const drafts: CourtDraft[] = (existing?.courts ?? []).map((c) => ({
      label: c.label,
      from: c.availableFrom,
      until: c.availableUntil,
      type: c.matchType,
    }));
    while (drafts.length < MAX_COURTS) drafts.push({ from: cur?.startTime ?? '19:00', until: cur?.endTime ?? '21:00', type: 'doubles' });
    return drafts;
  });
  const [format, setFormat] = useState<Format>(() =>
    !existing ? 'doubles' : new Set(existing.courts.map((c) => c.matchType)).size > 1 ? 'mixed' : existing.session.matchType,
  );
  /** A level game every N games; 0 = off. */
  const [levelEvery, setLevelEvery] = useState(cur ? (cur.levelEvery ?? 0) : 3);
  const [venue, setVenue] = useState(cur?.venue ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get<GroupView>(`/groups/${gid}`).then((r) => setGroup(r.data));
  }, [gid]);

  if (!isAdmin) return <div className="center-msg">Only admins can {editing ? 'edit' : 'create'} sessions.</div>;

  // Courts that still follow the session's hours move with them.
  function setSessionTime(which: 'start' | 'end', v: string) {
    const key = which === 'start' ? 'from' : 'until';
    const old = which === 'start' ? start : end;
    setCourts(courts.map((c) => (c[key] === old ? { ...c, [key]: v } : c)));
    (which === 'start' ? setStart : setEnd)(v);
    setError(null);
  }
  const setCourt = (i: number, patch: Partial<CourtDraft>) => {
    setCourts(courts.map((c, j) => (i === j ? { ...c, ...patch } : c)));
    setError(null);
  };
  function chooseFormat(f: Format) {
    setFormat(f);
    // Mixed starts with the last court on singles; the rest stay doubles.
    if (f === 'mixed' && courts.slice(0, count).every((c) => c.type === 'doubles')) setCourt(count - 1, { type: 'singles' });
  }

  const needsVenue = editing || (group !== null && !group.venue);
  const active = courts.slice(0, count);
  // Existing courts keep their labels; added ones take the next free letter.
  const used = new Set(active.map((c) => c.label).filter(Boolean));
  const spare = [...LABELS].filter((l) => !used.has(l));
  const labels = active.map((c) => c.label ?? spare.shift()!);

  async function create() {
    if (end <= start) return setError('End time must be after start time.');
    const bad = active.findIndex((c) => c.until <= c.from);
    if (bad >= 0) return setError(`Court ${labels[bad]} closes before it opens.`);
    if (needsVenue && !venue.trim()) return setError('Where is it? Add a venue (or set one for the group in Manage).');
    setBusy(true);
    try {
      if (existing) {
        await send('PUT', `/sessions/${existing.session.id}/setup`, {
          venue: venue.trim(),
          date,
          startTime: start,
          endTime: end,
          matchType: format === 'singles' ? 'singles' : 'doubles',
          levelEvery: levelEvery || null,
          courts: active.map((c, i) => ({
            label: labels[i],
            availableFrom: c.from,
            availableUntil: c.until,
            matchType: format === 'mixed' && c.type === 'singles' ? 'singles' : null,
          })),
        });
        navigate(back, { replace: true });
        return;
      }
      await send('POST', `/groups/${gid}/sessions`, {
        ...(needsVenue && { venue: venue.trim() }),
        date,
        startTime: start,
        endTime: end,
        matchType: format === 'singles' ? 'singles' : 'doubles',
        levelEvery: levelEvery || null,
        courts: active.map((c, i) => ({
          label: labels[i],
          availableFrom: c.from,
          availableUntil: c.until,
          matchType: format === 'mixed' && c.type === 'singles' ? 'singles' : null,
        })),
      });
      navigate(`/g/${gid}?tab=sessions`, { replace: true });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const maxGap = group?.settings?.doublesMaxGap ?? 8;
  return (
    <div className="screen">
      <div className="head">
        <div className="head-row">
          <BackButton label={editing ? 'Back' : membership!.groupName} onClick={() => navigate(back)} />
        </div>
        <div className="title">{editing ? 'Edit session' : 'New session'}</div>
      </div>
      <div className="body">
        <div className="col" style={{ gap: 20 }}>
          <div className="stack-sm">
            <div className="label">Date</div>
            <div className="date-chips" role="group" aria-label="Date">
              {dates.map((d, i) => (
                <button
                  key={i}
                  type="button"
                  className="date-chip"
                  aria-pressed={!otherDate && date === ymd(d)}
                  aria-label={formatDate(ymd(d))}
                  onClick={() => (setDate(ymd(d)), setOtherDate(false))}
                >
                  <span className="dow">{i === 0 ? 'Today' : weekdayShort(d)}</span>
                  <span className="dom">{d.getDate()}</span>
                </button>
              ))}
              <button type="button" className="date-chip" aria-pressed={otherDate} onClick={() => setOtherDate(true)}>
                <span className="dow">Later</span>
                <span className="dom">…</span>
              </button>
            </div>
            {otherDate && (
              <input className="input" type="date" aria-label="Session date" min={editing ? undefined : ymd(dates[0])} value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label="Starts">
              <input className="input" type="time" value={start} onChange={(e) => setSessionTime('start', e.target.value)} />
            </Field>
            <Field label="Ends">
              <input className="input" type="time" value={end} onChange={(e) => setSessionTime('end', e.target.value)} />
            </Field>
          </div>

          {needsVenue && (
            <Field label="Venue">
              <input className="input" placeholder="e.g. Riverside SC" value={venue} onChange={(e) => setVenue(e.target.value)} />
            </Field>
          )}

          <div className="stack-sm" style={{ gap: 8 }}>
            <div className="row">
              <div className="label">Courts</div>
              <div className="push">
                <Stepper large label="courts" value={count} min={MIN_COURTS} max={MAX_COURTS} onChange={setCount} />
              </div>
            </div>
            <div className="list" style={{ borderTop: '1px solid var(--color-divider)' }}>
              {active.map((c, i) => (
                <div key={i} className={`court-row ${format === 'mixed' ? 'mixed' : ''}`}>
                  <div className="court-id">{labels[i]}</div>
                  <input className="input input-sm" type="time" aria-label={`Court ${labels[i]} opens`} value={c.from} onChange={(e) => setCourt(i, { from: e.target.value })} />
                  <div className="faint" style={{ textAlign: 'center' }}>
                    –
                  </div>
                  <input className="input input-sm" type="time" aria-label={`Court ${labels[i]} closes`} value={c.until} onChange={(e) => setCourt(i, { until: e.target.value })} />
                  {format === 'mixed' && (
                    <Seg
                      className="seg-sm"
                      label={`Court ${labels[i]} format`}
                      value={c.type}
                      onChange={(t) => setCourt(i, { type: t })}
                      options={[
                        { value: 'doubles', label: 'D' },
                        { value: 'singles', label: 'S' },
                      ]}
                    />
                  )}
                </div>
              ))}
            </div>
            <p className="small muted">
              Each court can have its own booked window. Admins get a warning 25 min before a court closes.
            </p>
          </div>

          <div className="stack-sm">
            <div className="label">Format</div>
            <Seg
              className="seg-wide"
              label="Format"
              value={format}
              onChange={chooseFormat}
              options={[
                { value: 'doubles', label: 'Doubles' },
                { value: 'singles', label: 'Singles' },
                { value: 'mixed', label: 'Mixed' },
              ]}
            />
            {format === 'mixed' && <p className="small muted">Pick doubles (D) or singles (S) for each court above.</p>}
          </div>

          <div className="stack-sm">
            <div className="label">Level game every</div>
            <Seg
              label="Level game every"
              value={levelEvery}
              onChange={setLevelEvery}
              options={[
                ...[2, 3, 4].map((n) => ({ value: n, label: `${n} games` })),
                { value: 0, label: 'Off' },
              ]}
            />
          </div>
          <p className="small muted">
            {levelEvery
              ? `Every ${levelEvery === 2 ? '2nd' : levelEvery === 3 ? '3rd' : '4th'} game is against players of a similar level. The rest are mixed: the strongest player partners the weakest, so everyone gets to learn.`
              : 'No rotation: games go to whoever has waited longest, with teams kept even.'}{' '}
            Teams more than {maxGap} levels apart are flagged.
          </p>
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
              {formatDate(date)} · {start}–{end} · {plural(count, 'court')}
            </span>
            <span className="push">
              {editing
                ? existing.session.status === 'live'
                  ? 'Changes apply to games not started yet'
                  : 'Attendance stays as it is'
                : 'Everyone in the group is invited'}
            </span>
          </div>
          <Btn variant="primary" size="lg" disabled={busy} onClick={create}>
            {editing ? 'Save changes' : 'Create session'}
          </Btn>
        </div>
      </div>
    </div>
  );
}
