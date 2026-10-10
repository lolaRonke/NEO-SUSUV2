// Envoi d'e-mails via l'API Resend (https://resend.com).
// Secrets : RESEND_API_KEY, MAIL_FROM (ex. "NEO-SUSU <relances@votre-domaine.fr>").
import type { Email } from "./reminders.ts";

const API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM = Deno.env.get("MAIL_FROM") ?? "";

// idempotencyKey : un envoi rejoue avec la meme cle n'envoie pas un second e-mail.
export async function sendEmail(to: string, email: Email, idempotencyKey: string): Promise<string> {
  if (!API_KEY || !FROM) throw new Error("RESEND_API_KEY / MAIL_FROM manquants");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({ from: FROM, to: [to], subject: email.subject, text: email.text, html: email.html }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Resend ${res.status}: ${body}`);
  return JSON.parse(body).id as string;
}
