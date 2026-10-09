// node --experimental-strip-types --test supabase/tests/distribution.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { feeFor, isRoundReady, planRound, type PaidContribution } from "../functions/_shared/distribution.ts";

const members = Array.from({ length: 10 }, (_, i) => `u${i + 1}`);
const contribs = (status: "paid" | "transferred" = "paid"): PaidContribution[] =>
  members.map((u, i) => ({ id: `c${i + 1}`, user_id: u, amount_cents: 5000, wallet_id: `w-${u}`, status }));

test("commission 1,5% arrondie", () => {
  assert.equal(feeFor(5000, 150), 75);
  assert.equal(feeFor(2500000, 150), 37500); // 25 000,00 -> 375,00 (meme valeur que l'apercu de l'app)
  assert.equal(feeFor(5000, 0), 0);
  assert.throws(() => feeFor(0, 150));
  assert.throws(() => feeFor(5000, 5000));
});

test("tour pret seulement quand les 10 membres ont paye", () => {
  const all = contribs();
  assert.equal(isRoundReady(members, all), true);
  assert.equal(isRoundReady(members, all.slice(1)), false);
  assert.equal(isRoundReady(members, [...all.slice(1), { user_id: "u1", status: "pending" }]), false);
  assert.equal(isRoundReady([], []), false);
});

test("groupe de 10 a 50 EUR, plan Free : 9 transferts, beneficiaire recoit 493,25 EUR", () => {
  const plan = planRound("u3", contribs(), 150);
  assert.equal(plan.transfers.length, 9);
  assert.ok(plan.transfers.every((t) => t.from_user_id !== "u3"));
  assert.equal(plan.fees_cents, 9 * 75);
  assert.equal(plan.payout_cents, 5000 + 9 * (5000 - 75));
  // Rien ne se cree ni ne se perd : total collecte = verse + commissions
  assert.equal(plan.payout_cents + plan.fees_cents, 10 * 5000);
});

test("reprise apres echec partiel : les cotisations deja transferees ne sont pas rejouees", () => {
  const c = contribs();
  c[0].status = "transferred";
  c[1].status = "transferred";
  const plan = planRound("u10", c, 150);
  assert.equal(plan.transfers.length, 7);
  assert.equal(plan.payout_cents, 5000 + 9 * 4925); // le montant final ne change pas
});
