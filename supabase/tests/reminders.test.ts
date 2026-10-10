// node --experimental-strip-types --test supabase/tests/reminders.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildEmail, fallbackDraft, isDraftAcceptable, LEGAL_NOTICE_LEVEL_3, nextReminderLevel, type ReminderFacts,
} from "../functions/_shared/reminders.ts";

const due = new Date("2026-10-01T00:00:00Z");
const day = (n: number) => new Date(due.getTime() + n * 86400000);
const iso = (n: number) => day(n).toISOString();

test("pas de relance avant l'echeance", () => {
  assert.equal(nextReminderLevel(due, [], day(-1)), null);
});

test("relance 1 des que le paiement est en retard", () => {
  assert.equal(nextReminderLevel(due, [], day(0)), 1);
  assert.equal(nextReminderLevel(due, [], day(5)), 1);
});

test("relance 2 exactement 10 jours apres la 1re", () => {
  const sent = [{ level: 1, sent_at: iso(1) }];
  assert.equal(nextReminderLevel(due, sent, day(10)), null);
  assert.equal(nextReminderLevel(due, sent, day(11)), 2);
});

test("relance 3 (huissier) 10 jours apres la 2e, puis plus rien", () => {
  const two = [{ level: 1, sent_at: iso(1) }, { level: 2, sent_at: iso(11) }];
  assert.equal(nextReminderLevel(due, two, day(20)), null);
  assert.equal(nextReminderLevel(due, two, day(21)), 3);
  const three = [...two, { level: 3, sent_at: iso(21) }];
  assert.equal(nextReminderLevel(due, three, day(400)), null);
});

test("une relance reservee mais non envoyee (sent_at null) ne compte pas", () => {
  assert.equal(nextReminderLevel(due, [{ level: 1, sent_at: null }], day(3)), 1);
});

const facts: ReminderFacts = {
  firstName: "Aicha", tontineName: "Famille Diallo", roundNumber: 4, amount: "50,00 EUR",
  dueDate: "1 octobre 2026", daysLate: 21, payUrl: "https://app.example/tontine-detail.html?id=t1",
};

test("garde-fous : aucune menace juridique ni lien venant de l'IA", () => {
  const ok = { subject: "Petit rappel", body: "Bonjour Aicha, votre cotisation est en attente, merci de la regler." };
  assert.equal(isDraftAcceptable(1, ok), true);
  assert.equal(isDraftAcceptable(1, { ...ok, body: ok.body + " Sinon un huissier viendra." }), false);
  assert.equal(isDraftAcceptable(3, { ...ok, body: ok.body + " Mise en demeure." }), false);
  assert.equal(isDraftAcceptable(2, { ...ok, body: ok.body + " Payez sur https://evil.example" }), false);
  assert.equal(isDraftAcceptable(1, { subject: "", body: ok.body }), false);
  assert.equal(isDraftAcceptable(1, null), false);
});

test("les modeles de secours passent les garde-fous", () => {
  for (const lvl of [1, 2, 3] as const) assert.equal(isDraftAcceptable(lvl, fallbackDraft(lvl, facts)), true);
});

test("seule la 3e relance contient la mention du commissaire de justice (huissier)", () => {
  for (const lvl of [1, 2] as const) {
    const m = buildEmail(lvl, facts, fallbackDraft(lvl, facts));
    assert.ok(!/huissier|commissaire/i.test(m.text + m.html));
  }
  const m3 = buildEmail(3, facts, fallbackDraft(3, facts));
  assert.ok(m3.text.includes(LEGAL_NOTICE_LEVEL_3));
  assert.ok(m3.html.includes("huissier"));
  assert.ok(m3.text.includes("50,00 EUR") && m3.text.includes(facts.payUrl) && m3.text.includes("3 sur 3"));
});

test("le HTML echappe le texte genere", () => {
  const m = buildEmail(1, { ...facts, firstName: "<script>x</script>" }, { subject: "s", body: "Bonjour <b>toi</b>, merci de regler ta cotisation." });
  assert.ok(!m.html.includes("<b>toi</b>") && m.html.includes("&lt;b&gt;"));
});
