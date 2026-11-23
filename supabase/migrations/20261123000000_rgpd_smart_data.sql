-- =====================================================================
-- NEO-SUSU — RGPD & Smart Data (phase 1 du calendrier) · 23/11/2026
-- Tables : consents, events, data_requests, score_neo
-- Toutes protégées par RLS : chaque membre ne voit que ses lignes.
-- Le back-office lit via la clé service_role (jamais côté navigateur).
-- À appliquer d'abord sur une branche Supabase de test.
-- =====================================================================

-- 1. Preuve des consentements (historique, jamais écrasé)
create table if not exists public.consents (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references auth.users(id) on delete cascade,
  purpose        text not null check (purpose in ('essential','analytics','voice_ai','marketing','open_banking')),
  granted        boolean not null,
  policy_version text not null,
  source         text,
  created_at     timestamptz not null default now()
);
create index if not exists consents_user_idx on public.consents (user_id, purpose, created_at desc);

-- Dernier choix par finalité
create or replace view public.consents_current
with (security_invoker = true) as
select distinct on (user_id, purpose) user_id, purpose, granted, policy_version, created_at
from public.consents
order by user_id, purpose, created_at desc;

-- 2. Journal d'événements (smart data). Aucune donnée d'identité dans props.
create table if not exists public.events (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null,
  category   text not null check (category in ('contract','analytics')),
  props      jsonb not null default '{}'::jsonb,
  lang       text,
  created_at timestamptz not null default now()
);
create index if not exists events_user_idx on public.events (user_id, created_at desc);
create index if not exists events_name_idx on public.events (name, created_at desc);

-- 3. Demandes d'exercice des droits (délai légal : 1 mois)
create table if not exists public.data_requests (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  type        text not null check (type in ('access','export','rectification','erasure','objection','score_review')),
  message     text,
  status      text not null default 'received' check (status in ('received','in_progress','done','rejected')),
  due_at      timestamptz not null default (now() + interval '1 month'),
  answered_at timestamptz,
  created_at  timestamptz not null default now()
);

-- 4. Historique du Score NEO (versionné, explicable)
create table if not exists public.score_neo (
  id                    bigint generated always as identity primary key,
  user_id               uuid not null references auth.users(id) on delete cascade,
  score                 smallint not null check (score between 0 and 100),
  tier                  text not null,
  model_version         text not null,
  stats                 jsonb not null,   -- entrées du calcul (sans pays, langue ni origine)
  details               jsonb not null,   -- points par critère, montrés au membre
  human_review_required boolean not null default false,
  reviewed_by           uuid,
  reviewed_at           timestamptz,
  computed_at           timestamptz not null default now()
);
create index if not exists score_neo_user_idx on public.score_neo (user_id, computed_at desc);

-- Garde-fou : refuser tout critère interdit dans les entrées du score
alter table public.score_neo drop constraint if exists score_neo_no_forbidden_inputs;
alter table public.score_neo add constraint score_neo_no_forbidden_inputs
  check (not (stats ?| array['country','pays','nationality','nationalite','language','langue','origin','origine','religion']));

-- ---------------- RLS ----------------
alter table public.consents      enable row level security;
alter table public.events        enable row level security;
alter table public.data_requests enable row level security;
alter table public.score_neo     enable row level security;

drop policy if exists "consents: lire les siens"  on public.consents;
drop policy if exists "consents: ajouter les siens" on public.consents;
create policy "consents: lire les siens"   on public.consents for select to authenticated using ((select auth.uid()) = user_id);
create policy "consents: ajouter les siens" on public.consents for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists "events: lire les siens"  on public.events;
drop policy if exists "events: ajouter les siens" on public.events;
create policy "events: lire les siens"   on public.events for select to authenticated using ((select auth.uid()) = user_id);
create policy "events: ajouter les siens" on public.events for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists "data_requests: lire les siennes"  on public.data_requests;
drop policy if exists "data_requests: créer les siennes" on public.data_requests;
create policy "data_requests: lire les siennes"  on public.data_requests for select to authenticated using ((select auth.uid()) = user_id);
create policy "data_requests: créer les siennes" on public.data_requests for insert to authenticated with check ((select auth.uid()) = user_id);

-- Le score est calculé côté serveur (service_role) : le membre peut seulement le lire.
drop policy if exists "score_neo: lire le sien" on public.score_neo;
create policy "score_neo: lire le sien" on public.score_neo for select to authenticated using ((select auth.uid()) = user_id);

-- ---------------- Durées de conservation ----------------
-- Purge des événements d'analytique après 13 mois (à planifier avec pg_cron) :
--   select cron.schedule('purge-analytics', '0 3 * * *',
--     $$delete from public.events where category = 'analytics' and created_at < now() - interval '13 months'$$);
-- Purge des anciennes versions du score après 12 mois (on garde la dernière) :
--   select cron.schedule('purge-old-scores', '15 3 * * *',
--     $$delete from public.score_neo s where computed_at < now() - interval '12 months'
--       and exists (select 1 from public.score_neo n where n.user_id = s.user_id and n.computed_at > s.computed_at)$$);

-- ---------------- Indicateurs (pilotage phase 2) ----------------
-- Vue réservée au back-office (pas d'accès authenticated).
create or replace view public.kpi_monthly
with (security_invoker = true) as
select date_trunc('month', created_at) as month,
       count(*) filter (where name = 'contribution_paid')                                         as contributions_paid,
       count(*) filter (where name = 'contribution_paid' and coalesce((props->>'days_late')::int,0) = 0) as contributions_on_time,
       count(*) filter (where name = 'contribution_late')                                         as contributions_late,
       count(*) filter (where name = 'circle_completed')                                          as circles_completed,
       count(distinct user_id) filter (where name = 'signup')                                     as signups
from public.events
group by 1;
revoke all on public.kpi_monthly from anon, authenticated;
