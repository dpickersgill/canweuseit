import { query, withTenant } from './db.js';
import { sendMail } from './mail.js';
import { config } from './config.js';
import { sendSms } from './sms.js';

// Records a notification for each person and emails them. Never throws: a mail problem must not undo a booking decision.
// items: [{ userId, kind, subject, text }]
export async function notify(tenantId, items) {
  try {
    const wanted = items.filter((i) => i.userId);
    if (!wanted.length) return;
    const { rows: users } = await query('select id, email, phone, sms_opt_in from app_user where id = any($1)', [[...new Set(wanted.map((i) => i.userId))]]);
    const email = new Map(users.map((u) => [u.id, u.email]));
    const phone = new Map(users.filter((u) => u.sms_opt_in && u.phone).map((u) => [u.id, u.phone]));
    for (const i of wanted) {
      let sent = false;
      try {
        await sendMail({ to: email.get(i.userId), subject: i.subject, text: `${i.text}\n\nOpen CanWeUseIt: ${config.appUrl}` });
        sent = true;
      } catch (err) { console.error('mail failed', err.message); }
      // urgent changes (closures, cancellations, a slot opening) also go by text to people who opted in
      if (i.sms && phone.has(i.userId)) { try { await sendSms(phone.get(i.userId), i.sms); } catch (err) { console.error('sms failed', err.message); } }
      await withTenant(tenantId, (c) => c.query(
        'insert into notification (tenant_id, user_id, kind, payload, sent_at) values ($1,$2,$3,$4, case when $5 then now() end)',
        [tenantId, i.userId, i.kind, JSON.stringify({ subject: i.subject, text: i.text }), sent]));
    }
  } catch (err) { console.error('notify failed', err.message); }
}

// Everyone who reviews requests in this tenant.
export async function staffIds(tenantId) {
  return withTenant(tenantId, async (c) =>
    (await c.query("select distinct user_id from role_assignment where role in ('tenant_admin','approver')")).rows.map((r) => r.user_id));
}
