import { Fragment, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CourtView, MatchView, PlayerRef, send, SessionState } from '../api';
import { Btn, Frame } from '../components/ui';
import { minutesSince, minutesUntil, names, plural } from '../format';
import { idsOf, nextFor, teamAvg, useSessionCtx } from './context';

type Density = 'full' | 'grid' | 'rows';

export function LiveTab({ tablet }: { tablet: boolean }) {
  const { state, gid, isAdmin, goTo } = useSessionCtx();
  const navigate = useNavigate();
  const status = state.session.status;
  const n = state.courts.length;
  const density: Density = n <= 2 ? 'full' : tablet || n <= 4 ? 'grid' : 'rows';

  if (status === 'closed') {
    return (
      <div className="col">
        <Frame className="empty-card">
          <div className="heading">Session finished</div>
          <div className="muted body-sm">Results and games played are in the summary.</div>
          {isAdmin && (
            <Btn style={{ alignSelf: 'flex-start', height: 44 }} onClick={() => goTo('summary')}>
              View summary
            </Btn>
          )}
        </Frame>
      </div>
    );
  }

  const present = state.attendance.filter((a) => a.status === 'present').length;
  return (
    <div className={`live-grid ${tablet ? 'split' : ''}`}>
      <div className="live-col">
        {status === 'scheduled' &&
          (isAdmin ? (
            <Frame className="empty-card">
              <div className="heading">Not started</div>
              <div className="muted body-sm">
                {plural(present, 'player')} marked here. Tick who's playing, then the play order is built — walk-ins can
                be added from Attend afterwards.
              </div>
              <Btn variant="primary" size="md" onClick={() => navigate(`/g/${gid}/s/${state.session.id}/start`)}>
                Start session
              </Btn>
            </Frame>
          ) : (
            <Frame className="empty-card">
              <div className="heading">Not started yet</div>
              <div className="muted body-sm">The queue appears here once an admin starts the session.</div>
            </Frame>
          ))}
        {!isAdmin && <MeCard />}
        {status === 'live' && <Courts density={density} />}
      </div>
      {status === 'live' && <Queue />}
    </div>
  );
}

// — player names (with levels for admins) —

function Name({ p, align = 'left' }: { p: PlayerRef; align?: 'left' | 'right' }) {
  const { levels, state } = useSessionCtx();
  const lvl = levels.get(p.id);
  const me = p.id === state.viewer.memberId;
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: align === 'right' ? 'flex-end' : undefined }}>
      {align === 'right' && lvl !== undefined && <span className="plvl">{lvl}</span>}
      <span className={`pname ${me ? 'is-me' : ''}`}>{p.name}</span>
      {align === 'left' && lvl !== undefined && <span className="plvl">{lvl}</span>}
    </div>
  );
}

function lvText(levels: Map<number, number>, m: MatchView) {
  const a = teamAvg(levels, m.sideA);
  const b = teamAvg(levels, m.sideB);
  return a !== null && b !== null ? `Lv ${a} v ${b}` : '';
}

// — courts —

function useCourtInfo(court: CourtView) {
  const { state, isAdmin, now } = useSessionCtx();
  const cur = court.current;
  const left = minutesUntil(state.session.date, court.availableUntil, now);
  const next = cur ? undefined : nextFor(state, court, now);
  return {
    cur,
    next,
    left,
    elapsed: cur ? (cur.pending ? 'offline' : `${minutesSince(cur.startedAt, now)} min`) : '',
    warn: isAdmin && !!cur && left > 0 && left < 25,
    idleText:
      left <= 0
        ? 'Court window closed'
        : next
          ? isAdmin
            ? 'Free — tap Start to call the next match'
            : 'Free — next match starting soon'
          : 'Free — no match queued',
    canStart: isAdmin && !cur && !!next && left > 0,
  };
}

function Courts({ density }: { density: Density }) {
  const { state } = useSessionCtx();
  if (density === 'full') return <div className="stack" style={{ gap: 14 }}>{state.courts.map((c) => <CourtFull key={c.id} court={c} />)}</div>;
  if (density === 'grid') return <div className="courts-2">{state.courts.map((c) => <CourtCell key={c.id} court={c} />)}</div>;
  return <div className="stack">{state.courts.map((c) => <CourtRowCard key={c.id} court={c} />)}</div>;
}

