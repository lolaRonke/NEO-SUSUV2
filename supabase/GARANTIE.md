# Option « garantie de paiement »

## Principe

1. **Le choix.** En rejoignant une tontine, chaque membre peut cocher l'option. Le choix est figé dès
   que le groupe est complet : personne ne peut la prendre juste avant son tour après avoir vu un
   défaut.
2. **Le prix.** Quand un membre qui a l'option reçoit sa cagnotte, **3 %** sont prélevés en plus de la
   commission et versés dans la **réserve de solidarité du groupe**. Comme la commission, c'est
   prélevé sur la cagnotte : le membre paie toujours sa cotisation normale.
   Exemple, 10 membres à 50 € : commission 6,75 € + garantie 13,50 €, cagnotte nette 479,75 €.
3. **La protection.** Si, **20 jours après l'échéance** (au moment de la 3e relance), des cotisations
   manquent pour un bénéficiaire qui a l'option, la réserve les verse à leur place et le tour est
   réparti normalement.
4. **La dette.** Le membre défaillant doit alors cette somme à la réserve :
   - les relances continuent jusqu'à la 3e (mention du commissaire de justice) ;
   - sa prochaine tentative de paiement rembourse d'abord la réserve.
5. **La fin.** Quand la tontine se termine, ce qui reste dans la réserve est rendu aux membres
   **au prorata de ce qu'ils y ont versé**. Un membre qui doit encore de l'argent à la réserve ne
   reçoit rien tant qu'il n'a pas remboursé. S'il rembourse après la fin, cette somme est rendue
   aux autres de la même façon.

**Pourquoi cette forme ?** NEO-SUSU n'avance jamais d'argent et n'encaisse pas la garantie : la
réserve appartient au groupe, chaque mouvement est inscrit dans un registre consultable par les
membres, et le reliquat leur revient. C'est une **entraide entre membres**, pas une assurance ni un
crédit, ce qui demanderait un agrément (ACPR, ORIAS).

> ⚖️ **À valider par un avocat avant la mise en production.** La frontière avec l'assurance dépend de
> la rédaction des CGU. Ne parlez jamais d'« assurance » : employez « réserve de solidarité » ou
> « garantie entre membres ». Précisez que la protection est limitée au solde de la réserve.

## Limites, à afficher clairement aux membres

- **La réserve couvre tout ou rien.** Elle paie toutes les cotisations manquantes d'un tour si elle
  le peut, sinon rien. Un versement partiel bloquerait le tour tout en vidant la réserve.
- **Les premiers tours ne sont pas couverts.** La réserve démarre vide et se remplit à chaque
  cagnotte d'un membre qui a l'option. Avec 10 membres à 50 € qui l'ont tous prise, elle reçoit
  13,50 € par tour : il faut environ 4 tours pour couvrir une cotisation manquante.
- **La protection ne bénéficie qu'aux membres qui ont pris l'option.** En revanche, n'importe quel
  membre défaillant peut devenir débiteur de la réserve.

## Fichiers

| Fichier | Rôle |
|---|---|
| `migrations/20261009150000_garantie.sql` | Choix de l'option (figé au démarrage), taux par tour, registre `guarantee_ledger`, dettes `guarantee_claims`, statut de cotisation `covered`, RPC `set_guarantee` |
| `functions/_shared/guarantee.ts` | Wallet de la réserve, prime, couverture, remboursement, restitution du reliquat |
| `functions/_shared/distribution.ts` | Calculs : part garantie, couverture tout-ou-rien, prorata au centime (testés) |
| `functions/payment-reminders` | Déclenche la couverture chaque jour pour les tours bloqués depuis 20 jours |

## Mise en service

1. **Créez l'utilisateur Mangopay de la plateforme.** C'est un utilisateur « légal » (votre société),
   créé une seule fois depuis le tableau de bord Mangopay ou par l'API, qui détient les wallets des
   réserves pour le compte des groupes. Enregistrez son identifiant :
   ```bash
   supabase secrets set MANGOPAY_PLATFORM_USER_ID=...
   ```
2. **Appliquez la migration** (`supabase db push`) et **redéployez** `mangopay-webhook`,
   `mangopay-contribute`, `payment-reminders` et `tontine-distribute`.
3. **Si la restitution du reliquat échoue** en fin de tontine, rejouez-la :
   `POST tontine-distribute { "refund_tontine_id": "..." }` avec l'en-tête `x-admin-secret`.
