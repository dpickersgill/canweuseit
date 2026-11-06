const env = process.env;

export const config = {
  port: Number(env.PORT || 8080),
  isProd: env.NODE_ENV === 'production',
  appUrl: env.APP_URL || 'http://localhost:8080',
  sessionSecret: env.SESSION_SECRET || (env.NODE_ENV === 'production' ? null : 'dev-only-secret-change-me'),
  postmarkToken: env.POSTMARK_TOKEN || null,
  mailFrom: env.MAIL_FROM || 'CanWeUseIt <no-reply@canweuseit.com>',
  mailReplyTo: env.MAIL_REPLY_TO || null,
  mailStream: env.POSTMARK_STREAM || 'outbound',
  stripeKey: env.STRIPE_SECRET_KEY || null,
  stripeWebhookSecrets: [env.STRIPE_WEBHOOK_SECRET, env.STRIPE_CONNECT_WEBHOOK_SECRET].filter(Boolean),
  stripeApiBase: env.STRIPE_API_BASE || 'https://api.stripe.com',
  twilio: { sid: env.TWILIO_ACCOUNT_SID || null, token: env.TWILIO_AUTH_TOKEN || null, from: env.TWILIO_FROM || null, messagingService: env.TWILIO_MESSAGING_SERVICE_SID || null, apiBase: env.TWILIO_API_BASE || 'https://api.twilio.com' },
  map: { tiles: env.MAP_TILE_URL || 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attribution: env.MAP_ATTRIBUTION || 'Imagery: Esri, Maxar, Earthstar Geographics' },
  legal: { entity: env.LEGAL_ENTITY || 'CanWeUseIt', contact: env.LEGAL_CONTACT || 'privacy@canweuseit.com', state: env.LEGAL_STATE || 'Pennsylvania' },
  db: {
    host: env.DB_HOST || '127.0.0.1', // on Cloud Run: /cloudsql/PROJECT:REGION:INSTANCE
    port: Number(env.DB_PORT || 5432),
    database: env.DB_NAME || 'canweuseit_staging',
    user: env.DB_USER || 'cwui_app',
    password: env.DB_PASSWORD,
  },
};

if (!config.sessionSecret) throw new Error('SESSION_SECRET is required in production');
