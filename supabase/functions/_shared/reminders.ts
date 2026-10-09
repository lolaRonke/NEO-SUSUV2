// Logique pure des relances de paiement (aucun appel reseau) :
// relance 1 des le retard constate, relance 2 dix jours apres, relance 3 (mention du
// commissaire de justice / huissier) dix jours apres la 2e. Rien au-dela.

export const REMINDER_INTERVAL_DAYS = 10;
export const MAX_REMINDER_LEVEL = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ReminderLevel = 1 | 2 | 3;
export type SentReminder = { level: number; sent_at: string | null };

export function nextReminderLevel(dueAt: Date, sent: SentReminder[], now: Date): ReminderLevel | null {
  if (now < dueAt) return null;
  const done = sent.filter((r) => r.sent_at).sort((a, b) => a.level - b.level);
  const last = done[done.length - 1];
  if (!last) return 1;
  if (last.level >= MAX_REMINDER_LEVEL) return null;
  const nextAt = new Date(last.sent_at!).getTime() + REMINDER_INTERVAL_DAYS * DAY_MS;
  return now.getTime() >= nextAt ? ((last.level + 1) as ReminderLevel) : null;
}

export type ReminderFacts = {
  firstName: string;
  tontineName: string;
  roundNumber: number;
  amount: string; // deja formate, ex. "50,00 EUR"
  dueDate: string; // deja formatee, ex. "1 octobre 2026"
  daysLate: number;
  payUrl: string;
};

export type Draft = { subject: string; body: string };
export type Email = { subject: string; text: string; html: string };

// Paragraphe juridique fixe : ecrit par nous, jamais par l'IA, pour que la mention
// envoyee soit toujours exactement celle validee.
export const LEGAL_NOTICE_LEVEL_3 =
  "Sans régularisation de votre part, les membres du groupe pourront confier le recouvrement " +
  "des sommes impayées à un commissaire de justice (anciennement huissier de justice).";

const ESCALATION_WORDS = /huissier|commissaire de justice|poursuite|tribunal|contentieux|mise en demeure/i;

// Un brouillon IA n'est retenu que s'il respecte les garde-fous ; sinon on utilise le modele fixe.
export function isDraftAcceptable(level: ReminderLevel, draft: Draft | null): draft is Draft {
  if (!draft) return false;
  if (typeof draft.subject !== "string" || typeof draft.body !== "string") return false;
  if (!draft.subject.trim() || draft.subject.length > 150) return false;
  if (draft.body.trim().length < 40 || draft.body.length > 2500) return false;
  if (/https?:\/\//i.test(draft.body)) return false; // le seul lien autorise est ajoute par le code
  // Aucune menace juridique avant la 3e relance (et a la 3e, seul le paragraphe fixe en parle).
  if (ESCALATION_WORDS.test(draft.subject) || ESCALATION_WORDS.test(draft.body)) return false;
  return true;
}

export function fallbackDraft(level: ReminderLevel, f: ReminderFacts): Draft {
  const intro = `Bonjour ${f.firstName},`;
  if (level === 1) {
    return {
      subject: `Rappel : cotisation en attente pour « ${f.tontineName} »`,
      body: `${intro}\n\nSauf erreur de notre part, votre cotisation du tour ${f.roundNumber} n'a pas encore été reçue. ` +
        `Les autres membres du groupe attendent qu'elle soit réglée pour que la cagnotte puisse être versée. ` +
        `Si vous avez rencontré un souci, n'hésitez pas à nous répondre.\n\nMerci d'avance,\nL'équipe NEO-SUSU`,
    };
  }
  if (level === 2) {
    return {
      subject: `2e rappel : cotisation impayée pour « ${f.tontineName} »`,
      body: `${intro}\n\nMalgré notre premier rappel, votre cotisation du tour ${f.roundNumber} reste impayée ` +
        `(${f.daysLate} jours de retard). Ce retard bloque le versement de la cagnotte au bénéficiaire du tour. ` +
        `Merci de régulariser votre situation au plus vite.\n\nCordialement,\nL'équipe NEO-SUSU`,
    };
  }
  return {
    subject: `Dernier rappel avant recouvrement : « ${f.tontineName} »`,
    body: `${intro}\n\nMalgré deux rappels, votre cotisation du tour ${f.roundNumber} est toujours impayée ` +
      `(${f.daysLate} jours de retard). Nous vous demandons de la régler sans délai.\n\nCordialement,\nL'équipe NEO-SUSU`,
  };
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Assemble le mail final : texte (IA ou modele) + recapitulatif chiffre + mention legale,
// ces deux derniers toujours generes par le code a partir des donnees de la base.
export function buildEmail(level: ReminderLevel, f: ReminderFacts, draft: Draft): Email {
  const recap = [
    `Tontine : ${f.tontineName} (tour ${f.roundNumber})`,
    `Montant dû : ${f.amount}`,
    `Échéance : ${f.dueDate} (${f.daysLate} jours de retard)`,
    `Relance : ${level} sur ${MAX_REMINDER_LEVEL}`,
  ];
  const legal = level === 3 ? LEGAL_NOTICE_LEVEL_3 : null;
  const text = [draft.body.trim(), "", ...recap, "", `Régler ma cotisation : ${f.payUrl}`, ...(legal ? ["", legal] : [])]
    .join("\n");
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#1C1A17">` +
    draft.body.trim().split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("") +
    `<table style="border-collapse:collapse;margin:16px 0">` +
    recap.map((r) => {
      const [k, ...v] = r.split(" : ");
      return `<tr><td style="padding:4px 12px 4px 0;color:#6A6058">${escapeHtml(k)}</td><td style="padding:4px 0"><strong>${escapeHtml(v.join(" : "))}</strong></td></tr>`;
    }).join("") +
    `</table>` +
    `<p><a href="${escapeHtml(f.payUrl)}" style="background:#D4940A;color:#1C1A17;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold">Régler ma cotisation</a></p>` +
    (legal ? `<p style="border-left:3px solid #D4524A;padding-left:12px"><strong>${escapeHtml(legal)}</strong></p>` : "") +
    `</div>`;
  return { subject: draft.subject.trim(), text, html };
}
