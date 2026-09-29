/**
 * Demo data: a group with 16 members, a finished session from last week (with results) and a
 * session today that's ready to take attendance for.
 *
 *   admin@demo.dev  / password123   (admin)
 *   member@demo.dev / password123   (read-only member)
 */
import bcrypt from 'bcryptjs';
import { execute, pool, query, transaction } from './db.js';
import { migrate } from './migrate.js';
import { resetInviteCode } from './services/invites.js';

const NAMES = [
  'Aisha', 'Ben', 'Chen', 'Dara', 'Eli', 'Farah', 'Gus', 'Hana',
  'Ivan', 'Jules', 'Kofi', 'Lena', 'Mo', 'Nadia', 'Omar', 'Priya',
];
const LEVELS = [72, 45, 88, 60, 38, 66, 52, 81, 29, 57, 70, 63, 41, 76, 49, 55];

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

async function main() {
  await migrate();
  const [existing] = await query(pool, "SELECT id FROM users WHERE email = 'admin@demo.dev'");
  if (existing) {
    console.log('Demo data already present (admin@demo.dev). Nothing to do.');
    return;
  }
  const hash = await bcrypt.hash('password123', 10);

  await transaction(async (conn) => {
    const admin = await execute(conn, 'INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)', ['admin@demo.dev', hash, 'Sam (Admin)']);
    const member = await execute(conn, 'INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)', ['member@demo.dev', hash, NAMES[0]]);
    const g = await execute(conn, 'INSERT INTO `groups` (name, venue, usual_days, owner_user_id) VALUES (?, ?, ?, ?)', [
      'Tuesday Smashers', 'Riverside Sports Hall', 'Tue,Thu', admin.insertId,
    ]);
    const groupId = g.insertId;
    await resetInviteCode(conn, groupId);

    const memberIds: number[] = [];
    const adminMember = await execute(conn, 'INSERT INTO members (group_id, user_id, name, role, level) VALUES (?, ?, ?, ?, ?)', [
      groupId, admin.insertId, 'Sam (Admin)', 'admin', 58,
    ]);
    memberIds.push(adminMember.insertId);
    for (const [i, name] of NAMES.entries()) {
      const r = await execute(conn, 'INSERT INTO members (group_id, user_id, name, role, level) VALUES (?, ?, ?, ?, ?)', [
        groupId, i === 0 ? member.insertId : null, name, 'member', LEVELS[i],
      ]);
      memberIds.push(r.insertId);
    }

    // Last week: closed session with a handful of results.
    const past = new Date(Date.now() - 7 * 86_400_000);
    const ps = await execute(conn,
      "INSERT INTO sessions (group_id, venue, date, start_time, end_time, match_type, status) VALUES (?, ?, ?, '19:00', '21:00', 'doubles', 'closed')",
      [groupId, 'Riverside Sports Hall', ymd(past)]);
    const courtA = await execute(conn, "INSERT INTO courts (session_id, label, available_from, available_until) VALUES (?, 'A', '19:00', '21:00')", [ps.insertId]);
    const courtB = await execute(conn, "INSERT INTO courts (session_id, label, available_from, available_until) VALUES (?, 'B', '19:00', '20:00')", [ps.insertId]);
    const pastPlayers = memberIds.slice(0, 12);
    await execute(conn, "INSERT INTO attendance (session_id, member_id, status) VALUES ?", [
      memberIds.map((id) => [ps.insertId, id, pastPlayers.includes(id) ? 'departed' : 'absent']),
    ]);
    const base = new Date(`${ymd(past)}T19:00:00`).getTime();
    for (let i = 0; i < 8; i++) {
      const court = i % 2 ? courtB.insertId : courtA.insertId;
      const start = new Date(base + Math.floor(i / 2) * 16 * 60_000);
      const end = new Date(start.getTime() + (13 + (i % 4)) * 60_000);
      const m = await execute(conn,
        "INSERT INTO matches (session_id, court_id, type, status, position, started_at, ended_at, winner_side) VALUES (?, ?, 'doubles', 'done', ?, ?, ?, ?)",
        [ps.insertId, court, i, start, end, i % 3 === 2 ? null : i % 2 ? 'B' : 'A']);
      const four = [0, 1, 2, 3].map((k) => pastPlayers[(i * 4 + k) % pastPlayers.length]);
      await execute(conn, 'INSERT INTO match_players (match_id, member_id, side) VALUES ?', [
        [[m.insertId, four[0], 'A'], [m.insertId, four[3], 'A'], [m.insertId, four[1], 'B'], [m.insertId, four[2], 'B']],
      ]);
    }

    // Today: scheduled, whole group invited, two courts with different windows (FR-9).
    const now = new Date();
    const startH = now.getHours();
    const endH = Math.min(startH + 3, 23);
    const ts = await execute(conn,
      "INSERT INTO sessions (group_id, venue, date, start_time, end_time, match_type) VALUES (?, ?, ?, ?, ?, 'doubles')",
      [groupId, 'Riverside Sports Hall', ymd(now), `${pad(startH)}:00`, `${pad(endH)}:59`]);
    await execute(conn, 'INSERT INTO courts (session_id, label, available_from, available_until) VALUES ?', [[
      [ts.insertId, 'A', `${pad(startH)}:00`, `${pad(endH)}:59`],
      [ts.insertId, 'B', `${pad(startH)}:00`, `${pad(Math.min(startH + 2, 23))}:00`],
    ]]);
    await execute(conn, 'INSERT INTO attendance (session_id, member_id) VALUES ?', [memberIds.map((id) => [ts.insertId, id])]);
  });
  console.log('Seeded demo data.\n  admin@demo.dev / password123 (admin)\n  member@demo.dev / password123 (member)');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
