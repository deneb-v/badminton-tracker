import { useCallback, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, CourtView, isNetworkError, MatchView, send, sendOrQueue, SessionState } from '../api';
import { useGroup } from '../App';
import { BackButton, Btn, Sheet } from '../components/ui';
import { clock, FORMAT_LABEL, formatDate, minutesSince, names, plural } from '../format';
import { useSession } from '../useSession';
import { useToast } from '../toast';
import { Ctx, gameCode, nextFor, SessionCtx, useMediaQuery, useNow } from '../session/context';
import { LiveTab } from '../session/LiveTab';
import { PlanTab } from '../session/PlanTab';
import { AttendanceTab } from '../session/AttendanceTab';
import { SummaryTab } from '../session/SummaryTab';
import { HistoryTab } from '../session/HistoryTab';
import { MeStats } from '../group/MeStats';

type Tab = 'live' | 'plan' | 'attendance' | 'summary' | 'history' | 'me';
/** Opens the edit form (its own page) rather than a tab. */
const EDIT = 'edit';

const ADMIN_TABS: [Tab, string][] = [
  ['live', 'Live'],
  ['plan', 'Plan'],
  ['attendance', 'Attend'],
  ['summary', 'Summary'],
  ['history', 'History'],
];
const MEMBER_TABS: [Tab, string][] = [
  ['live', 'Queue'],
  ['me', 'Me'],
];

