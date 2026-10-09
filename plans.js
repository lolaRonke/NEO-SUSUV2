// ── Catalogue des abonnements NEO-SUSU ──
// Doit rester identique a la table public.plans (supabase/migrations/20261009140000_abonnements.sql) :
// c'est la base qui fait foi pour les limites et la commission reellement prelevee.
const NEO_PLANS = [
  { id: "free",      name: "Gratuit",   nameEn: "Free",   month: 0,     year: 0,      feeBps: 150, maxTontines: 1,    maxMembers: 10 },
  { id: "essentiel", name: "Essentiel", month: 4.99,  year: 49.90,  feeBps: 50,  maxTontines: 3,    maxMembers: 20, popular: true },
  { id: "pro",       name: "Pro",       month: 14.99, year: 149.90, feeBps: 0,   maxTontines: null, maxMembers: 50 },
];
const NEO_LEGACY_PLANS = { premium: "essentiel", business: "pro" };

function neoPlanId() {
  let id = null;
  try { id = localStorage.getItem("ns_plan"); } catch (e) {}
  id = NEO_LEGACY_PLANS[id] || id;
  return NEO_PLANS.some(p => p.id === id) ? id : "free";
}
function neoName(plan) { return (neoLang() === "en" && plan.nameEn) || plan.name; }
function neoPlan(id) { return NEO_PLANS.find(p => p.id === (id || neoPlanId())); }
function neoLang() { try { return localStorage.getItem("ns_lang") || "fr"; } catch (e) { return "fr"; } }
function neoEur(n) { return n.toLocaleString(neoLang() === "en" ? "en-IE" : "fr-FR", { style: "currency", currency: "EUR" }); }
function neoPct(bps) { const v = (bps / 100).toLocaleString(neoLang() === "en" ? "en-GB" : "fr-FR"); return neoLang() === "en" ? v + "%" : v + " %"; }

// Commission sur une cotisation, au centime pres (meme arrondi que le serveur de paiement).
function neoFee(amount, plan) { return Math.round(amount * 100 * plan.feeBps / 10000) / 100; }

// Cout total pour le groupe sur un cycle complet (un tour par membre, un tour par mois) :
// commissions prelevees sur les cagnottes + abonnement de l'organisateur sur la duree du cycle.
// A chaque tour, la cotisation du beneficiaire reste chez lui : seules (membres - 1) sont commissionnees.
function neoCycleCost(plan, amount, members, period) {
  if (members > plan.maxMembers) return null;
  const fees = members * (members - 1) * neoFee(amount, plan);
  const months = members;
  const sub = period === "year" ? plan.year * Math.ceil(months / 12) : plan.month * months;
  return { fees, sub, total: Math.round((fees + sub) * 100) / 100 };
}

// Plan reel de l'utilisateur, lu en base quand Supabase est configure (window.NEO_SUPABASE).
async function neoSyncPlan() {
  const sb = window.NEO_SUPABASE;
  if (!sb) return neoPlanId();
  const { data, error } = await sb.rpc("my_plan");
  if (!error && data && data[0]) { try { localStorage.setItem("ns_plan", data[0].id); } catch (e) {} }
  return neoPlanId();
}

// Souscription : page de paiement Stripe. En mode demo, renvoie false.
async function neoCheckout(planId, period) {
  const sb = window.NEO_SUPABASE;
  if (!sb) return false;
  const { data, error } = await sb.functions.invoke("subscription-checkout", { body: { plan: planId, period } });
  if (error || !data || !data.url) throw new Error(error ? error.message : "checkout");
  window.location.href = data.url;
  return true;
}

async function neoManageSubscription() {
  const sb = window.NEO_SUPABASE;
  if (!sb) return false;
  const { data, error } = await sb.functions.invoke("subscription-portal", { body: {} });
  if (error || !data || !data.url) throw new Error(error ? error.message : "portal");
  window.location.href = data.url;
  return true;
}
