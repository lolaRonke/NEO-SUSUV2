# NEO-SUSU

L'épargne communautaire (tontine) digitale pour la diaspora africaine.
Application web mobile (PWA) en HTML/CSS/JS, avec Supabase pour les comptes et les données.

NEO-SUSU · SIREN 914 419 494

## Pages

| Page | Rôle |
|---|---|
| `index.html` | Accueil, accès au mode démo |
| `signup.html` / `login.html` / `reset-password.html` | Inscription, connexion (email ou Google), mot de passe oublié |
| `dashboard.html` | Tableau de bord : montants reçus/cotisés, score, liste des tontines |
| `create-tontine.html` | Créer une tontine (code d'invitation généré) |
| `join-tontine.html` | Rejoindre avec un code ou un lien `join-tontine.html?code=XXXXXX` |
| `tontine-detail.html` | Membres, ordre de passage, paiement du tour, invitation |
| `profile.html` | Infos personnelles, mot de passe, langue |
| `admin.html` | Statistiques (réservé aux comptes `is_admin`) |

Fichiers communs : `neo-susu.css` (charte), `app.js` (langue FR/EN, Supabase, démo), `config.js` (URL et clé publique Supabase).

## Fonctionnement d'une tontine

1. L'organisateur crée la tontine et reçoit le pot au tour 1.
2. Les membres rejoignent avec le code ; l'ordre de passage suit l'ordre d'arrivée.
3. La tontine démarre quand elle est complète (ou quand l'organisateur la lance, 2 membres min.).
4. À chaque tour, chacun déclare avoir payé ; quand tout le monde a payé, le pot est attribué au bénéficiaire du tour et le tour suivant commence.
5. Après le dernier tour, la tontine passe en « Terminée ».

Commission par cotisation selon le plan : Free 1,5 % · Premium 0,5 % · Business 0 %.

> Le paiement en ligne (carte, Mobile Money) n'est pas encore branché : le bouton « J'ai payé ma part » enregistre le versement fait à l'organisateur.

## Base de données

Le schéma complet est dans `supabase/schema.sql` (tables, sécurité RLS, fonctions). Pour l'installer sur un projet Supabase : SQL Editor → coller le fichier → Run.

Pour donner les droits administrateur à un compte :

```sql
update public.profiles set is_admin = true where id = (select id from auth.users where email = 'votre@email.com');
```

Réglages à faire dans Supabase → Authentication → URL Configuration : mettre l'adresse du site (ex. `https://lolaronke.github.io/NEO-SUSUV2/`) dans **Site URL** et **Redirect URLs**. Pour « Continuer avec Google », activer le fournisseur Google dans Authentication → Providers.
