// Option « garantie de paiement » : reserve de solidarite de chaque groupe (voir migration 20261009150000).
// Le wallet de la reserve appartient a l'utilisateur Mangopay de la plateforme (MANGOPAY_PLATFORM_USER_ID),
// qui ne fait que le gerer pour le compte du groupe : chaque mouvement est inscrit dans guarantee_ledger.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";
import { mangopay } from "./mangopay.ts";
import { feeFor, planCover, planRefunds } from "./distribution.ts";
import { PAYMENT_CURRENCY } from "./supabase.ts";

export const GUARANTEE_DELAY_DAYS = 20; // declenchement : 20 jours apres l'echeance (3e relance)
const PLATFORM_USER = Deno.env.get("MANGOPAY_PLATFORM_USER_ID") ?? "";
const DAY_MS = 24 * 60 * 60 * 1000;

// Cle d'idempotence Mangopay (16 a 36 caracteres) derivee d'une reference stable.
export async function keyFor(ref: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ref));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 36);
}

async function hasLedger(db: SupabaseClient, ref: string): Promise<boolean> {
  const { data } = await db.from("guarantee_ledger").select("id").eq("ref", ref).maybeSingle();
  return !!data;
}

async function addLedger(db: SupabaseClient, row: {
  tontine_id: string; round_id?: string; user_id?: string; kind: string; amount_cents: number; ref: string; transfer_id: string;
}) {
  const { error } = await db.from("guarantee_ledger").upsert(row, { onConflict: "ref", ignoreDuplicates: true });
  if (error) throw error;
}

export async function reserveBalance(db: SupabaseClient, tontineId: string): Promise<number> {
  const { data, error } = await db.rpc("guarantee_balance", { p_tontine_id: tontineId });
  if (error) throw error;
  return Number(data ?? 0);
}

// Wallet de la reserve, cree au premier besoin.
export async function ensureReserveWallet(db: SupabaseClient, tontineId: string): Promise<string> {
  const { data: t, error } = await db.from("tontines").select("guarantee_wallet_id").eq("id", tontineId).single();
  if (error) throw error;
  if (t.guarantee_wallet_id) return t.guarantee_wallet_id;
  if (!PLATFORM_USER) throw new Error("MANGOPAY_PLATFORM_USER_ID manquant");
  const wallet = await mangopay.createWallet(PLATFORM_USER, PAYMENT_CURRENCY);
  // Si deux appels se croisent, on garde le premier wallet enregistre.
  const { data: won } = await db.from("tontines").update({ guarantee_wallet_id: wallet.Id })
    .eq("id", tontineId).is("guarantee_wallet_id", null).select("guarantee_wallet_id").maybeSingle();
  if (won) return won.guarantee_wallet_id;
  const { data: again } = await db.from("tontines").select("guarantee_wallet_id").eq("id", tontineId).single();
  return again!.guarantee_wallet_id;
}

// Prime du tour : part garantie de la cagnotte, du wallet du beneficiaire vers la reserve.
export async function collectPremium(
  db: SupabaseClient,
  round: { id: string; tontine_id: string; beneficiary_id: string },
  beneficiary: { provider_user_id: string; wallet_id: string },
  amountCents: number,
): Promise<void> {
  const ref = `premium:${round.id}`;
  if (amountCents <= 0 || await hasLedger(db, ref)) return;
  const reserve = await ensureReserveWallet(db, round.tontine_id);
  const tr = await mangopay.createTransfer({
    authorId: beneficiary.provider_user_id, fromWallet: beneficiary.wallet_id, toWallet: reserve,
    currency: PAYMENT_CURRENCY, amount: amountCents, fee: 0, tag: `garantie:prime:${round.id}`,
  }, await keyFor(ref));
  if (tr.Status !== "SUCCEEDED") throw new Error(`Prime de garantie ${tr.Id} ${tr.Status}: ${tr.ResultMessage ?? ""}`);
  await addLedger(db, { tontine_id: round.tontine_id, round_id: round.id, user_id: round.beneficiary_id, kind: "premium", amount_cents: amountCents, ref, transfer_id: tr.Id });
}

