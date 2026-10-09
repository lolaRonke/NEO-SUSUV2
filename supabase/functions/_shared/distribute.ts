// Repartition automatique d'un tour : des que les N membres ont paye leur cotisation,
// chaque cotisation est transferee vers le wallet du beneficiaire (commission prelevee),
// puis le total est vire sur son IBAN.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";
import { mangopay } from "./mangopay.ts";
import { isRoundReady, planRound, type PaidContribution } from "./distribution.ts";
import { PAYMENT_CURRENCY } from "./supabase.ts";

type Payout = { id: string; round_id: string; user_id: string; amount_cents: number; attempts: number };

export async function distributeRound(db: SupabaseClient, roundId: string): Promise<{ status: string }> {
  // Verrou : un seul appel peut faire passer le tour en "distributing" (webhooks en double, relances).
  const { data: round, error: lockErr } = await db
    .from("tontine_rounds")
    .update({ status: "distributing", last_error: null })
    .eq("id", roundId)
    .in("status", ["collecting", "failed"])
    .select("id, tontine_id, round_number, beneficiary_id, fee_bps")
    .maybeSingle();
  if (lockErr) throw lockErr;
  if (!round) return { status: "skipped" };

  try {
    const [{ data: members, error: mErr }, { data: contribs, error: cErr }] =
      await Promise.all([
        // Participants = beneficiaires des tours (liste figee au demarrage du groupe).
        db.from("tontine_rounds").select("beneficiary_id").eq("tontine_id", round.tontine_id),
        db.from("contributions").select("id, user_id, amount_cents, status").eq("round_id", round.id),
      ]);
    if (mErr || cErr) throw mErr ?? cErr;

    const memberIds = members!.map((m) => m.beneficiary_id as string);
    if (!isRoundReady(memberIds, contribs!)) {
      await db.from("tontine_rounds").update({ status: "collecting" }).eq("id", round.id);
      return { status: "collecting" };
    }

    const { data: accounts, error: aErr } = await db
      .from("payment_accounts")
      .select("user_id, provider_user_id, wallet_id, bank_account_id")
      .in("user_id", memberIds);
    if (aErr) throw aErr;
    const acc = new Map(accounts!.map((a) => [a.user_id as string, a]));
    const beneficiary = acc.get(round.beneficiary_id);
    if (!beneficiary) throw new Error("Le beneficiaire n'a pas de compte de paiement");

    const paid: PaidContribution[] = contribs!.map((c) => {
      const a = acc.get(c.user_id);
      if (!a) throw new Error(`Compte de paiement manquant pour ${c.user_id}`);
      return { ...c, wallet_id: a.wallet_id } as PaidContribution;
    });
    // Commission figee a l'ouverture du tour, selon le plan de l'organisateur (migration abonnements).
    const plan = planRound(round.beneficiary_id, paid, round.fee_bps ?? 150);

    for (const t of plan.transfers) {
      const tr = await mangopay.createTransfer({
        authorId: acc.get(t.from_user_id)!.provider_user_id,
        fromWallet: t.from_wallet_id,
        toWallet: beneficiary.wallet_id,
        currency: PAYMENT_CURRENCY,
        amount: t.debited_cents,
        fee: t.fee_cents,
        tag: `round:${round.id}`,
      }, t.contribution_id);
      if (tr.Status !== "SUCCEEDED") throw new Error(`Transfert ${tr.Id} ${tr.Status}: ${tr.ResultMessage ?? ""}`);
      await db.from("contributions")
        .update({ status: "transferred", transfer_id: tr.Id, fee_cents: t.fee_cents, updated_at: new Date().toISOString() })
        .eq("id", t.contribution_id);
    }

    const { data: payout, error: pErr } = await db
      .from("payouts")
      .upsert(
        { round_id: round.id, user_id: round.beneficiary_id, amount_cents: plan.payout_cents },
        { onConflict: "round_id", ignoreDuplicates: false },
      )
      .select("id, round_id, user_id, amount_cents, attempts, status")
      .single();
    if (pErr) throw pErr;
    // Sur une relance, ne pas renvoyer un virement deja parti.
    if (!["created", "succeeded"].includes(payout.status)) await sendPayout(db, payout as Payout, beneficiary);

    await db.from("tontine_rounds").update({ status: "paid", distributed_at: new Date().toISOString() }).eq("id", round.id);

    // Ouvre le tour suivant, ou cloture la tontine apres le dernier beneficiaire.
    const { data: next } = await db
      .from("tontine_rounds")
      .update({ status: "collecting" })
      .eq("tontine_id", round.tontine_id)
      .eq("round_number", round.round_number + 1)
      .eq("status", "pending")
      .select("id");
    if (!next?.length) await db.from("tontines").update({ status: "completed" }).eq("id", round.tontine_id);

    return { status: "paid" };
  } catch (e) {
    await db.from("tontine_rounds")
      .update({ status: "failed", last_error: String((e as Error).message ?? e).slice(0, 500) })
      .eq("id", round.id);
    throw e;
  }
}

// Virement du wallet du beneficiaire vers son IBAN. Sans IBAN, les fonds restent
// dans son wallet et le virement part des qu'il enregistre son IBAN (mangopay-onboard).
export async function sendPayout(
  db: SupabaseClient,
  payout: Payout,
  account: { provider_user_id: string; wallet_id: string; bank_account_id: string | null },
): Promise<void> {
  if (!account.bank_account_id) {
    await db.from("payouts").update({ status: "awaiting_bank_account" }).eq("id", payout.id);
    return;
  }
  // Nouvelle cle par tentative (ex. apres correction de l'IBAN) ; une meme tentative rejouee
  // reste idempotente. Le solde du wallet empeche de toute facon un double virement.
  const attempt = payout.attempts + 1;
  await db.from("payouts").update({ attempts: attempt }).eq("id", payout.id);
  const key = payout.id.replace(/-/g, "") + String(attempt).padStart(4, "0");
  const po = await mangopay.createPayout({
    authorId: account.provider_user_id,
    walletId: account.wallet_id,
    bankAccountId: account.bank_account_id,
    currency: PAYMENT_CURRENCY,
    amount: payout.amount_cents,
    tag: `round:${payout.round_id}`,
  }, key);
  await db.from("payouts").update({
    status: po.Status === "FAILED" ? "failed" : "created",
    payout_id: po.Id,
    last_error: po.Status === "FAILED" ? po.ResultMessage ?? null : null,
    updated_at: new Date().toISOString(),
  }).eq("id", payout.id);
}
