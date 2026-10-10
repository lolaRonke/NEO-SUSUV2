# Abonnements NEO-SUSU

## 1. Le marché (octobre 2026)

| Application | Cible | Modèle de prix |
|---|---|---|
| **Tontineo** | Diaspora, France | Abonnement seul : 2,99 €/mois (1 tontine, 10 membres), 5,99 € (3 tontines, 20 membres), 19,99 € (illimité, 50 membres), 39,99 € (150 membres). 14 jours d'essai. |
| **My Tontine** | Afrique (FCFA) | Gratuit avec commission sur les frais de gestion ; Premium à 15 000 FCFA/an (≈ 23 €). |
| **Wao Ma Tontine** | France | 3 % prélevés sur chaque cagnotte. |
| **Tont'in** | France | Gratuit, commission uniquement au virement des gains. |
| **Tontine 2.0** | Cagnottes | 1,20 % + 0,15 € de frais bancaires. |
| **Money Fellows** | Égypte | Frais selon la position dans le tour (jusqu'à 16 % pour les premiers, remises pour les derniers). |
| **Ajo** | Nigeria, Ghana | Gratuit (outil de suivi, sans gestion de l'argent). |

Les tarifs viennent des sites des éditeurs et de la presse ; ils n'ont pas été vérifiés indépendamment
et peuvent changer.

**Ce qu'on en retient :**
- Les applications de simple **suivi** se paient par abonnement (Tontineo) ou sont gratuites (Ajo).
- Celles qui **manipulent l'argent** prennent une commission (Wao 3 %, Tontine 2.0 1,2 %), car chaque
  paiement par carte leur coûte des frais.
- NEO-SUSU fait les deux : l'argent circule par Mangopay, avec versements automatiques et relances IA.
  Un modèle **hybride** (gratuit avec commission, ou abonnement qui réduit la commission) est donc le
  plus adapté.
- Le seuil d'entrée du marché est bas (Tontineo dès 2,99 €). L'avantage concurrentiel le plus fort est
  de proposer **gratuitement** le cas d'usage type : une tontine de 10 personnes.

## 2. Les offres retenues

| | **Gratuit** | **Essentiel** | **Pro** |
|---|---|---|---|
| Prix | 0 € | 4,99 €/mois ou 49,90 €/an | 14,99 €/mois ou 149,90 €/an |
| Commission sur la cagnotte | 1,5 % | 0,5 % | 0 % |
| Tontines actives | 1 | 3 | illimitées |
| Membres par tontine | 10 | 20 | 50 |
| Versements automatiques, relances IA | ✓ | ✓ | ✓ |

- **Qui paie l'abonnement ?** L'organisateur de la tontine. Les membres n'ont jamais à s'abonner.
- **Annuel :** 2 mois offerts.
- **Commission :** elle est prélevée sur la cagnotte versée au bénéficiaire. Son taux suit le plan de
  l'organisateur et il est **figé à l'ouverture de chaque tour** : les membres le connaissent pendant
  la collecte, et il ne change pas en cours de route.

**Par rapport à Tontineo :**
- le cas d'usage type (1 tontine de 10 personnes) est gratuit chez NEO-SUSU, contre 2,99 €/mois ;
- l'Essentiel est 1 € moins cher (4,99 € contre 5,99 €) à limites égales ;
- le Pro est 5 € moins cher (14,99 € contre 19,99 €) ;
- en plus, NEO-SUSU gère réellement l'argent (versements automatiques, relances).

**Honnêteté des chiffres.** Le simulateur du tableau de bord calcule le coût réel d'un cycle complet
pour le groupe (commissions + abonnement) et indique le plan le moins cher. Par exemple :
- 10 membres à 50 € : Gratuit 67,50 €, Essentiel 72,40 € → le Gratuit reste le meilleur choix ;
- 10 membres à 100 € : Gratuit 135 €, Essentiel 94,90 € → l'Essentiel devient rentable.

Les fonctionnalités annoncées auparavant mais inexistantes (« IA vocale », « API », « support 24/7 »)
ont été retirées.

> ⚠️ **À valider avec votre devis Mangopay :** la commission du plan Gratuit (1,5 %) doit couvrir les
> frais de paiement par carte facturés par Mangopay. Les tarifs Mangopay ne sont pas publics (devis
> sur demande). Si leurs frais dépassent la commission, augmentez `fee_bps` du plan Gratuit dans la
> table `plans` **et** dans `plans.js`. Le test `supabase/tests/plans.test.ts` vérifie que les deux
> restent identiques.

## 3. Fonctionnement technique

- **Encaissement par Stripe Billing.** L'abonnement est un revenu de NEO-SUSU, pas l'argent des
  membres : il n'a pas besoin des wallets Mangopay. Stripe fournit la page de paiement, les factures,
  les relances de carte expirée, le changement de plan et la résiliation (espace client).
- **La base fait foi.**
  - La table `plans` contient les prix, commissions et limites.
  - `subscriptions` est tenue à jour par le webhook Stripe (signé et vérifié).
  - `effective_plan()` renvoie le plan payant en cours de validité, sinon Gratuit. Un paiement en
    échec garde le plan jusqu'à la fin de la période payée.
- **Limites appliquées par la base** (trigger `enforce_plan_limits`) : impossible de créer une 2e
  tontine ou une tontine de plus de 10 membres en Gratuit, même en contournant l'interface.
- **Fonctions :**
  - `subscription-checkout` : page de paiement Stripe. Si un abonnement existe déjà, elle renvoie vers
    l'espace client.
  - `subscription-portal` : espace client (changer de plan, de carte, factures, résiliation).
  - `stripe-webhook` : met à jour l'abonnement.

## 4. Mise en service

1. Créez un compte Stripe. Dans **Produits**, créez « NEO-SUSU Essentiel » et « NEO-SUSU Pro », chacun
   avec un prix mensuel et un prix annuel (4,99 € / 49,90 € et 14,99 € / 149,90 €, TTC). Notez les
   4 identifiants `price_...`.
2. Dans **Paramètres → Facturation → Portail client**, activez le changement de plan entre ces
   4 prix, la mise à jour de la carte et la résiliation en fin de période.
3. Dans **Développeurs → Webhooks**, ajoutez l'URL
   `https://<projet>.supabase.co/functions/v1/stripe-webhook` avec les événements
   `customer.subscription.created`, `customer.subscription.updated` et
   `customer.subscription.deleted`. Notez le secret de signature `whsec_...`.
4. Configurez les secrets et déployez :
   ```bash
   supabase secrets set STRIPE_SECRET_KEY=sk_test_... STRIPE_WEBHOOK_SECRET=whsec_... \
     STRIPE_PRICE_ESSENTIEL_MONTH=price_... STRIPE_PRICE_ESSENTIEL_YEAR=price_... \
     STRIPE_PRICE_PRO_MONTH=price_... STRIPE_PRICE_PRO_YEAR=price_...
   supabase db push
   supabase functions deploy subscription-checkout
   supabase functions deploy subscription-portal
   supabase functions deploy stripe-webhook --no-verify-jwt
   ```
5. **Côté front.** Les pages utilisent `window.NEO_SUPABASE`, le client Supabase que `supabase.js`
   doit créer :
   ```js
   window.NEO_SUPABASE = supabase.createClient(URL_DU_PROJET, CLE_PUBLIQUE)
   ```
   Sans lui, l'application reste en mode démo : les boutons affichent un message au lieu d'ouvrir
   le paiement.
6. Testez avec la carte Stripe de test `4242 4242 4242 4242`, puis passez les clés en mode live.

**À trancher avant la production :**
- **TVA.** Les prix sont affichés TTC. Si NEO-SUSU est assujettie, activez Stripe Tax ou fixez des
  prix TTC incluant 20 % de TVA.
- **Essai gratuit.** Tontineo propose 14 jours d'essai. On peut l'ajouter avec `trial_period_days`
  dans `subscription-checkout`.
- **CGU et CGV.** Elles doivent reprendre les prix, la commission, la résiliation et le droit de
  rétractation de 14 jours pour les particuliers.
