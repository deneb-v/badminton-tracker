import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { createUser } from '../src/create-user.js';

const app = createApp();
const api = (token?: string) => ({
  get: (url: string) => request(app).get(url).set('Authorization', `Bearer ${token}`),
  post: (url: string, body: object = {}) => request(app).post(url).set('Authorization', `Bearer ${token}`).send(body),
  put: (url: string, body: object = {}) => request(app).put(url).set('Authorization', `Bearer ${token}`).send(body),
  patch: (url: string, body: object = {}) => request(app).patch(url).set('Authorization', `Bearer ${token}`).send(body),
  delete: (url: string) => request(app).delete(url).set('Authorization', `Bearer ${token}`),
});

async function signIn(email: string, password = 'password1') {
  const r = await request(app).post('/api/auth/login').send({ email, password });
  expect(r.status).toBe(200);
  return api(r.body.token);
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const hhmm = (offsetMin: number) => {
  const d = new Date(Date.now() + offsetMin * 60_000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

let admin: ReturnType<typeof api>;
let member: ReturnType<typeof api>;
let groupId: number;
let memberIds: number[] = [];
let aliceId: number;
const suffix = Date.now();

beforeAll(async () => {
  await createUser(`admin${suffix}@test.dev`, 'Admin', 'password1');
  admin = await signIn(`admin${suffix}@test.dev`);
  groupId = (await admin.post('/api/groups', { name: 'Tuesday Club', level: 60, venue: 'Riverside SC', days: ['Sat', 'Thu'] })).body
    .id;

  const alice = await admin.post(`/api/groups/${groupId}/members`, {
    name: 'Alice',
    level: 70,
    email: `alice${suffix}@test.dev`,
    password: 'password1',
  });
  expect(alice.status).toBe(201);
  aliceId = alice.body.id;
  const levels = [30, 35, 40, 45, 50, 55, 65, 75, 80];
  for (const [i, level] of levels.entries()) {
    const r = await admin.post(`/api/groups/${groupId}/members`, { name: `Player ${i + 1}`, level });
    memberIds.push(r.body.id);
  }
  const login = await request(app).post('/api/auth/login').send({ email: `alice${suffix}@test.dev`, password: 'password1' });
  member = api(login.body.token);
});

afterAll(async () => {
  await pool.end();
});

async function createLiveSession(courts?: object[]) {
  const s = await admin.post(`/api/groups/${groupId}/sessions`, {
    venue: 'Sports Hall',
    date: today(),
    startTime: '00:00',
    endTime: '23:59',
    ...(courts && { courts }),
  });
  expect(s.status).toBe(201);
  const sid = s.body.id as number;
  for (const id of [aliceId, ...memberIds]) {
    const r = await admin.put(`/api/sessions/${sid}/attendance/${id}`, { status: 'present' });
    expect(r.status).toBe(200);
  }
  const live = await admin.post(`/api/sessions/${sid}/start`);
  expect(live.status).toBe(200);
  return { sid, state: live.body };
}

describe('auth', () => {
  it('rejects unauthenticated requests', async () => {
    expect((await request(app).get('/api/me')).status).toBe(401);
  });

  it('lists group memberships on /me', async () => {
    const me = await member.get('/api/me');
    expect(me.body.groups).toEqual([expect.objectContaining({ groupId, role: 'member', memberId: aliceId })]);
  });
});

describe('level visibility (§2.2)', () => {
  it('admins see levels on the roster, members never do', async () => {
    const asAdmin = await admin.get(`/api/groups/${groupId}/members`);
    expect(asAdmin.body[0]).toHaveProperty('level');
    const asMember = await member.get(`/api/groups/${groupId}/members`);
    expect(asMember.status).toBe(200);
    expect(JSON.stringify(asMember.body)).not.toMatch(/level/i);
  });

  it('session state sent to members carries no level, balance flag, or wins', async () => {
    const { sid } = await createLiveSession();
    const state = await member.get(`/api/sessions/${sid}`);
    expect(state.status).toBe(200);
    expect(state.body.queue.length).toBeGreaterThan(0);
    const body = JSON.stringify(state.body);
    for (const leak of ['level', 'unbalanced', '"gap"', 'wins', 'losses', 'winnerSide', 'locked']) {
      expect(body).not.toContain(leak);
    }
  });

  it('members can see only their own history, without wins', async () => {
    const own = await member.get(`/api/groups/${groupId}/members/${aliceId}/stats`);
    expect(own.status).toBe(200);
    expect(JSON.stringify(own.body)).not.toMatch(/wins|losses|level/);
    expect((await member.get(`/api/groups/${groupId}/members/${memberIds[0]}/stats`)).status).toBe(403);
  });

  it('group settings (thresholds) are admin-only', async () => {
    expect((await member.get(`/api/groups/${groupId}`)).body.settings).toBeUndefined();
    expect((await admin.get(`/api/groups/${groupId}`)).body.settings.doublesMaxGap).toBe(8);
  });
});

describe('member permissions (§2.1)', () => {
  it('members cannot write anything', async () => {
    const { sid, state } = await createLiveSession();
    const matchId = state.queue[0].id;
    const attempts = [
      member.put(`/api/sessions/${sid}/attendance/${aliceId}`, { status: 'absent' }),
      member.post(`/api/sessions/${sid}/matches/${matchId}/start`),
      member.post(`/api/groups/${groupId}/sessions`, { venue: 'x', date: today(), startTime: '10:00', endTime: '11:00' }),
      member.post(`/api/groups/${groupId}/members`, { name: 'x', level: 10 }),
      member.patch(`/api/groups/${groupId}/members/${aliceId}`, { level: 99 }),
    ];
    for (const r of await Promise.all(attempts)) expect(r.status).toBe(403);
  });
});

describe('session flow', () => {
  it('plans one queue for both courts', async () => {
    const { state } = await createLiveSession();
    expect(state.session.status).toBe('live');
    // Queued games aren't tied to a court; the first two go on whichever courts are free.
    expect(state.queue.every((m: { courtId: number | null }) => m.courtId === null)).toBe(true);
    expect(state.queue.map((m: { gameNo: number }) => m.gameNo)).toEqual(state.queue.map((_: unknown, i: number) => i + 1));
    const first = state.queue.slice(0, 2);
    const ids = first.flatMap((m: { sideA: { id: number }[]; sideB: { id: number }[] }) => [...m.sideA, ...m.sideB].map((p) => p.id));
    expect(new Set(ids).size).toBe(8);
  });

  it('done + winner records the result, frees the court, and counts games', async () => {
    const { sid, state } = await createLiveSession();
    const courtA = state.courts.find((c: { label: string }) => c.label === 'A');
    const firstA = state.queue[0];
    const started = await admin.post(`/api/sessions/${sid}/matches/${firstA.id}/start`, { courtId: courtA.id });
    expect(started.status).toBe(200);
    expect(started.body.courts.find((c: { id: number }) => c.id === courtA.id).current).toMatchObject({
      id: firstA.id,
      courtLabel: 'A',
      gameNo: 1,
    });

    const done = await admin.post(`/api/sessions/${sid}/matches/${firstA.id}/finish`, { winnerSide: 'A' });
    expect(done.status).toBe(200);
    expect(done.body.history[0]).toMatchObject({ id: firstA.id, winnerSide: 'A', status: 'done' });
    // Nothing starts by itself: the admin calls the next game with Start.
    expect(done.body.courts.find((c: { id: number }) => c.id === courtA.id).current).toBeNull();

    const winners = firstA.sideA.map((p: { id: number }) => p.id);
    for (const a of done.body.attendance.filter((x: { memberId: number }) => winners.includes(x.memberId))) {
      expect(a).toMatchObject({ gamesPlayed: 1, wins: 1, losses: 0 });
    }

    // Replaying the same tap (offline outbox) is harmless.
    const again = await admin.post(`/api/sessions/${sid}/matches/${firstA.id}/finish`, { winnerSide: 'A' });
    expect(again.status).toBe(200);
    expect(again.body.history.filter((m: { id: number }) => m.id === firstA.id)).toHaveLength(1);
  });

  it('winner tap is skippable and can be filled in later', async () => {
    const { sid, state } = await createLiveSession();
    const m = state.queue[0];
    await admin.post(`/api/sessions/${sid}/matches/${m.id}/start`, { courtId: state.courts[0].id });
    const done = await admin.post(`/api/sessions/${sid}/matches/${m.id}/finish`, {});
    expect(done.body.history[0].winnerSide).toBeNull();
    const fixed = await admin.patch(`/api/sessions/${sid}/matches/${m.id}`, { winnerSide: 'B' });
    expect(fixed.body.history[0].winnerSide).toBe('B');
  });

  it('finishing a game keeps the next games as they are', async () => {
    const { sid, state } = await createLiveSession();
    const [a, b] = state.courts;
    const [g1, g2] = state.queue;
    await admin.post(`/api/sessions/${sid}/matches/${g1.id}/start`, { courtId: a.id });
    const on = await admin.post(`/api/sessions/${sid}/matches/${g2.id}/start`, { courtId: b.id });
    const nextTwo = on.body.queue.slice(0, 2).map((m: never) => [(m as { id: number }).id, ids(m)]);
    const done = await admin.post(`/api/sessions/${sid}/matches/${g1.id}/finish`, { winnerSide: 'B' });
    expect(done.body.queue.slice(0, 2).map((m: never) => [(m as { id: number }).id, ids(m)])).toEqual(nextTwo);
  });

  it('start needs a free court of the right type, with nobody still on court', async () => {
    const { sid, state } = await createLiveSession();
    const [a, b] = state.courts;
    const [g1, g2] = state.queue;
    await admin.post(`/api/sessions/${sid}/matches/${g1.id}/start`, { courtId: a.id });
    expect((await admin.post(`/api/sessions/${sid}/matches/${g2.id}/start`, { courtId: a.id })).status).toBe(409);
    expect((await admin.post(`/api/sessions/${sid}/matches/${g2.id}/start`, {})).status).toBe(400);
    // A game sharing a player with the one on court A can't start on B.
    const clash = (await admin.get(`/api/sessions/${sid}`)).body.queue.find((m: never) => ids(m).some((id) => ids(g1).includes(id)));
    if (clash) expect((await admin.post(`/api/sessions/${sid}/matches/${clash.id}/start`, { courtId: b.id })).status).toBe(409);
  });

  it('a departing player is dropped from the upcoming queue (FR-13, FR-23)', async () => {
    const { sid, state } = await createLiveSession();
    const leaving = state.queue[0].sideA[0].id;
    const after = await admin.put(`/api/sessions/${sid}/attendance/${leaving}`, { status: 'departed' });
    const queued = after.body.queue.flatMap((m: { sideA: { id: number }[]; sideB: { id: number }[] }) => [...m.sideA, ...m.sideB].map((p) => p.id));
    expect(queued).not.toContain(leaving);
  });

  it('walk-in guests join the pool (FR-14) but not the roster', async () => {
    const { sid } = await createLiveSession();
    const r = await admin.post(`/api/sessions/${sid}/guests`, { name: 'Walk-in Wendy', level: 50 });
    expect(r.body.attendance.find((a: { name: string }) => a.name === 'Walk-in Wendy')).toMatchObject({ status: 'present', isGuest: true });
    const roster = await admin.get(`/api/groups/${groupId}/members`);
    expect(roster.body.map((m: { name: string }) => m.name)).not.toContain('Walk-in Wendy');
  });

  it('warns before starting a match that will not fit the court window', async () => {
    const s = await admin.post(`/api/groups/${groupId}/sessions`, {
      venue: 'Short Hall',
      date: today(),
      startTime: '00:00',
      endTime: '23:59',
      courts: [{ label: 'A', availableFrom: '00:00', availableUntil: hhmm(5) }],
    });
    const sid = s.body.id;
    for (const id of memberIds.slice(0, 4)) await admin.put(`/api/sessions/${sid}/attendance/${id}`, { status: 'present' });
    const live = await admin.post(`/api/sessions/${sid}/start`);
    const m = live.body.queue[0];
    const courtId = live.body.courts[0].id;
    const warned = await admin.post(`/api/sessions/${sid}/matches/${m.id}/start`, { courtId });
    expect(warned.status).toBe(409);
    expect(warned.body.code).toBe('WINDOW_WARNING');
    const forced = await admin.post(`/api/sessions/${sid}/matches/${m.id}/start`, { courtId, force: true });
    expect(forced.status).toBe(200);
  });
});

describe('overrides (FR-22)', () => {
  it('a swapped player sticks through regeneration', async () => {
    const { sid, state } = await createLiveSession();
    const m = state.queue[0];
    const inMatch = [...m.sideA, ...m.sideB].map((p: { id: number }) => p.id);
    const bench = [aliceId, ...memberIds].find((id) => !inMatch.includes(id))!;
    const sideA = [bench, ...m.sideA.slice(1).map((p: { id: number }) => p.id)];
    const edited = await admin.patch(`/api/sessions/${sid}/matches/${m.id}`, { sideA });
    expect(edited.status).toBe(200);
    const regen = await admin.post(`/api/sessions/${sid}/regenerate`);
    const kept = regen.body.queue.find((x: { id: number }) => x.id === m.id);
    expect(kept.locked).toBe(true);
    expect(kept.sideA.map((p: { id: number }) => p.id)).toEqual(sideA.sort((a, b) => a - b));
  });

  it('rejects a lineup that does not fit the court', async () => {
    const { sid, state } = await createLiveSession();
    const r = await admin.post(`/api/sessions/${sid}/matches`, {
      courtId: state.courts[0].id,
      sideA: [memberIds[0]],
      sideB: [memberIds[1]],
    });
    expect(r.status).toBe(400);
  });

  it('inserted matches go to the front of the queue', async () => {
    const { sid } = await createLiveSession();
    const r = await admin.post(`/api/sessions/${sid}/matches`, {
      sideA: [memberIds[7], memberIds[8]],
      sideB: [memberIds[0], memberIds[1]],
    });
    expect(r.status).toBe(200);
    const first = r.body.queue[0];
    expect(ids(first).sort()).toEqual([memberIds[7], memberIds[8], memberIds[0], memberIds[1]].sort());
    expect(first.locked).toBe(true);
    expect(first.unbalanced).toBe(true); // 75+80 v 30+35 — admin's call, but flagged
  });
});

describe('multi-admin', () => {
  it('serialises concurrent writes and bumps the version once per write', async () => {
    const { sid, state } = await createLiveSession();
    const [a, b] = state.courts;
    const [ma, mb] = state.queue;
    const v0 = state.session.version;
    const [ra, rb] = await Promise.all([
      admin.post(`/api/sessions/${sid}/matches/${ma.id}/start`, { courtId: a.id }),
      admin.post(`/api/sessions/${sid}/matches/${mb.id}/start`, { courtId: b.id }),
    ]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    const final = await admin.get(`/api/sessions/${sid}`);
    expect(final.body.session.version).toBe(v0 + 2);
    expect(final.body.courts.every((c: { current: unknown }) => c.current)).toBe(true);
  });
});

type P = { id: number };
const ids = (m: { sideA: P[]; sideB: P[] }) => [...m.sideA, ...m.sideB].map((p) => p.id);

describe('Cloudflare Access re-login', () => {
  it('sends the browser back into the app, but only to a path on this site', async () => {
    const back = async (ret?: string) =>
      (await request(app).get('/api/auth/cloudflare').query(ret === undefined ? {} : { return: ret })).headers.location;
    expect(await back('/g/2/s/9?tab=plan')).toBe('/g/2/s/9?tab=plan');
    expect(await back()).toBe('/');
    for (const evil of ['//evil.com', '/\\evil.com', 'https://evil.com', 'evil.com']) expect(await back(evil)).toBe('/');
  });
});

describe('groups & invites', () => {
  it('open sign-up is gone; players join with the invite code', async () => {
    const reg = await request(app).post('/api/auth/register').send({ email: `x${suffix}@t.dev`, password: 'password1', name: 'X' });
    expect(reg.status).not.toBe(201);

    const g = await admin.get(`/api/groups/${groupId}`);
    expect(g.body.venue).toBe('Riverside SC');
    expect(g.body.days).toEqual(['Thu', 'Sat']);
    expect(g.body.inviteCode).toMatch(/^[A-Z2-9]{6}$/);

    expect((await request(app).get(`/api/invites/${g.body.inviteCode.toLowerCase()}`)).body.groupName).toBe('Tuesday Club');
    expect((await request(app).get('/api/invites/ZZZZZZ')).status).toBe(404);

    // "Player 1" was added by the admin without a login: joining under that name claims the entry.
    const join = await request(app)
      .post('/api/auth/join')
      .send({ code: g.body.inviteCode, name: 'player 1', email: `p1${suffix}@t.dev`, password: 'password1' });
    expect(join.status).toBe(201);
    const me = await api(join.body.token).get('/api/me');
    expect(me.body.groups).toMatchObject([{ groupId, memberId: memberIds[0], role: 'member', days: ['Thu', 'Sat'] }]);

    const again = await request(app)
      .post('/api/auth/join')
      .send({ code: g.body.inviteCode, name: 'Someone', email: `p1${suffix}@t.dev`, password: 'wrong-password' });
    expect(again.status).toBe(409);
  });

  it('members never see the invite code; resetting it retires the old one', async () => {
    const m = await member.get(`/api/groups/${groupId}`);
    expect(m.body.inviteCode).toBeUndefined();
    const old = (await admin.get(`/api/groups/${groupId}`)).body.inviteCode;
    const fresh = await admin.post(`/api/groups/${groupId}/invite-code`);
    expect(fresh.body.inviteCode).not.toBe(old);
    expect((await request(app).get(`/api/invites/${old}`)).status).toBe(404);
    expect((await member.post(`/api/groups/${groupId}/invite-code`)).status).toBe(403);
  });

  it('creates a group with its starting roster, and only the owner can delete it', async () => {
    const r = await admin.post('/api/groups', {
      name: 'Saturday Social',
      venue: 'Northgate Hall',
      days: ['Sat'],
      members: [
        { name: 'Ana', level: 70 },
        { name: 'Lee', level: 66 },
      ],
    });
    expect(r.status).toBe(201);
    const gid = r.body.id;
    const roster = await admin.get(`/api/groups/${gid}/members`);
    expect(roster.body.map((m: { name: string }) => m.name)).toEqual(['Admin', 'Ana', 'Lee']);
    const owner = roster.body.find((m: { name: string }) => m.name === 'Admin');
    expect(owner.isOwner).toBe(true);
    expect((await admin.patch(`/api/groups/${gid}/members/${owner.id}`, { role: 'member' })).status).toBe(403);

    // A co-admin can't delete it.
    await admin.patch(`/api/groups/${gid}/members/${roster.body[1].id}`, {
      role: 'admin',
      email: `ana${suffix}@t.dev`,
      password: 'password1',
    });
    const ana = await signIn(`ana${suffix}@t.dev`);
    expect((await ana.delete(`/api/groups/${gid}`)).status).toBe(403);
    expect((await admin.delete(`/api/groups/${gid}`)).status).toBe(204);
    expect((await admin.get(`/api/groups/${gid}`)).status).toBe(403);
  });

  it('group-wide history is admin-only', async () => {
    const r = await admin.get(`/api/groups/${groupId}/history`);
    expect(r.status).toBe(200);
    expect(r.body[0]).toMatchObject({ name: expect.any(String), played: expect.any(Number), wins: expect.any(Number) });
    expect((await member.get(`/api/groups/${groupId}/history`)).status).toBe(403);
  });
});

describe('courtside session features', () => {
  it('venue defaults to the group, and mixed courts are reported as mixed', async () => {
    const s = await admin.post(`/api/groups/${groupId}/sessions`, {
      date: today(),
      startTime: '09:30',
      endTime: '11:00',
      levelEvery: 2,
      courts: [
        { label: 'A', availableFrom: '09:30', availableUntil: '11:00' },
        { label: 'B', availableFrom: '09:30', availableUntil: '11:00', matchType: 'singles' },
      ],
    });
    expect(s.status).toBe(201);
    const list = await admin.get(`/api/groups/${groupId}/sessions`);
    const row = list.body.find((x: { id: number }) => x.id === s.body.id);
    expect(row).toMatchObject({ venue: 'Riverside SC', format: 'mixed' });
    const state = await admin.get(`/api/sessions/${s.body.id}`);
    expect(state.body.session.levelEvery).toBe(2);
    expect((await member.get(`/api/sessions/${s.body.id}`)).body.session.levelEvery).toBeUndefined();
  });

  it('edits a session: details, settings and courts in one save', async () => {
    const { sid, state } = await createLiveSession();
    const setup = (courts: object[], extra: object = {}) => ({
      venue: 'New Hall',
      date: today(),
      startTime: '00:00',
      endTime: '23:59',
      matchType: 'doubles',
      levelEvery: 2,
      courts,
      ...extra,
    });
    const court = (label: string, extra: object = {}) => ({ label, availableFrom: '00:00', availableUntil: '23:59', ...extra });

    const r = await admin.put(`/api/sessions/${sid}/setup`, setup([court('A'), court('B'), court('C', { matchType: 'singles' })]));
    expect(r.status).toBe(200);
    expect(r.body.session).toMatchObject({ venue: 'New Hall', levelEvery: 2 });
    expect(r.body.courts.map((c: { label: string; matchType: string }) => [c.label, c.matchType])).toEqual([
      ['A', 'doubles'],
      ['B', 'doubles'],
      ['C', 'singles'],
    ]);
    expect(r.body.queue.some((m: { type: string }) => m.type === 'singles')).toBe(true);

    // A court with games played can't be removed; one without can.
    await admin.post(`/api/sessions/${sid}/matches/${r.body.queue[0].id}/start`, { courtId: state.courts[0].id });
    expect((await admin.put(`/api/sessions/${sid}/setup`, setup([court('B')]))).status).toBe(409);
    const fewer = await admin.put(`/api/sessions/${sid}/setup`, setup([court('A'), court('B')]));
    expect(fewer.body.courts.map((c: { label: string }) => c.label)).toEqual(['A', 'B']);

    expect((await member.put(`/api/sessions/${sid}/setup`, setup([court('A')]))).status).toBe(403);
  });

  it('numbers games per court and swaps a waiting player in', async () => {
    const { sid, state } = await createLiveSession();
    const [a] = state.courts;
    const onA = state.queue.filter((m: { courtId: number }) => m.courtId === a.id);
    expect(onA.map((m: { gameNo: number }) => m.gameNo)).toEqual(onA.map((_: unknown, i: number) => i + 1));

    const m = state.queue[0];
    const waiting = [aliceId, ...memberIds].find((id) => !state.queue.slice(0, 2).some((q: never) => ids(q).includes(id)))!;
    const out = ids(m)[0];
    const r = await admin.post(`/api/sessions/${sid}/matches/${m.id}/swap`, { out, in: waiting });
    expect(r.body.error ?? r.status).toBe(200);
    const after = r.body.queue.find((x: { id: number }) => x.id === m.id);
    expect(ids(after)).toContain(waiting);
    expect(ids(after)).not.toContain(out);
    expect(after.locked).toBe(true);
  });

  it('swapping with a player from another queued match trades them', async () => {
    const { sid, state } = await createLiveSession();
    const [m1, m2] = state.queue;
    const out = ids(m1)[0];
    const incoming = ids(m2).find((id) => !ids(m1).includes(id))!;
    const r = await admin.post(`/api/sessions/${sid}/matches/${m1.id}/swap`, { out, in: incoming });
    expect(r.status).toBe(200);
    const q1 = r.body.queue.find((x: { id: number }) => x.id === m1.id);
    const q2 = r.body.queue.find((x: { id: number }) => x.id === m2.id);
    expect(ids(q1)).toContain(incoming);
    expect(ids(q2)).toContain(out);
    expect(ids(q2)).not.toContain(incoming);
  });

  it('re-draw replaces a match with a different lineup', async () => {
    const { sid, state } = await createLiveSession();
    const m = state.queue[0];
    const r = await admin.post(`/api/sessions/${sid}/matches/${m.id}/redraw`);
    expect(r.status).toBe(200);
    const after = r.body.queue.find((x: { id: number }) => x.id === m.id);
    expect(after.locked).toBe(true);
    expect([...ids(after)].sort()).not.toEqual([...ids(m)].sort());
  });

  it('a planned game takes its game number, is filled up, and is used up when it starts', async () => {
    const { sid, state } = await createLiveSession();
    const [a, b] = state.courts;
    const first = state.queue[0];
    // Start game 1, then plan game 2 around two specific players.
    await admin.post(`/api/sessions/${sid}/matches/${first.id}/start`, { courtId: a.id });
    const bench = [aliceId, ...memberIds].filter((id) => !ids(first).includes(id));
    const [p, q] = [bench[bench.length - 1], bench[bench.length - 2]];
    expect((await admin.post(`/api/sessions/${sid}/plan`, { gameNo: 1, memberId: p })).status).toBe(409);
    await admin.post(`/api/sessions/${sid}/plan`, { gameNo: 2, memberId: p });
    const r = await admin.post(`/api/sessions/${sid}/plan`, { gameNo: 2, memberId: q });
    expect(r.body.plan).toEqual([{ gameNo: 2, memberIds: [p, q] }]);
    const next = r.body.queue[0];
    expect(next).toMatchObject({ gameNo: 2, planned: true });
    expect(ids(next)).toEqual(expect.arrayContaining([p, q]));
    expect(ids(next)).toHaveLength(4);

    // Members don't see the plan.
    expect((await member.get(`/api/sessions/${sid}`)).body.plan).toBeUndefined();

    // Starting the planned game (on whichever court is free) uses up the slot.
    const started = await admin.post(`/api/sessions/${sid}/matches/${next.id}/start`, { courtId: b.id });
    expect(started.body.courts.find((c: { id: number }) => c.id === b.id).current).toMatchObject({ id: next.id, gameNo: 2, planned: true });
    expect(started.body.plan).toEqual([]);
  });

  it('moving a planned player between games and removing them', async () => {
    const { sid } = await createLiveSession();
    await admin.post(`/api/sessions/${sid}/plan`, { gameNo: 3, memberId: aliceId });
    const moved = await admin.post(`/api/sessions/${sid}/plan`, { gameNo: 2, memberId: aliceId, from: { gameNo: 3 } });
    expect(moved.body.plan).toEqual([{ gameNo: 2, memberIds: [aliceId] }]);
    const del = await admin.delete(`/api/sessions/${sid}/plan/2/${aliceId}`);
    expect(del.status).toBe(200);
    expect(del.body.plan).toEqual([]);
    expect((await member.post(`/api/sessions/${sid}/plan`, { gameNo: 3, memberId: aliceId })).status).toBe(403);
  });
});

describe("who's playing & walk-ins", () => {
  it('starting with a ticked list marks exactly those players here', async () => {
    const s = await admin.post(`/api/groups/${groupId}/sessions`, { date: today(), startTime: '00:00', endTime: '23:59' });
    const picked = [aliceId, ...memberIds.slice(0, 4)];
    const r = await admin.post(`/api/sessions/${s.body.id}/start`, { present: picked });
    expect(r.status).toBe(200);
    const here = r.body.attendance.filter((a: { status: string }) => a.status === 'present').map((a: { memberId: number }) => a.memberId);
    expect(here.sort()).toEqual([...picked].sort());
    expect(r.body.attendance.filter((a: { status: string }) => a.status === 'absent').length).toBeGreaterThan(0);
    expect(r.body.queue.every((m: never) => ids(m).every((id) => picked.includes(id)))).toBe(true);
  });

  it('a walk-in joins the group, is here now, and starts level with the least-played', async () => {
    const { sid, state } = await createLiveSession();
    const m = state.queue[0];
    await admin.post(`/api/sessions/${sid}/matches/${m.id}/start`, { courtId: state.courts[0].id });
    const done = await admin.post(`/api/sessions/${sid}/matches/${m.id}/finish`, { winnerSide: 'A' });
    const minGames = Math.min(...done.body.attendance.filter((a: { status: string }) => a.status === 'present').map((a: { gamesPlayed: number }) => a.gamesPlayed));

    const r = await admin.post(`/api/sessions/${sid}/walk-ins`, { name: `Walker ${sid}`, level: 55 });
    expect(r.status).toBe(200);
    const w = r.body.attendance.find((a: { name: string }) => a.name === `Walker ${sid}`);
    expect(w).toMatchObject({ status: 'present', isGuest: false });
    const roster = await admin.get(`/api/groups/${groupId}/members`);
    expect(roster.body.some((x: { name: string }) => x.name === `Walker ${sid}`)).toBe(true);
    const [{ games_credit }] = (await pool.query('SELECT games_credit FROM attendance WHERE session_id = ? AND member_id = ?', [sid, w.memberId]))[0] as { games_credit: number }[];
    expect(games_credit).toBe(minGames);

    // An existing member's name marks them arrived rather than duplicating them.
    await admin.put(`/api/sessions/${sid}/attendance/${memberIds[2]}`, { status: 'absent' });
    const again = await admin.post(`/api/sessions/${sid}/walk-ins`, { name: 'player 3', level: 10 });
    expect(again.body.attendance.find((a: { memberId: number }) => a.memberId === memberIds[2]).status).toBe('present');
    expect((await member.post(`/api/sessions/${sid}/walk-ins`, { name: 'X', level: 50 })).status).toBe(403);
  });
});
