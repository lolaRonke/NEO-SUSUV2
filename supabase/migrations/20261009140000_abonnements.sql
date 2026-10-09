-- Abonnements NEO-SUSU : plans, abonnements Stripe, limites et commission par plan.
-- L'abonnement est porte par l'ORGANISATEUR de la tontine (owner_id). Les membres qui
-- rejoignent une tontine n'ont jamais besoin d'abonnement.

-- ── Catalogue des plans (source unique des prix, limites et commissions)
create table if not exists public.plans (
  id                  text primary key,
  name                text not null,
  price_month_cents   integer not null check (price_month_cents >= 0),
  price_year_cents    integer not null check (price_year_cents >= 0),
  fee_bps             integer not null check (fee_bps between 0 and 1000), -- 150 = 1,5 %
  max_active_tontines integer check (max_active_tontines > 0),             -- null = illimite
  max_members         integer not null check (max_members >= 2),
  sort                integer not null default 0
);

insert into public.plans (id, name, price_month_cents, price_year_cents, fee_bps, max_active_tontines, max_members, sort) values
  ('free',      'Gratuit',   0,    0,     150, 1,    10, 0),
  ('essentiel', 'Essentiel', 499,  4990,  50,  3,    20, 1),
  ('pro',       'Pro',       1499, 14990, 0,   null, 50, 2)
on conflict (id) do update set
  name = excluded.name, price_month_cents = excluded.price_month_cents,
  price_year_cents = excluded.price_year_cents, fee_bps = excluded.fee_bps,
  max_active_tontines = excluded.max_active_tontines, max_members = excluded.max_members,
  sort = excluded.sort;

-- ── Client et abonnement Stripe de chaque utilisateur (ecrits uniquement par les Edge Functions)
create table if not exists public.billing_customers (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text not null unique,
  created_at         timestamptz not null default now()
);

create table if not exists public.subscriptions (
  user_id                uuid primary key references auth.users(id) on delete cascade,
  plan_id                text not null references public.plans(id),
  billing_period         text not null check (billing_period in ('month', 'year')),
  status                 text not null,          -- statut Stripe : active, trialing, past_due, canceled...
  stripe_subscription_id text not null unique,
  current_period_end     timestamptz not null,
  cancel_at_period_end   boolean not null default false,
  updated_at             timestamptz not null default now()
);

alter table public.plans             enable row level security;
alter table public.billing_customers enable row level security;
alter table public.subscriptions     enable row level security;

drop policy if exists "plans are public" on public.plans;
create policy "plans are public" on public.plans for select using (true);

drop policy if exists "own subscription" on public.subscriptions;
create policy "own subscription" on public.subscriptions for select using (user_id = auth.uid());

-- ── Plan en vigueur : abonnement payant valide, sinon Gratuit.
-- past_due reste valide jusqu'a la fin de la periode payee (Stripe relance le paiement).
create or replace function public.effective_plan(p_user uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(
    (select s.plan_id from subscriptions s
      where s.user_id = p_user
        and s.status in ('active', 'trialing', 'past_due')
        and s.current_period_end > now()),
    'free');
$$;
-- Interne : ne pas laisser n'importe qui interroger le plan d'un autre utilisateur.
revoke all on function public.effective_plan(uuid) from public, anon, authenticated;

-- Pour le front : le plan de l'utilisateur connecte, avec ses limites.
create or replace function public.my_plan()
returns setof public.plans language sql stable security definer set search_path = public as $$
  select p.* from plans p where p.id = effective_plan(auth.uid());
$$;
grant execute on function public.my_plan() to authenticated;

-- ── Organisateur de la tontine (renseigne automatiquement a la creation)
alter table public.tontines add column if not exists owner_id uuid references auth.users(id) default auth.uid();

-- ── Limites du plan a la creation / modification d'une tontine
create or replace function public.trg_enforce_plan_limits()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_plan   plans%rowtype;
  v_active integer;
begin
  if new.owner_id is null then
    return new;  -- tontine creee par le serveur (service_role) : pas de limite
  end if;
  select * into v_plan from plans where id = effective_plan(new.owner_id);

  if new.max_members > v_plan.max_members then
    raise exception 'Le plan % permet jusqu''a % membres par tontine', v_plan.name, v_plan.max_members
      using errcode = 'check_violation';
  end if;

  if tg_op = 'INSERT' and v_plan.max_active_tontines is not null then
    select count(*) into v_active from tontines
     where owner_id = new.owner_id and status in ('open', 'active');
    if v_active >= v_plan.max_active_tontines then
      raise exception 'Le plan % permet % tontine(s) active(s) a la fois', v_plan.name, v_plan.max_active_tontines
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists enforce_plan_limits on public.tontines;
create trigger enforce_plan_limits
  before insert or update of max_members on public.tontines
  for each row execute function public.trg_enforce_plan_limits();

-- ── Commission figee a l'ouverture de chaque tour, selon le plan de l'organisateur a ce moment.
-- Les membres connaissent ainsi la commission pendant la collecte, et elle ne change pas
-- en cours de repartition si l'organisateur change de plan.
alter table public.tontine_rounds add column if not exists fee_bps integer check (fee_bps between 0 and 1000);

create or replace function public.trg_set_round_due_at()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'collecting' and new.due_at is null then
    select now() + make_interval(days => t.payment_delay_days) into new.due_at
    from tontines t where t.id = new.tontine_id;
  end if;
  if new.status = 'collecting' and new.fee_bps is null then
    select coalesce(p.fee_bps, 150) into new.fee_bps
    from tontines t left join plans p on p.id = effective_plan(t.owner_id)
    where t.id = new.tontine_id;
  end if;
  return new;
end $$;
