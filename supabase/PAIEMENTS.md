# Répartition automatique des fonds (Mangopay)

## Principe

1. **Le groupe se remplit.** Quand la tontine atteint `max_members` (par ex. 10), un trigger SQL crée
   automatiquement un tour par membre, dans l'ordre d'arrivée, et ouvre la collecte du tour 1.
   Plus personne ne peut rejoindre ensuite.
2. **Chacun paie sa cotisation** par carte (`mangopay-contribute`). L'argent arrive sur le wallet
   Mangopay **du membre lui-même** : il reste à son nom tant que tout le groupe n'a pas payé.
3. **Dès la 10e cotisation reçue**, Mangopay prévient le webhook (`mangopay-webhook`), qui :
   - transfère les 9 cotisations vers le wallet du bénéficiaire du tour, en prélevant la commission
     NEO-SUSU au passage (taux du plan de l'organisateur, figé à l'ouverture du tour : voir `ABONNEMENTS.md`) ;
   - vire le total sur l'IBAN du bénéficiaire ;
   - ouvre le tour suivant (ou clôture la tontine après le dernier).

Exemple avec 10 membres à 50 € et le plan Free : le bénéficiaire reçoit 50 + 9 × 49,25 = **493,25 €**
et NEO-SUSU perçoit 6,75 €. La cotisation du bénéficiaire reste dans son propre wallet, donc elle
ne paie pas de commission.

**Sécurité :**
- Les clés Mangopay ne quittent jamais le serveur. Le navigateur n'appelle que les Edge Functions.
- Les tables de paiement sont en lecture seule pour les membres (RLS). Toutes les écritures passent
  par les fonctions.
- Mangopay ne signe pas ses webhooks : le webhook exige un jeton secret dans l'URL et relit chaque
  paiement auprès de l'API avant d'agir.
- Chaque transfert et chaque virement porte une clé d'idempotence. Une notification reçue deux fois
  ou une relance ne paie donc jamais deux fois.

## Fichiers

| Fichier | Rôle |
|---|---|
| `migrations/20261009120000_paiements_mangopay.sql` | Tables `payment_accounts`, `tontine_rounds`, `contributions`, `payouts`, RLS, démarrage automatique |
| `functions/mangopay-onboard` | Crée l'utilisateur et le wallet Mangopay du membre, enregistre son IBAN |
| `functions/mangopay-contribute` | Lance le paiement par carte de la cotisation du tour en cours |
| `functions/mangopay-webhook` | Reçoit les notifications Mangopay et déclenche la répartition |
| `functions/tontine-distribute` | Relance manuelle (admin) d'un tour en échec |
| `functions/_shared/distribution.ts` | Calcul de la répartition (testé : `tests/distribution.test.ts`) |
| `migrations/20261009130000_relances_paiement.sql` | Échéance de chaque tour, historique des relances |
| `functions/payment-reminders` | Relances quotidiennes des membres en retard (rédigées par Claude) |
| `functions/_shared/reminders.ts` | Calendrier des relances et garde-fous (testé : `tests/reminders.test.ts`) |

## Relances des membres en retard

Chaque tour a une échéance : ouverture de la collecte + `tontines.payment_delay_days` (7 jours par
défaut). Une fois par jour, `payment-reminders` repère les membres qui n'ont pas payé à temps et
leur envoie un e-mail :

| Relance | Quand | Contenu |
|---|---|---|
| 1 | Dès le premier jour de retard | Rappel cordial |
| 2 | 10 jours après la 1re | Rappel ferme |
| 3 | 10 jours après la 2e | Dernier rappel + mention : le groupe pourra confier le recouvrement à un commissaire de justice (anciennement huissier) |

Il n'y a rien après la 3e relance. Les relances s'arrêtent dès que le membre paie.

**Rôle de l'IA.** Claude rédige chaque e-mail : il le personnalise et adapte le ton au niveau de
relance. Plusieurs garde-fous encadrent ce texte :
- **Ajouté par le code, jamais par l'IA :** le récapitulatif chiffré (montant, échéance, jours de
  retard), le lien de paiement et la mention sur le commissaire de justice. Ce sont toujours les
  données de la base et le texte exact validé.
- **Texte rejeté :** s'il contient un lien ou s'il parle d'huissier, de tribunal ou de poursuites.
  Ainsi aucune menace n'apparaît avant la 3e relance, et la mention légale reste mot pour mot celle
  prévue.
- **Mail de secours :** si l'IA est indisponible, refuse la demande ou produit un texte rejeté, un
  modèle fixe est envoyé à la place. Une relance n'est jamais bloquée.
- **Historique :** chaque mail envoyé est enregistré dans `payment_reminders` (objet, texte, IA ou
  modèle). Le membre peut relire les siens.

