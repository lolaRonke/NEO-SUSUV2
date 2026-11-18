-- =====================================================================
-- NEO-SUSU — 002 : vérification d'identité (KYC)
-- À exécuter APRÈS schema.sql.
-- Les pièces sont stockées dans un espace privé « kyc » : chaque
-- utilisateur ne voit que ses fichiers, les administrateurs voient tout.
-- Les fichiers ne peuvent être ni modifiés ni supprimés par l'utilisateur.
-- =====================================================================

-- ── Statuts KYC : « none » = rien envoyé, « pending » = en cours d'examen
alter table public.profiles drop constraint if exists profiles_kyc_status_check;
update public.profiles set kyc_status = 'none' where kyc_status = 'pending';
alter table public.profiles alter column kyc_status set default 'none';
alter table public.profiles add constraint profiles_kyc_status_check
  check (kyc_status in ('none','pending','verified','rejected'));

-- ── Dossiers déposés
create table if not exists public.kyc_submissions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  doc_type      text not null check (doc_type in ('passport','id_card','residence_permit','driver_license')),
  doc_country   text check (char_length(doc_country) <= 5),
  front_path    text not null,
  back_path     text,
  selfie_path   text not null,
  status        text not null default 'pending' check (status in ('pending','verified','rejected')),
  reject_reason text check (char_length(reject_reason) <= 300),
  reviewed_by   uuid references public.profiles(id) on delete set null,
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists kyc_submissions_user_idx on public.kyc_submissions(user_id);
create index if not exists kyc_submissions_pending_idx on public.kyc_submissions(created_at) where status = 'pending';
create index if not exists kyc_submissions_reviewer_idx on public.kyc_submissions(reviewed_by);

alter table public.kyc_submissions enable row level security;
drop policy if exists "kyc: lecture de ses dossiers" on public.kyc_submissions;
create policy "kyc: lecture de ses dossiers" on public.kyc_submissions
  for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete on public.kyc_submissions from anon, authenticated;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()) and is_admin);
$$;

-- ── Espace de stockage privé
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('kyc', 'kyc', false, 8388608, array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "kyc: dépôt dans son dossier" on storage.objects;
create policy "kyc: dépôt dans son dossier" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'kyc' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "kyc: lecture de ses fichiers ou admin" on storage.objects;
create policy "kyc: lecture de ses fichiers ou admin" on storage.objects
  for select to authenticated
  using (bucket_id = 'kyc' and ((storage.foldername(name))[1] = (select auth.uid())::text or public.is_admin()));

-- ── Envoi d'un dossier par l'utilisateur
create or replace function public.submit_kyc(
  p_doc_type text, p_doc_country text, p_front text, p_back text, p_selfie text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  v_status text;
  v_id uuid;
  p text;
begin
  if uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select kyc_status into v_status from public.profiles where id = uid for update;
  if v_status = 'verified' then raise exception 'KYC_ALREADY_VERIFIED'; end if;
  if v_status = 'pending'  then raise exception 'KYC_ALREADY_PENDING'; end if;
  if p_doc_type not in ('passport','id_card','residence_permit','driver_license') then raise exception 'INVALID_INPUT'; end if;
  if p_doc_type <> 'passport' and nullif(p_back, '') is null then raise exception 'KYC_BACK_REQUIRED'; end if;

  -- Chaque fichier doit être dans le dossier de l'utilisateur et exister réellement
  foreach p in array array_remove(array[p_front, nullif(p_back, ''), p_selfie], null) loop
    if p is null or p not like uid::text || '/%' or p like '%..%' then raise exception 'KYC_FILE_INVALID'; end if;
    if not exists (select 1 from storage.objects o where o.bucket_id = 'kyc' and o.name = p) then
      raise exception 'KYC_FILE_MISSING';
    end if;
  end loop;
  if p_selfie is null or p_front is null then raise exception 'KYC_FILE_INVALID'; end if;

  insert into public.kyc_submissions (user_id, doc_type, doc_country, front_path, back_path, selfie_path)
  values (uid, p_doc_type, left(upper(nullif(trim(p_doc_country), '')), 5), p_front, nullif(p_back, ''), p_selfie)
  returning id into v_id;
  update public.profiles set kyc_status = 'pending' where id = uid;
  return v_id;
end $$;

-- ── Liste des dossiers à examiner (admin)
create or replace function public.admin_kyc_pending()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'FORBIDDEN'; end if;
  return (select coalesce(jsonb_agg(r order by r.created_at), '[]'::jsonb) from (
    select k.id, k.user_id, k.doc_type, k.doc_country, k.front_path, k.back_path, k.selfie_path, k.created_at,
           p.first_name, p.last_name, p.country, p.phone, u.email
    from public.kyc_submissions k
    join public.profiles p on p.id = k.user_id
    join auth.users u on u.id = k.user_id
    where k.status = 'pending') r);
end $$;

-- ── Décision de l'admin
create or replace function public.admin_review_kyc(p_submission uuid, p_approve boolean, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare k public.kyc_submissions;
begin
  if not public.is_admin() then raise exception 'FORBIDDEN'; end if;
  select * into k from public.kyc_submissions where id = p_submission for update;
  if not found or k.status <> 'pending' then raise exception 'KYC_NOT_PENDING'; end if;
  if not p_approve and char_length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'REASON_REQUIRED'; end if;
  update public.kyc_submissions
     set status = case when p_approve then 'verified' else 'rejected' end,
         reject_reason = case when p_approve then null else left(trim(p_reason), 300) end,
         reviewed_by = auth.uid(), reviewed_at = now()
   where id = p_submission;
  update public.profiles set kyc_status = case when p_approve then 'verified' else 'rejected' end where id = k.user_id;
end $$;

revoke execute on function public.submit_kyc(text,text,text,text,text), public.admin_kyc_pending(),
                           public.admin_review_kyc(uuid,boolean,text), public.is_admin() from public, anon;
grant execute on function public.submit_kyc(text,text,text,text,text), public.admin_kyc_pending(),
                          public.admin_review_kyc(uuid,boolean,text), public.is_admin() to authenticated;
