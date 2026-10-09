// Espace de gestion Stripe : changer de plan, de carte, telecharger les factures, resilier.
// POST {} -> { url }
import { admin, handle, HttpError, json, requireUser } from "../_shared/supabase.ts";
import { stripe } from "../_shared/stripe.ts";

const APP_URL = (Deno.env.get("APP_URL") ?? "https://lolaronke.github.io/neo-susu").replace(/\/$/, "");

Deno.serve(handle(async (req) => {
  const user = await requireUser(req);
  const { data: customer } = await admin
    .from("billing_customers")
    .select("stripe_customer_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!customer) throw new HttpError(404, "Aucun abonnement");
  const portal = await stripe.billingPortal.sessions.create({
    customer: customer.stripe_customer_id,
    return_url: `${APP_URL}/dashboard.html`,
  });
  return json({ url: portal.url });
}));