// Couverture d'un tour bloque : la reserve verse les cotisations manquantes au beneficiaire.
// Retourne "covered" si le tour peut etre reparti, sinon la raison.
export async function coverRound(db: SupabaseClient, roundId: string, now = new Date()): Promise<string> {
  const { data: round } = await db.from("tontine_rounds")
    .select("id, tontine_id, beneficiary_id, status, due_at, fee_bps, guarantee_bps")
    .eq("id", roundId).single();
  if (!round || round.status !== "collecting" || !round.guarantee_bps || !round.due_at) return "not_eligible";
  if (now.getTime() < new Date(round.due_at).getTime() + GUARANTEE_DELAY_DAYS * DAY_MS) return "too_early";

  const [{ data: tontine }, { data: participants }, { data: contribs }, { data: accounts }] = await Promise.all([
    db.from("tontines").select("amount").eq("id", round.tontine_id).single(),
    db.from("tontine_rounds").select("beneficiary_id").eq("tontine_id", round.tontine_id),
    db.from("contributions").select("user_id, status").eq("round_id", round.id),
    db.from("payment_accounts").select("user_id, wallet_id").eq("user_id", round.beneficiary_id),
  ]);
  const beneficiaryWallet = accounts?.[0]?.wallet_id;
  if (!tontine || !participants || !beneficiaryWallet) return "missing_data";
  const amountCents = Math.round(Number(tontine.amount) * 100);
  const settled = new Set((contribs ?? []).filter((c) => c.status === "paid" || c.status === "transferred").map((c) => c.user_id));
  const debtors = participants.map((p) => p.beneficiary_id as string).filter((id) => !settled.has(id));
  if (!debtors.length) return "nothing_missing";

  // Couvertures restant a verser (une couverture deja versee lors d'une execution precedente est sautee).
  const todo: { debtor: string; claimId: string }[] = [];
  for (const debtor of debtors) {
    await db.from("guarantee_claims").upsert(
      { round_id: round.id, debtor_id: debtor, amount_cents: amountCents },
      { onConflict: "round_id,debtor_id", ignoreDuplicates: true },
    );
    const { data: claim } = await db.from("guarantee_claims").select("id").eq("round_id", round.id).eq("debtor_id", debtor).single();
    if (!(await hasLedger(db, `cover:${claim!.id}`))) todo.push({ debtor, claimId: claim!.id });
  }

  const balance = await reserveBalance(db, round.tontine_id);
  const plan = planCover(todo.map((t) => ({ user_id: t.debtor, amount_cents: amountCents })), balance);
  if (todo.length && !plan.cover) {
    await db.from("tontine_rounds").update({
      last_error: `Reserve de garantie insuffisante : ${(balance / 100).toFixed(2)} EUR pour ${(plan.needed_cents / 100).toFixed(2)} EUR manquants`,
    }).eq("id", round.id);
    return "insufficient_reserve";
  }

  const reserve = await ensureReserveWallet(db, round.tontine_id);
  const fee = feeFor(amountCents, round.fee_bps ?? 150);
  for (const t of todo) {
    // D'abord marquer la cotisation comme couverte : si le membre vient de payer, on ne couvre pas.
    await db.from("contributions").upsert(
      { round_id: round.id, user_id: t.debtor, amount_cents: amountCents, status: "covered", fee_cents: fee },
      { onConflict: "round_id,user_id", ignoreDuplicates: true },
    );
    const { data: marked } = await db.from("contributions")
      .update({ status: "covered", fee_cents: fee, updated_at: now.toISOString() })
      .eq("round_id", round.id).eq("user_id", t.debtor).in("status", ["pending", "failed", "covered"])
      .select("id").maybeSingle();
    if (!marked) { // le membre a paye entre-temps : plus de dette
      await db.from("guarantee_claims").delete().eq("id", t.claimId);
      continue;
    }
    const ref = `cover:${t.claimId}`;
    const tr = await mangopay.createTransfer({
      authorId: PLATFORM_USER, fromWallet: reserve, toWallet: beneficiaryWallet,
      currency: PAYMENT_CURRENCY, amount: amountCents, fee, tag: `garantie:couverture:${round.id}`,
    }, await keyFor(ref));
    if (tr.Status !== "SUCCEEDED") throw new Error(`Couverture ${tr.Id} ${tr.Status}: ${tr.ResultMessage ?? ""}`);
    await addLedger(db, { tontine_id: round.tontine_id, round_id: round.id, user_id: t.debtor, kind: "cover", amount_cents: -amountCents, ref, transfer_id: tr.Id });
  }
  return "covered";
}

