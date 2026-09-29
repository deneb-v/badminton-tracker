import { useEffect, useState } from 'react';
import { get, MemberStats } from '../api';
import { SectionTitle } from '../components/ui';
import { formatDate, plural } from '../format';

const ATTENDED = new Set(['present', 'departed']);

/**
 * A player's own record. Members never get wins/losses from the server; admins viewing someone
 * see them via `showResults`.
 */
export function MeStats({
  gid,
  memberId,
  today,
  showResults,
}: {
  gid: number;
  memberId: number;
  /** Games in the session on screen, when shown inside one. */
  today?: number;
  showResults?: boolean;
}) {
  const [stats, setStats] = useState<MemberStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    get<MemberStats>(`/groups/${gid}/members/${memberId}/stats`)
      .then((r) => setStats(r.data))
      .catch((e) => setError((e as Error).message));
  }, [gid, memberId]);

  if (error) return <p className="err">{error}</p>;
  if (!stats) return <p className="muted">Loading…</p>;
  const { totals } = stats;
  const last = stats.sessions.find((s) => ATTENDED.has(s.attendance));
  const third =
    today !== undefined
      ? { v: today, label: 'Today' }
      : showResults && totals.wins !== undefined
        ? { v: `${totals.wins}–${totals.losses}`, label: 'Won–lost' }
        : { v: last?.gamesPlayed ?? 0, label: 'Last session' };

  return (
    <>
      <div className="stats-lg">
        <div>
          <b>{totals.sessionsAttended}</b>
          <span>Sessions</span>
        </div>
        <div>
          <b>{totals.gamesPlayed}</b>
          <span>Games played</span>
        </div>
        <div>
          <b>{third.v}</b>
          <span>{third.label}</span>
        </div>
      </div>
      <div className="list">
        <SectionTitle>Recent sessions</SectionTitle>
        {stats.sessions.length === 0 && <p className="body-sm muted" style={{ padding: '11px 0' }}>No sessions yet.</p>}
        {stats.sessions.slice(0, 12).map((s) => (
          <div key={s.sessionId} className="line" style={{ alignItems: 'baseline', padding: '11px 0' }}>
            <div style={{ fontSize: 15 }}>{formatDate(s.date)}</div>
            <div className="small muted trunc">{s.venue}</div>
            <div className="push heading" style={{ fontWeight: 400, fontSize: 17, flex: 'none' }}>
              {ATTENDED.has(s.attendance)
                ? `${plural(s.gamesPlayed, 'game')}${showResults && s.wins !== undefined ? ` · ${s.wins}–${s.losses}` : ''}`
                : s.attendance === 'absent'
                  ? 'Absent'
                  : s.attendance === 'late'
                    ? 'Late'
                    : 'Not marked'}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
