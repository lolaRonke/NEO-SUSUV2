// node --experimental-strip-types --test supabase/tests/plans.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../../", import.meta.url);
const ctx: Record<string, any> = { localStorage: { getItem: () => null, setItem() {} }, window: {} };
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL("plans.js", root), "utf8") + "\nthis.NEO_PLANS = NEO_PLANS;", ctx);
const { NEO_PLANS, neoFee, neoCycleCost, neoPlan } = ctx;

test("plans.js est identique au catalogue SQL (prix, commission, limites)", () => {
  const sql = readFileSync(new URL("supabase/migrations/20261009140000_abonnements.sql", root), "utf8");
  const rows = [...sql.matchAll(/\('(\w+)',\s*'[^']+',\s*(\d+),\s*(\d+),\s*(\d+),\s*(null|\d+),\s*(\d+),\s*\d+\)/g)];
  assert.equal(rows.length, NEO_PLANS.length);
  for (const [, id, month, year, fee, maxT, maxM] of rows) {
    const p = NEO_PLANS.find((x: any) => x.id === id);
    assert.ok(p, `plan ${id} absent de plans.js`);
    assert.equal(Math.round(p.month * 100), Number(month), `${id} prix mensuel`);
    assert.equal(Math.round(p.year * 100), Number(year), `${id} prix annuel`);
    assert.equal(p.feeBps, Number(fee), `${id} commission`);
    assert.equal(p.maxTontines, maxT === "null" ? null : Number(maxT), `${id} tontines`);
    assert.equal(p.maxMembers, Number(maxM), `${id} membres`);
  }
});

test("l'annuel offre 2 mois", () => {
  for (const p of NEO_PLANS) assert.equal(Math.round(p.year * 100), Math.round(p.month * 100) * 10);
});

test("anciens noms de plans (premium/business) reconnus", () => {
  ctx.localStorage.getItem = () => "premium";
  assert.equal(neoPlan().id, "essentiel");
  ctx.localStorage.getItem = () => "business";
  assert.equal(neoPlan().id, "pro");
  ctx.localStorage.getItem = () => null;
  assert.equal(neoPlan().id, "free");
});

test("commission au centime, comme le serveur", () => {
  const [free, ess, pro] = NEO_PLANS;
  assert.equal(neoFee(50, free), 0.75);
  assert.equal(neoFee(50, ess), 0.25);
  assert.equal(neoFee(50, pro), 0);
  assert.equal(neoFee(33.33, free), 0.5);
});

test("simulateur : cout d'un cycle complet pour le groupe", () => {
  const [free, ess, pro] = NEO_PLANS;
  // 10 membres a 50 EUR : 90 cotisations commissionnees sur 10 mois
  assert.equal(JSON.stringify(neoCycleCost(free, 50, 10, "month")), JSON.stringify({ fees: 67.5, sub: 0, total: 67.5 }));
  assert.equal(neoCycleCost(ess, 50, 10, "month").total, 72.4); // 22,50 + 10 x 4,99
  assert.equal(neoCycleCost(pro, 50, 10, "month").total, 149.9);
  // 10 membres a 100 EUR : Essentiel devient le moins cher
  assert.equal(neoCycleCost(free, 100, 10, "month").total, 135);
  assert.equal(neoCycleCost(ess, 100, 10, "month").total, 94.9);
  // annuel : un an payé couvre un cycle de 10 mois
  assert.equal(neoCycleCost(ess, 100, 10, "year").total, 94.9); // 45 + 49,90
  // limites de membres
  assert.equal(neoCycleCost(free, 50, 12, "month"), null);
  assert.ok(neoCycleCost(ess, 50, 20, "month"));
  assert.equal(neoCycleCost(ess, 50, 21, "month"), null);
});
