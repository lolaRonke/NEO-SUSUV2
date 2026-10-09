// Calcul pur de la repartition d'un tour de tontine (aucun appel reseau).
// Montants en centimes (unite mineure), comme l'API Mangopay.

export type PaidContribution = {
  id: string;
  user_id: string;
  amount_cents: number;
  wallet_id: string;
  // covered : cotisation d'un membre defaillant, payee par la reserve de garantie du groupe
  // (deja versee sur le wallet du beneficiaire, commission comprise).
  status: "paid" | "transferred" | "covered";
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
  // Part reversee a la reserve de garantie du groupe (beneficiaire ayant pris l'option)
  guarantee_cents: number;
};

// Option garantie : 3 % prelevés sur la cagnotte, comme la commission, au profit de la reserve du groupe.
export const GUARANTEE_BPS = 300;

// Commission arrondie a l'unite la plus proche, comme l'apercu de create-tontine.html.
export function feeFor(amountCents: number, feeBps: number): number {
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error("montant invalide");
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 1000) throw new Error("commission invalide");
  return Math.round((amountCents * feeBps) / 10000);
}

// Un tour est pret quand chaque membre a une cotisation payee.
export function isRoundReady(memberIds: string[], contributions: { user_id: string; status: string }[]): boolean {
  const paid = new Set(
    contributions.filter((c) => c.status === "paid" || c.status === "transferred" || c.status === "covered")
      .map((c) => c.user_id),
  );
  return memberIds.length > 0 && memberIds.every((id) => paid.has(id));
}

// La cotisation du beneficiaire reste dans son propre wallet (pas de transfert, donc pas de commission).
// Chaque autre cotisation est transferee vers le wallet du beneficiaire, commission prelevee au passage.
// Si le beneficiaire a pris la garantie (guaranteeBps > 0), la part garantie est calculee sur les memes
// cotisations et reversee ensuite a la reserve du groupe.
export function planRound(
  beneficiaryId: string,
  contributions: PaidContribution[],
  feeBps: number,
  guaranteeBps = 0,
): RoundPlan {
  let payout = 0;
  let fees = 0;
  let guarantee = 0;
  const transfers: TransferStep[] = [];
  for (const c of contributions) {
    if (c.user_id === beneficiaryId) {
      payout += c.amount_cents;
      continue;
    }
    const fee = feeFor(c.amount_cents, feeBps);
    const share = feeFor(c.amount_cents, guaranteeBps);
    payout += c.amount_cents - fee - share;
    fees += fee;
    guarantee += share;
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
  return { transfers, payout_cents: payout, fees_cents: fees, guarantee_cents: guarantee };
}

export type Missing = { user_id: string; amount_cents: number };

// La reserve couvre toutes les cotisations manquantes du tour, ou aucune : un versement partiel
// laisserait le tour bloque tout en vidant la reserve.
export function planCover(missing: Missing[], balanceCents: number): { cover: boolean; needed_cents: number } {
  const needed = missing.reduce((s, m) => s + m.amount_cents, 0);
  return { cover: missing.length > 0 && needed <= balanceCents, needed_cents: needed };
}

// Reliquat de la reserve en fin de tontine, rendu au prorata de ce que chacun y a verse.
// Les centimes d'arrondi vont aux plus gros contributeurs, pour que la somme rendue soit exacte.
export function planRefunds(balanceCents: number, paidIn: { user_id: string; cents: number }[]): { user_id: string; cents: number }[] {
  const total = paidIn.reduce((s, p) => s + p.cents, 0);
  if (balanceCents <= 0 || total <= 0) return [];
  const shares = paidIn.map((p) => ({ user_id: p.user_id, exact: (balanceCents * p.cents) / total, cents: p.cents }));
  const out = shares.map((s) => ({ user_id: s.user_id, cents: Math.floor(s.exact) }));
  let rest = balanceCents - out.reduce((s, o) => s + o.cents, 0);
  const order = shares.map((s, i) => ({ i, frac: s.exact - Math.floor(s.exact), cents: s.cents }))
    .sort((a, b) => b.frac - a.frac || b.cents - a.cents);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest--) out[order[k].i].cents++;
  return out.filter((o) => o.cents > 0);
}