function CourtFull({ court }: { court: CourtView }) {
  const { isAdmin, busy, startMatch, finishMatch } = useSessionCtx();
  const { cur, next, left, elapsed, warn, idleText, canStart } = useCourtInfo(court);
  return (
    <Frame className="court-full">
      <div className="row" style={{ alignItems: 'baseline' }}>
        <div className="court-name">Court {court.label}</div>
        <div className="small muted">
          until {court.availableUntil}
          {court.matchType === 'singles' && ' · singles'}
        </div>
        <div className="elapsed">{elapsed}</div>
      </div>
      {cur ? (
        <>
          <div className="matchup">
            <div className="side">{cur.sideA.map((p) => <Name key={p.id} p={p} />)}</div>
            <div className="vs">vs</div>
            <div className="side side-b">{cur.sideB.map((p) => <Name key={p.id} p={p} align="right" />)}</div>
          </div>
          {warn && <div className="tag tag-neutral">Closes in {left} min — next match may not fit</div>}
          {isAdmin && (
            <Btn variant="primary" size="md" disabled={busy} onClick={() => finishMatch(cur)}>
              Done on Court {court.label}
            </Btn>
          )}
        </>
      ) : (
        <div className="muted" style={{ fontSize: 14 }}>
          {idleText}
        </div>
      )}
      {canStart && (
        <Btn variant="primary" size="md" disabled={busy} onClick={() => startMatch(next!, court)}>
          Start {names([...next!.sideA, ...next!.sideB], ', ')}
        </Btn>
      )}
    </Frame>
  );
}

function CourtCell({ court }: { court: CourtView }) {
  const { isAdmin, busy, levels, startMatch, finishMatch } = useSessionCtx();
  const { cur, next, left, elapsed, warn, idleText, canStart } = useCourtInfo(court);
  return (
    <Frame className="court-cell">
      <div className="row" style={{ alignItems: 'baseline', gap: 6 }}>
        <div className="heading" style={{ fontSize: 20 }}>
          Court {court.label}
        </div>
        <div className="elapsed" style={{ fontSize: 17 }}>
          {elapsed}
        </div>
      </div>
      {cur ? (
        <>
          <div className="names">{names(cur.sideA, ' · ')}</div>
          <div className="vs" style={{ fontSize: 10 }}>
            vs
          </div>
          <div className="names">{names(cur.sideB, ' · ')}</div>
          <div className="faint" style={{ fontSize: 11, minHeight: 15 }}>
            {lvText(levels, cur)}
          </div>
          {warn && <div className="tag tag-neutral" style={{ padding: '2px 6px' }}>Closes in {left} min</div>}
          {isAdmin && (
            <Btn variant="primary" size="md" style={{ marginTop: 'auto' }} disabled={busy} onClick={() => finishMatch(cur)}>
              Done
            </Btn>
          )}
        </>
      ) : (
        <div className="muted body-sm">{idleText}</div>
      )}
      {canStart && (
        <Btn variant="primary" size="md" style={{ marginTop: 'auto' }} disabled={busy} onClick={() => startMatch(next!, court)}>
          Start
        </Btn>
      )}
    </Frame>
  );
}

function CourtRowCard({ court }: { court: CourtView }) {
  const { isAdmin, busy, levels, startMatch, finishMatch } = useSessionCtx();
  const { cur, next, left, elapsed, warn, idleText, canStart } = useCourtInfo(court);
  return (
    <Frame className="court-rowcard">
      <div className="rid">
        <div className="heading" style={{ fontSize: 24, lineHeight: 1 }}>
          {court.label}
        </div>
        <div style={{ fontSize: 10, color: 'var(--color-accent-700)' }}>{elapsed}</div>
      </div>
      <div style={{ minWidth: 0 }}>
        {cur ? (
          <>
            <div className="names">{names(cur.sideA, ' · ')}</div>
            <div className="names muted">v {names(cur.sideB, ' · ')}</div>
            <div className="faint" style={{ fontSize: 11 }}>
              {lvText(levels, cur)}
            </div>
            {warn && <div style={{ fontSize: 11, color: 'var(--color-neutral-800)' }}>Closes in {left} min</div>}
          </>
        ) : (
          <div className="muted body-sm">{idleText}</div>
        )}
      </div>
      {cur && isAdmin && (
        <Btn variant="primary" style={{ height: 48, minWidth: 76, fontSize: 16 }} disabled={busy} onClick={() => finishMatch(cur)}>
          Done
        </Btn>
      )}
      {canStart && (
        <Btn variant="primary" style={{ height: 48, minWidth: 76, fontSize: 16 }} disabled={busy} onClick={() => startMatch(next!, court)}>
          Start
        </Btn>
      )}
    </Frame>
  );
}

// — member status card —

const ORDINAL = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

