import { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, GroupView, MemberView, send, WEEK, Weekday } from '../api';
import { useAuth } from '../auth';
import { Btn, DayPicker, Field, SectionTitle, XIcon } from '../components/ui';
import { toggleDay } from '../pages/NewGroup';
import { useToast } from '../toast';
import { AccountSection } from './AccountSection';

type Settings = NonNullable<GroupView['settings']>;

export function ManageTab({ gid }: { gid: number }) {
  const { me, refresh } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [group, setGroup] = useState<GroupView | null>(null);
  const [members, setMembers] = useState<MemberView[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [copied, setCopied] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const load = useCallback(() => {
    get<GroupView>(`/groups/${gid}`).then((r) => {
      setGroup(r.data);
      setSettings(r.data.settings ?? null);
    });
    get<MemberView[]>(`/groups/${gid}/members`).then((r) => setMembers(r.data));
  }, [gid]);
  useEffect(load, [load]);
  useEffect(() => () => clearTimeout(saveTimer.current), []);

  if (!group) return <p className="muted">Loading…</p>;

  // Details save as you type (after a pause), then the header picks them up.
  function editDetails(patch: Partial<Pick<GroupView, 'name' | 'venue' | 'days'>>) {
    const next = { ...group!, ...patch };
    setGroup(next);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      if (!next.name.trim()) return;
      try {
        await send('PATCH', `/groups/${gid}`, { name: next.name, venue: next.venue, days: next.days });
        await refresh();
      } catch (e) {
        toast((e as Error).message, 'error');
      }
    }, 600);
  }

  const inviteLink = `${location.origin}/join/${group.inviteCode}`;
  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast(inviteLink);
    }
  }
  async function resetCode() {
    try {
      const r = await send<{ inviteCode: string }>('POST', `/groups/${gid}/invite-code`);
      setGroup({ ...group!, inviteCode: r.inviteCode });
      setCopied(false);
      toast('New code. The old one no longer works.');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  async function setRole(m: MemberView, role: 'admin' | 'member') {
    try {
      await send('PATCH', `/groups/${gid}/members/${m.id}`, { role });
      load();
      if (m.id === me!.groups.find((g) => g.groupId === gid)?.memberId) await refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  }

  async function saveSettings(e: FormEvent) {
    e.preventDefault();
    try {
      await send('PATCH', `/groups/${gid}`, settings!);
      toast('Balancing saved');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  async function deleteGroup() {
    if (!deleteArmed) return setDeleteArmed(true);
    try {
      await send('DELETE', `/groups/${gid}`);
      await refresh();
      navigate('/groups', { replace: true });
    } catch (e) {
      toast((e as Error).message, 'error');
      setDeleteArmed(false);
    }
  }

  const admins = members.filter((m) => m.role === 'admin').sort((a, b) => Number(b.isOwner) - Number(a.isOwner));
  const candidates = members.filter((m) => m.role !== 'admin' && m.hasLogin);
  const isOwner = group.ownerUserId == null || group.ownerUserId === me!.user.id;
  const num = (k: keyof Settings) => ({
    value: settings![k],
    onChange: (e: { target: { value: string } }) => setSettings({ ...settings!, [k]: Number(e.target.value) }),
  });

  return (
    <>
      <section className="stack" style={{ gap: 14 }}>
        <SectionTitle>Details</SectionTitle>
        <Field label="Group name">
          <input className="input" value={group.name} onChange={(e) => editDetails({ name: e.target.value })} />
        </Field>
        <Field label="Venue">
          <input className="input" placeholder="e.g. Riverside SC" value={group.venue} onChange={(e) => editDetails({ venue: e.target.value })} />
        </Field>
        <div className="stack-sm">
          <div className="label">Usual days</div>
          <DayPicker<Weekday> days={group.days} week={WEEK} onToggle={(d) => editDetails({ days: toggleDay(group.days, d) })} />
        </div>
        <p className="small muted">Changes save automatically. New sessions use this venue.</p>
      </section>

      <section className="stack">
        <SectionTitle>Invite members</SectionTitle>
        <p className="body-sm muted">Players join with this code and see their queue position — never levels or win rates.</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 8, alignItems: 'center' }}>
          <div className="code-box" aria-label="Invite code">
            {group.inviteCode}
          </div>
          <Btn style={{ height: 44, minWidth: 104 }} onClick={copyInvite}>
            {copied ? 'Copied' : 'Copy link'}
          </Btn>
        </div>
        <button type="button" className="btn btn-ghost" style={{ alignSelf: 'flex-start', fontSize: 13 }} onClick={resetCode}>
          Reset code
        </button>
      </section>

      <section className="stack">
        <SectionTitle>Admins</SectionTitle>
        <div className="list">
          {admins.map((a) => (
            <div key={a.id} className="line">
              <div className="trunc" style={{ fontSize: 15 }}>
                {a.name}
                {a.email && <span className="small faint"> · {a.email}</span>}
              </div>
              <span className="tag tag-neutral push">{a.isOwner ? 'Owner' : 'Co-admin'}</span>
              {!a.isOwner && (
                <button type="button" className="btn btn-ghost btn-icon" aria-label={`Remove ${a.name} as admin`} onClick={() => setRole(a, 'member')}>
                  <XIcon />
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="stack-sm">
          <div className="small muted">Make a member a co-admin</div>
          {candidates.length ? (
            <div className="chips">
              {candidates.map((c) => (
                <button key={c.id} type="button" className="chip chip-dashed" onClick={() => setRole(c, 'admin')}>
                  + {c.name}
                </button>
              ))}
            </div>
          ) : (
            <p className="body-sm muted">Only members who've joined with their own login can be admins.</p>
          )}
        </div>
      </section>

      {settings && (
        <form className="stack" onSubmit={saveSettings}>
          <SectionTitle>Balancing</SectionTitle>
          <p className="body-sm muted">
            Limits are soft: if nobody fits, they widen rather than leave a court empty, and the match is flagged
            Unbalanced (admins only).
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label="Doubles: team-average gap">
              <input className="input" type="number" min={0} max={99} {...num('doublesMaxGap')} />
            </Field>
            <Field label="Doubles: gap between partners">
              <input className="input" type="number" min={0} max={99} {...num('intraTeamMaxSpread')} />
            </Field>
            <Field label="Singles: level gap">
              <input className="input" type="number" min={0} max={99} {...num('singlesMaxGap')} />
            </Field>
            <Field label="Typical match (min)">
              <input className="input" type="number" min={3} max={90} {...num('defaultMatchMinutes')} />
            </Field>
          </div>
          <Btn type="submit" style={{ alignSelf: 'flex-start', height: 44, minWidth: 104 }}>
            Save
          </Btn>
        </form>
      )}

      <AccountSection />

      {isOwner && (
        <section className="stack">
          <SectionTitle>Delete group</SectionTitle>
          <p className="body-sm muted">Removes all members, sessions and match history. This can't be undone.</p>
          <Btn style={{ height: 44, alignSelf: 'flex-start', minWidth: 180 }} onClick={deleteGroup} onBlur={() => setDeleteArmed(false)}>
            {deleteArmed ? 'Tap again to delete' : 'Delete group'}
          </Btn>
        </section>
      )}
    </>
  );
}
