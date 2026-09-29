import { FormEvent, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { get, send, setToken } from '../api';
import { useAuth } from '../auth';
import { BackButton, Btn, Field } from '../components/ui';

const clean = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

/** Sign-up is invite-only: a player joins a group with its 6-character code. */
export function Join() {
  const { token, refresh } = useAuth();
  const navigate = useNavigate();
  const [code, setCode] = useState(clean(useParams().code ?? ''));
  const [groupName, setGroupName] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setGroupName(null);
    if (code.length !== 6) return;
    let live = true;
    get<{ groupName: string }>(`/invites/${code}`)
      .then((r) => live && setGroupName(r.data.groupName))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [code]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!groupName) return setError('Enter the 6-character code from your organiser.');
    setBusy(true);
    setError(null);
    try {
      if (token) {
        const { id } = await send<{ id: number }>('POST', '/groups/join', { code });
        await refresh();
        navigate(`/g/${id}`, { replace: true });
      } else {
        if (!form.name.trim()) throw new Error('Enter your name as the group knows you.');
        if (form.password.length < 8) throw new Error('Password must be at least 8 characters.');
        const { token: t } = await send<{ token: string }>('POST', '/auth/join', { code, ...form });
        setToken(t);
        navigate('/', { replace: true });
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => {
    setForm({ ...form, [k]: e.target.value });
    setError(null);
  };

  return (
    <div className="screen">
      <div className="head">
        <div className="head-row">
          <BackButton label={token ? 'Your groups' : 'Sign in'} onClick={() => navigate(token ? '/groups' : '/')} />
        </div>
        <div className="title">Join a group</div>
      </div>
      <form className="body" onSubmit={submit} noValidate>
        <div className="col col-tight">
          <Field label="Invite code">
            <input
              className="input code-input"
              value={code}
              placeholder="TGR4K8"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setCode(clean(e.target.value));
                setError(null);
              }}
            />
          </Field>
          {groupName ? (
            <p className="note">
              You're joining <b>{groupName}</b>.
            </p>
          ) : (
            <p className="body-sm muted">Ask your organiser for the code, or open the link they shared.</p>
          )}
          {!token && (
            <>
              <Field label="Your name">
                <input className="input" autoComplete="name" value={form.name} onChange={set('name')} placeholder="As the group knows you" />
              </Field>
              <Field label="Email">
                <input className="input" type="email" autoComplete="email" value={form.email} onChange={set('email')} placeholder="you@club.com" />
              </Field>
              <Field label="Password">
                <input
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={form.password}
                  onChange={set('password')}
                  placeholder="At least 8 characters"
                />
              </Field>
              <p className="small muted">Players see the queue and their own games. Levels and win rates stay with the admins.</p>
            </>
          )}
          {error && (
            <p className="err" role="alert">
              {error}
            </p>
          )}
          <Btn type="submit" variant="primary" size="lg" disabled={busy || !groupName}>
            {groupName ? `Join ${groupName}` : 'Join group'}
          </Btn>
        </div>
      </form>
    </div>
  );
}
