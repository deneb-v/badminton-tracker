import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { send, setToken } from '../api';
import { Btn, Field } from '../components/ui';

export function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return setError('Enter a valid email address.');
    if (!password) return setError('Enter your password.');
    setBusy(true);
    setError(null);
    try {
      const { token } = await send<{ token: string }>('POST', '/auth/login', { email: email.trim(), password });
      setToken(token);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen">
      <div className="auth-body">
        <form className="col auth-col" onSubmit={submit} noValidate>
          <div className="brand">
            <div className="kicker">Court queues for badminton groups</div>
            <h1 className="brand-name">Courtside</h1>
          </div>
          <div className="stack" style={{ gap: 14 }}>
            <Field label="Email">
              <input
                className="input"
                type="email"
                placeholder="you@club.com"
                autoComplete="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setError(null);
                }}
              />
            </Field>
            <Field label="Password">
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setError(null);
                }}
              />
            </Field>
            {error && (
              <p className="err" role="alert">
                {error}
              </p>
            )}
            <Btn type="submit" variant="primary" size="lg" disabled={busy}>
              Sign in
            </Btn>
          </div>
          <div className="auth-foot">
            <div className="small muted">Joining a group as a player?</div>
            <Btn size="md" style={{ fontSize: 15 }} onClick={() => navigate('/join')}>
              Join with an invite code
            </Btn>
          </div>
        </form>
      </div>
    </div>
  );
}
