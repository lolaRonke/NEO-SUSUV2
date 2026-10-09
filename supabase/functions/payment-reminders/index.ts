// Relances automatiques des membres en retard, a lancer une fois par jour (pg_cron, voir PAIEMENTS.md).
// POST avec l'en-tete x-admin-secret: <CRON_SECRET>
import { admin, handle, HttpError, json, PAYMENT_CURRENCY } from "../_shared/supabase.ts";
import { buildEmail, fallbackDraft, nextReminderLevel, type ReminderFacts } from "../_shared/reminders.ts";
import { writeReminder } from "../_shared/ai-writer.ts";
import { sendEmail } from "../_shared/mailer.ts";

const SECRET = Deno.env.get("CRON_SECRET") ?? "";
const APP_URL = (Deno.env.get("APP_URL") ?? "https://lolaronke.github.io/neo-susu").replace(/\/$/, "");
const DAY_MS = 24 * 60 * 60 * 1000;

const money = new Intl.NumberFormat("fr-FR", { style: "currency", currency: PAYMENT_CURRENCY });
const date = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Paris" });

Deno.serve(handle(async (req) => {
  if (!SECRET || req.headers.get("x-admin-secret") !== SECRET) throw new HttpError(403, "Interdit");
  const now = new Date();
  const summary = { sent: 0, ai: 0, errors: 0 };

  const { data: rounds, error } = await admin
    .from("tontine_rounds")
    .select("id, tontine_id, round_number, due_at")
    .eq("status", "collecting")
    .lte("due_at", now.toISOString());
  if (error) throw error;

  for (const round of rounds ?? []) {
    const [{ data: tontine }, { data: participants }, { data: contribs }, { data: reminders }] = await Promise.all([
      admin.from("tontines").select("name, amount").eq("id", round.tontine_id).single(),
      admin.from("tontine_rounds").select("beneficiary_id").eq("tontine_id", round.tontine_id),
      admin.from("contributions").select("user_id, status").eq("round_id", round.id),
      admin.from("payment_reminders").select("user_id, level, sent_at").eq("round_id", round.id),
    ]);
    if (!tontine || !participants) continue;
    const paid = new Set((contribs ?? []).filter((c) => c.status === "paid" || c.status === "transferred").map((c) => c.user_id));
    const late = participants.map((p) => p.beneficiary_id as string).filter((id) => !paid.has(id));

    for (const userId of late) {
      const level = nextReminderLevel(new Date(round.due_at), (reminders ?? []).filter((r) => r.user_id === userId), now);
      if (!level) continue;

      // Reservation : la contrainte unique (tour, membre, niveau) empeche un double envoi
      // si deux executions se chevauchent.
      const { data: claim } = await admin
        .from("payment_reminders")
        .insert({ round_id: round.id, user_id: userId, level })
        .select("id")
        .maybeSingle();
      if (!claim) continue;

      try {
        const { data: u } = await admin.auth.admin.getUserById(userId);
        const email = u?.user?.email;
        if (!email) throw new Error("adresse e-mail introuvable");
        const { data: profile } = await admin.from("profiles").select("first_name").eq("id", userId).maybeSingle();

        const facts: ReminderFacts = {
          firstName: profile?.first_name || email.split("@")[0],
          tontineName: tontine.name,
          roundNumber: round.round_number,
          amount: money.format(Number(tontine.amount)),
          dueDate: date.format(new Date(round.due_at)),
          daysLate: Math.max(0, Math.floor((now.getTime() - new Date(round.due_at).getTime()) / DAY_MS)),
          payUrl: `${APP_URL}/tontine-detail.html?id=${round.tontine_id}`,
        };
        const aiDraft = await writeReminder(level, facts);
        const message = buildEmail(level, facts, aiDraft ?? fallbackDraft(level, facts));
        const emailId = await sendEmail(email, message, `relance-${claim.id}`);

        await admin.from("payment_reminders").update({
          sent_at: new Date().toISOString(),
          subject: message.subject,
          body: message.text,
          ai_generated: !!aiDraft,
          email_id: emailId,
        }).eq("id", claim.id);
        summary.sent++;
        if (aiDraft) summary.ai++;
      } catch (e) {
        // Libere la reservation : la relance sera retentee a la prochaine execution.
        await admin.from("payment_reminders").delete().eq("id", claim.id);
        console.error(`Relance ${level} pour ${userId} (tour ${round.id}) :`, e);
        summary.errors++;
      }
    }
  }
  return json(summary);
}));