export function SessionPage() {
  const sid = Number(useParams().sid);
  const { gid, isAdmin } = useGroup();
  const navigate = useNavigate();
  const { state, stale, error, apply, pending, syncError } = useSession(sid);
  const toast = useToast();
  const now = useNow();
  const tablet = useMediaQuery('(min-width: 900px)');
  const [params, setParams] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [warn, setWarn] = useState<{ match: MatchView; court: CourtView; message: string } | null>(null);
  const [finishing, setFinishing] = useState<MatchView | null>(null);
  const base = `/sessions/${sid}`;

  const act = useCallback<SessionCtx['act']>(
    async (fn) => {
      setBusy(true);
      try {
        const next = await fn();
        if (next) apply(next);
        return true;
      } catch (e) {
        toast(isNetworkError(e) ? "You're offline — that needs a connection." : (e as Error).message, 'error');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [apply, toast],
  );

  const doStart = useCallback(
    async (m: MatchView, court: CourtView, force: boolean) => {
      setBusy(true);
      try {
        const next = await sendOrQueue<SessionState>({
          sessionId: sid,
          kind: 'start',
          matchId: m.id,
          method: 'POST',
          url: `${base}/matches/${m.id}/start`,
          body: { courtId: court.id, force },
        });
        if (next) apply(next);
        setWarn(null);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'WINDOW_WARNING') setWarn({ match: m, court, message: e.message });
        else toast((e as Error).message, 'error');
      } finally {
        setBusy(false);
      }
    },
    [apply, base, sid, toast],
  );

  const levels = useMemo(
    () => new Map((state?.attendance ?? []).filter((a) => a.level !== undefined).map((a) => [a.memberId, a.level!])),
    [state],
  );

  if (error && !state) return <div className="center-msg err">{error}</div>;
  if (!state) return <div className="center-msg">Loading…</div>;

  const { session } = state;
  const tabs = isAdmin ? ADMIN_TABS : MEMBER_TABS;
  const menu: [Tab | typeof EDIT, string][] = isAdmin && session.status !== 'closed' ? [...tabs, [EDIT, 'Edit']] : tabs;
  const requested = params.get('tab') as Tab | null;
  const tab: Tab = tabs.some(([k]) => k === requested) ? requested! : isAdmin && session.status === 'closed' ? 'summary' : 'live';
  const goTo = (t: string) => setParams({ tab: t }, { replace: true });

  const ctx: SessionCtx = {
    state,
    gid,
    isAdmin,
    busy,
    now,
    levels,
    act,
    base,
    goTo,
    startMatch: (m, court) => void doStart(m, court, false),
    finishMatch: (m) => setFinishing(m),
  };

  async function finish(m: MatchView, winnerSide: 'A' | 'B' | null) {
    setFinishing(null);
    await act(() =>
      sendOrQueue<SessionState>({
        sessionId: sid,
        kind: 'finish',
        matchId: m.id,
        method: 'POST',
        url: `${base}/matches/${m.id}/finish`,
        body: { winnerSide },
      }),
    );
  }

  const viewerName = state.attendance.find((a) => a.memberId === state.viewer.memberId)?.name ?? 'Me';
  const formats = new Set(state.courts.map((c) => c.matchType));
  const format = formats.size > 1 ? 'mixed' : session.matchType;
  const titles: Record<Tab, [string, string]> = {
    live: [isAdmin ? 'Now playing' : 'Queue', `${plural(state.courts.length, 'court')} · ${FORMAT_LABEL[format].toLowerCase()}`],
    plan: ['Game plan', 'Tap + to override'],
    attendance: ['Attendance', 'Mark arrivals · add walk-ins'],
    summary: ['Session summary', `${formatDate(session.date)} · ${session.startTime}–${session.endTime}`],
    history: ['Member history', 'All sessions'],
    me: ['My games', viewerName],
  };
  const [title, subtitle] = titles[tab];
  // What this court calls once its game is done (its players are free again by then).
  const nextOn = (m: MatchView) => {
    const court = state.courts.find((c) => c.id === m.courtId);
    if (!court) return undefined;
    const freed = { ...state, courts: state.courts.map((c) => (c.id === court.id ? { ...c, current: null } : c)) };
    return nextFor(freed, court);
  };
  const today = state.attendance.find((a) => a.memberId === state.viewer.memberId)?.gamesPlayed ?? 0;

  const tabButtons = menu.map(([k, label]) => (
    <button
      key={k}
      type="button"
      role="tab"
      aria-selected={tab === k}
      onClick={() =>
        k === EDIT ? navigate(`/g/${gid}/s/${sid}/edit`, { state: { back: `/g/${gid}/s/${sid}?tab=${tab}` } }) : goTo(k)
      }
    >
      {label}
    </button>
  ));

  return (
    <Ctx.Provider value={ctx}>
      <div className="screen">
        <div className="head" style={{ paddingTop: 14 }}>
          <div className="head-row">
            <BackButton label="Group" onClick={() => navigate(`/g/${gid}`)} />
            <div className="kicker trunc">
              {state.group.name} · {formatDate(session.date)} · {clock(now)}
            </div>
            <span className="tag tag-outline push">{isAdmin ? 'Admin' : 'Member'}</span>
          </div>
          <div className="head-title">
            <div className="title">{title}</div>
            <div className="push small muted" style={{ flex: 'none' }}>
              {subtitle}
            </div>
          </div>
        </div>
        {tablet && (
          <div className="tabs tabs-live" role="tablist">
            {tabButtons}
          </div>
        )}

        <div className="body live-body">
          {(stale || syncError || pending > 0) && (
            <div className="col" style={{ marginBottom: 14, maxWidth: 'none' }}>
              {stale && <p className="note">Showing the last copy saved on this phone.</p>}
              {syncError && <p className="note">{syncError}</p>}
              {pending > 0 && <p className="note">{plural(pending, 'change')} waiting to sync.</p>}
            </div>
          )}
          {tab === 'live' && <LiveTab tablet={tablet} />}
          {tab === 'plan' && <PlanTab />}
          {tab === 'attendance' && <AttendanceTab />}
          {tab === 'summary' && <SummaryTab />}
          {tab === 'history' && <HistoryTab />}
          {tab === 'me' && (
            <div className="col">
              <MeStats gid={gid} memberId={state.viewer.memberId} today={today} />
            </div>
          )}
        </div>

        {!tablet && (
          <div className="tabbar" role="tablist">
            {tabButtons}
          </div>
        )}
      </div>

      {finishing && (
        <Sheet label={`Court ${finishing.courtLabel}: who won?`} onClose={() => setFinishing(null)}>
          <div className="kicker">
            Court {finishing.courtLabel} · {gameCode(finishing)} ·{' '}
            {finishing.pending ? 'started offline' : `${minutesSince(finishing.startedAt, now)} min played`}
          </div>
          <div className="sheet-title">Who won?</div>
          {(['A', 'B'] as const).map((side) => (
            <Btn key={side} className="winner-btn" onClick={() => finish(finishing, side)}>
              <span>{names(side === 'A' ? finishing.sideA : finishing.sideB)}</span>
              <span className="side-label">Side {side}</span>
            </Btn>
          ))}
          <div className="row">
            <button type="button" className="btn btn-ghost" style={{ height: 44, flex: 1, fontSize: 15 }} onClick={() => finish(finishing, null)}>
              No result — skip
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ height: 44, flex: 1, fontSize: 15, color: 'var(--color-neutral-700)' }}
              onClick={() => setFinishing(null)}
            >
              Keep playing
            </button>
          </div>
          <div className="small muted">
            Next up on Court {finishing.courtLabel} (tap Start to call it):{' '}
            {(() => {
              const n = nextOn(finishing);
              return n ? `${n.planned ? 'planned — ' : ''}${names([...n.sideA, ...n.sideB], ', ')}` : 'nothing queued';
            })()}
          </div>
          {!finishing.pending && (
            <button
              type="button"
              className="link small"
              style={{ alignSelf: 'flex-start' }}
              onClick={async () => {
                const m = finishing;
                setFinishing(null);
                await act(() => send<SessionState>('POST', `${base}/matches/${m.id}/cancel`));
              }}
            >
              Started by mistake? Undo the start
            </button>
          )}
        </Sheet>
      )}

      {warn && (
        <Sheet label="Start anyway?" onClose={() => setWarn(null)}>
          <div className="kicker">Court {warn.court.label}</div>
          <div className="sheet-title">Start anyway?</div>
          <p className="body-sm">{warn.message}.</p>
          <Btn variant="primary" size="md" disabled={busy} onClick={() => doStart(warn.match, warn.court, true)}>
            Start anyway
          </Btn>
          <button type="button" className="btn btn-ghost" style={{ height: 44 }} onClick={() => setWarn(null)}>
            Not now
          </button>
        </Sheet>
      )}
    </Ctx.Provider>
  );
}
