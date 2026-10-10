-- Relances automatiques des cotisations en retard

-- Delai de paiement accorde a chaque tour, a compter de l'ouverture de la collecte
alter table public.tontines add column if not exists payment_delay_days integer not null default 7
  check (payment_delay_days between 0 and 60);
alter table public.tontine_rounds add column if not exists due_at timestamptz;

-- Fixe l'echeance des qu'un tour passe en collecte
create or replace function public.trg_set_round_due_at()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'collecting' and new.due_at is null then
    select now() + make_interval(days => t.payment_delay_days) into new.due_at
    from tontines t where t.id = new.tontine_id;
  end if;
  return new;
end $$;

drop trigger if exists set_round_due_at on public.tontine_rounds;
create trigger set_round_due_at
  before insert or update of status on public.tontine_rounds
  for each row execute function public.trg_set_round_due_at();

-- Historique des relances : une ligne par (tour, membre, niveau 1 a 3).
-- sent_at reste vide tant que l'e-mail n'est pas parti.
create table if not exists public.payment_reminders (
  id           uuid primary key default gen_random_uuid(),
  round_id     uuid not null references public.tontine_rounds(id) on delete cascade,
  user_id      uuid not null references auth.users(id),
  level        smallint not null check (level between 1 and 3),
  subject      text,
  body         text,
  ai_generated boolean not null default false,
  email_id     text,
  sent_at      timestamptz,
  created_at   timestamptz not null default now(),
  unique (round_id, user_id, level)
);

alter table public.payment_reminders enable row level security;

-- Chaque membre peut relire les relances qu'il a recues ; ecritures reservees au serveur.
drop policy if exists "own reminders" on public.payment_reminders;
create policy "own reminders" on public.payment_reminders
  for select using (user_id = auth.uid());
