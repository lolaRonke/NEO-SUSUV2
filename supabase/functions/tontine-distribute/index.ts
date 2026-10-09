// Relance manuelle (admin) d'un tour en echec ou bloque. Rejouable sans risque :
// transferts et virements utilisent des cles d'idempotence Mangopay.
// POST { round_id } avec l'en-tete x-admin-secret: <DISTRIBUTE_SECRET>
import { admin, handle, HttpError, json } from "../_shared/supabase.ts";
import { distributeRound } from "../_shared/distribute.ts";

const SECRET = Deno.env.get("DISTRIBUTE_SECRET") ?? "";

Deno.serve(handle(async (req) => {
  if (!SECRET || req.headers.get("x-admin-secret") !== SECRET) throw new HttpError(403, "Interdit");
  const { round_id } = await req.json().catch(() => ({}));
  if (!round_id) throw new HttpError(400, "round_id requis");
  return json(await distributeRound(admin, round_id));
}));
