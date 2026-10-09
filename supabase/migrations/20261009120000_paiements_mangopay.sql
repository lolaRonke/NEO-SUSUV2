-- Paiements automatiques NEO-SUSU via Mangopay
-- Prerequis : tables public.tontines (id uuid, amount, max_members) et
-- public.tontine_members (tontine_id uuid, user_id uuid, created_at timestamptz).

alter table public.tontines add column if not exists fee_bps integer not null default 150
  check (fee_bps between 0 and 1000);                -- commission en points de base (150 = 1,5 %)
alter table public.tontines add column if not exists status text not null default 'open'
  check (status in ('open', 'active', 'completed'));

-- Compte Mangopay de chaque membre (utilisateur + wallet + IBAN)
create table if not exists public.payment_accounts (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  provider         text not null default 'mangopay',
  provider_user_id text not null,
  wallet_id        text not null,
  bank_account_id  text,
  currency         text not null default 'EUR',
  created_at       timestamptz not null default now()
);

-- Un tour par membre : au tour N, le beneficiaire N recoit la cagnotte
create table if not exists public.tontine_rounds (
  id             uuid primary key default gen_random_uuid(),
  tontine_id     uuid not null references public.tontines(id) on delete cascade,
  round_number   integer not null check (round_number > 0),
  beneficiary_id uuid not null references auth.users(id),
  status         text not null default 'pending'
                 check (status in ('pending', 'collecting', 'distributing', 'paid', 'failed')),
  last_error     text,
  distributed_at timestamptz,
  created_at     timestamptz not null default now(),
  unique (tontine_id, round_number)
);

create table if not exists public.contributions (
  id           uuid primary key default gen_random_uuid(),
  round_id     uuid not null references public.tontine_rounds(id) on delete cascade,
  user_id      uuid not null references auth.users(id),
  amount_cents bigint not null check (amount_cents > 0),
  fee_cents    bigint not null default 0 check (fee_cents >= 0),
  status       text not null default 'pending' check (status in ('pending', 'paid', 'transferred', 'failed')),
  payin_id     text,
  transfer_id  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (round_id, user_id)
);
create index if not exists contributions_payin_id_idx on public.contributions (payin_id);

create table if not exists public.payouts (
  id           uuid primary key default gen_random_uuid(),
  round_id     uuid not null unique references public.tontine_rounds(id) on delete cascade,
  user_id      uuid not null references auth.users(id),
  amount_cents bigint not null check (amount_cents > 0),
  status       text not null default 'pending'
               check (status in ('pending', 'awaiting_bank_account', 'created', 'succeeded', 'failed')),
  payout_id    text,
  attempts     integer not null default 0,  -- chaque tentative a sa propre cle d'idempotence
  last_error   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists payouts_payout_id_idx on public.payouts (payout_id);

-- ── RLS : lecture seule pour les membres, ecritures uniquement par les Edge Functions (service_role)
alter table public.payment_accounts enable row level security;
alter table public.tontine_rounds   enable row level security;
alter table public.contributions    enable row level security;
alter table public.payouts          enable row level security;

create or replace function public.is_tontine_member(p_tontine_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from tontine_members where tontine_id = p_tontine_id and user_id = auth.uid());
$$;

drop policy if exists "own payment account" on public.payment_accounts;
create policy "own payment account" on public.payment_accounts
  for select using (user_id = auth.uid());

drop policy if exists "members read rounds" on public.tontine_rounds;
create policy "members read rounds" on public.tontine_rounds
  for select using (public.is_tontine_member(tontine_id));

drop policy if exists "members read contributions" on public.contributions;
create policy "members read contributions" on public.contributions
  for select using (exists (
    select 1 from public.tontine_rounds r where r.id = round_id and public.is_tontine_member(r.tontine_id)));

drop policy if exists "members read payouts" on public.payouts;
create policy "members read payouts" on public.payouts
  for select using (exists (
    select 1 from public.tontine_rounds r where r.id = round_id and public.is_tontine_member(r.tontine_id)));

-- ── Demarrage automatique : quand le groupe atteint max_members (ex. 10),
-- on cree un tour par membre (ordre d'arrivee) et on ouvre la collecte du tour 1.
create or replace function public.start_tontine_if_full(p_tontine_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_max   integer;
  v_count integer;
begin
  -- Verrou sur la tontine : deux adhesions simultanees ne creent pas deux jeux de tours.
  select max_members into v_max from tontines where id = p_tontine_id for update;
  if v_max is null or exists (select 1 from tontine_rounds where tontine_id = p_tontine_id) then
    return false;
  end if;
  select count(*) into v_count from tontine_members where tontine_id = p_tontine_id;
  if v_count < v_max then
    return false;
  end if;

  insert into tontine_rounds (tontine_id, round_number, beneficiary_id, status)
  select p_tontine_id,
         row_number() over (order by m.created_at, m.user_id),
         m.user_id,
         'pending'
  from tontine_members m
  where m.tontine_id = p_tontine_id;

  update tontine_rounds set status = 'collecting' where tontine_id = p_tontine_id and round_number = 1;
  update tontines set status = 'active' where id = p_tontine_id;
  return true;
end $$;

revoke all on function public.start_tontine_if_full(uuid) from public, anon, authenticated;

create or replace function public.trg_start_tontine_if_full()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform start_tontine_if_full(new.tontine_id);
  return new;
end $$;

drop trigger if exists start_tontine_when_full on public.tontine_members;
create trigger start_tontine_when_full
  after insert on public.tontine_members
  for each row execute function public.trg_start_tontine_if_full();

-- Une fois les tours crees, l'ordre des beneficiaires est fige : plus d'adhesion possible.
create or replace function public.trg_block_join_when_started()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from tontine_rounds where tontine_id = new.tontine_id) then
    raise exception 'Cette tontine est complete et a deja demarre';
  end if;
  return new;
end $$;

drop trigger if exists block_join_when_started on public.tontine_members;
create trigger block_join_when_started
  before insert on public.tontine_members
  for each row execute function public.trg_block_join_when_started();
