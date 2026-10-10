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

import { GUARANTEE_BPS, planCover, planRefunds } from "../functions/_shared/distribution.ts";

test("garantie : 3 % en plus de la commission, sur les 9 cotisations des autres", () => {
  const plan = planRound("u3", contribs(), 150, GUARANTEE_BPS);
  assert.equal(plan.fees_cents, 9 * 75);
  assert.equal(plan.guarantee_cents, 9 * 150); // 13,50 EUR vers la reserve
  assert.equal(plan.payout_cents, 5000 + 9 * (5000 - 75 - 150)); // 479,75 EUR
  assert.equal(plan.payout_cents + plan.fees_cents + plan.guarantee_cents, 10 * 5000);
});

test("sans garantie, le calcul ne change pas", () => {
  assert.equal(planRound("u3", contribs(), 150).guarantee_cents, 0);
  assert.equal(planRound("u3", contribs(), 150, 0).payout_cents, 5000 + 9 * 4925);
});

test("une cotisation couverte par la reserve compte comme payee, sans nouveau transfert", () => {
  const c = contribs();
  c[4].status = "covered";
  assert.equal(isRoundReady(members, c), true);
  const plan = planRound("u1", c, 150, GUARANTEE_BPS);
  assert.equal(plan.transfers.length, 8);
  assert.ok(!plan.transfers.some((t) => t.contribution_id === "c5"));
  assert.equal(plan.payout_cents, 5000 + 9 * (5000 - 75 - 150));
});

test("la reserve couvre tout le manque ou rien", () => {
  const missing = [{ user_id: "u5", amount_cents: 5000 }, { user_id: "u6", amount_cents: 5000 }];
  assert.deepEqual(planCover(missing, 10000), { cover: true, needed_cents: 10000 });
  assert.deepEqual(planCover(missing, 9999), { cover: false, needed_cents: 10000 });
  assert.equal(planCover([], 10000).cover, false);
});

test("reliquat rendu au prorata, au centime pres", () => {
  const r = planRefunds(1000, [{ user_id: "a", cents: 300 }, { user_id: "b", cents: 300 }, { user_id: "c", cents: 300 }]);
  assert.equal(r.reduce((s, x) => s + x.cents, 0), 1000);
  assert.deepEqual(r.map((x) => x.cents).sort(), [333, 333, 334]);
  const r2 = planRefunds(700, [{ user_id: "a", cents: 450 }, { user_id: "b", cents: 150 }]);
  assert.deepEqual(r2, [{ user_id: "a", cents: 525 }, { user_id: "b", cents: 175 }]);
  assert.deepEqual(planRefunds(0, [{ user_id: "a", cents: 1 }]), []);
});