> ⚖️ Faites relire la formulation de la 3e relance (`LEGAL_NOTICE_LEVEL_3` dans
> `functions/_shared/reminders.ts`) par un juriste avant la mise en production. Si vous voulez
> qu'elle vaille mise en demeure, c'est à ce texte qu'il faut l'ajouter.

## Mise en service

1. **Compte Mangopay.** Créez un compte sandbox sur mangopay.com et récupérez le *Client ID* et la
   *clé API*.
2. **Vérifiez vos tables.** La migration suppose :
   - `tontines` : `id uuid`, `amount` (en euros, pas en centimes), `max_members` ;
   - `tontine_members` : `tontine_id`, `user_id`, `created_at`.

   Adaptez-la si vos colonnes diffèrent.
3. **Appliquez la migration et déployez les fonctions :**
   ```bash
   supabase db push
   supabase secrets set MANGOPAY_CLIENT_ID=... MANGOPAY_API_KEY=... \
     MANGOPAY_BASE_URL=https://api.sandbox.mangopay.com \
     MANGOPAY_WEBHOOK_TOKEN=$(openssl rand -hex 24) DISTRIBUTE_SECRET=$(openssl rand -hex 24) \
     APP_ORIGIN=https://lolaronke.github.io \
     APP_URL=https://lolaronke.github.io/neo-susu \
     CRON_SECRET=$(openssl rand -hex 24) ANTHROPIC_API_KEY=sk-ant-... \
     RESEND_API_KEY=re_... MAIL_FROM="NEO-SUSU <relances@votre-domaine.fr>"
   supabase functions deploy mangopay-onboard
   supabase functions deploy mangopay-contribute
   supabase functions deploy mangopay-webhook --no-verify-jwt
   supabase functions deploy tontine-distribute --no-verify-jwt
   supabase functions deploy payment-reminders --no-verify-jwt
   ```
4. **Déclarez le webhook chez Mangopay** pour les événements `PAYIN_NORMAL_SUCCEEDED`,
   `PAYIN_NORMAL_FAILED`, `PAYOUT_NORMAL_SUCCEEDED` et `PAYOUT_NORMAL_FAILED` (Dashboard → Hooks),
   avec l'URL :
   `https://<projet>.supabase.co/functions/v1/mangopay-webhook?token=<MANGOPAY_WEBHOOK_TOKEN>`
5. **E-mails.** Créez un compte Resend et vérifiez votre nom de domaine d'envoi.
6. **Planifiez les relances** tous les jours à 9 h (UTC). Activez d'abord les extensions `pg_cron` et
   `pg_net` (Dashboard → Database → Extensions), puis lancez dans l'éditeur SQL :
   ```sql
   select cron.schedule('relances-neosusu', '0 9 * * *', $$
     select net.http_post(
       url     := 'https://<projet>.supabase.co/functions/v1/payment-reminders',
       headers := jsonb_build_object('Content-Type', 'application/json', 'x-admin-secret', '<CRON_SECRET>'),
       body    := '{}'::jsonb)
   $$);
   ```

## Appels depuis le front

```js
// 1. Une fois par membre : identité (obligatoire pour recevoir des fonds) + IBAN
await supabase.functions.invoke("mangopay-onboard", { body: {
  identity: { firstName: "Aicha", lastName: "Diallo", birthday: 631152000, nationality: "FR",
              address: { AddressLine1: "1 rue X", City: "Paris", PostalCode: "75001", Country: "FR" } },
  iban: "FR76 ...",
}});

// 2. À chaque tour : payer sa cotisation, puis rediriger vers la page de paiement Mangopay
const { data } = await supabase.functions.invoke("mangopay-contribute", { body: {
  tontine_id: tontineId, return_url: location.href,
}});
location.href = data.redirect_url;
```

## Limites connues

- **FCFA non supporté.** Mangopay (comme CentralPay) fonctionne en euros et dans quelques autres
  devises européennes, pas en XOF/XAF. Pour des cotisations en FCFA, il faut un prestataire
  mobile money (Wave, Orange Money, CinetPay, PayDunya…).
- **KYC.** Mangopay exige une vérification d'identité (pièce d'identité) avant d'autoriser les
  virements. Tant qu'elle n'est pas faite, le virement échoue, le tour passe en `failed` avec le
  message de Mangopay, et l'argent reste dans le wallet du bénéficiaire. Relancez ensuite avec
  `tontine-distribute`.
- **Virement refusé (IBAN erroné, par exemple).** L'argent reste dans le wallet du bénéficiaire.
  Dès qu'il enregistre un nouvel IBAN via `mangopay-onboard`, le virement repart automatiquement.
- **Membre qui ne paie toujours pas après la 3e relance.** Le tour reste bloqué en collecte et rien
  n'est versé. Le recours au commissaire de justice est une décision du groupe, hors application.
- **Clés d'idempotence.** Elles sont valables 24 h chez Mangopay. Relancez un tour en échec dans
  ce délai.