function MeCard() {
  const { state, now } = useSessionCtx();
  const meId = state.viewer.memberId;
  const att = state.attendance.find((a) => a.memberId === meId);
  const court = state.courts.find((c) => c.current && idsOf(c.current).includes(meId));
  const qi = state.queue.findIndex((m) => idsOf(m).includes(meId));

  let headline = 'Resting';
  let eta = '';
  let detail = 'You’ll be added to the next match that forms.';
  let match: MatchView | null = null;
  if (!att) {
    headline = 'Not invited';
    detail = 'You’re not on this session’s list. Ask an admin to add you.';
  } else if (court) {
    headline = `On Court ${court.label}`;
    eta = `${minutesSince(court.current!.startedAt, now)} min`;
    detail = 'You’re playing now.';
    match = court.current;
  } else if (att.status !== 'present') {
    headline = { invited: 'Not checked in', late: 'On your way', absent: 'Sitting out', departed: 'Signed out', present: '' }[att.status];
    detail =
      att.status === 'departed'
        ? 'You’ve left this session. Thanks for playing!'
        : 'An admin marks you in when you arrive — then you join the queue.';
  } else if (qi >= 0) {
    match = state.queue[qi];
    headline = qi === 0 ? 'You’re up next' : `${ORDINAL(qi + 1)} in line`;
    detail = qi === 0 ? 'On the next free court. Stay close.' : 'Games go on whichever court is free first.';
  }

  let partner = '';
  let opp = '';
  if (match) {
    const mine = match.sideA.some((p) => p.id === meId) ? match.sideA : match.sideB;
    const other = mine === match.sideA ? match.sideB : match.sideA;
    partner = names(mine.filter((p) => p.id !== meId));
    opp = names(other);
  }

  return (
    <Frame className="me-card">
      <div className="kicker">{att?.name ?? 'You'} — your status</div>
      <div className="row" style={{ alignItems: 'baseline', gap: 10 }}>
        <div className="me-headline">{headline}</div>
        <div className="me-eta">{eta}</div>
      </div>
      <div style={{ fontSize: 14, color: 'var(--color-accent-200)' }}>{detail}</div>
      {match && (
        <div className="me-pair" style={partner ? undefined : { gridTemplateColumns: '1fr' }}>
          {partner && (
            <div>
              <div className="caps">With</div>
              <div className="heading">{partner}</div>
            </div>
          )}
          <div>
            <div className="caps">Against</div>
            <div className="heading">{opp}</div>
          </div>
        </div>
      )}
      <div className="small" style={{ color: 'var(--color-accent-300)' }}>
        Games today: {att?.gamesPlayed ?? 0}
      </div>
    </Frame>
  );
}

// — queue —

function Queue() {
  const { state, isAdmin, busy, act, base } = useSessionCtx();
  const [open, setOpen] = useState<number | null>(null);
  const meId = state.viewer.memberId;
  const inQueue = new Set(state.queue.flatMap(idsOf));
  const onCourt = new Set(state.courts.flatMap((c) => (c.current ? idsOf(c.current) : [])));
  const waiting = state.attendance.filter((a) => a.status === 'present' && !inQueue.has(a.memberId) && !onCourt.has(a.memberId));

  return (
    <div className="list" style={{ minWidth: 0 }}>
      <div className="row" style={{ alignItems: 'baseline', paddingBottom: 6, borderBottom: '1px solid var(--color-divider)' }}>
        <div className="heading" style={{ fontSize: 18 }}>
          Up next
        </div>
        {isAdmin && (
          <button
            type="button"
            className="btn btn-ghost push"
            style={{ fontSize: 13 }}
            disabled={busy}
            title="Rebuild the queue and drop manual swaps (the game plan stays)"
            onClick={() => act(() => send<SessionState>('POST', `${base}/regenerate`, { reset: true }))}
          >
            Regenerate
          </button>
        )}
      </div>
      {state.queue.length === 0 && (
        <p className="body-sm muted" style={{ padding: '12px 6px' }}>
          No matches queued. Mark more players in, or check court hours.
        </p>
      )}
      {state.queue.map((m, i) => (
        <QueueRow
          key={m.id}
          m={m}
          n={i + 1}
          open={open === m.id}
          mine={!isAdmin && idsOf(m).includes(meId)}
          onToggle={() => setOpen(open === m.id ? null : m.id)}
        />
      ))}
      {isAdmin && waiting.length > 0 && (
        <div className="small muted" style={{ padding: '10px 6px' }}>
          Waiting for a match: {waiting.map((a) => a.name).join(', ')}
        </div>
      )}
    </div>
  );
}

