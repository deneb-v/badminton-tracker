import { FormEvent, useState } from 'react';
import { send } from '../api';
import { useAuth } from '../auth';
import { Btn, Field, SectionTitle, Seg } from '../components/ui';
import { useTheme } from '../theme';
import { useToast } from '../toast';

/** Appearance, password and sign-out — for admins (in Manage) and members (Account tab). */
export function AccountSection() {
  const { me, signOut } = useAuth();
  const toast = useToast();
  const [theme, setTheme] = useTheme();
  const [pw, setPw] = useState({ current: '', next: '' });

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    if (pw.next.length < 8) return toast('New password must be at least 8 characters', 'error');
    try {
      await send('POST', '/me/password', pw);
      setPw({ current: '', next: '' });
      toast('Password changed');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  return (
    <>
      <section className="stack">
        <SectionTitle>Appearance</SectionTitle>
        <Seg
          label="Theme"
          className="seg-wide"
          value={theme}
          onChange={setTheme}
          options={[
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
            { value: 'system', label: 'Auto' },
          ]}
        />
      </section>
      <form className="stack" onSubmit={changePassword}>
        <SectionTitle aside={me?.user.email}>Password</SectionTitle>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Current">
            <input className="input" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          </Field>
          <Field label="New (8+ characters)">
            <input className="input" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
          </Field>
        </div>
        <div className="row">
          <Btn type="submit" style={{ height: 44 }} disabled={!pw.current || !pw.next}>
            Change password
          </Btn>
          <button type="button" className="btn btn-ghost push" onClick={signOut}>
            Sign out
          </button>
        </div>
      </form>
    </>
  );
}
