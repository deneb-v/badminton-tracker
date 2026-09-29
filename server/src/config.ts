import 'dotenv/config';

const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';

export const config = {
  port: Number(process.env.PORT ?? 4000),
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret',
  db: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'badminton',
    password: process.env.DB_PASSWORD ?? 'badminton',
    database: isTest
      ? (process.env.TEST_DB_NAME ?? 'badminton_tracker_test')
      : (process.env.DB_NAME ?? 'badminton_tracker'),
  },
};
