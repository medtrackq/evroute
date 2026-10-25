-- EVROUTE usage statistics. Run in Supabase: SQL Editor -> New query -> paste -> Run.
-- Safe to run again after an update: it only adds what is missing.
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

-- Random per-car id (added later; the alters bring an existing database up to date).
alter table plans add column if not exists car_uid text;
alter table events add column if not exists car_uid text;
alter table charges add column if not exists car_uid text;
alter table charges add column if not exists plug text; -- socket the driver used (CCS2, CHAdeMO, GBT, Type2, Tesla)
create index if not exists plans_uid on plans (car_uid);
create index if not exists charges_uid on charges (car_uid, created_at);

-- Real consumption per model from drivers' charging reports: between two reports from the same car,
-- the odometer gives the distance and the battery drop (after the first charge -> before the next,
-- times battery size) gives the energy. Segments with an unreported charge in between, or odd
-- numbers, are left out.
create or replace view car_consumption with (security_invoker = true) as
with seg as (
  select car_id, car_uid,
         odometer - lag(odometer) over w as km,
         (lag(soc_to) over w - soc_from) / 100.0 * battery_kwh as kwh_used
  from charges
  where ok and car_uid is not null and odometer is not null and soc_from is not null and soc_to is not null and battery_kwh is not null
  window w as (partition by car_uid order by created_at)
)
select car_id, count(distinct car_uid) as cars, count(*) as segments, round(sum(km)) as km,
       round(sum(kwh_used) / sum(km) * 100, 1) as real_kwh_100km
from seg
where km between 20 and 800 and kwh_used > 0 and kwh_used / km * 100 between 8 and 40
group by car_id order by segments desc;

-- How often each car comes back.
create or replace view car_returns with (security_invoker = true) as
select car_id, count(distinct car_uid) as cars, count(*) as plans,
       round(count(*)::numeric / nullif(count(distinct car_uid), 0), 1) as plans_per_car,
       count(distinct car_uid) filter (where n > 1) as cars_back
from (select car_id, car_uid, count(*) over (partition by car_uid) as n from plans where car_uid is not null) p
group by car_id order by cars desc;

-- Optional accounts (sign in with an emailed code). A user's saved trips, and their own charging
-- reports linked to them. Deleting the user deletes their trips and unlinks their reports, which
-- stay as anonymous station data.
create table if not exists trips (
  user_id uuid not null references auth.users (id) on delete cascade,
  q text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, q)
);
alter table trips enable row level security;
alter table charges add column if not exists user_id uuid references auth.users (id) on delete set null;
create index if not exists charges_user on charges (user_id, created_at);
alter table events add column if not exists ctx text; -- where a sign-up prompt was shown or used

-- Sign-up prompts: how often each was shown, tapped, and led to signing in.
create or replace view signup_funnel with (security_invoker = true) as
select ctx, count(*) filter (where kind = 'nudge') as shown, count(*) filter (where kind = 'nudge_go') as tapped,
       count(*) filter (where kind = 'signin') as signed_in, count(*) filter (where kind = 'premium') as premium_interest
from events where kind in ('nudge', 'nudge_go', 'signin', 'premium') group by ctx order by shown desc;

-- The admin page (admin.html): one "open" event a day per browser (a random id, dev) for counting
-- people, the language they use, what broke, and messages sent from the contact form.
alter table events add column if not exists dev text;
alter table events add column if not exists lang text;
create index if not exists events_dev on events (kind, created_at, dev);
alter table events add column if not exists ref text; -- "arrive": where a visitor came from (?ref=tiktok, facebook, line...)

create table if not exists errors (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  src text not null,            -- web (the page) or server
  msg text not null, at text,   -- message, and file:line or the server part that failed
  page text, lang text, ua text, dev text
);
alter table errors enable row level security;
create index if not exists errors_created on errors (created_at);

create table if not exists feedback (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  kind text not null,           -- bug, station, idea, other
  message text not null, email text,
  page text, lang text, car_id text, plan_id text, ua text, dev text,
  user_id uuid references auth.users (id) on delete set null,
  status text not null default 'new'
);
alter table feedback enable row level security;
create index if not exists feedback_created on feedback (created_at);

-- Car models added or corrected on the admin page, on top of assets/js/cars.js (the same id
-- replaces a listed model; hidden takes it off the list).
create table if not exists cars (
  id text primary key,
  brand text not null, model text not null,
  kwh numeric, use numeric, dc numeric, ac numeric,
  plugs jsonb not null default '["CCS2"]',
  hidden boolean not null default false,
  note text,
  updated_at timestamptz not null default now()
);
alter table cars enable row level security;

-- The monthly sweep of Google Places for PTT EV Station PluZ (lib/sweep.mjs). Google's terms allow
-- keeping place ids, and positions for at most 30 days: the server deletes older rows.
create table if not exists sweeps (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running', -- running, done, capped, failed
  cells int, cursor int not null default 0, calls int not null default 0, found int not null default 0,
  note text
);
create table if not exists swept_places (
  place_id text primary key,
  lat numeric not null, lng numeric not null,
  op text,
  fetched_at timestamptz not null default now()
);
alter table sweeps enable row level security;
alter table swept_places enable row level security;

-- Places to see on the way added or changed on the admin page, on top of data/trip-places.json
-- (the same id replaces a bundled place; hidden takes it off the list). lib/places.mjs checks rows.
create table if not exists trip_places (
  id text primary key,
  name text not null, name_en text,
  cat jsonb not null default '[]',
  lat numeric, lng numeric,
  prov text, area text,
  visit int,
  note text, promo text, link text,
  months jsonb,
  partner boolean not null default false,
  checked boolean not null default true,
  hidden boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table trip_places enable row level security;

-- Switches set on the admin page, e.g. key 'floods' = {"on": false} turns route-around-floods off.
create table if not exists settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table settings enable row level security;

revoke all on plans, events, charges, trips, car_usage, app_opens, station_reports, car_consumption, car_returns, signup_funnel, errors, feedback, cars, sweeps, swept_places, settings, trip_places from anon, authenticated;
