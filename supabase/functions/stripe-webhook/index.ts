// Recoit les evenements Stripe (signes) et tient a jour public.subscriptions.
// A deployer avec --no-verify-jwt. Evenements a activer dans Stripe :
// customer.subscription.created, customer.subscription.updated, customer.subscription.deleted
import type Stripe from "npm:stripe@22.6.2";
import { admin } from "../_shared/supabase.ts";
import { cryptoProvider, planForPrice, stripe } from "../_shared/stripe.ts";

const SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";
const ENDED = ["canceled", "incomplete_expired"];

Deno.serve(async (req) => {
  const signature = req.headers.get("Stripe-Signature");
  if (!SECRET || !signature) return new Response("forbidden", { status: 403 });

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(await req.text(), signature, SECRET, undefined, cryptoProvider);
  } catch {
    return new Response("signature invalide", { status: 400 });
  }
  if (!event.type.startsWith("customer.subscription.")) return new Response("ok");

  try {
    // Les evenements peuvent arriver dans le desordre : on relit l'etat actuel chez Stripe.
    const sub = await stripe.subscriptions.retrieve((event.data.object as Stripe.Subscription).id);
    const item = sub.items.data[0];
    const mapped = item ? planForPrice(item.price.id) : null;
    if (!mapped) {
      console.warn(`Abonnement ${sub.id} : prix inconnu ${item?.price.id}`);
      return new Response("ok");
    }

    let userId = sub.metadata.user_id;
    if (!userId) {
      const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
      const { data } = await admin.from("billing_customers").select("user_id").eq("stripe_customer_id", customerId).maybeSingle();
      userId = data?.user_id;
    }
    if (!userId) {
      console.warn(`Abonnement ${sub.id} : utilisateur introuvable`);
      return new Response("ok");
    }

    const row = {
      user_id: userId,
      plan_id: mapped.plan,
      billing_period: mapped.period,
      status: sub.status,
      stripe_subscription_id: sub.id,
      current_period_end: new Date(item.current_period_end * 1000).toISOString(),
      cancel_at_period_end: sub.cancel_at_period_end,
      updated_at: new Date().toISOString(),
    };

    if (ENDED.includes(sub.status)) {
      // La fin d'un ancien abonnement ne doit pas ecraser un abonnement plus recent.
      await admin.from("subscriptions").update(row).eq("user_id", userId).eq("stripe_subscription_id", sub.id);
    } else {
      await admin.from("subscriptions").upsert(row, { onConflict: "user_id" });
    }
  } catch (e) {
    console.error(event.type, e);
    return new Response("error", { status: 500 }); // Stripe renverra l'evenement
  }
  return new Response("ok");
});
