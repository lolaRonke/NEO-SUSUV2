// Recoit les notifications Mangopay (GET ?EventType=...&RessourceId=...&token=...).
// Mangopay ne signe pas ses webhooks : on exige un jeton secret dans l'URL ET on relit
// la ressource aupres de l'API avant d'agir, on ne fait jamais confiance au contenu de l'appel.
// A deployer avec --no-verify-jwt (Mangopay n'envoie pas de JWT Supabase).
import { admin } from "../_shared/supabase.ts";
import { mangopay } from "../_shared/mangopay.ts";
import { distributeRound } from "../_shared/distribute.ts";

const SECRET = Deno.env.get("MANGOPAY_WEBHOOK_TOKEN") ?? "";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (!SECRET || url.searchParams.get("token") !== SECRET) return new Response("forbidden", { status: 403 });
  const event = url.searchParams.get("EventType") ?? "";
  const id = url.searchParams.get("RessourceId") ?? "";
  if (!id) return new Response("ok");

  try {
    if (event.startsWith("PAYIN_NORMAL_")) {
      const payIn = await mangopay.getPayIn(id);
      if (payIn.Status === "CREATED") return new Response("ok");
      const now = new Date().toISOString();
      if (payIn.Status === "SUCCEEDED") {
        // Retrouve la cotisation par le Tag pose a la creation : un paiement reussi compte meme si
        // le membre a relance un autre paiement entre-temps (payin_id remplace).
        const contributionId = payIn.Tag?.startsWith("contribution:") ? payIn.Tag.slice(13) : null;
        if (!contributionId) return new Response("ok");
        await admin
          .from("contributions")
          .update({ status: "paid", payin_id: payIn.Id, updated_at: now })
          .eq("id", contributionId)
          .in("status", ["pending", "failed"]);
        const { data: c } = await admin.from("contributions").select("round_id").eq("id", contributionId).maybeSingle();
        // Derniere cotisation du groupe recue -> repartition automatique. Si une notification
        // precedente a echoue en cours de route, la relance de Mangopay reprend la repartition.
        if (c) await distributeRound(admin, c.round_id);
      } else {
        // Un echec ne compte que pour la tentative en cours.
        await admin.from("contributions").update({ status: "failed", updated_at: now })
          .eq("payin_id", payIn.Id).eq("status", "pending");
      }
    } else if (event.startsWith("PAYOUT_NORMAL_")) {
      const payout = await mangopay.getPayout(id);
      if (payout.Status !== "CREATED") {
        await admin.from("payouts").update({
          status: payout.Status === "SUCCEEDED" ? "succeeded" : "failed",
          last_error: payout.Status === "FAILED" ? payout.ResultMessage ?? null : null,
          updated_at: new Date().toISOString(),
        }).eq("payout_id", payout.Id);
      }
    }
  } catch (e) {
    // 500 -> Mangopay renverra la notification plus tard.
    console.error(event, id, e);
    return new Response("error", { status: 500 });
  }
  return new Response("ok");
});
