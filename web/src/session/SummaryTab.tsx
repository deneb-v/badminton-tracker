import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MatchView, send, SessionState } from '../api';
import { Btn, SectionTitle, Sheet } from '../components/ui';
import { formatTime, names } from '../format';
import { gameCode, useSessionCtx } from './context';

/** FR-27 fairness summary + results. Wins/levels only render when the server sent them (admins). */
export function SummaryTab() {
  const { state, gid, isAdmin, act, base, busy } = useSessionCtx();
  const navigate = useNavigate();
  const [resultFor, setResultFor] = useState<MatchView | null>(null);
  const [confirm, setConfirm] = useState<'close' | 'delete' | null>(null);

  const players = state.attendance
    .filter((a) => a.gamesPlayed > 0 || a.status === 'present' || a.status === 'departed')
    .sort((a, b) => b.gamesPlayed - a.gamesPlayed || a.name.localeCompare(b.name));
  const games = players.map((p) => p.gamesPlayed);
  const maxG = Math.max(1, ...games);
  const minG = games.length ? Math.min(...games) : 0;
  const lengths = state.history
    .filter((m) => m.startedAt && m.endedAt)
    .map((m) => (new Date(m.endedAt!).getTime() - new Date(m.startedAt!).getTime()) / 60_000);
  const avgLen = lengths.length ? `${Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length)} min` : '—';

  return (
    <div className="col">
      <div className="stats-2">
        <div>
          <b>{state.history.length}</b>
          <span>Matches finished</span>
        </div>
        <div>
          <b>{players.length}</b>
          <span>Players</span>
        </div>
        <div>
          <b>{avgLen}</b>
          <span>Avg match length</span>
        </div>
        <div>
          <b>{games.length ? `${minG}–${Math.max(...games)}` : '—'}</b>
          <span>Games per player</span>
        </div>
      </div>

      <div className="stack-sm">
        <SectionTitle aside="Target spread ≤ 1">Games played</SectionTitle>
        {players.length === 0 && <p className="body-sm muted">No one has played yet.</p>}
        {players.map((p) => (
          <div key={p.memberId} className="bar-row">
            <div className={`trunc ${p.memberId === state.viewer.memberId ? 'is-me' : ''}`}>{p.name}</div>
            <div className="bar">
              <div
                style={{
                  width: `${(p.gamesPlayed / maxG) * 100}%`,
                  background: p.gamesPlayed === minG && maxG - minG > 1 ? 'var(--color-neutral-500)' : undefined,
                }}
              />
            </div>
            <div className="heading" style={{ textAlign: 'right', fontWeight: 400, fontSize: 15 }}>
              {p.gamesPlayed}
            </div>
          </div>
        ))}
      </div>

      <div className="list">
        <SectionTitle>Matches</SectionTitle>
        {state.history.length === 0 && <p className="body-sm muted" style={{ padding: '10px 0' }}>No finished matches yet.</p>}
        {state.history.map((m) => (
          <div key={m.id} className="line" style={{ padding: '8px 0', alignItems: 'flex-start' }}>
            <div className="qnum" style={{ width: 40, flex: 'none', fontSize: 17 }}>
              {gameCode(m)}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: m.winnerSide === 'A' ? 700 : 400 }}>{names(m.sideA)}</div>
              <div className="body-sm" style={{ fontWeight: m.winnerSide === 'B' ? 700 : 400 }}>
                <span className="muted">vs </span>
                {names(m.sideB)}
              </div>
              <div className="faint" style={{ fontSize: 11 }}>
                {formatTime(m.endedAt)}
                {isAdmin && (m.winnerSide ? ` · Side ${m.winnerSide} won` : ' · no result')}
              </div>
            </div>
            {isAdmin && !m.pending && (
              <button type="button" className="btn btn-ghost" style={{ fontSize: 13 }} onClick={() => setResultFor(m)}>
                {m.winnerSide ? 'Edit' : 'Result'}
              </button>
            )}
          </div>
        ))}
      </div>

      {isAdmin && state.session.status !== 'closed' && (
        <div className="stack">
          <SectionTitle>Session</SectionTitle>
          {state.session.status === 'live' ? (
            <Btn style={{ height: 44, alignSelf: 'flex-start', minWidth: 180 }} disabled={busy} onClick={() => setConfirm('close')}>
              End session
            </Btn>
          ) : (
            <Btn style={{ height: 44, alignSelf: 'flex-start', minWidth: 180 }} disabled={busy} onClick={() => setConfirm('delete')}>
              Delete session
            </Btn>
          )}
        </div>
      )}

      {resultFor && (
        <Sheet label="Who won?" onClose={() => setResultFor(null)}>
          <div className="kicker">Court {resultFor.courtLabel} · {gameCode(resultFor)}</div>
          <div className="sheet-title">Who won?</div>
          {(['A', 'B'] as const).map((side) => (
            <Btn
              key={side}
              className="winner-btn"
              style={resultFor.winnerSide === side ? { borderColor: 'var(--color-accent)' } : undefined}
              onClick={async () => {
                if (await act(() => send<SessionState>('PATCH', `${base}/matches/${resultFor.id}`, { winnerSide: side }))) setResultFor(null);
              }}
            >
              <span>{names(side === 'A' ? resultFor.sideA : resultFor.sideB)}</span>
              <span className="side-label">Side {side}</span>
            </Btn>
          ))}
          <button
            type="button"
            className="btn btn-ghost"
            style={{ height: 44 }}
            onClick={async () => {
              if (await act(() => send<SessionState>('PATCH', `${base}/matches/${resultFor.id}`, { winnerSide: null }))) setResultFor(null);
            }}
          >
            No result
          </button>
        </Sheet>
      )}

      {confirm && (
        <Sheet label={confirm === 'close' ? 'End session?' : 'Delete session?'} onClose={() => setConfirm(null)}>
          <div className="sheet-title">{confirm === 'close' ? 'End session?' : 'Delete session?'}</div>
          <p className="body-sm">
            {confirm === 'close'
              ? 'Matches still on court are marked finished (no result) and the queue and plan are cleared. Results stay in history.'
              : 'This removes the session and its invite list. It can’t be undone.'}
          </p>
          <Btn
            variant="primary"
            size="md"
            disabled={busy}
            onClick={async () => {
              if (confirm === 'close') {
                if (await act(() => send<SessionState>('POST', `${base}/close`))) setConfirm(null);
              } else if (await act(() => send('DELETE', base))) {
                navigate(`/g/${gid}`, { replace: true });
              }
            }}
          >
            {confirm === 'close' ? 'End session' : 'Delete'}
          </Btn>
          <button type="button" className="btn btn-ghost" style={{ height: 44 }} onClick={() => setConfirm(null)}>
            Cancel
          </button>
        </Sheet>
      )}
    </div>
  );
}
