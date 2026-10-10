// Cree le compte Mangopay (utilisateur + wallet) du membre connecte et/ou enregistre son IBAN.
// POST { identity?: {...NaturalUserInput sans email}, iban?: string }
import { admin, handle, HttpError, json, PAYMENT_CURRENCY, requireUser } from "../_shared/supabase.ts";
import { mangopay } from "../_shared/mangopay.ts";
import { sendPayout } from "../_shared/distribute.ts";

Deno.serve(handle(async (req) => {
  const user = await requireUser(req);
  const body = await req.json().catch(() => ({}));

  let { data: account } = await admin
    .from("payment_accounts")
    .select("user_id, provider_user_id, wallet_id, bank_account_id")
    .eq("user_id", user.id)
    .maybeSingle();

  const id = body.identity;
  if (!account) {
    if (!id?.firstName || !id?.lastName || !id?.birthday || !id?.nationality || !id?.address) {
      throw new HttpError(400, "Identite incomplete (nom, prenom, date de naissance, nationalite, adresse)");
    }
    const mpUser = await mangopay.createNaturalUser({ ...id, email: user.email!, countryOfResidence: id.countryOfResidence ?? id.address.Country });
    const wallet = await mangopay.createWallet(mpUser.Id, PAYMENT_CURRENCY);
    const { data, error } = await admin
      .from("payment_accounts")
      .insert({ user_id: user.id, provider_user_id: mpUser.Id, wallet_id: wallet.Id, currency: PAYMENT_CURRENCY })
      .select("user_id, provider_user_id, wallet_id, bank_account_id")
      .single();
    if (error) throw error;
    account = data;
  }

  if (body.iban) {
    if (!id?.address) throw new HttpError(400, "Adresse requise avec l'IBAN");
    const bank = await mangopay.createIbanAccount(
      account!.provider_user_id,
      `${id.firstName ?? ""} ${id.lastName ?? ""}`.trim() || user.email!,
      body.iban,
      id.address,
    );
    await admin.from("payment_accounts").update({ bank_account_id: bank.Id }).eq("user_id", user.id);
    account!.bank_account_id = bank.Id;

    // Virements en attente faute d'IBAN, ou echoues (IBAN errone) : on les envoie maintenant.
    const { data: waiting } = await admin
      .from("payouts")
      .select("id, round_id, user_id, amount_cents, attempts")
      .eq("user_id", user.id)
      .in("status", ["awaiting_bank_account", "failed"]);
    for (const p of waiting ?? []) await sendPayout(admin, p, account!);
  }

  return json({ ok: true, has_bank_account: !!account!.bank_account_id });
}));
