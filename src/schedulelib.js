// What a club (or one of its teams) has on the field: team times placed inside approved dates,
// plus approved dates with no team plan (named by their team label, if any). Call inside withTenant.
export async function clubEvents(c, { organizationId, teamId = null, from, to, limit = 5000 }) {
  const team = teamId ? (await c.query('select id, name, organization_id from team where id = $1', [teamId])).rows[0] : null;
  if (teamId && !team) return [];
  const org = team ? team.organization_id : organizationId;
  return (await c.query(
    `select * from (
       select ts.id, ts.starts_at as "startsAt", ts.ends_at as "endsAt", tm.name as team, s.name as space, f.name as facility, o.name as organization, r.title
         from team_slot ts join booking_date bd on bd.id = ts.booking_date_id join team tm on tm.id = ts.team_id
         join request r on r.id = bd.request_id join organization o on o.id = r.organization_id
         join space s on s.id = ts.space_id join facility f on f.id = s.facility_id
        where bd.status = 'confirmed' and r.organization_id = $1 and ($2::uuid is null or ts.team_id = $2)
       union all
       select bd.id, bd.starts_at, bd.ends_at, bd.label, s.name, f.name, o.name, r.title
         from booking_date bd join request r on r.id = bd.request_id join organization o on o.id = r.organization_id
         join space s on s.id = bd.space_id join facility f on f.id = s.facility_id
        where bd.status = 'confirmed' and r.organization_id = $1
          and not exists (select 1 from team_slot x where x.booking_date_id = bd.id)
          and ($2::uuid is null or lower(coalesce(bd.label, '')) = lower($3))
     ) e where "endsAt" > $4 and "startsAt" < $5 order by "startsAt", space limit $6`,
    [org, team?.id || null, team?.name || '', from, to, limit])).rows;
}
