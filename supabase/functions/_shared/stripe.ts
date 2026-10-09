// Stripe Billing : encaissement des abonnements NEO-SUSU (revenu de la plateforme).
// L'argent des tontines, lui, passe uniquement par Mangopay.
// Secrets : STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET et un prix Stripe par plan et periode :
// STRIPE_PRICE_ESSENTIEL_MONTH, STRIPE_PRICE_ESSENTIEL_YEAR, STRIPE_PRICE_PRO_MONTH, STRIPE_PRICE_PRO_YEAR.
import Stripe from "npm:stripe@22.6.2";

export const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  httpClient: Stripe.createFetchHttpClient(),
});
export const cryptoProvider = Stripe.createSubtleCryptoProvider();

export type PaidPlan = "essentiel" | "pro";
export type Period = "month" | "year";

const PRICES: Record<PaidPlan, Record<Period, string>> = {
  essentiel: {
    month: Deno.env.get("STRIPE_PRICE_ESSENTIEL_MONTH") ?? "",
    year: Deno.env.get("STRIPE_PRICE_ESSENTIEL_YEAR") ?? "",
  },
  pro: {
    month: Deno.env.get("STRIPE_PRICE_PRO_MONTH") ?? "",
    year: Deno.env.get("STRIPE_PRICE_PRO_YEAR") ?? "",
  },
};

export function priceFor(plan: string, period: string): string | null {
  const price = PRICES[plan as PaidPlan]?.[period as Period];
  return price || null;
}

export function planForPrice(priceId: string): { plan: PaidPlan; period: Period } | null {
  for (const plan of Object.keys(PRICES) as PaidPlan[]) {
    for (const period of ["month", "year"] as Period[]) {
      if (PRICES[plan][period] === priceId) return { plan, period };
    }
  }
  return null;
}