// Un membre defaillant rembourse la reserve (paiement tardif d'une cotisation couverte).
export async function recoverClaim(db: SupabaseClient, contributionId: string): Promise<void> {
  const { data: c } = await db.from("contributions").select("round_id, user_id, status").eq("id", contributionId).single();
  if (!c || c.status !== "covered") return;
  const [{ data: claim }, { data: round }, { data: account }] = await Promise.all([
    db.from("guarantee_claims").select("id, amount_cents, status").eq("round_id", c.round_id).eq("debtor_id", c.user_id).maybeSingle(),
    db.from("tontine_rounds").select("tontine_id").eq("id", c.round_id).single(),
    db.from("payment_accounts").select("provider_user_id, wallet_id").eq("user_id", c.user_id).single(),
  ]);
  if (!claim || claim.status !== "open" || !round || !account) return;
  const ref = `recovery:${claim.id}`;
  if (!(await hasLedger(db, ref))) {
    const reserve = await ensureReserveWallet(db, round.tontine_id);
    const tr = await mangopay.createTransfer({
      authorId: account.provider_user_id, fromWallet: account.wallet_id, toWallet: reserve,
      currency: PAYMENT_CURRENCY, amount: claim.amount_cents, fee: 0, tag: `garantie:remboursement:${c.round_id}`,
    }, await keyFor(ref));
    if (tr.Status !== "SUCCEEDED") throw new Error(`Remboursement ${tr.Id} ${tr.Status}: ${tr.ResultMessage ?? ""}`);
    await addLedger(db, { tontine_id: round.tontine_id, round_id: c.round_id, user_id: c.user_id, kind: "recovery", amount_cents: claim.amount_cents, ref, transfer_id: tr.Id });
  }
  await db.from("guarantee_claims").update({ status: "recovered", recovered_at: new Date().toISOString() }).eq("id", claim.id);

  // Tontine deja terminee : ce remboursement est rendu aux membres comme le reste du reliquat.
  const { data: t } = await db.from("tontines").select("status").eq("id", round.tontine_id).single();
  if (t?.status === "completed") await refundReserve(db, round.tontine_id);
}

// Fin de tontine : reliquat rendu au prorata des primes versees. Un membre qui doit encore de
// l'argent a la reserve ne recoit rien tant que sa dette n'est pas remboursee.
export async function refundReserve(db: SupabaseClient, tontineId: string): Promise<void> {
  const { data: t } = await db.from("tontines").select("guarantee_wallet_id").eq("id", tontineId).single();
  if (!t?.guarantee_wallet_id) return;
  const { data: ledger } = await db.from("guarantee_ledger").select("id, kind, user_id, amount_cents, ref, created_at")
    .eq("tontine_id", tontineId).order("created_at");
  if (!ledger?.length) return;

  // Lot de restitution identifie par le dernier mouvement hors restitution : rejouer le meme lot
  // (apres une erreur) produit exactement les memes montants et references.
  const lastMove = [...ledger].reverse().find((l) => l.kind !== "refund")!;
  const batch = `refund:${lastMove.id}:`;
  const base = ledger.filter((l) => !l.ref.startsWith(batch)).reduce((s, l) => s + Number(l.amount_cents), 0);

  const { data: openClaims } = await db.from("guarantee_claims").select("debtor_id, round_id, tontine_rounds!inner(tontine_id)")
    .eq("status", "open").eq("tontine_rounds.tontine_id", tontineId);
  const debtors = new Set((openClaims ?? []).map((c) => c.debtor_id));
  const paidIn = new Map<string, number>();
  for (const l of ledger) {
    if (l.kind === "premium" && l.user_id && !debtors.has(l.user_id)) paidIn.set(l.user_id, (paidIn.get(l.user_id) ?? 0) + Number(l.amount_cents));
  }
  const refunds = planRefunds(base, [...paidIn].map(([user_id, cents]) => ({ user_id, cents })));
  if (!refunds.length) return;

  const { data: accounts } = await db.from("payment_accounts").select("user_id, provider_user_id, wallet_id, bank_account_id")
    .in("user_id", refunds.map((r) => r.user_id));
  const acc = new Map((accounts ?? []).map((a) => [a.user_id as string, a]));
  for (const r of refunds) {
    const a = acc.get(r.user_id);
    const ref = `${batch}${r.user_id}`;
    if (!a || await hasLedger(db, ref)) continue;
    const tr = await mangopay.createTransfer({
      authorId: PLATFORM_USER, fromWallet: t.guarantee_wallet_id, toWallet: a.wallet_id,
      currency: PAYMENT_CURRENCY, amount: r.cents, fee: 0, tag: `garantie:reliquat:${tontineId}`,
    }, await keyFor(ref));
    if (tr.Status !== "SUCCEEDED") throw new Error(`Reliquat ${tr.Id} ${tr.Status}: ${tr.ResultMessage ?? ""}`);
    await addLedger(db, { tontine_id: tontineId, user_id: r.user_id, kind: "refund", amount_cents: -r.cents, ref, transfer_id: tr.Id });
    if (a.bank_account_id) {
      await mangopay.createPayout({
        authorId: a.provider_user_id, walletId: a.wallet_id, bankAccountId: a.bank_account_id,
        currency: PAYMENT_CURRENCY, amount: r.cents, tag: `garantie:reliquat:${tontineId}`,
      }, await keyFor(`${ref}:virement`));
    }
  }
}
