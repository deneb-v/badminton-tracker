import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { Btn, EmptyCard, Frame } from '../components/ui';
import { plural } from '../format';

export const groupMeta = (g: { venue: string; days: string[] }) =>
  [g.venue, g.days.join(' · ')].filter(Boolean).join(' · ');

export function Groups() {
  const { me, signOut, refresh } = useAuth();
  const navigate = useNavigate();
  const groups = me!.groups;
  // Member counts and details may have changed inside a group.
  useEffect(() => void refresh(), [refresh]);

  return (
    <div className="screen">
      <div className="head" style={{ paddingTop: 14 }}>
        <div className="head-row">
          <div className="kicker trunc">{me!.user.email}</div>
          <button type="button" className="btn btn-ghost push" style={{ minHeight: 32, fontSize: 13 }} onClick={signOut}>
            Sign out
          </button>
        </div>
        <div className="title">Your groups</div>
      </div>
      <div className="body">
        <div className="col col-tight">
          {groups.length === 0 && (
            <EmptyCard title="No groups yet">
              A group holds your members and their levels. Sessions run inside a group. Create one, or join with the code
              your organiser shared.
            </EmptyCard>
          )}
          {groups.map((g) => (
            <Frame key={g.groupId} as="button" type="button" className="card-btn" onClick={() => navigate(`/g/${g.groupId}`)}>
              <div className="row" style={{ alignItems: 'baseline', width: '100%' }}>
                <div className="heading trunc" style={{ fontSize: 22 }}>
                  {g.groupName}
                </div>
                {g.role === 'admin' && <span className="tag tag-outline">Admin</span>}
                <div className="push small muted" style={{ flex: 'none' }}>
                  {plural(g.memberCount, 'member')}
                </div>
              </div>
              <div className="body-sm muted">{groupMeta(g) || 'No venue set'}</div>
            </Frame>
          ))}
          <Btn variant="primary" size="lg" onClick={() => navigate('/groups/new')}>
            Create a group
          </Btn>
          <Btn size="md" style={{ fontSize: 15 }} onClick={() => navigate('/join')}>
            Join with an invite code
          </Btn>
        </div>
      </div>
    </div>
  );
}
