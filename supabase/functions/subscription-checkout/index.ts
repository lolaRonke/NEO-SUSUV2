// Ouvre la page de paiement Stripe pour souscrire un plan.
// POST { plan: "essentiel" | "pro", period: "month" | "year" } -> { url }
// Si l'utilisateur a deja un abonnement, renvoie vers l'espace de gestion Stripe (changement de plan).
import type { SupabaseClient, User } from "npm:@supabase/supabase-js@2.45.4";
import { admin, handle, HttpError, json, requireUser } from "../_shared/supabase.ts";
import { priceFor, stripe } from "../_shared/stripe.ts";

const APP_URL = (Deno.env.get("APP_URL") ?? "https://lolaronke.github.io/neo-susu").replace(/\/$/, "");

// Un seul client Stripe par utilisateur, meme en cas de double clic.
async function stripeCustomerFor(db: SupabaseClient, user: User): Promise<string> {
  const { data: existing } = await db.from("billing_customers").select("stripe_customer_id").eq("user_id", user.id).maybeSingle();
  if (existing) return existing.stripe_customer_id;
  const customer = await stripe.customers.create(
    { email: user.email, metadata: { user_id: user.id } },
    { idempotencyKey: `customer-${user.id}` },
  );
  await db.from("billing_customers").upsert(
    { user_id: user.id, stripe_customer_id: customer.id },
    { onConflict: "user_id", ignoreDuplicates: true },
  );
  return customer.id;
}

Deno.serve(handle(async (req) => {
  const user = await requireUser(req);
  const { plan, period } = await req.json().catch(() => ({}));
  const price = priceFor(plan, period);
  if (!price) throw new HttpError(400, "Plan ou periode invalide");

  const customer = await stripeCustomerFor(admin, user);

  const { data: current } = await admin
    .from("subscriptions")
    .select("status, current_period_end")
    .eq("user_id", user.id)
    .maybeSingle();
  const hasActive = current && ["active", "trialing", "past_due"].includes(current.status) &&
    new Date(current.current_period_end) > new Date();
  if (hasActive) {
    const portal = await stripe.billingPortal.sessions.create({ customer, return_url: `${APP_URL}/dashboard.html` });
    return json({ url: portal.url, portal: true });
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer,
    client_reference_id: user.id,
    line_items: [{ price, quantity: 1 }],
    subscription_data: { metadata: { user_id: user.id } },
    allow_promotion_codes: true,
    success_url: `${APP_URL}/dashboard.html?abonnement=ok`,
    cancel_url: `${APP_URL}/dashboard.html?abonnement=annule`,
  });
  return json({ url: session.url });
}));
