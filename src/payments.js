// Online payments through Stripe Connect. Each governing group connects its own Stripe account (Express);
// groups pay invoices by card through Stripe Checkout; money goes to the governing group, less the platform fee.
import crypto from 'node:crypto';
import { Router } from 'express';
import { query, withTenant } from './db.js';
import { config } from './config.js';
import { requireUser, requireTenant, hasRole } from './tenant.js';
import { notify, staffIds } from './notify.js';

export const paymentsRouter = Router();
export const paymentsPublic = Router();
const err = (http, message) => Object.assign(new Error(message), { http });
const isStaff = (req) => hasRole(req, 'tenant_admin', 'approver');
const bad = (e) => e.code === '22P02';

// Stripe takes form encoding with brackets for nesting: a[b]=1, items[0][x]=2.
function flatten(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') flatten(v, key, out); else out.push([key, String(v)]);
  }
  return out;
}

export async function stripe(method, path, params, { idempotencyKey } = {}) {
  if (!config.stripeKey) throw err(503, 'Online payments are not switched on for this server yet');
  const body = params ? new URLSearchParams(flatten(params)).toString() : '';
  const res = await fetch(`${config.stripeApiBase}/v1/${path}${method === 'GET' && body ? `?${body}` : ''}`, {
    method,
    headers: { Authorization: `Bearer ${config.stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
    body: method === 'GET' ? undefined : body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { console.error('stripe', res.status, data?.error?.message); throw err(502, `The payment provider said: ${data?.error?.message || res.status}`); }
  return data;
}

const send = (res, e, next) => (e.http ? res.status(e.http).json({ error: e.message }) : bad(e) ? res.status(404).json({ error: 'Not found' }) : next(e));
const requireAdmin = (req, res, next) => (hasRole(req, 'tenant_admin') ? next() : res.status(403).json({ error: 'Only a tenant admin can do this' }));

// ---------------------------------------------------------------- connect the governing group's Stripe account
const authed = Router();
authed.use(requireUser, requireTenant);

authed.get('/payments/status', requireAdmin, async (req, res, next) => {
  try {
    let t = await withTenant(req.tenantId, async (c) => (await c.query(
      'select t.stripe_account_id, t.payments_ready, t.deposit_cents, t.platform_fee_bps, p.online_payments, p.name as plan from tenant t join plan p on p.code = t.plan_code where t.id = $1', [req.tenantId])).rows[0]);
    if (t.stripe_account_id && !t.payments_ready && config.stripeKey) {
      const a = await stripe('GET', `accounts/${encodeURIComponent(t.stripe_account_id)}`);
      const ready = !!(a.charges_enabled && a.details_submitted);
      if (ready) { await withTenant(req.tenantId, (c) => c.query('update tenant set payments_ready = true where id = $1', [req.tenantId])); t = { ...t, payments_ready: true }; }
    }
    res.json({ serverReady: !!config.stripeKey, planAllows: t.online_payments, plan: t.plan, connected: !!t.stripe_account_id, ready: t.payments_ready, depositCents: t.deposit_cents, platformFeePercent: t.platform_fee_bps / 100 });
  } catch (e) { send(res, e, next); }
});

authed.post('/payments/connect', requireAdmin, async (req, res, next) => {
  try {
    const t = await withTenant(req.tenantId, async (c) => (await c.query(
      'select t.id, t.name, t.stripe_account_id, p.online_payments from tenant t join plan p on p.code = t.plan_code where t.id = $1', [req.tenantId])).rows[0]);
    if (!t.online_payments) throw err(402, 'Online payments come with the Standard and Pro plans');
    let account = t.stripe_account_id;
    if (!account) {
      const me = (await query('select email from app_user where id = $1', [req.userId])).rows[0];
      const a = await stripe('POST', 'accounts', { type: 'express', country: 'US', email: me.email, business_profile: { name: t.name },
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } }, metadata: { tenant_id: t.id } }, { idempotencyKey: `acct-${t.id}` });
      account = a.id;
      await withTenant(req.tenantId, (c) => c.query('update tenant set stripe_account_id = $2 where id = $1 and stripe_account_id is null', [req.tenantId, account]));
    }
    const link = await stripe('POST', 'account_links', { account, type: 'account_onboarding',
      refresh_url: `${config.appUrl}/#setup`, return_url: `${config.appUrl}/?stripe=done#setup` });
    res.json({ url: link.url });
  } catch (e) { send(res, e, next); }
});

// ---------------------------------------------------------------- pay an invoice by card
authed.post('/invoices/:id/checkout', async (req, res, next) => {
  try {
    const out = await withTenant(req.tenantId, async (c) => {
      const i = (await c.query(
        `select i.id, i.number, i.amount_cents, i.status, i.organization_id, t.name as tenant, t.stripe_account_id, t.payments_ready, t.platform_fee_bps, p.online_payments
           from invoice i join tenant t on t.id = i.tenant_id join plan p on p.code = t.plan_code where i.id = $1`, [req.params.id])).rows[0];
      if (!i) throw err(404, 'Invoice not found');
      const mine = req.roles.some((r) => r.organizationId === i.organization_id);
      if (!mine && !isStaff(req)) throw err(403, 'Only the group that owes this invoice can pay it');
      if (i.status !== 'open') throw err(409, `This invoice is ${i.status}`);
      if (!i.online_payments || !i.payments_ready) throw err(409, 'Card payments are not set up for this group yet');
      if (i.amount_cents < 50) throw err(400, 'Card payments must be at least $0.50');
      return i;
    });
    const me = (await query('select email from app_user where id = $1', [req.userId])).rows[0];
    const s = await stripe('POST', 'checkout/sessions', {
      mode: 'payment', client_reference_id: out.id, customer_email: me.email,
      line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: out.amount_cents, product_data: { name: `${out.tenant}: invoice ${out.number}` } } }],
      payment_intent_data: { application_fee_amount: Math.floor(out.amount_cents * out.platform_fee_bps / 10000), transfer_data: { destination: out.stripe_account_id }, metadata: { invoice_id: out.id } },
      metadata: { invoice_id: out.id, tenant_id: req.tenantId },
      success_url: `${config.appUrl}/?paid=1#billing`, cancel_url: `${config.appUrl}/#billing`,
    });
    await withTenant(req.tenantId, (c) => c.query('update invoice set checkout_id = $2 where id = $1', [out.id, s.id]));
    res.json({ url: s.url });
  } catch (e) { send(res, e, next); }
});

