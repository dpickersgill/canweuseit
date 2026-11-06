import { Router } from 'express';
import { query, withTenant } from './db.js';
import { issueLoginLink } from './auth.js';
import { requireUser, requireTenant, hasRole } from './tenant.js';

export const peopleRouter = Router();
peopleRouter.use(requireUser, requireTenant);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KINDS = ['club', 'school', 'league', 'other'];
const cleanName = (v) => (typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 120 ? v.trim() : null);
const isStaff = (req) => hasRole(req, 'tenant_admin', 'approver');
const isOrgAdminOf = (req, orgId) => req.roles.some((r) => r.role === 'org_admin' && r.organizationId === orgId);

// Find the user for an email or create one. Users are platform-level; one login can hold roles in many tenants.
export async function findOrCreateUser(email, fullName) {
  const found = await query('select id from app_user where lower(email) = $1', [email]);
  if (found.rows.length) return found.rows[0].id;
  return (await query('insert into app_user (email, full_name) values ($1, $2) returning id', [email, fullName])).rows[0].id;
}

// Give someone a role in this tenant and email them a sign-in link.
export async function addPerson(req, { email, fullName, role, organizationId, facilityId = null, quiet = false }) {
  const userId = await findOrCreateUser(email, fullName);
  await withTenant(req.tenantId, (c) => c.query(
    'insert into role_assignment (tenant_id, user_id, organization_id, role, facility_id) values ($1, $2, $3, $4, $5)',
    [req.tenantId, userId, organizationId, role, facilityId]));
  if (quiet) return userId;
  const { rows: [t] } = await withTenant(req.tenantId, (c) => c.query('select name from tenant where id = $1', [req.tenantId]));
  await issueLoginLink(email, {
    subject: `You've been added to ${t.name} on CanWeUseIt`,
    intro: `${t.name} added you to CanWeUseIt. Click to sign in (valid for 15 minutes, works once):`,
  });
  return userId;
}

const parsePerson = (body) => {
  const email = String(body?.email || '').trim().toLowerCase();
  const fullName = cleanName(body?.fullName);
  return EMAIL_RE.test(email) && email.length <= 254 && fullName ? { email, fullName } : null;
};

const handleDup = (res, next) => (err) => {
  if (err.code === '23505') return res.status(409).json({ error: 'That person already has that role here' });
  if (err.code === '23514') return res.status(400).json({ error: 'That role does not fit here' });
  if (err.code === '23503' || err.code === '22P02') return res.status(400).json({ error: 'Unknown site' });
  next(err);
};

// Organizations. Staff see all of them; everyone else sees only their own.
peopleRouter.get('/organizations', async (req, res, next) => {
  try {
    const mine = new Set(req.roles.map((r) => r.organizationId).filter(Boolean));
    const rows = await withTenant(req.tenantId, async (c) =>
      (await c.query('select id, name, kind, auto_approve as "autoApprove", tier from organization order by name')).rows);
    res.json({ organizations: isStaff(req) ? rows : rows.filter((o) => mine.has(o.id)) });
  } catch (err) { next(err); }
});

peopleRouter.post('/organizations', async (req, res, next) => {
  try {
    if (!hasRole(req, 'tenant_admin')) return res.status(403).json({ error: 'Only a tenant admin can add organizations' });
    const name = cleanName(req.body?.name);
    const kind = req.body?.kind || 'club';
    if (!name || !KINDS.includes(kind)) return res.status(400).json({ error: `name is required; kind must be one of ${KINDS.join(', ')}` });
    const row = await withTenant(req.tenantId, async (c) =>
      (await c.query('insert into organization (tenant_id, name, kind) values ($1, $2, $3) returning id, name, kind', [req.tenantId, name, kind])).rows[0]);
    res.status(201).json(row);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An organization with that name already exists' });
    next(err);
  }
});

