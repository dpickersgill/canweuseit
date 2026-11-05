import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({ ...config.db, max: 10 });

// Run fn inside a transaction scoped to one tenant. Row-level security keys off app.tenant_id,
// and set_config(..., true) makes it local to this transaction, so it can never leak to the next request.
export async function withTenant(tenantId, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// For platform-level tables (app_user, login_token) and sign-in lookups. No tenant set,
// so tenant-scoped tables return nothing from here.
export function query(text, params) {
  return pool.query(text, params);
}
