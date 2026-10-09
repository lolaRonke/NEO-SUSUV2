// Client minimal de l'API Mangopay v2.01 (Deno / Supabase Edge Functions).
// Secrets attendus : MANGOPAY_CLIENT_ID, MANGOPAY_API_KEY, MANGOPAY_BASE_URL
// (https://api.sandbox.mangopay.com en test, https://api.mangopay.com en production).

type Money = { Currency: string; Amount: number };
export type MpStatus = "CREATED" | "SUCCEEDED" | "FAILED";
export type MpResource = { Id: string; Status: MpStatus; ResultCode?: string; ResultMessage?: string; Tag?: string };

const CLIENT_ID = Deno.env.get("MANGOPAY_CLIENT_ID") ?? "";
const API_KEY = Deno.env.get("MANGOPAY_API_KEY") ?? "";
const BASE_URL = Deno.env.get("MANGOPAY_BASE_URL") ?? "https://api.sandbox.mangopay.com";

let token: { value: string; expiresAt: number } | null = null;

async function getToken(): Promise<string> {
  if (token && token.expiresAt > Date.now() + 60_000) return token.value;
  if (!CLIENT_ID || !API_KEY) throw new Error("MANGOPAY_CLIENT_ID / MANGOPAY_API_KEY manquants");
  const res = await fetch(`${BASE_URL}/v2.01/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${CLIENT_ID}:${API_KEY}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`Mangopay OAuth ${res.status}: ${await res.text()}`);
  const data = await res.json();
  token = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return token.value;
}

// idempotencyKey (16 a 36 caracteres) : un POST rejoue avec la meme cle renvoie
// la meme ressource au lieu d'en creer une seconde -> pas de double transfert / double virement.
async function call<T>(method: "GET" | "POST", path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await getToken()}`,
    "Content-Type": "application/json",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(`${BASE_URL}/v2.01/${CLIENT_ID}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Mangopay ${method} ${path} ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

const money = (currency: string, amount: number): Money => ({ Currency: currency, Amount: amount });

export type NaturalUserInput = {
  firstName: string;
  lastName: string;
  email: string;
  birthday: number; // timestamp Unix (secondes)
  nationality: string; // code ISO, ex. "FR"
  countryOfResidence: string;
  address: { AddressLine1: string; City: string; PostalCode: string; Country: string };
};

export const mangopay = {
  // Tout membre peut devenir beneficiaire et recevoir un virement -> categorie OWNER.
  createNaturalUser: (u: NaturalUserInput) =>
    call<{ Id: string }>("POST", "/users/natural", {
      FirstName: u.firstName,
      LastName: u.lastName,
      Email: u.email,
      Birthday: u.birthday,
      Nationality: u.nationality,
      CountryOfResidence: u.countryOfResidence,
      Address: u.address,
      UserCategory: "OWNER",
      TermsAndConditionsAccepted: true,
    }),

  createWallet: (userId: string, currency: string) =>
    call<{ Id: string }>("POST", "/wallets", { Owners: [userId], Currency: currency, Description: "NEO-SUSU" }),

  createIbanAccount: (userId: string, ownerName: string, iban: string, address: NaturalUserInput["address"]) =>
    call<{ Id: string }>("POST", `/users/${userId}/bankaccounts/iban`, {
      OwnerName: ownerName,
      OwnerAddress: address,
      IBAN: iban.replace(/\s+/g, ""),
    }),

  // Paiement par carte vers le wallet du membre lui-meme : l'argent reste a son nom
  // jusqu'a ce que tout le groupe ait paye.
  createCardWebPayIn: (p: { authorId: string; walletId: string; currency: string; amount: number; returnUrl: string; tag: string }) =>
    call<MpResource & { RedirectURL: string }>("POST", "/payins/card/web", {
      AuthorId: p.authorId,
      CreditedWalletId: p.walletId,
      DebitedFunds: money(p.currency, p.amount),
      Fees: money(p.currency, 0),
      ReturnURL: p.returnUrl,
      CardType: "CB_VISA_MASTERCARD",
      Culture: "FR",
      Tag: p.tag,
    }),

  // Les Fees sont preleves sur le montant et verses sur le wallet de frais de la plateforme.
  createTransfer: (
    p: { authorId: string; fromWallet: string; toWallet: string; currency: string; amount: number; fee: number; tag: string },
    idempotencyKey: string,
  ) =>
    call<MpResource>("POST", "/transfers", {
      AuthorId: p.authorId,
      DebitedWalletId: p.fromWallet,
      CreditedWalletId: p.toWallet,
      DebitedFunds: money(p.currency, p.amount),
      Fees: money(p.currency, p.fee),
      Tag: p.tag,
    }, idempotencyKey),

  createPayout: (
    p: { authorId: string; walletId: string; bankAccountId: string; currency: string; amount: number; tag: string },
    idempotencyKey: string,
  ) =>
    call<MpResource>("POST", "/payouts/bank-wire", {
      AuthorId: p.authorId,
      DebitedWalletId: p.walletId,
      BankAccountId: p.bankAccountId,
      DebitedFunds: money(p.currency, p.amount),
      Fees: money(p.currency, 0),
      BankWireRef: "NEO-SUSU",
      Tag: p.tag,
    }, idempotencyKey),

  getPayIn: (id: string) => call<MpResource>("GET", `/payins/${id}`),
  getPayout: (id: string) => call<MpResource>("GET", `/payouts/${id}`),
};
