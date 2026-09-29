import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { get, MemberView, send } from '../api';
import { useGroup } from '../App';
import { BackButton, Btn, Field, SectionTitle } from '../components/ui';
import { MeStats } from '../group/MeStats';
import { useToast } from '../toast';
import { clampLevel } from './NewGroup';

/** An admin's view of one member: their record, plus name / level / login details. */
export function MemberPage() {
  const { gid, isAdmin, membership } = useGroup();
  const mid = Number(useParams().mid);
  const navigate = useNavigate();
  const toast = useToast();
  const [member, setMember] = useState<MemberView | null>(null);
  const [form, setForm] = useState({ name: '', level: '50', email: '', password: '' });

  const load = useCallback(() => {
    if (!isAdmin) return;
    get<MemberView[]>(`/groups/${gid}/members?includeInactive=1&includeGuests=1`).then((r) => {
      const m = r.data.find((x) => x.id === mid) ?? null;
      setMember(m);
      if (m) setForm({ name: m.name, level: String(m.level ?? 50), email: m.email ?? '', password: '' });
    });
  }, [gid, mid, isAdmin]);
  useEffect(load, [load]);

  const back = () => navigate(`/g/${gid}?tab=${isAdmin ? 'members' : 'me'}`);
  const emailChanged = form.email.trim() !== (member?.email ?? '');

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      await send('PATCH', `/groups/${gid}/members/${mid}`, {
        name: form.name,
        level: clampLevel(form.level),
        ...(emailChanged && form.email.trim() && { email: form.email.trim() }),
        ...(form.password && { password: form.password }),
      });
      toast('Saved');
      load();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  async function toggleActive() {
    try {
      await send('PATCH', `/groups/${gid}/members/${mid}`, { active: !member!.active });
      load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  const isMe = membership?.memberId === mid;
  return (
    <div className="screen">
      <div className="head">
        <div className="head-row">
          <BackButton label={isAdmin ? 'Members' : 'Group'} onClick={back} />
          {member?.active === false && <span className="tag tag-neutral push">Removed</span>}
        </div>
        <div className="head-title">
          <div className="title">{isMe ? 'My games' : (member?.name ?? 'Member')}</div>
          {member?.level !== undefined && <div className="push small muted">Lv {member.level}</div>}
        </div>
      </div>
      <div className="body">
        <div className="col">
          <MeStats gid={gid} memberId={mid} showResults={isAdmin} />
          {isAdmin && member && (
            <form className="stack" onSubmit={save}>
              <SectionTitle>Details</SectionTitle>
              <div className="add-grid" style={{ gridTemplateColumns: 'minmax(0,1fr) 72px' }}>
                <Field label="Name">
                  <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
                </Field>
                <Field label="Level">
                  <input className="input" type="number" min={1} max={100} value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })} />
                </Field>
              </div>
              {!member.isGuest && (
                <>
                  <Field label="Login email (optional)">
                    <input className="input" type="email" autoComplete="off" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                  </Field>
                  {emailChanged && form.email.trim() && (
                    <Field label="Initial password — needed if this email has no account yet">
                      <input className="input" autoComplete="off" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
                    </Field>
                  )}
                  <p className="small muted">Easier: share the group's invite code from Manage, and they set up their own login.</p>
                </>
              )}
              <div className="row">
                <Btn type="submit" variant="primary" style={{ height: 44, minWidth: 104 }}>
                  Save
                </Btn>
                {!member.isGuest && !member.isOwner && (
                  <button type="button" className="btn btn-ghost push" onClick={toggleActive}>
                    {member.active ? 'Remove from group' : 'Add back to group'}
                  </button>
                )}
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
