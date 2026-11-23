/* =====================================================================
   NEO-SUSU — Score NEO v1 (par points, explicable)  · 23/11/2026
   Phase 1 du calendrier : règles simples et transparentes.
   Le modèle IA (v2) ne viendra qu'après ~6 mois de données réelles.

   Garde-fous RGPD (art. 22) :
   - n'utilise JAMAIS pays, nationalité, langue, origine ou religion ;
   - chaque décision défavorable (refus, plafond, rang) est marquée
     "human_review_required" et doit être validée par l'équipe ;
   - le détail des points est montré au membre, qui peut demander une revue.
   ===================================================================== */
(function () {
  "use strict";

  var VERSION = "v1-points-2026-11";

  /* Pondérations (total 100). À recalibrer en phase 3 avec les données du pilote. */
  var WEIGHTS = { punctuality: 40, circles: 25, seniority: 15, kyc: 10, sponsor: 10 };

  /* Paliers et plafonds par cercle (montant total de la cagnotte, en €).
     Valeurs de départ à calibrer avec CentralPay et le pilote. */
  var TIERS = [
    { min: 70, key: "pillar",    fr: "Pilier",     en: "Pillar",    maxPot: 6000 },
    { min: 40, key: "trusted",   fr: "Confiance",  en: "Trusted",   maxPot: 3000 },
    { min: 0,  key: "discovery", fr: "Découverte", en: "Discovery", maxPot: 1000 }
  ];

  var FORBIDDEN = ["country", "pays", "nationality", "nationalite", "language", "langue", "origin", "origine", "religion"];

  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

  /* stats = {
       payments_total, payments_on_time,   // cotisations dues / payées à l'heure
       avg_days_late,                      // retard moyen (jours) sur les retards
       circles_completed,                  // cercles terminés sans défaut
       months_since_signup,
       kyc_verified (bool),
       sponsor_score (0-100 | null)        // score du parrain, s'il existe
     } */
  function compute(stats) {
    stats = Object.assign({}, stats || {});   // copie : on ne modifie pas l'objet appelant
    FORBIDDEN.forEach(function (k) { delete stats[k]; });

    var total = stats.payments_total || 0;
    var onTime = stats.payments_on_time || 0;
    // Nouveau membre : neutre à 50 % sur la ponctualité, pour ne pas pénaliser l'absence d'historique.
    var punctRate = total > 0 ? onTime / total : 0.5;
    var latePenalty = total > 0 ? clamp((stats.avg_days_late || 0) / 30, 0, 0.25) : 0;
    var punctuality = Math.round(WEIGHTS.punctuality * clamp(punctRate - latePenalty, 0, 1));

    var circles = Math.round(WEIGHTS.circles * clamp((stats.circles_completed || 0) / 5, 0, 1));
    var seniority = Math.round(WEIGHTS.seniority * clamp((stats.months_since_signup || 0) / 12, 0, 1));
    var kyc = stats.kyc_verified ? WEIGHTS.kyc : 0;
    var sponsor = stats.sponsor_score >= 70 ? WEIGHTS.sponsor : stats.sponsor_score >= 40 ? Math.round(WEIGHTS.sponsor / 2) : 0;

    var score = clamp(punctuality + circles + seniority + kyc + sponsor, 0, 100);
    var tier = TIERS.find(function (x) { return score >= x.min; });

    return {
      version: VERSION, score: score, tier: tier.key, tier_fr: tier.fr, tier_en: tier.en, max_pot_eur: tier.maxPot,
      details: [
        { key: "punctuality", fr: "Ponctualité des cotisations", en: "On-time contributions", points: punctuality, max: WEIGHTS.punctuality,
          hint_fr: total ? onTime + " / " + total + " à l'heure" : "Pas encore d'historique (neutre)", hint_en: total ? onTime + " / " + total + " on time" : "No history yet (neutral)" },
        { key: "circles", fr: "Cercles terminés", en: "Completed circles", points: circles, max: WEIGHTS.circles,
          hint_fr: (stats.circles_completed || 0) + " sur 5 pris en compte", hint_en: (stats.circles_completed || 0) + " of 5 counted" },
        { key: "seniority", fr: "Ancienneté", en: "Seniority", points: seniority, max: WEIGHTS.seniority,
          hint_fr: (stats.months_since_signup || 0) + " mois sur 12", hint_en: (stats.months_since_signup || 0) + " of 12 months" },
        { key: "kyc", fr: "Identité vérifiée", en: "Verified identity", points: kyc, max: WEIGHTS.kyc,
          hint_fr: stats.kyc_verified ? "Vérifiée" : "À compléter", hint_en: stats.kyc_verified ? "Verified" : "To complete" },
        { key: "sponsor", fr: "Parrainage", en: "Sponsorship", points: sponsor, max: WEIGHTS.sponsor,
          hint_fr: stats.sponsor_score == null ? "Aucun parrain" : "Parrain actif", hint_en: stats.sponsor_score == null ? "No sponsor" : "Active sponsor" }
      ],
      computed_at: new Date().toISOString()
    };
  }

  /* Composition d'un cercle : vérifie le plafond et propose un ordre de passage.
     members = [{ id, score }], pot = montant total de la cagnotte (€).
     Ne décide rien seul : renvoie une PROPOSITION à valider par l'équipe. */
  function proposeCircle(members, pot) {
    var sorted = members.slice().sort(function (a, b) { return b.score - a.score; });
    var minScore = sorted.length ? sorted[sorted.length - 1].score : 0;
    var cap = TIERS.find(function (x) { return minScore >= x.min; }).maxPot;
    return {
      // Les plus fiables reçoivent en premier : ceux qui touchent tôt ont le plus d'intérêt à arrêter ensuite.
      proposed_order: sorted.map(function (m, i) { return { turn: i + 1, member_id: m.id }; }),
      pot_eur: pot, cap_eur: cap, within_cap: pot <= cap,
      human_review_required: true,
      reason_fr: pot <= cap ? "Cagnotte dans le plafond du membre le moins avancé."
                            : "Cagnotte au-dessus du plafond (" + cap + " €) : validation humaine obligatoire."
    };
  }

  /* Risque d'impayé simple (phase 2), avant le modèle prédictif de la phase 3. */
  function lateRisk(stats, daysToDue) {
    var s = compute(stats).score;
    var level = s < 40 ? "high" : s < 70 ? "medium" : "low";
    var remindAt = level === "high" ? 5 : level === "medium" ? 3 : 1; // jours avant échéance
    return { level: level, remind_days_before: remindAt, remind_now: daysToDue <= remindAt };
  }

  window.NEO_SCORE = { VERSION: VERSION, WEIGHTS: WEIGHTS, TIERS: TIERS, compute: compute, proposeCircle: proposeCircle, lateRisk: lateRisk };
})();