function QueueRow({ m, n, open, mine, onToggle }: { m: MatchView; n: number; open: boolean; mine: boolean; onToggle: () => void }) {
  const { state, isAdmin, levels, busy, act, base } = useSessionCtx();
  const [swapFrom, setSwapFrom] = useState<number | null>(null);
  const a = teamAvg(levels, m.sideA);
  const b = teamAvg(levels, m.sideB);
  const idx = state.queue.findIndex((x) => x.id === m.id);
  const mixedFormats = new Set(state.courts.map((c) => c.matchType)).size > 1;
  const run = (fn: () => Promise<SessionState>) => act(fn).then((ok) => ok && setSwapFrom(null));

  const inMatch = new Set(idsOf(m));
  const onCourt = new Set(state.courts.flatMap((c) => (c.current ? idsOf(c.current) : [])));
  const cands = swapFrom
    ? state.attendance
        .filter((p) => p.status === 'present' && !inMatch.has(p.memberId))
        .map((p) => {
          const k = state.queue.findIndex((x) => x.id !== m.id && idsOf(x).includes(p.memberId));
          return { p, rank: onCourt.has(p.memberId) ? 2 : k >= 0 ? 1 : 0, sub: onCourt.has(p.memberId) ? 'on court' : k >= 0 ? `#${k + 1}` : 'waiting' };
        })
        .sort((x, y) => x.rank - y.rank || x.p.gamesPlayed - y.p.gamesPlayed || x.p.name.localeCompare(y.p.name))
    : [];
  const name = (id: number) => state.attendance.find((p) => p.memberId === id)?.name ?? '';

  return (
    <div className={`qrow ${open ? 'open' : ''} ${mine ? 'mine' : ''} ${m.planned ? 'planned' : ''}`}>
      <button type="button" className="qrow-main" disabled={!isAdmin} aria-expanded={isAdmin ? open : undefined} onClick={onToggle}>
        <div className="qnum">{n}</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 15 }}>{names(m.sideA)}</div>
          <div className="body-sm muted">vs {names(m.sideB)}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
          {m.planned && <span className="tag tag-outline">Planned</span>}
          {isAdmin && m.unbalanced && <span className="tag tag-accent">Unbalanced</span>}
          {m.pending && <span className="tag tag-neutral">Syncing</span>}
          <div className="faint" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
            {isAdmin && a !== null && b !== null ? `${a} / ${b}` : ''}
            {mixedFormats && `${isAdmin && a !== null ? ' · ' : ''}${m.type === 'singles' ? 'Singles' : 'Doubles'}`}
          </div>
        </div>
      </button>
      {open && (
        <div className="qrow-edit">
          <div className="kicker">{swapFrom ? `Swap ${name(swapFrom)} with…` : 'Tap a player to swap them out'}</div>
          <div className="chips">
            {[...m.sideA, ...m.sideB].map((p) => (
              <button key={p.id} type="button" className="chip" aria-pressed={swapFrom === p.id} onClick={() => setSwapFrom(swapFrom === p.id ? null : p.id)}>
                {p.name}
                {levels.has(p.id) && <span className="chip-sub" style={{ color: 'inherit', opacity: 0.8 }}>{levels.get(p.id)}</span>}
              </button>
            ))}
          </div>
          {swapFrom && (
            <div className="chips cands">
              {cands.length === 0 && <span className="body-sm muted">Nobody else is marked in.</span>}
              {cands.map(({ p, sub }) => (
                <Fragment key={p.memberId}>
                  <button
                    type="button"
                    className="chip chip-dashed"
                    disabled={busy}
                    onClick={() => run(() => send<SessionState>('POST', `${base}/matches/${m.id}/swap`, { out: swapFrom, in: p.memberId }))}
                  >
                    {p.name}
                    {p.level !== undefined && ` ${p.level}`}
                    <span className="chip-sub">{sub}</span>
                  </button>
                </Fragment>
              ))}
            </div>
          )}
          <div className="grid-3">
            <Btn style={{ height: 40 }} disabled={busy || idx <= 0} onClick={() => run(() => send<SessionState>('POST', `${base}/matches/${m.id}/move`, { direction: 'up' }))}>
              Move up
            </Btn>
            <Btn
              style={{ height: 40 }}
              disabled={busy || idx >= state.queue.length - 1}
              onClick={() => run(() => send<SessionState>('POST', `${base}/matches/${m.id}/move`, { direction: 'down' }))}
            >
              Move down
            </Btn>
            <Btn style={{ height: 40 }} disabled={busy} onClick={() => run(() => send<SessionState>('POST', `${base}/matches/${m.id}/redraw`))}>
              Re-draw
            </Btn>
          </div>
          <div className="small muted">
            Games go on whichever court is free first. Edited matches are kept when the queue rebuilds
            {m.locked ? ' (this one is).' : '.'}
          </div>
        </div>
      )}
    </div>
  );
}
