-- Option « garantie de paiement » : reserve de solidarite propre a chaque groupe.
--
-- - Chaque membre choisit l'option avant le demarrage du groupe. Le choix est ensuite fige.
-- - Quand un membre ayant l'option recoit la cagnotte, 3 % sont preleves en plus de la commission
--   et verses dans la reserve du groupe.
-- - Si, 20 jours apres l'echeance, des cotisations manquent pour un beneficiaire ayant l'option, la
--   reserve les verse a sa place (si elle suffit), et le membre defaillant doit cette somme a la reserve.
-- - En fin de tontine, le reliquat est rendu aux membres au prorata de ce qu'ils y ont verse.
-- L'argent de la reserve appartient au groupe, jamais a NEO-SUSU.

alter table public.tontine_members add column if not exists guarantee boolean not null default false;
alter table public.tontines        add column if not exists guarantee_wallet_id text;
alter table public.tontine_rounds  add column if not exists guarantee_bps integer not null default 0
  check (guarantee_bps between 0 and 1000);

-- Cotisation « covered » : payee par la reserve a la place d'un membre defaillant
alter table public.contributions drop constraint if exists contributions_status_check;
alter table public.contributions add constraint contributions_status_check
  check (status in ('pending', 'paid', 'transferred', 'covered', 'failed'));

-- Registre de la reserve : chaque mouvement, avec une reference unique (rejouable sans doublon).
-- amount_cents > 0 : entree (prime, remboursement d'un defaillant) ; < 0 : sortie (couverture, reliquat rendu).
create table if not exists public.guarantee_ledger (
  id            uuid primary key default gen_random_uuid(),
  tontine_id    uuid not null references public.tontines(id) on delete cascade,
  round_id      uuid references public.tontine_rounds(id) on delete cascade,
  user_id       uuid references auth.users(id),
  kind          text not null check (kind in ('premium', 'cover', 'recovery', 'refund')),
  amount_cents  bigint not null check (amount_cents <> 0),
  ref           text not null unique,
  transfer_id   text,
  created_at    timestamptz not null default now()
);
create index if not exists guarantee_ledger_tontine_idx on public.guarantee_ledger (tontine_id);

-- Dette d'un membre defaillant envers la reserve
create table if not exists public.guarantee_claims (
  id            uuid primary key default gen_random_uuid(),
  round_id      uuid not null references public.tontine_rounds(id) on delete cascade,
  debtor_id     uuid not null references auth.users(id),
  amount_cents  bigint not null check (amount_cents > 0),
  status        text not null default 'open' check (status in ('open', 'recovered')),
  created_at    timestamptz not null default now(),
  recovered_at  timestamptz,
  unique (round_id, debtor_id)
);

create or replace function public.guarantee_balance(p_tontine_id uuid)
returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount_cents), 0)::bigint from guarantee_ledger where tontine_id = p_tontine_id;
$$;

alter table public.guarantee_ledger enable row level security;
alter table public.guarantee_claims enable row level security;

drop policy if exists "members read ledger" on public.guarantee_ledger;
create policy "members read ledger" on public.guarantee_ledger
  for select using (public.is_tontine_member(tontine_id));

drop policy if exists "members read claims" on public.guarantee_claims;
create policy "members read claims" on public.guarantee_claims
  for select using (exists (
    select 1 from public.tontine_rounds r where r.id = round_id and public.is_tontine_member(r.tontine_id)));

-- ── Choix de l'option par le membre connecte, uniquement avant le demarrage du groupe
create or replace function public.set_guarantee(p_tontine_id uuid, p_enabled boolean)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from tontine_rounds where tontine_id = p_tontine_id) then
    raise exception 'Le groupe a demarre : le choix de la garantie est fige' using errcode = 'check_violation';
  end if;
  update tontine_members set guarantee = p_enabled
   where tontine_id = p_tontine_id and user_id = auth.uid();
  if not found then
    raise exception 'Vous n''etes pas membre de cette tontine' using errcode = 'insufficient_privilege';
  end if;
  return p_enabled;
end $$;
revoke all on function public.set_guarantee(uuid, boolean) from public, anon;
grant execute on function public.set_guarantee(uuid, boolean) to authenticated;

-- Le choix est fige une fois les tours crees, meme par une modification directe de la table
create or replace function public.trg_lock_guarantee()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.guarantee is distinct from old.guarantee
     and exists (select 1 from tontine_rounds where tontine_id = new.tontine_id) then
    raise exception 'Le groupe a demarre : le choix de la garantie est fige' using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists lock_guarantee on public.tontine_members;
create trigger lock_guarantee
  before update of guarantee on public.tontine_members
  for each row execute function public.trg_lock_guarantee();

-- ── A l'ouverture d'un tour : echeance, commission (plan de l'organisateur) et taux de garantie
-- (3 % si le beneficiaire du tour a pris l'option), tous figes pour la duree du tour.
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
  if new.status = 'collecting' and (tg_op = 'INSERT' or old.status is distinct from 'collecting') then
    select case when m.guarantee then 300 else 0 end into new.guarantee_bps
    from tontine_members m where m.tontine_id = new.tontine_id and m.user_id = new.beneficiary_id;
    new.guarantee_bps := coalesce(new.guarantee_bps, 0);
  end if;
  return new;
end $$;