// People in an organization. Staff and that organization's admins can see them.
peopleRouter.get('/organizations/:id/members', async (req, res, next) => {
  try {
    if (!isStaff(req) && !isOrgAdminOf(req, req.params.id)) return res.status(403).json({ error: 'Not allowed' });
    const rows = await withTenant(req.tenantId, async (c) =>
      (await c.query('select user_id, role from role_assignment where organization_id = $1', [req.params.id])).rows);
    const ids = rows.map((r) => r.user_id);
    const { rows: users } = ids.length ? await query('select id, email, full_name from app_user where id = any($1)', [ids]) : { rows: [] };
    const byId = new Map(users.map((u) => [u.id, u]));
    res.json({ members: rows.map((r) => ({ userId: r.user_id, role: r.role, email: byId.get(r.user_id)?.email, fullName: byId.get(r.user_id)?.full_name })) });
  } catch (err) {
    if (err.code === '22P02') return res.status(404).json({ error: 'Organization not found' });
    next(err);
  }
});

// Add a person to an organization. Tenant admins may add org_admin or booker; an org's own admin may add bookers.
peopleRouter.post('/organizations/:id/members', async (req, res, next) => {
  try {
    const person = parsePerson(req.body);
    const role = req.body?.role || 'booker';
    if (!person || !['org_admin', 'booker'].includes(role)) return res.status(400).json({ error: 'email, fullName and a role of org_admin or booker are required' });
    const allowed = hasRole(req, 'tenant_admin') || (role === 'booker' && isOrgAdminOf(req, req.params.id));
    if (!allowed) return res.status(403).json({ error: 'Not allowed' });
    const org = await withTenant(req.tenantId, async (c) => (await c.query('select id from organization where id = $1', [req.params.id])).rows[0]);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    await addPerson(req, { ...person, role, organizationId: org.id });
    res.status(201).json({ ok: true });
  } catch (err) {
    if (err.code === '22P02') return res.status(404).json({ error: 'Organization not found' });
    handleDup(res, next)(err);
  }
});

// Tenant staff (admins and approvers). Tenant admins only.
peopleRouter.post('/staff', async (req, res, next) => {
  try {
    if (!hasRole(req, 'tenant_admin')) return res.status(403).json({ error: 'Only a tenant admin can add staff' });
    const person = parsePerson(req.body);
    const role = req.body?.role;
    if (!person || !['tenant_admin', 'approver', 'grounds'].includes(role)) return res.status(400).json({ error: 'email, fullName and a role of tenant_admin, approver or grounds are required' });
    const facilityId = req.body?.facilityId || null;
    if (facilityId && role === 'tenant_admin') return res.status(400).json({ error: 'Admins cover every site' });
    if (role === 'grounds' && !facilityId) return res.status(400).json({ error: 'Choose the site a groundskeeper covers' });
    await addPerson(req, { ...person, role, organizationId: null, facilityId });
    res.status(201).json({ ok: true });
  } catch (err) { handleDup(res, next)(err); }
});

// Priority level (1-5, higher wins) for a person. Used later to order the approval queue.
peopleRouter.put('/priority', async (req, res, next) => {
  try {
    if (!hasRole(req, 'tenant_admin')) return res.status(403).json({ error: 'Only a tenant admin can set priority' });
    const email = String(req.body?.email || '').trim().toLowerCase();
    const level = req.body?.level;
    if (!Number.isInteger(level) || level < 1 || level > 5) return res.status(400).json({ error: 'level must be a whole number from 1 to 5' });
    const { rows } = await query('select id from app_user where lower(email) = $1', [email]);
    if (!rows.length) return res.status(404).json({ error: 'No such person' });
    const member = await withTenant(req.tenantId, async (c) =>
      (await c.query('select 1 from role_assignment where user_id = $1', [rows[0].id])).rowCount);
    if (!member) return res.status(404).json({ error: 'No such person in this tenant' });
    await withTenant(req.tenantId, (c) => c.query(
      `insert into user_priority (tenant_id, user_id, level) values ($1, $2, $3)
       on conflict (tenant_id, user_id) do update set level = excluded.level`, [req.tenantId, rows[0].id, level]));
    res.json({ ok: true });
  } catch (err) { next(err); }
});
