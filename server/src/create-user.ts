/**
 * Sign-up is invite-only, so the first organiser's login is made here:
 *
 *   npm run create-user -- organiser@club.com "Jo Smith" 'a-long-password'
 *
 * They can then sign in, create a group, and share its invite code.
 */
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execute, pool, query } from './db.js';

export async function createUser(email: string, name: string, password: string): Promise<number> {
  const normalized = email.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(normalized)) throw new Error('Enter a valid email address');
  if (!name.trim()) throw new Error('Enter a name');
  if (password.length < 8) throw new Error('Password must be at least 8 characters');
  const [existing] = await query(pool, 'SELECT id FROM users WHERE email = ?', [normalized]);
  if (existing) throw new Error(`${normalized} already has an account`);
  const r = await execute(pool, 'INSERT INTO users (email, password_hash, name) VALUES (?, ?, ?)', [
    normalized,
    await bcrypt.hash(password, 10),
    name.trim(),
  ]);
  return r.insertId;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [email, name, password] = process.argv.slice(2);
  if (!email || !name || !password) {
    console.error('Usage: npm run create-user -- <email> "<name>" <password>');
    process.exitCode = 1;
  } else {
    createUser(email, name, password)
      .then(() => console.log(`Created ${email.trim().toLowerCase()}. They can sign in and create a group.`))
      .catch((err) => {
        console.error((err as Error).message);
        process.exitCode = 1;
      })
      .finally(() => pool.end());
  }
}
