import { useNavigate } from 'react-router-dom';
import { SessionSummary } from '../api';
import { Btn, EmptyCard, Frame, SectionTitle } from '../components/ui';
import { FORMAT_LABEL, formatDate, plural, todayYmd } from '../format';

const STATUS = {
  live: { label: 'Live', tag: 'tag-accent' },
  scheduled: { label: 'Not started', tag: 'tag-neutral' },
  closed: { label: 'Finished', tag: 'tag-neutral' },
} as const;

export function SessionsTab({
  gid,
  sessions,
  error,
  isAdmin,
}: {
  gid: number;
  sessions: SessionSummary[] | null;
  error: string | null;
  isAdmin: boolean;
}) {
  const navigate = useNavigate();

  if (error && !sessions) return <p className="err">{error}</p>;
  if (!sessions) return <p className="muted">Loading…</p>;
  if (sessions.length === 0) {
    return (
      <EmptyCard title="No sessions yet">
        {isAdmin ? 'Set up courts and times to start queuing matches.' : 'Your organiser hasn’t scheduled any sessions yet.'}
      </EmptyCard>
    );
  }

  const open = (s: SessionSummary, tab?: string) => navigate(`/g/${gid}/s/${s.id}${tab ? `?tab=${tab}` : ''}`);

  // Starting goes through "Who's playing?" first.
  const start = (s: SessionSummary) => navigate(`/g/${gid}/s/${s.id}/start`);
  const edit = (s: SessionSummary) => navigate(`/g/${gid}/s/${s.id}/edit`, { state: { back: `/g/${gid}?tab=sessions` } });

  // Live first, then what's coming up soonest, then the past (newest first).
  const today = todayYmd();
  const current = sessions
    .filter((s) => s.status !== 'closed')
    .sort((a, b) => (a.status === 'live' ? -1 : 0) - (b.status === 'live' ? -1 : 0) || a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
  const past = sessions.filter((s) => s.status === 'closed');

  const card = (s: SessionSummary) => {
    const st = STATUS[s.status];
    const overdue = s.status === 'scheduled' && s.date < today;
    return (
      <Frame key={s.id} className="card" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: '4px 10px', alignItems: 'center' }}>
        <div className="heading" style={{ fontSize: 20 }}>
          {formatDate(s.date)}
        </div>
        <span className={`tag ${st.tag}`}>{overdue ? 'Missed' : st.label}</span>
        <div className="body-sm muted" style={{ gridColumn: '1 / -1' }}>
          {s.startTime}–{s.endTime} · {plural(s.courtCount, 'court')} · {FORMAT_LABEL[s.format]}
          {s.venue && ` · ${s.venue}`}
          {s.status === 'closed' && ` · ${plural(s.presentCount, 'player')}`}
        </div>
        <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, paddingTop: 6 }}>
          {s.status === 'scheduled' && isAdmin && (
            <Btn variant="primary" size="md" style={{ flex: 1 }} onClick={() => start(s)}>
              Start session
            </Btn>
          )}
          {s.status === 'live' && (
            <Btn size="md" style={{ flex: 1 }} onClick={() => open(s)}>
              Open live session
            </Btn>
          )}
          {s.status === 'closed' && (
            <Btn size="md" style={{ flex: 1 }} onClick={() => open(s, isAdmin ? 'summary' : undefined)}>
              {isAdmin ? 'View summary' : 'View'}
            </Btn>
          )}
          {s.status !== 'closed' && isAdmin && (
            <Btn size="md" onClick={() => edit(s)}>
              Edit
            </Btn>
          )}
        </div>
      </Frame>
    );
  };

  return (
    <>
      {current.map(card)}
      {current.length === 0 && <p className="body-sm muted">Nothing scheduled.</p>}
      {past.length > 0 && (
        <>
          <SectionTitle>Past</SectionTitle>
          {past.map(card)}
        </>
      )}
    </>
  );
}
