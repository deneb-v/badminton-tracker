import mysql, { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { config } from './config.js';

export const pool: Pool = mysql.createPool({
  ...config.db,
  connectionLimit: 10,
  // Timestamps are stored as UTC; DATE columns stay plain 'YYYY-MM-DD' strings.
  timezone: 'Z',
  dateStrings: ['DATE'],
});

export type Conn = Pool | PoolConnection;

export async function query<T = RowDataPacket>(conn: Conn, sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await conn.query<RowDataPacket[]>(sql, params);
  return rows as T[];
}

export async function execute(conn: Conn, sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
  const [res] = await conn.query<ResultSetHeader>(sql, params);
  return res;
}

export async function transaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
