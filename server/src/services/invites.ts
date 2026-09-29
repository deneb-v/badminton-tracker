import { randomInt } from 'node:crypto';
import { Conn, execute, query } from '../db.js';
import { notFound } from '../errors.js';

// No 0/O, 1/I/L: codes get read out loud and typed on phones.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function makeInviteCode(): string {
  return Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
}

export const normalizeCode = (code: string) => code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Gives the group a fresh invite code (retrying on the rare collision) and returns it. */
export async function resetInviteCode(conn: Conn, groupId: number): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const code = makeInviteCode();
    try {
      await execute(conn, 'UPDATE `groups` SET invite_code = ? WHERE id = ?', [code, groupId]);
      return code;
    } catch (err) {
      if ((err as { code?: string }).code !== 'ER_DUP_ENTRY' || attempt >= 5) throw err;
    }
  }
}

export async function groupForCode(conn: Conn, code: string): Promise<{ id: number; name: string }> {
  const [g] = await query<{ id: number; name: string }>(conn, 'SELECT id, name FROM `groups` WHERE invite_code = ?', [
    normalizeCode(code),
  ]);
  if (!g) throw notFound('That invite code is not valid. Ask your organiser for the current one.');
  return g;
}

/**
 * Adds a user to a group as a member. Re-activates an old membership, or claims a roster entry
 * with the same name that has no login yet (admins often add players before they sign up).
 * New members start at level 50 until an admin adjusts it.
 */
export async function joinGroup(conn: Conn, groupId: number, userId: number, name: string): Promise<number> {
  const [existing] = await query<{ id: number }>(conn, 'SELECT id FROM members WHERE group_id = ? AND user_id = ?', [
    groupId,
    userId,
  ]);
  if (existing) {
    await execute(conn, 'UPDATE members SET active = 1 WHERE id = ?', [existing.id]);
    return existing.id;
  }
  const [unclaimed] = await query<{ id: number }>(
    conn,
    `SELECT id FROM members WHERE group_id = ? AND user_id IS NULL AND is_guest = 0 AND LOWER(name) = LOWER(?)
     ORDER BY active DESC, id LIMIT 1`,
    [groupId, name],
  );
  if (unclaimed) {
    await execute(conn, 'UPDATE members SET user_id = ?, active = 1 WHERE id = ?', [userId, unclaimed.id]);
    return unclaimed.id;
  }
  const r = await execute(conn, 'INSERT INTO members (group_id, user_id, name, role, level) VALUES (?, ?, ?, ?, ?)', [
    groupId,
    userId,
    name,
    'member',
    50,
  ]);
  return r.insertId;
}
