-- =====================================================================
-- NEO-SUSU — schéma de base de données Supabase
-- Tables : profiles, tontines, tontine_members, contributions, payouts
-- Toute écriture sensible passe par des fonctions (RPC) contrôlées ;
-- la lecture directe est limitée par RLS aux membres concernés.
-- =====================================================================

-- ── TABLES ───────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  first_name  text not null default '' check (char_length(first_name) <= 50),
  last_name   text not null default '' check (char_length(last_name) <= 50),
  phone       text check (char_length(phone) <= 25),
  country     text check (char_length(country) <= 5),
  score       int  not null default 50 check (score between 0 and 100),
  kyc_status  text not null default 'pending' check (kyc_status in ('pending','verified','rejected')),
  plan        text not null default 'free' check (plan in ('free','premium','business')),
  is_admin    boolean not null default false,
  created_at  timestamptz not null default now()
);

create table if not exists public.tontines (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (char_length(name) between 2 and 80),
  description   text check (char_length(description) <= 500),
  amount        numeric(14,2) not null check (amount > 0),
  currency      text not null check (currency in ('XOF','XAF','NGN','EUR','GBP')),
  frequency     text not null check (frequency in ('weekly','biweekly','monthly')),
  max_members   int  not null check (max_members between 2 and 50),
  start_date    date not null default current_date,
  invite_code   text not null unique,
  owner_id      uuid not null references public.profiles(id) on delete cascade,
  status        text not null default 'waiting' check (status in ('waiting','active','completed')),
  current_round int  not null default 1,
  created_at    timestamptz not null default now()
);
create index if not exists tontines_owner_idx on public.tontines(owner_id);

