// A club's field schedule as a file its own app can import: TeamSnap, SportsEngine or LeagueApps.
// None of the three can subscribe to an outside calendar, so a CSV import is the way in.
import { Router } from 'express';
import { withTenant } from './db.js';
import { requireUser, requireTenant, hasRole } from './tenant.js';
import { isDate, localToUtc } from './time.js';
import { toCsv } from './admin.js';
import { clubEvents } from './schedulelib.js';

export const exportsRouter = Router();
const authed = Router();
authed.use(requireUser, requireTenant);

const parts = (d, tz) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  .formatToParts(new Date(d)).map((x) => [x.type, x.value]));
const mdy = (p) => `${p.month}/${p.day}/${p.year}`;
const h24 = (p) => `${p.hour}:${p.minute}`;
const h12 = (p) => { const h = Number(p.hour); return `${h % 12 || 12}:${p.minute} ${h < 12 ? 'AM' : 'PM'}`; };
const dur = (a, b) => { const m = Math.round((new Date(b) - new Date(a)) / 60000); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

const SE_HEAD = ['Start_Date', 'Start_Time', 'End_Date', 'End_Time', 'Title', 'Description', 'Location', 'Location_URL', 'All_Day_Event', 'Event_Type', 'Tags',
  'Team1_ID', 'Team1_Division_ID', 'Team1_Is_Home', 'Team2_ID', 'Team2_Division_ID', 'Team2_Name', 'Custom_Opponent', 'Event_ID', 'Game_ID',
  'Affects_Standings', 'Points_Win', 'Points_Loss', 'Points_Tie', 'Points_OT_Win', 'Points_OT_Loss', 'Division_Override'];
const LA_HEAD = ['SUB_PROGRAM', 'NAME', 'TYPE', 'START_DATE', 'END_DATE', 'START_TIME', 'END_TIME', 'TEAM', 'LOCATION', 'SUB_LOCATION', 'LOCATION_NOTE', 'DESCRIPTION'];
const TS_HEAD = ['Date', 'Time', 'Name', 'Location Name', 'Location Details', 'Duration (HH:MM)', 'Arrival Time (Minutes)', 'Notes'];

export const FORMATS = {
  // TeamSnap team import: first row is headings that you match to TeamSnap fields; no opponent = practice.
  teamsnap: { head: TS_HEAD, row: (e, s, t) => ({ Date: mdy(s), Time: h12(s), Name: e.team ? `${e.team} practice` : e.title, 'Location Name': e.facility, 'Location Details': e.space,
    'Duration (HH:MM)': dur(e.startsAt, e.endsAt), 'Arrival Time (Minutes)': '', Notes: e.title }) },
  // SportsEngine Schedule Upload: regular events (Event_Type blank). Every column kept, as the upload expects.
  sportsengine: { head: SE_HEAD, row: (e, s, t) => ({ Start_Date: mdy(s), Start_Time: h24(s), End_Date: mdy(t), End_Time: h24(t),
    Title: (e.team ? `${e.team} practice` : e.title).slice(0, 255), Description: `${e.title} (${e.space}, ${e.facility})`.slice(0, 400), Location: `${e.facility}, ${e.space}`.slice(0, 255), All_Day_Event: '0' }) },
  // LeagueApps events template: TYPE Practice; teams and locations are matched after upload.
  leagueapps: { head: LA_HEAD, row: (e, s, t) => ({ NAME: e.team ? `${e.team} practice` : e.title, TYPE: 'Practice', START_DATE: mdy(s), END_DATE: mdy(t),
    START_TIME: h24(s), END_TIME: h24(t), TEAM: e.team || '', LOCATION: e.facility, SUB_LOCATION: e.space, DESCRIPTION: e.title }) },
};

authed.get('/export/club-schedule.csv', async (req, res, next) => {
  try {
    const { organizationId, teamId, format = 'teamsnap', from, to } = req.query;
    const f = FORMATS[format];
    if (!f) return res.status(400).json({ error: 'format must be teamsnap, sportsengine or leagueapps' });
    if ((from && !isDate(from)) || (to && !isDate(to))) return res.status(400).json({ error: 'Dates look like 2027-09-01' });
    const out = await withTenant(req.tenantId, async (c) => {
      const t = (await c.query('select timezone from tenant where id = $1', [req.tenantId])).rows[0];
      let org = organizationId;
      if (teamId) org = (await c.query('select organization_id from team where id = $1', [teamId])).rows[0]?.organization_id;
      if (!org) return { status: 400, body: { error: 'Choose a group or a team' } };
      if (!hasRole(req, 'tenant_admin', 'approver') && !req.roles.some((r) => r.organizationId === org)) return { status: 403, body: { error: 'Not your group' } };
      const start = from ? localToUtc(from, '00:00', t.timezone) : new Date();
      const end = to ? localToUtc(to, '23:59', t.timezone) : new Date(Date.now() + 366 * 86400000);
      const events = await clubEvents(c, { organizationId: org, teamId: teamId || null, from: start, to: end });
      return { status: 200, rows: events.map((e) => f.row(e, parts(e.startsAt, t.timezone), parts(e.endsAt, t.timezone))) };
    });
    if (out.status !== 200) return res.status(out.status).json(out.body);
    res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="schedule-${format}.csv"`).send(toCsv(f.head, out.rows));
  } catch (err) { if (err.code === '22P02') return res.status(400).json({ error: 'Unknown group or team' }); next(err); }
});

exportsRouter.use(authed);
