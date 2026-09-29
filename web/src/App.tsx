import { Navigate, Outlet, Route, Routes, useParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useAuth } from './auth';
import { onOutboxChange, readOutbox } from './api';
import { Login } from './pages/Login';
import { Join } from './pages/Join';
import { Groups } from './pages/Groups';
import { NewGroup } from './pages/NewGroup';
import { GroupHome } from './pages/GroupHome';
import { EditSession, NewSession } from './pages/NewSession';
import { SessionPage } from './pages/SessionPage';
import { MemberPage } from './pages/MemberPage';
import { WhosPlaying } from './pages/WhosPlaying';

export function App() {
  const { token, me, loading } = useAuth();
  const { online, pending } = useOnline();
  let routes;
  if (!token) {
    routes = (
      <Routes>
        <Route path="/join/:code?" element={<Join />} />
        <Route path="*" element={<Login />} />
      </Routes>
    );
  } else if (loading || !me) {
    routes = <div className="center-msg">Loading…</div>;
  } else {
    routes = (
      <Routes>
        <Route path="/groups" element={<Groups />} />
        <Route path="/groups/new" element={<NewGroup />} />
        <Route path="/join/:code?" element={<Join />} />
        <Route path="/g/:gid" element={<GroupGuard />}>
          <Route index element={<GroupHome />} />
          <Route path="sessions/new" element={<NewSession />} />
          <Route path="s/:sid" element={<SessionPage />} />
          <Route path="s/:sid/start" element={<WhosPlaying />} />
          <Route path="s/:sid/edit" element={<EditSession />} />
          <Route path="members/:mid" element={<MemberPage />} />
        </Route>
        <Route path="*" element={<Navigate to={me.groups.length === 1 ? `/g/${me.groups[0].groupId}` : '/groups'} replace />} />
      </Routes>
    );
  }
  return (
    <div className="app">
      {(!online || pending > 0) && (
        <div className={`netbar ${online ? 'netbar-sync' : ''}`} role="status">
          {online
            ? `Syncing ${pending} change${pending === 1 ? '' : 's'}…`
            : `Offline${pending ? ` · ${pending} change${pending === 1 ? '' : 's'} will sync` : ' · showing last known data'}`}
        </div>
      )}
      <div className="app-main">{routes}</div>
    </div>
  );
}

export function useGroup() {
  const { me } = useAuth();
  const gid = Number(useParams().gid);
  const membership = me?.groups.find((g) => g.groupId === gid);
  return { gid, membership, isAdmin: membership?.role === 'admin' };
}

function GroupGuard() {
  const { membership } = useGroup();
  if (!membership) return <Navigate to="/groups" replace />;
  return <Outlet />;
}

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  const [pending, setPending] = useState(readOutbox().length);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    const off = onOutboxChange(() => setPending(readOutbox().length));
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
      off();
    };
  }, []);
  return { online, pending };
}