create table if not exists public.tontine_members (
  tontine_id  uuid not null references public.tontines(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  turn_order  int  not null,
  joined_at   timestamptz not null default now(),
  primary key (tontine_id, user_id),
  unique (tontine_id, turn_order)
);
create index if not exists tontine_members_user_idx on public.tontine_members(user_id);

create table if not exists public.contributions (
  id          uuid primary key default gen_random_uuid(),
  tontine_id  uuid not null references public.tontines(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  round       int  not null,
  amount      numeric(14,2) not null,
  fee         numeric(14,2) not null,
  created_at  timestamptz not null default now(),
  unique (tontine_id, user_id, round)
);
create index if not exists contributions_user_idx on public.contributions(user_id);

create table if not exists public.payouts (
  id          uuid primary key default gen_random_uuid(),
  tontine_id  uuid not null references public.tontines(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  round       int  not null,
  amount      numeric(14,2) not null,
  currency    text not null,
  created_at  timestamptz not null default now(),
  unique (tontine_id, round)
);
create index if not exists payouts_user_idx on public.payouts(user_id);

-- ── RLS ──────────────────────────────────────────────────────────────
alter table public.profiles        enable row level security;
alter table public.tontines        enable row level security;
alter table public.tontine_members enable row level security;
alter table public.contributions   enable row level security;
alter table public.payouts         enable row level security;

create or replace function public.is_member(p_tontine uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.tontine_members
                 where tontine_id = p_tontine and user_id = (select auth.uid()));
$$;

drop policy if exists "profil: lecture du sien" on public.profiles;
create policy "profil: lecture du sien" on public.profiles
  for select to authenticated using (id = (select auth.uid()));
drop policy if exists "profil: modification du sien" on public.profiles;
create policy "profil: modification du sien" on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- Seuls les champs d'identité sont modifiables par l'utilisateur
-- (le score, le plan, le KYC et le rôle admin ne le sont pas).
revoke insert, update, delete on public.profiles from anon, authenticated;
grant update (first_name, last_name, phone, country) on public.profiles to authenticated;

drop policy if exists "tontine: lecture membres" on public.tontines;
create policy "tontine: lecture membres" on public.tontines
  for select to authenticated using (public.is_member(id));
drop policy if exists "membres: lecture membres" on public.tontine_members;
create policy "membres: lecture membres" on public.tontine_members
  for select to authenticated using (public.is_member(tontine_id));
drop policy if exists "cotisations: lecture membres" on public.contributions;
create policy "cotisations: lecture membres" on public.contributions
  for select to authenticated using (public.is_member(tontine_id));
drop policy if exists "versements: lecture membres" on public.payouts;
create policy "versements: lecture membres" on public.payouts
  for select to authenticated using (public.is_member(tontine_id));

revoke insert, update, delete on public.tontines, public.tontine_members, public.contributions, public.payouts from anon, authenticated;

-- ── CRÉATION DU PROFIL À L'INSCRIPTION ───────────────────────────────
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
declare m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
begin
  insert into public.profiles (id, first_name, last_name, phone, country)
  values (
    new.id,
    left(coalesce(nullif(m->>'first_name',''), m->>'given_name', split_part(coalesce(m->>'full_name', m->>'name', ''), ' ', 1), ''), 50),
    left(coalesce(nullif(m->>'last_name',''), m->>'family_name', nullif(substr(coalesce(m->>'full_name', m->>'name', ''), strpos(coalesce(m->>'full_name', m->>'name', ''), ' ') + 1), coalesce(m->>'full_name', m->>'name', '')), ''), 50),
    left(nullif(m->>'phone',''), 25),
    left(nullif(m->>'country',''), 5)
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── FONCTIONS MÉTIER (RPC) ───────────────────────────────────────────
create or replace function public.plan_fee_rate(p_plan text)
returns numeric language sql immutable set search_path = '' as $$
  select case p_plan when 'business' then 0 when 'premium' then 0.5 else 1.5 end::numeric;
$$;

create or replace function public.create_tontine(
  p_name text, p_description text, p_amount numeric, p_currency text,
  p_frequency text, p_max_members int, p_start_date date)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  v_plan text;
  v_limit int;
  v_code text;
  v_id uuid;
begin
  if uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select plan into v_plan from public.profiles where id = uid;
  v_limit := case v_plan when 'business' then 50 when 'premium' then 20 else 6 end;
  if p_max_members is null or p_max_members < 2 or p_max_members > v_limit then raise exception 'PLAN_LIMIT_MEMBERS'; end if;
  if coalesce(v_plan,'free') = 'free' and exists (
       select 1 from public.tontines where owner_id = uid and status <> 'completed') then
    raise exception 'PLAN_LIMIT_TONTINES';
  end if;
  if char_length(trim(coalesce(p_name,''))) < 2 or p_amount is null or p_amount <= 0 then raise exception 'INVALID_INPUT'; end if;

  loop  -- code à 6 caractères sans caractères ambigus (0/O, 1/I)
    select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random()*32)::int, 1), '')
      into v_code from generate_series(1,6);
    exit when not exists (select 1 from public.tontines where invite_code = v_code);
  end loop;

  insert into public.tontines (name, description, amount, currency, frequency, max_members, start_date, invite_code, owner_id)
  values (trim(p_name), nullif(trim(p_description),''), round(p_amount, 2), p_currency, p_frequency, p_max_members,
          coalesce(p_start_date, current_date), v_code, uid)
  returning id into v_id;
  insert into public.tontine_members (tontine_id, user_id, turn_order) values (v_id, uid, 1);
  return v_id;
end $$;

create or replace function public.join_tontine(p_code text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  t public.tontines;
  n int;
begin
  if uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into t from public.tontines where invite_code = upper(trim(p_code)) for update;
  if not found then raise exception 'CODE_INVALID'; end if;
  if exists (select 1 from public.tontine_members where tontine_id = t.id and user_id = uid) then return t.id; end if;
  if t.status <> 'waiting' then raise exception 'TONTINE_STARTED'; end if;
  select count(*) into n from public.tontine_members where tontine_id = t.id;
  if n >= t.max_members then raise exception 'TONTINE_FULL'; end if;
  insert into public.tontine_members (tontine_id, user_id, turn_order) values (t.id, uid, n + 1);
  if n + 1 = t.max_members then update public.tontines set status = 'active' where id = t.id; end if;
  return t.id;
end $$;

create or replace function public.start_tontine(p_tontine uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare t public.tontines; n int;
begin
  select * into t from public.tontines where id = p_tontine for update;
  if not found or t.owner_id <> auth.uid() then raise exception 'NOT_OWNER'; end if;
  if t.status <> 'waiting' then raise exception 'TONTINE_STARTED'; end if;
  select count(*) into n from public.tontine_members where tontine_id = p_tontine;
  if n < 2 then raise exception 'NOT_ENOUGH_MEMBERS'; end if;
  update public.tontines set status = 'active', max_members = n where id = p_tontine;
end $$;

create or replace function public.pay_contribution(p_tontine uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  t public.tontines;
  v_plan text;
  v_fee numeric;
  n int; paid int;
  v_benef uuid;
  v_payout boolean := false;
begin
  if uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into t from public.tontines where id = p_tontine for update;
  if not found or not exists (select 1 from public.tontine_members where tontine_id = p_tontine and user_id = uid) then
    raise exception 'NOT_MEMBER';
  end if;
  if t.status <> 'active' then raise exception 'TONTINE_NOT_ACTIVE'; end if;
  if exists (select 1 from public.contributions where tontine_id = p_tontine and user_id = uid and round = t.current_round) then
    raise exception 'ALREADY_PAID';
  end if;

  select plan into v_plan from public.profiles where id = uid;
  v_fee := round(t.amount * public.plan_fee_rate(v_plan) / 100, 2);
  insert into public.contributions (tontine_id, user_id, round, amount, fee) values (p_tontine, uid, t.current_round, t.amount, v_fee);
  update public.profiles set score = least(100, score + 2) where id = uid;

  select count(*) into n from public.tontine_members where tontine_id = p_tontine;
  select count(*) into paid from public.contributions where tontine_id = p_tontine and round = t.current_round;
  if paid >= n then
    select user_id into v_benef from public.tontine_members where tontine_id = p_tontine and turn_order = t.current_round;
    insert into public.payouts (tontine_id, user_id, round, amount, currency) values (p_tontine, v_benef, t.current_round, t.amount * n, t.currency);
    update public.tontines
      set current_round = current_round + 1,
          status = case when current_round + 1 > n then 'completed' else 'active' end
      where id = p_tontine;
    v_payout := true;
  end if;
  return jsonb_build_object('round', t.current_round, 'fee', v_fee, 'payout', v_payout);
end $$;

create or replace function public.my_tontines()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x order by x->>'status_rank', x->>'created_at' desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', t.id, 'name', t.name, 'amount', t.amount, 'currency', t.currency, 'frequency', t.frequency,
      'max_members', t.max_members, 'status', t.status, 'current_round', t.current_round, 'created_at', t.created_at,
      'status_rank', case t.status when 'active' then 1 when 'waiting' then 2 else 3 end,
      'member_count', (select count(*) from public.tontine_members m2 where m2.tontine_id = t.id),
      'paid_count', (select count(*) from public.contributions c where c.tontine_id = t.id and c.round = t.current_round),
      'paid_this_round', exists (select 1 from public.contributions c where c.tontine_id = t.id and c.round = t.current_round and c.user_id = m.user_id),
      'my_turn', m.turn_order) as x
    from public.tontine_members m join public.tontines t on t.id = m.tontine_id
    where m.user_id = (select auth.uid())
  ) s;
$$;

create or replace function public.my_summary()
returns jsonb language sql stable security definer set search_path = '' as $$
  with me as (select (select auth.uid()) as uid),
  mine as (select t.*, m.turn_order from public.tontine_members m join public.tontines t on t.id = m.tontine_id, me where m.user_id = me.uid)
  select jsonb_build_object(
    'tontine_count', (select count(*) from mine),
    'member_total', (select count(*) from public.tontine_members tm where tm.tontine_id in (select id from mine)),
    'next_turn', (select min(turn_order - current_round) from mine where status <> 'completed' and turn_order >= current_round),
    'received', (select coalesce(jsonb_agg(jsonb_build_object('currency', currency, 'total', total)), '[]'::jsonb)
                 from (select currency, sum(amount) total from public.payouts, me where user_id = me.uid group by currency) r),
    'contributed', (select coalesce(jsonb_agg(jsonb_build_object('currency', currency, 'total', total)), '[]'::jsonb)
                 from (select t.currency, sum(c.amount) total from public.contributions c join public.tontines t on t.id = c.tontine_id, me
                       where c.user_id = me.uid group by t.currency) r)
  );
$$;

create or replace function public.tontine_detail(p_tontine uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare uid uuid := auth.uid(); t public.tontines; res jsonb;
begin
  if uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into t from public.tontines where id = p_tontine;
  if not found or not exists (select 1 from public.tontine_members where tontine_id = p_tontine and user_id = uid) then
    raise exception 'NOT_MEMBER';
  end if;
  select jsonb_build_object(
    'id', t.id, 'name', t.name, 'description', t.description, 'amount', t.amount, 'currency', t.currency,
    'frequency', t.frequency, 'max_members', t.max_members, 'start_date', t.start_date, 'invite_code', t.invite_code,
    'status', t.status, 'current_round', t.current_round, 'is_owner', t.owner_id = uid,
    'my_plan', (select plan from public.profiles where id = uid),
    'members', (select coalesce(jsonb_agg(jsonb_build_object(
        'user_id', m.user_id, 'first_name', p.first_name, 'last_name', p.last_name, 'turn_order', m.turn_order,
        'is_me', m.user_id = uid,
        'paid', exists (select 1 from public.contributions c where c.tontine_id = t.id and c.user_id = m.user_id and c.round = t.current_round),
        'received', exists (select 1 from public.payouts po where po.tontine_id = t.id and po.user_id = m.user_id)
      ) order by m.turn_order), '[]'::jsonb)
      from public.tontine_members m join public.profiles p on p.id = m.user_id where m.tontine_id = t.id)
  ) into res;
  return res;
end $$;

create or replace function public.admin_stats()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and is_admin) then raise exception 'FORBIDDEN'; end if;
  return jsonb_build_object(
    'users', (select count(*) from public.profiles),
    'users_month', (select count(*) from public.profiles where created_at >= date_trunc('month', now())),
    'tontines_total', (select count(*) from public.tontines),
    'tontines_active', (select count(*) from public.tontines where status = 'active'),
    'tontines_waiting', (select count(*) from public.tontines where status = 'waiting'),
    'contributions_month', (select count(*) from public.contributions where created_at >= date_trunc('month', now())),
    'volume_month', (select coalesce(jsonb_agg(jsonb_build_object('currency', currency, 'total', total)), '[]'::jsonb) from (
        select t.currency, sum(c.amount) total from public.contributions c join public.tontines t on t.id = c.tontine_id
        where c.created_at >= date_trunc('month', now()) group by t.currency) v),
    'kyc_pending', (select count(*) from public.profiles where kyc_status = 'pending'),
    'recent_tontines', (select coalesce(jsonb_agg(r), '[]'::jsonb) from (
        select t.name, t.amount, t.currency, t.status, t.max_members,
               p.first_name || ' ' || p.last_name as owner,
               (select count(*) from public.tontine_members m where m.tontine_id = t.id) as members
        from public.tontines t join public.profiles p on p.id = t.owner_id order by t.created_at desc limit 10) r),
    'recent_users', (select coalesce(jsonb_agg(r), '[]'::jsonb) from (
        select first_name || ' ' || last_name as name, country, plan, kyc_status
        from public.profiles order by created_at desc limit 10) r)
  );
end $$;

-- ── DROITS D'EXÉCUTION ───────────────────────────────────────────────
revoke execute on function public.create_tontine(text,text,numeric,text,text,int,date),
                           public.join_tontine(text), public.start_tontine(uuid), public.pay_contribution(uuid),
                           public.my_tontines(), public.my_summary(), public.tontine_detail(uuid), public.admin_stats(),
                           public.is_member(uuid), public.handle_new_user()
  from public, anon;
grant execute on function public.create_tontine(text,text,numeric,text,text,int,date),
                          public.join_tontine(text), public.start_tontine(uuid), public.pay_contribution(uuid),
                          public.my_tontines(), public.my_summary(), public.tontine_detail(uuid), public.admin_stats(),
                          public.is_member(uuid)
  to authenticated;
