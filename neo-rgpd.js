/* =====================================================================
   NEO-SUSU — Module RGPD & Smart Data  (v1 · 23/11/2026)
   - Consentements (stockés localement + synchronisés Supabase si dispo)
   - Bandeau cookies conforme CNIL (Accepter / Refuser au même niveau)
   - Journal d'événements (smart data) : analytique seulement si consenti
   - Pied de page Confidentialité · Mes données sur chaque écran
   Inclure en bas de page : <script src="./neo-rgpd.js"></script>
   ===================================================================== */
(function () {
  "use strict";

  var POLICY_VERSION = "2026-11-23";
  var KEY_CONSENTS = "ns_consents";
  var KEY_QUEUE = "ns_event_queue";
  var CONSENT_MAX_AGE_DAYS = 182; // ~6 mois : on redemande ensuite (recommandation CNIL)
  var QUEUE_MAX = 200;

  /* Catégories de consentement.
     required = nécessaire au service (base légale : contrat), non désactivable. */
  var PURPOSES = {
    essential:    { required: true,  fr: "Fonctionnement du service",          en: "Service operation" },
    analytics:    { required: false, fr: "Mesure d'audience et amélioration", en: "Analytics and improvement" },
    voice_ai:     { required: false, fr: "Assistant vocal IA (OpenAI, États-Unis)", en: "AI voice assistant (OpenAI, USA)" },
    marketing:    { required: false, fr: "Actualités et offres NEO-SUSU",      en: "NEO-SUSU news and offers" },
    open_banking: { required: false, fr: "Analyse de mes comptes bancaires pour le Score NEO", en: "Bank account analysis for my NEO Score" }
  };

  /* Événements métier (smart data). category "contract" = nécessaires au contrat,
     enregistrés sans consentement ; "analytics" = uniquement si consenti. */
  var EVENTS = {
    signup:              "contract",
    kyc_submitted:       "contract",
    kyc_verified:        "contract",
    circle_created:      "contract",
    circle_joined:       "contract",
    contribution_paid:   "contract",   // props: { circle_id, amount, days_late }
    contribution_late:   "contract",
    reminder_sent:       "contract",   // props: { channel, lang }
    payout_received:     "contract",
    circle_completed:    "contract",
    score_review_requested: "contract",
    page_view:           "analytics",
    feature_used:        "analytics",
    voice_session:       "analytics"
  };

  function lang() { try { return localStorage.getItem("ns_lang") || "fr"; } catch (e) { return "fr"; } }
  function t(fr, en) { return lang() === "en" ? en : fr; }

  function read(key, fallback) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  }
  function write(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {} }

  /* Client Supabase si supabase.js l'a créé (plusieurs noms possibles). */
  function client() {
    return window.supabaseClient || window.sb || window._supabase || window.neoSupabase || null;
  }
  async function currentUserId() {
    var c = client(); if (!c || !c.auth) return null;
    try { var r = await c.auth.getUser(); return r && r.data && r.data.user ? r.data.user.id : null; } catch (e) { return null; }
  }

  /* ---------------- Consentements ---------------- */
  function getConsents() {
    var c = read(KEY_CONSENTS, null);
    if (!c) return null;
    var ageDays = (Date.now() - Date.parse(c.date)) / 864e5;
    if (c.version !== POLICY_VERSION || ageDays > CONSENT_MAX_AGE_DAYS) return null; // à redemander
    return c;
  }
  function hasConsent(purpose) {
    if (PURPOSES[purpose] && PURPOSES[purpose].required) return true;
    var c = getConsents(); return !!(c && c.choices && c.choices[purpose]);
  }
  async function setConsents(choices, source) {
    var clean = {};
    Object.keys(PURPOSES).forEach(function (p) { clean[p] = PURPOSES[p].required ? true : !!(choices && choices[p]); });
    var record = { version: POLICY_VERSION, date: new Date().toISOString(), choices: clean, source: source || "app", synced: false };
    write(KEY_CONSENTS, record);
    await syncConsents();
    document.dispatchEvent(new CustomEvent("neo:consents", { detail: record }));
    if (!clean.analytics) purgeAnalyticsQueue();
    return record;
  }

  /* Preuve du consentement côté serveur (table public.consents).
     Rejouée à la première connexion si le choix a été fait avant (ex. à l'inscription). */
  async function syncConsents() {
    var rec = read(KEY_CONSENTS, null);
    if (!rec || rec.synced) return;
    var c = client(), uid = await currentUserId();
    if (!c || !uid) return;
    try {
      var r = await c.from("consents").insert(Object.keys(rec.choices).map(function (p) {
        return { user_id: uid, purpose: p, granted: rec.choices[p], policy_version: rec.version, source: rec.source, created_at: rec.date };
      }));
      if (r && r.error) throw r.error;
      rec.synced = true; write(KEY_CONSENTS, rec);
    } catch (e) { console.warn("[RGPD] consentement non synchronisé :", e.message); }
  }

  /* ---------------- Journal d'événements (smart data) ---------------- */
  function purgeAnalyticsQueue() {
    write(KEY_QUEUE, read(KEY_QUEUE, []).filter(function (e) { return e.category !== "analytics"; }));
  }
  async function track(name, props) {
    var category = EVENTS[name] || "analytics";
    if (category === "analytics" && !hasConsent("analytics")) return false;
    // Minimisation : on refuse les champs d'identité dans les propriétés.
    var safe = {};
    Object.keys(props || {}).forEach(function (k) {
      if (!/^(email|phone|telephone|name|nom|prenom|first_name|last_name|iban|address|adresse|nationality|nationalite|country|pays|language_origin)$/i.test(k)) safe[k] = props[k];
    });
    var evt = { name: name, category: category, props: safe, at: new Date().toISOString(), lang: lang() };
    var c = client(), uid = await currentUserId();
    if (c && uid) {
      try { await c.from("events").insert({ user_id: uid, name: name, category: category, props: safe, lang: evt.lang }); return true; }
      catch (e) { /* hors ligne : file d'attente */ }
    }
    var q = read(KEY_QUEUE, []); q.push(evt); write(KEY_QUEUE, q.slice(-QUEUE_MAX));
    return true;
  }
  async function flushQueue() {
    var c = client(), uid = await currentUserId(); if (!c || !uid) return;
    var q = read(KEY_QUEUE, []); if (!q.length) return;
    try {
      await c.from("events").insert(q.map(function (e) { return { user_id: uid, name: e.name, category: e.category, props: e.props, lang: e.lang, created_at: e.at }; }));
      write(KEY_QUEUE, []);
    } catch (e) {}
  }

  /* ---------------- Droits des personnes ---------------- */
  async function requestRight(type, message) {
    // type : access | export | rectification | erasure | objection | score_review
    var c = client(), uid = await currentUserId();
    if (c && uid) {
      var r = await c.from("data_requests").insert({ user_id: uid, type: type, message: message || null });
      if (r && r.error) throw r.error;
      if (type === "score_review") track("score_review_requested", {});
      return "db";
    }
    var subject = encodeURIComponent("[RGPD] Demande : " + type);
    var body = encodeURIComponent((message || "") + "\n\n— envoyé depuis l'app NEO-SUSU");
    window.location.href = "mailto:dpo@neo-susu.com?subject=" + subject + "&body=" + body;
    return "mail";
  }
  async function exportMyData() {
    var out = { exported_at: new Date().toISOString(), policy_version: POLICY_VERSION,
                consents: getConsents(), pending_events: read(KEY_QUEUE, []), language: lang() };
    var c = client(), uid = await currentUserId();
    if (c && uid) {
      var tables = ["profiles", "tontine_members", "contributions", "consents", "events", "data_requests", "score_neo"];
      for (var i = 0; i < tables.length; i++) {
        try {
          var col = tables[i] === "profiles" ? "id" : "user_id";
          var r = await c.from(tables[i]).select("*").eq(col, uid);
          if (!r.error) out[tables[i]] = r.data;
        } catch (e) {}
      }
    }
    var blob = new Blob([JSON.stringify(out, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "neo-susu-mes-donnees.json";
    document.body.appendChild(a); a.click(); a.remove();
    return out;
  }

  /* ---------------- Bandeau cookies ---------------- */
  function injectStyles() {
    if (document.getElementById("neo-rgpd-style")) return;
    var s = document.createElement("style"); s.id = "neo-rgpd-style";
    s.textContent =
      ".neo-cookie{position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;max-width:560px;margin:0 auto;background:var(--card,#38342A);border:1px solid var(--stroke-gold,rgba(212,148,10,.3));border-radius:20px;padding:18px;box-shadow:0 18px 48px rgba(0,0,0,.45);font-family:var(--ff-b,system-ui);color:var(--text,#F0EAE0);font-size:13px;line-height:1.5}" +
      ".neo-cookie h3{font-family:var(--ff-s,serif);font-size:20px;color:var(--gold-pale,#F0C96A);margin:0 0 6px}" +
      ".neo-cookie p{color:var(--text2,#A09080);margin:0 0 12px}.neo-cookie a{color:var(--gold-pale,#F0C96A)}" +
      ".neo-cookie .row{display:flex;gap:8px;flex-wrap:wrap}" +
      ".neo-cookie button{flex:1;min-width:130px;padding:12px;border-radius:14px;font-weight:700;font-size:13px;cursor:pointer;font-family:inherit;border:1px solid var(--stroke2,rgba(240,234,224,.14));background:var(--raised,#433E32);color:var(--text,#F0EAE0)}" +
      ".neo-cookie button:hover{border-color:var(--gold,#D4940A)}" +
      ".neo-cookie .link{display:block;text-align:center;margin-top:10px;font-size:12px}" +
      ".neo-legal{text-align:center;font-size:11px;color:var(--text3,#6A6058);padding:28px 12px 18px;font-family:var(--ff-b,system-ui)}" +
      ".neo-legal a{color:var(--text2,#A09080);text-decoration:none;margin:0 6px}.neo-legal a:hover{color:var(--gold-pale,#F0C96A)}";
    document.head.appendChild(s);
  }
  function showBanner() {
    if (document.getElementById("neoCookie")) return;
    injectStyles();
    var d = document.createElement("div");
    d.className = "neo-cookie"; d.id = "neoCookie"; d.setAttribute("role", "dialog"); d.setAttribute("aria-label", "Cookies");
    d.innerHTML =
      "<h3>" + t("Vos données, vos choix", "Your data, your choice") + "</h3>" +
      "<p>" + t("Nous utilisons des traceurs nécessaires au service. Avec votre accord, nous mesurons aussi l'audience pour améliorer NEO-SUSU. Vous pouvez changer d'avis à tout moment dans « Mes données ».",
                "We use trackers needed for the service. With your consent, we also measure audience to improve NEO-SUSU. You can change your mind anytime in “My data”.") +
      " <a href='./confidentialite.html'>" + t("En savoir plus", "Learn more") + "</a></p>" +
      "<div class='row'><button type='button' id='neoRefuse'>" + t("Tout refuser", "Reject all") + "</button>" +
      "<button type='button' id='neoAccept'>" + t("Tout accepter", "Accept all") + "</button></div>" +
      "<a class='link' href='./mes-donnees.html'>" + t("Personnaliser mes choix", "Customise my choices") + "</a>";
    document.body.appendChild(d);
    document.getElementById("neoRefuse").onclick = function () { setConsents({}, "banner"); d.remove(); };
    document.getElementById("neoAccept").onclick = function () {
      // « Tout accepter » du bandeau = traceurs uniquement ; l'IA vocale, la prospection
      // et l'open banking restent des choix séparés dans « Mes données ».
      var prev = (getConsents() || {}).choices || {};
      setConsents(Object.assign({}, prev, { analytics: true }), "banner"); d.remove();
    };
  }
  function addFooter() {
    if (document.querySelector(".neo-legal") || document.body.dataset.noLegal === "1") return;
    injectStyles();
    var f = document.createElement("div"); f.className = "neo-legal";
    f.innerHTML = "<a href='./confidentialite.html'>" + t("Confidentialité", "Privacy") + "</a>·" +
                  "<a href='./mes-donnees.html'>" + t("Mes données", "My data") + "</a>·" +
                  "<a href='mailto:dpo@neo-susu.com'>dpo@neo-susu.com</a>";
    (document.querySelector(".container") || document.body).appendChild(f);
  }

  function init() {
    addFooter();
    if (!getConsents() && !/mes-donnees\.html$/.test(location.pathname)) showBanner();
    track("page_view", { path: location.pathname.split("/").pop() || "index.html" });
    syncConsents();
    flushQueue();
  }

  window.NEO_RGPD = {
    POLICY_VERSION: POLICY_VERSION, PURPOSES: PURPOSES, EVENTS: EVENTS,
    getConsents: getConsents, hasConsent: hasConsent, setConsents: setConsents,
    track: track, flushQueue: flushQueue, requestRight: requestRight, exportMyData: exportMyData,
    showBanner: showBanner
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