// ---------------------------------------------------------------- refunds (deposits back, overpayments, cancellations)
authed.post('/invoices/:id/refund', async (req, res, next) => {
  try {
    if (!isStaff(req)) throw err(403, 'Only staff can refund');
    const out = await withTenant(req.tenantId, async (c) => {
      const i = (await c.query('select id, number, amount_cents, refunded_cents, status, paid_method, payment_intent, organization_id from invoice where id = $1 for update', [req.params.id])).rows[0];
      if (!i) throw err(404, 'Invoice not found');
      if (i.status !== 'paid') throw err(409, 'Only paid invoices can be refunded');
      const left = i.amount_cents - i.refunded_cents;
      const amount = req.body?.amountCents === undefined ? left : req.body.amountCents;
      if (!Number.isInteger(amount) || amount < 1 || amount > left) throw err(400, `Refund between $0.01 and $${(left / 100).toFixed(2)}`);
      let ref = null;
      if (i.paid_method === 'card' && i.payment_intent) {
        const r = await stripe('POST', 'refunds', { payment_intent: i.payment_intent, amount, reverse_transfer: true, refund_application_fee: true },
          { idempotencyKey: `refund-${i.id}-${i.refunded_cents}-${amount}` });
        ref = r.id;
      }
      const total = i.refunded_cents + amount;
      await c.query('update invoice set refunded_cents = $2, status = case when $2 >= amount_cents then \'refunded\' else status end where id = $1', [i.id, total]);
      await c.query("insert into audit_log (tenant_id, actor_id, action, entity, entity_id, detail) values ($1,$2,'invoice.refund','invoice',$3,$4)",
        [req.tenantId, req.userId, i.id, JSON.stringify({ amount, ref, note: req.body?.note ? String(req.body.note).slice(0, 200) : null })]);
      const managers = (await c.query("select user_id from role_assignment where organization_id = $1 and role = 'org_admin'", [i.organization_id])).rows.map((r) => r.user_id);
      return { i, amount, total, ref, managers };
    });
    notify(req.tenantId, out.managers.map((userId) => ({ userId, kind: 'invoice.refund', subject: `Refund on invoice ${out.i.number}`,
      text: `$${(out.amount / 100).toFixed(2)} has been refunded on invoice ${out.i.number}.${out.ref ? ' Card refunds take 5 to 10 business days to appear.' : ''}` })));
    res.json({ ok: true, refundedCents: out.total, card: !!out.ref });
  } catch (e) { send(res, e, next); }
});

paymentsRouter.use(authed);

// ---------------------------------------------------------------- Stripe webhook (no session; signature checked)
export function verifyStripe(raw, header, secrets, now = Date.now()) {
  if (!raw || !header || !secrets.length) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k, v]));
  const t = Number(header.split(',').find((p) => p.startsWith('t='))?.slice(2));
  const sigs = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!t || !sigs.length || Math.abs(now / 1000 - t) > 300) return false;
  void parts;
  return secrets.some((s) => {
    const want = Buffer.from(crypto.createHmac('sha256', s).update(`${t}.${raw}`).digest('hex'));
    return sigs.some((g) => g.length === want.length && crypto.timingSafeEqual(Buffer.from(g), want));
  });
}

paymentsPublic.post('/stripe/webhook', async (req, res, next) => {
  try {
    if (!verifyStripe(req.rawBody?.toString('utf8'), req.headers['stripe-signature'], config.stripeWebhookSecrets)) return res.status(400).json({ error: 'Bad signature' });
    const ev = JSON.parse(req.rawBody.toString('utf8'));
    const o = ev.data?.object || {};
    if ((ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') && o.payment_status === 'paid' && o.metadata?.invoice_id) {
      const { rows: [r] } = await query('select invoice_paid_online($1, $2, $3, $4) as tenant', [o.metadata.invoice_id, o.id, o.payment_intent, o.amount_total]);
      if (r?.tenant) {
        const inv = await withTenant(r.tenant, async (c) => {
          await c.query("insert into audit_log (tenant_id, actor_id, action, entity, entity_id, detail) values ($1, null, 'invoice.paid','invoice',$2,$3)",
            [r.tenant, o.metadata.invoice_id, JSON.stringify({ method: 'card', ref: o.payment_intent })]);
          return (await c.query('select i.number, o.name from invoice i join organization o on o.id = i.organization_id where i.id = $1', [o.metadata.invoice_id])).rows[0];
        });
        const staff = await staffIds(r.tenant);
        notify(r.tenant, staff.map((userId) => ({ userId, kind: 'invoice.paid', subject: `Paid: invoice ${inv.number}`, text: `${inv.name} paid invoice ${inv.number} by card.` })));
      }
    } else if (ev.type === 'account.updated' && o.id) {
      await query('select tenant_payments_ready($1, $2)', [o.id, !!(o.charges_enabled && o.details_submitted)]);
    }
    res.json({ received: true });
  } catch (e) { next(e); }
});
