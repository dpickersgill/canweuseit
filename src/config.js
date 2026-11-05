const env = process.env;

export const config = {
  port: Number(env.PORT || 8080),
  isProd: env.NODE_ENV === 'production',
  appUrl: env.APP_URL || 'http://localhost:8080',
  sessionSecret: env.SESSION_SECRET || (env.NODE_ENV === 'production' ? null : 'dev-only-secret-change-me'),
  postmarkToken: env.POSTMARK_TOKEN || null,
  mailFrom: env.MAIL_FROM || 'CanWeUseIt <no-reply@canweuseit.com>',
  db: {
    host: env.DB_HOST || '127.0.0.1', // on Cloud Run: /cloudsql/PROJECT:REGION:INSTANCE
    port: Number(env.DB_PORT || 5432),
    database: env.DB_NAME || 'canweuseit_staging',
    user: env.DB_USER || 'cwui_app',
    password: env.DB_PASSWORD,
  },
};

if (!config.sessionSecret) throw new Error('SESSION_SECRET is required in production');
