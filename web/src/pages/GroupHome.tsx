import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { get, SessionSummary } from '../api';
import { useGroup } from '../App';
import { BackButton, Btn } from '../components/ui';
import { groupMeta } from './Groups';
import { SessionsTab } from '../group/SessionsTab';
import { MembersTab } from '../group/MembersTab';
import { ManageTab } from '../group/ManageTab';
import { AccountSection } from '../group/AccountSection';
import { MeStats } from '../group/MeStats';

type Tab = 'sessions' | 'members' | 'manage' | 'me' | 'account';

export function GroupHome() {
  const { gid, membership, isAdmin } = useGroup();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [memberCount, setMemberCount] = useState(membership!.memberCount);
  const [error, setError] = useState<string | null>(null);

  const tabs: { key: Tab; label: string; count?: number }[] = isAdmin
    ? [
        { key: 'sessions', label: 'Sessions', count: sessions?.length },
        { key: 'members', label: 'Members', count: memberCount },
        { key: 'manage', label: 'Manage' },
      ]
    : [
        { key: 'sessions', label: 'Sessions', count: sessions?.length },
        { key: 'me', label: 'Me' },
        { key: 'account', label: 'Account' },
      ];
  const requested = params.get('tab') as Tab | null;
  const tab = tabs.some((t) => t.key === requested) ? requested! : 'sessions';

  const loadSessions = useCallback(() => {
    get<SessionSummary[]>(`/groups/${gid}/sessions`)
      .then((r) => setSessions(r.data))
      .catch((e) => setError((e as Error).message));
  }, [gid]);
  useEffect(loadSessions, [loadSessions]);
  useEffect(() => setMemberCount(membership!.memberCount), [membership]);

  const g = membership!;
  return (
    <div className="screen">
      <div className="head head-tabs">
        <div className="head-row">
          <BackButton label="Groups" onClick={() => navigate('/groups')} />
          <span className="tag tag-outline push">{isAdmin ? 'Admin' : 'Member'}</span>
        </div>
        <div className="title">{g.groupName}</div>
        <div className="small muted" style={{ minHeight: 16 }}>
          {groupMeta(g)}
        </div>
        <div className="tabs" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setParams({ tab: t.key }, { replace: true })}
            >
              {t.label}
              {t.count !== undefined && <span className="count">{t.count}</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="body">
        <div className="col">
          {tab === 'sessions' && <SessionsTab gid={gid} sessions={sessions} error={error} isAdmin={isAdmin} />}
          {tab === 'members' && <MembersTab gid={gid} onCount={setMemberCount} />}
          {tab === 'manage' && <ManageTab gid={gid} />}
          {tab === 'me' && <MeStats gid={gid} memberId={g.memberId} />}
          {tab === 'account' && <AccountSection />}
        </div>
      </div>

      {tab === 'sessions' && isAdmin && (
        <div className="foot">
          <div className="col">
            <Btn variant="primary" size="lg" onClick={() => navigate(`/g/${gid}/sessions/new`)}>
              New session
            </Btn>
          </div>
        </div>
      )}
    </div>
  );
}
