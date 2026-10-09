// Lance le paiement par carte de la cotisation du membre connecte pour le tour en cours.
// POST { tontine_id, return_url } -> { redirect_url } (page de paiement Mangopay)
import { admin, handle, HttpError, json, PAYMENT_CURRENCY, requireUser } from "../_shared/supabase.ts";
import { mangopay } from "../_shared/mangopay.ts";

Deno.serve(handle(async (req) => {
  const user = await requireUser(req);
  const { tontine_id, return_url } = await req.json().catch(() => ({}));
  if (!tontine_id || !return_url) throw new HttpError(400, "tontine_id et return_url requis");

  const [{ data: member }, { data: tontine }, { data: round }, { data: account }] = await Promise.all([
    admin.from("tontine_members").select("user_id").eq("tontine_id", tontine_id).eq("user_id", user.id).maybeSingle(),
    admin.from("tontines").select("amount").eq("id", tontine_id).single(),
    admin.from("tontine_rounds").select("id").eq("tontine_id", tontine_id).eq("status", "collecting").maybeSingle(),
    admin.from("payment_accounts").select("provider_user_id, wallet_id").eq("user_id", user.id).maybeSingle(),
  ]);
  if (!member) throw new HttpError(403, "Vous n'etes pas membre de cette tontine");
  if (!round) throw new HttpError(409, "Aucun tour en cours (le groupe n'est peut-etre pas encore complet)");
  if (!account) throw new HttpError(409, "Creez d'abord votre compte de paiement");

  // tontines.amount est en unites (ex. 50 EUR) ; Mangopay attend des centimes.
  const amountCents = Math.round(Number(tontine!.amount) * 100);
  if (!(amountCents > 0)) throw new HttpError(400, "Montant de cotisation invalide");

  const { data: contribution, error } = await admin
    .from("contributions")
    .upsert({ round_id: round.id, user_id: user.id, amount_cents: amountCents }, { onConflict: "round_id,user_id" })
    .select("id, status")
    .single();
  if (error) throw error;
  if (contribution.status === "paid" || contribution.status === "transferred") {
    throw new HttpError(409, "Cotisation deja payee pour ce tour");
  }

  const payIn = await mangopay.createCardWebPayIn({
    authorId: account.provider_user_id,
    walletId: account.wallet_id,
    currency: PAYMENT_CURRENCY,
    amount: amountCents,
    returnUrl: return_url,
    tag: `contribution:${contribution.id}`,
  });
  await admin.from("contributions")
    .update({ payin_id: payIn.Id, status: "pending", updated_at: new Date().toISOString() })
    .eq("id", contribution.id);

  return json({ redirect_url: payIn.RedirectURL });
}));
