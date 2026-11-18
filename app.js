/* =====================================================================
   NEO-SUSU — logique commune (langue, Supabase, mode démo, utilitaires)
   Chargé par toutes les pages après config.js et supabase-js.
   ===================================================================== */
(function () {
  "use strict";

  const CFG = window.NEO_CONFIG || {};
  const BASE = location.href.split(/[?#]/)[0].replace(/[^/]*$/, "");

  // ── Client Supabase ─────────────────────────────────────────────
  const sb = (window.supabase && CFG.SUPABASE_URL && CFG.SUPABASE_KEY)
    ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY)
    : null;

  // ── Langue ──────────────────────────────────────────────────────
  let lang = "fr";
  try { lang = localStorage.getItem("ns_lang") || "fr"; } catch (e) {}

  function t(fr, en) { return lang === "en" ? en : fr; }

  function applyLang() {
    document.documentElement.lang = lang;
    document.querySelectorAll("[data-fr]").forEach(el => {
      const v = el.getAttribute("data-" + lang);
      if (v != null) el.textContent = v;
    });
    document.querySelectorAll("[data-ph-fr]").forEach(el => {
      const v = el.getAttribute("data-ph-" + lang);
      if (v != null) el.placeholder = v;
    });
    document.querySelectorAll(".lang-flag").forEach(f =>
      f.classList.toggle("active", f.dataset.lang === lang));
    document.dispatchEvent(new CustomEvent("langchange", { detail: lang }));
  }

  function setLang(l) {
    lang = l === "en" ? "en" : "fr";
    try { localStorage.setItem("ns_lang", lang); } catch (e) {}
    applyLang();
  }

  function mountLangBar() {
    if (document.querySelector(".lang-bar")) return;
    const bar = document.createElement("div");
    bar.className = "lang-bar";
    bar.innerHTML =
      '<button class="lang-flag" data-lang="fr" title="Français" aria-label="Français">🇫🇷</button>' +
      '<div class="lang-sep"></div>' +
      '<button class="lang-flag" data-lang="en" title="English" aria-label="English">🇬🇧</button>';
    bar.addEventListener("click", e => {
      const b = e.target.closest(".lang-flag");
      if (b) setLang(b.dataset.lang);
    });
    document.body.prepend(bar);
  }

  // ── Utilitaires ─────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  const CURRENCIES = { XOF: "FCFA", XAF: "FCFA", NGN: "NGN", EUR: "€", GBP: "£" };
  function money(n, cur) {
    const v = Number(n || 0);
    const digits = (cur === "EUR" || cur === "GBP") ? 2 : 0;
    const s = v.toLocaleString(lang === "en" ? "en-GB" : "fr-FR",
      { minimumFractionDigits: v % 1 ? digits : 0, maximumFractionDigits: digits });
    return s + " " + (CURRENCIES[cur] || cur || "");
  }

  const FREQ = {
    weekly:   ["Hebdomadaire", "Weekly"],
    biweekly: ["Bimensuelle", "Biweekly"],
    monthly:  ["Mensuelle", "Monthly"]
  };
  function freqLabel(f) { const x = FREQ[f] || [f, f]; return t(x[0], x[1]); }

  const STATUS = {
    waiting:   ["En attente", "Waiting", "chip-gold"],
    active:    ["Active", "Active", "chip-green"],
    completed: ["Terminée", "Completed", "chip-violet"]
  };
  function statusChip(s) {
    const x = STATUS[s] || [s, s, "chip-grey"];
    return '<span class="chip ' + x[2] + '">' + esc(t(x[0], x[1])) + "</span>";
  }

  const PLANS = {
    free:     { name: "Free",     fee: 1.5, maxMembers: 6,  maxTontines: 1 },
    premium:  { name: "Premium",  fee: 0.5, maxMembers: 20, maxTontines: null },
    business: { name: "Business", fee: 0,   maxMembers: 50, maxTontines: null }
  };
  function fee(amount, plan) {
    const rate = (PLANS[plan] || PLANS.free).fee;
    return Math.round(Number(amount) * rate) / 100;
  }

  let toastTimer;
  function toast(msg, type) {
    let el = document.getElementById("ns-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "ns-toast";
      el.className = "toast";
      el.setAttribute("role", "status");
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = "toast show " + (type || "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
  }

  function showMsg(id, text, ok) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = "msg show " + (ok ? "msg-ok" : "msg-error");
  }
  function hideMsg(id) { const el = document.getElementById(id); if (el) el.className = "msg"; }

  function setLoading(btn, on, label) {
    if (!btn) return;
    if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || "…"; btn.classList.add("loading"); }
    else { btn.textContent = btn.dataset.label || btn.textContent; btn.classList.remove("loading"); }
  }

  // Traduit les erreurs techniques en messages lisibles.
  const ERRORS = {
    "Invalid login credentials": ["Email ou mot de passe incorrect", "Wrong email or password"],
    "Email not confirmed": ["Confirmez d'abord votre email (voir votre boîte de réception)", "Please confirm your email first"],
    "User already registered": ["Cet email est déjà utilisé", "This email is already registered"],
    "NOT_AUTHENTICATED": ["Session expirée, reconnectez-vous", "Session expired, please sign in again"],
    "CODE_INVALID": ["Code d'invitation introuvable", "Invitation code not found"],
    "TONTINE_FULL": ["Cette tontine est complète", "This tontine is full"],
    "TONTINE_STARTED": ["Cette tontine a déjà démarré", "This tontine has already started"],
    "TONTINE_NOT_ACTIVE": ["La tontine n'a pas encore démarré", "The tontine has not started yet"],
    "ALREADY_PAID": ["Vous avez déjà payé ce tour", "You already paid this round"],
    "NOT_MEMBER": ["Vous n'êtes pas membre de cette tontine", "You are not a member of this tontine"],
    "NOT_OWNER": ["Seul·e l'organisateur·rice peut faire cela", "Only the organiser can do this"],
    "PLAN_LIMIT_TONTINES": ["Le plan Free est limité à 1 tontine en cours. Passez Premium pour en créer plus.", "The Free plan allows 1 ongoing tontine. Go Premium for more."],
    "PLAN_LIMIT_MEMBERS": ["Trop de membres pour votre plan (Free : 6, Premium : 20, Business : 50)", "Too many members for your plan (Free: 6, Premium: 20, Business: 50)"],
    "NOT_ENOUGH_MEMBERS": ["Il faut au moins 2 membres pour démarrer", "At least 2 members are needed to start"],
    "INVALID_INPUT": ["Vérifiez les champs du formulaire", "Please check the form fields"],
    "FORBIDDEN": ["Accès refusé", "Access denied"],
    "KYC_ALREADY_VERIFIED": ["Ton identité est déjà vérifiée", "Your identity is already verified"],
    "KYC_ALREADY_PENDING": ["Ton dossier est déjà en cours d'examen", "Your documents are already under review"],
    "KYC_BACK_REQUIRED": ["Ajoute aussi le verso de la pièce", "Please add the back of the document too"],
    "KYC_FILE_MISSING": ["Un fichier n'a pas été reçu, réessaie", "A file was not received, please retry"],
    "KYC_FILE_INVALID": ["Fichier invalide", "Invalid file"],
    "KYC_NOT_PENDING": ["Ce dossier a déjà été traité", "This file has already been reviewed"],
    "REASON_REQUIRED": ["Indique le motif du refus", "Please give a reason for the rejection"],
    "Payload too large": ["Fichier trop lourd (8 Mo maximum)", "File too large (8 MB max)"],
    "mime type": ["Format non accepté (JPG, PNG, WEBP ou PDF)", "Format not accepted (JPG, PNG, WEBP or PDF)"]
  };
  function errText(err) {
    const raw = (err && (err.message || err.error_description || err)) + "";
    for (const k in ERRORS) if (raw.indexOf(k) !== -1) return t(ERRORS[k][0], ERRORS[k][1]);
    if (/rate limit|too many/i.test(raw)) return t("Trop de tentatives, réessayez dans quelques minutes", "Too many attempts, try again in a few minutes");
    if (/password/i.test(raw) && /6|8|short|weak/i.test(raw)) return t("Mot de passe trop faible (8 caractères minimum)", "Password too weak (8 characters minimum)");
    if (/Failed to fetch|NetworkError/i.test(raw)) return t("Connexion impossible, vérifiez votre réseau", "Connection failed, check your network");
    return raw;
  }

  // ── Mode démo ───────────────────────────────────────────────────
  function isDemo() {
    const p = new URLSearchParams(location.search);
    if (p.get("mode") === "demo") { try { sessionStorage.setItem("ns_demo", "1"); } catch (e) {} return true; }
    try { return sessionStorage.getItem("ns_demo") === "1" || !sb; } catch (e) { return !sb; }
  }
  function exitDemo() { try { sessionStorage.removeItem("ns_demo"); } catch (e) {} }

  function mountDemoBanner() {
    const b = document.createElement("div");
    b.className = "demo-banner active";
    b.innerHTML = '<span data-fr="MODE DÉMO — données fictives, rien n\'est enregistré" data-en="DEMO MODE — fictional data, nothing is saved">MODE DÉMO</span>' +
      '<a href="./signup.html" data-fr="Créer mon vrai compte →" data-en="Create my real account →">Créer mon vrai compte →</a>';
    b.querySelector("a").addEventListener("click", exitDemo);
    document.body.prepend(b);
    document.body.classList.add("has-demo");
    const fit = () => document.documentElement.style.setProperty("--demo-h", b.offsetHeight + "px");
    fit(); window.addEventListener("resize", fit); document.addEventListener("langchange", fit);
  }

  const DEMO = {
    profile: { first_name: "Aïcha", last_name: "Diallo", email: "demo@neo-susu.com", phone: "+221 77 123 45 67", country: "SN", score: 82, kyc_status: "none", plan: "free", is_admin: false },
    summary: { tontine_count: 3, member_total: 22, next_turn: 1, received: [{ currency: "XOF", total: 245000 }], contributed: [{ currency: "XOF", total: 160000 }] },
    tontines: [
      { id: "demo-1", name: "Tontine Famille Diallo", amount: 25000, currency: "XOF", frequency: "monthly", max_members: 10, member_count: 8, status: "active", current_round: 4, my_turn: 5, paid_count: 6, paid_this_round: true },
      { id: "demo-2", name: "Collègues du bureau", amount: 50000, currency: "XOF", frequency: "weekly", max_members: 6, member_count: 6, status: "active", current_round: 2, my_turn: 3, paid_count: 2, paid_this_round: false },
      { id: "demo-3", name: "Projet scolarité", amount: 10000, currency: "XOF", frequency: "biweekly", max_members: 8, member_count: 4, status: "waiting", current_round: 1, my_turn: 2, paid_count: 0, paid_this_round: false }
    ],
    detail: function (id) {
      const base = DEMO.tontines.find(x => x.id === id) || DEMO.tontines[0];
      const names = [["Mamadou", "Diallo"], ["Fatou", "Sow"], ["Ibrahim", "Koné"], ["Kadiatou", "Bah"], ["Seydou", "Traoré"], ["Awa", "Ndiaye"], ["Moussa", "Camara"]];
      names.splice(base.my_turn - 1, 0, ["Aïcha", "Diallo"]);
      const members = names.slice(0, base.member_count).map((n, i) => ({
        user_id: "d" + i, first_name: n[0], last_name: n[1], turn_order: i + 1,
        is_me: i === base.my_turn - 1, paid: base.status === "active" && i < base.paid_count,
        received: base.status !== "waiting" && i + 1 < base.current_round
      }));
      return Object.assign({}, base, { description: "", invite_code: "DEMO42", is_owner: true, start_date: "2026-01-15", members: members, my_plan: "free" });
    }
  };

  // ── Authentification ────────────────────────────────────────────
  function need() { if (!sb) throw new Error(t("Service indisponible : Supabase n'est pas configuré", "Service unavailable: Supabase is not configured")); return sb; }

  async function getUser() {
    if (!sb) return null;
    const { data } = await sb.auth.getSession();
    return data.session ? data.session.user : null;
  }
  async function requireAuth() {
    const u = await getUser();
    if (!u) { location.replace("./login.html"); throw new Error("redirect"); }
    return u;
  }
  async function signUp(email, password, meta) {
    const { data, error } = await need().auth.signUp({
      email, password, options: { data: meta, emailRedirectTo: BASE + "dashboard.html" }
    });
    if (error) throw error;
    // Supabase renvoie un utilisateur sans identités si l'email existe déjà.
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0)
      throw new Error("User already registered");
    return data;
  }
  async function signIn(email, password) {
    const { data, error } = await need().auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  }
  async function signInWithGoogle() {
    const { error } = await need().auth.signInWithOAuth({ provider: "google", options: { redirectTo: BASE + "dashboard.html" } });
    if (error) throw error;
  }
  async function resetPassword(email) {
    const { error } = await need().auth.resetPasswordForEmail(email, { redirectTo: BASE + "reset-password.html" });
    if (error) throw error;
  }
  async function updatePassword(pw) {
    const { error } = await need().auth.updateUser({ password: pw });
    if (error) throw error;
  }
  async function signOut() {
    exitDemo();
    if (sb) await sb.auth.signOut();
    location.href = "./index.html";
  }

  // ── Données ─────────────────────────────────────────────────────
  async function rpc(name, args) {
    const { data, error } = await need().rpc(name, args || {});
    if (error) throw error;
    return data;
  }
  async function getProfile() {
    const u = await requireAuth();
    const { data, error } = await sb.from("profiles").select("*").eq("id", u.id).single();
    if (error) throw error;
    data.email = u.email;
    return data;
  }
  async function updateProfile(fields) {
    const u = await requireAuth();
    const { error } = await sb.from("profiles").update(fields).eq("id", u.id);
    if (error) throw error;
  }

  // ── Vérification d'identité (KYC) ──────────────────────────────
  const KYC = {
    none:     ["Vérifie ton identité →", "Verify your identity →", "chip-gold"],
    pending:  ["⏳ Identité en cours de vérification", "⏳ Identity under review", "chip-violet"],
    verified: ["✓ Identité vérifiée", "✓ Identity verified", "chip-green"],
    rejected: ["✗ Vérification refusée — renvoyer", "✗ Verification rejected — resend", "chip-red"]
  };
  function kycInfo(status) { const x = KYC[status] || KYC.none; return { text: t(x[0], x[1]), cls: x[2] }; }

  // Réduit les photos (max 2000 px, JPEG) pour accélérer l'envoi depuis un téléphone.
  async function shrinkImage(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 600 * 1024) return file;
    try {
      const bmp = await createImageBitmap(file);
      const k = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas");
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise(r => c.toBlob(r, "image/jpeg", 0.85));
      return blob && blob.size < file.size ? new File([blob], "photo.jpg", { type: "image/jpeg" }) : file;
    } catch (e) { return file; }
  }
  async function uploadKycFile(file, label) {
    const u = await requireAuth();
    const f = await shrinkImage(file);
    if (f.size > 8 * 1024 * 1024) throw new Error("Payload too large");
    const ext = f.type === "application/pdf" ? "pdf" : f.type === "image/png" ? "png" : f.type === "image/webp" ? "webp" : "jpg";
    const path = u.id + "/" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + "-" + label + "." + ext;
    const { error } = await sb.storage.from("kyc").upload(path, f, { contentType: f.type, upsert: false });
    if (error) throw error;
    return path;
  }
  async function kycSignedUrl(path) {
    const { data, error } = await need().storage.from("kyc").createSignedUrl(path, 600);
    if (error) throw error;
    return data.signedUrl;
  }

  // ── Démarrage commun ────────────────────────────────────────────
  function boot(opts) {
    opts = opts || {};
    mountLangBar();
    if (opts.demoBanner && isDemo()) mountDemoBanner();
    applyLang();
    if ("serviceWorker" in navigator && location.protocol === "https:") {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    }
  }

  window.NS = {
    sb, CFG, BASE, t, setLang, applyLang, get lang() { return lang; },
    esc, money, freqLabel, statusChip, PLANS, fee, toast, showMsg, hideMsg, setLoading, errText,
    isDemo, exitDemo, DEMO,
    getUser, requireAuth, signUp, signIn, signInWithGoogle, resetPassword, updatePassword, signOut,
    rpc, getProfile, updateProfile, boot, kycInfo, uploadKycFile, kycSignedUrl
  };
})();
