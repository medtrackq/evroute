-- EVROUTE usage statistics. Run once in Supabase: SQL Editor -> New query -> paste -> Run.
-- The server writes with the secret (service role) key. Row level security is on with no
-- policies, so the public (anon) key can neither read nor write these tables.

create table if not exists plans (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  plan_id text,
  car_id text, brand text, model text,
  battery_kwh numeric, use_factory numeric, use_set numeric, dc_kw numeric, tuned boolean,
  start_soc numeric, min_soc numeric, target_soc numeric,
  from_lat numeric, from_lng numeric, to_lat numeric, to_lng numeric,
  dests int, round_trip boolean,
  km numeric, drive_min numeric, charge_min numeric, stops int, kwh numeric, cost numeric,
  arrive_soc numeric, ok boolean, google_added int,
  stations jsonb not null default '[]'
);

create table if not exists events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  plan_id text, kind text not null, station_id text, op text, car_id text
);

create table if not exists charges (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  plan_id text, station_id text not null, station_name text, op text, src text,
  station_lat numeric, station_lng numeric, planned_kw numeric, guess boolean,
  car_id text, battery_kwh numeric,
  ok boolean not null, problem text,
  soc_from numeric, soc_to numeric, kwh numeric, baht numeric, minutes numeric, max_kw numeric,
  odometer int, note text
);

alter table plans enable row level security;
alter table events enable row level security;
alter table charges enable row level security;

create index if not exists plans_created on plans (created_at);
create index if not exists plans_car on plans (car_id);
create index if not exists events_kind on events (kind, created_at);
create index if not exists charges_station on charges (station_id);

-- Handy views for a first look (Table Editor shows them too). security_invoker keeps them behind the
-- tables' row level security, and the revoke below keeps them off the public REST API.

-- Which cars people plan with, and how far their own consumption is from the factory figure.
create or replace view car_usage with (security_invoker = true) as
select brand, model, count(*) as plans,
       round(avg(use_factory), 1) as factory_kwh_100km,
       round(avg(use_set) filter (where tuned), 1) as owner_kwh_100km,
       count(*) filter (where tuned) as tuned_plans
from plans group by brand, model order by plans desc;

-- Taps on "open the operator's app", per operator: the number to show a charging network.
create or replace view app_opens with (security_invoker = true) as
select op, count(*) as opens, count(distinct plan_id) as plans
from events where kind = 'app' group by op order by opens desc;

-- What drivers reported after charging, per station.
create or replace view station_reports with (security_invoker = true) as
select station_id, max(station_name) as name, max(op) as op, count(*) as reports,
       count(*) filter (where ok) as worked,
       round(avg(max_kw) filter (where ok), 0) as avg_max_kw,
       round(avg(baht / nullif(kwh, 0)) filter (where ok), 2) as baht_per_kwh,
       mode() within group (order by problem) filter (where not ok) as common_problem
from charges group by station_id order by reports desc;

revoke all on plans, events, charges, car_usage, app_opens, station_reports from anon, authenticated;
