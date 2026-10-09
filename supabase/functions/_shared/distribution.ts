// Calcul pur de la repartition d'un tour de tontine (aucun appel reseau).
// Montants en centimes (unite mineure), comme l'API Mangopay.

export type PaidContribution = {
  id: string;
  user_id: string;
  amount_cents: number;
  wallet_id: string;
  status: "paid" | "transferred";
};

export type TransferStep = {
  contribution_id: string;
  from_user_id: string;
  from_wallet_id: string;
  debited_cents: number;
  fee_cents: number;
};

export type RoundPlan = {
  transfers: TransferStep[];
  // Montant total qui doit se trouver dans le wallet du beneficiaire pour ce tour
  payout_cents: number;
  fees_cents: number;
};

// Commission arrondie a l'unite la plus proche, comme l'apercu de create-tontine.html.
export function feeFor(amountCents: number, feeBps: number): number {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error("montant invalide");
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 1000) throw new Error("commission invalide");
  return Math.round((amountCents * feeBps) / 10000);
}

// Un tour est pret quand chaque membre a une cotisation payee.
export function isRoundReady(memberIds: string[], contributions: { user_id: string; status: string }[]): boolean {
  const paid = new Set(
    contributions.filter((c) => c.status === "paid" || c.status === "transferred").map((c) => c.user_id),
  );
  return memberIds.length > 0 && memberIds.every((id) => paid.has(id));
}

// La cotisation du beneficiaire reste dans son propre wallet (pas de transfert, donc pas de commission).
// Chaque autre cotisation est transferee vers le wallet du beneficiaire, commission prelevee au passage.
export function planRound(beneficiaryId: string, contributions: PaidContribution[], feeBps: number): RoundPlan {
  let payout = 0;
  let fees = 0;
  const transfers: TransferStep[] = [];
  for (const c of contributions) {
    if (c.user_id === beneficiaryId) {
      payout += c.amount_cents;
      continue;
    }
    const fee = feeFor(c.amount_cents, feeBps);
    payout += c.amount_cents - fee;
    fees += fee;
    if (c.status === "paid") {
      transfers.push({
        contribution_id: c.id,
        from_user_id: c.user_id,
        from_wallet_id: c.wallet_id,
        debited_cents: c.amount_cents,
        fee_cents: fee,
      });
    }
  }
  return { transfers, payout_cents: payout, fees_cents: fees };
}
