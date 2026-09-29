import mysql from 'mysql2/promise';

/** Fresh schema in the test database for each run. */
export default async function setup() {
  process.env.VITEST = 'true';
  const { config } = await import('../src/config.js');
  const { migrate } = await import('../src/migrate.js');
  const conn = await mysql.createConnection({ ...config.db, multipleStatements: true });
  const [tables] = await conn.query<mysql.RowDataPacket[]>('SHOW TABLES');
  const names = tables.map((t) => Object.values(t)[0] as string);
  if (names.length) {
    await conn.query(`SET FOREIGN_KEY_CHECKS = 0; DROP TABLE ${names.map((n) => `\`${n}\``).join(', ')}; SET FOREIGN_KEY_CHECKS = 1;`);
  }
  await conn.end();
  await migrate();
}
