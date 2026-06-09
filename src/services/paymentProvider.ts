// Couche d'abstraction multi-PSP (FedaPay + KKiaPay).
// Le provider actif est pilote depuis la setting `active_payment_provider`
// (admin BO). Ajouter un nouveau PSP = implementer cette interface et
// l'enregistrer dans `getActiveProvider`.
//
// Important : on garde TOUJOURS les montants en FCFA (XOF entier) cote provider.
// La conversion FCFA/EUR est faite cote mobile + cote createTopup si necessaire.

import { getPlatformSettings } from './platformSettings';

export type ProviderKey = 'fedapay' | 'kkiapay';

// ─── Inputs / outputs unifies ───────────────────────────────────────────

export type TopupInput = {
  amountFcfa: number;            // XOF integer (toujours)
  operator: string;              // 'mtn' | 'moov' | 'orange' | 'wave' | 'card'
  country: string;               // ISO-2, ex 'BJ'
  description: string;
  currency: 'XOF' | 'EUR';       // devise affichee a l'user (carte = EUR oblige)
  callbackUrl?: string;          // URL de retour apres paiement (page de confirmation)
  customer: {
    firstname?: string;
    lastname?: string;
    email?: string | null;
    phone: string;               // E.164
  };
  metadata?: Record<string, string | number | boolean>;
};

export type TopupResult = {
  paymentUrl: string;
  providerTxId: string;          // ref a stocker dans tx.ref
};

export type PayoutInput = {
  amountFcfa: number;
  operator: string;              // 'mtn' | 'moov' | 'orange' | 'wave'
  country: string;
  description: string;
  customer: {
    firstname?: string;
    lastname?: string;
    phone: string;               // E.164
  };
  metadata?: Record<string, string | number | boolean>;
};

export type PayoutResult = {
  providerPayoutId: string;
  status: 'pending' | 'sent' | 'approved' | 'declined' | 'failed';
};

// ─── Interface PSP ──────────────────────────────────────────────────────

export interface PaymentProvider {
  key: ProviderKey;
  isConfigured(): boolean;        // les cles env sont-elles presentes ?

  /** Cree une transaction d'encaissement (recharge solde ou achat carte). */
  createTopup(input: TopupInput): Promise<TopupResult>;

  /** Cree + declenche un payout (retrait Mobile Money). Throw si pas configurable/active. */
  createPayout(input: PayoutInput): Promise<PayoutResult>;

  /** Verifie la signature d'un webhook entrant. */
  verifyWebhookSignature(rawBody: Buffer | string, signatureHeader: string | undefined): boolean;
}

// ─── Factory ────────────────────────────────────────────────────────────

// Import-lazily pour eviter les dependances circulaires.
async function loadProvider(key: ProviderKey): Promise<PaymentProvider> {
  if (key === 'kkiapay') {
    const mod = await import('./kkiapay');
    return mod.kkiapayProvider;
  }
  const mod = await import('./fedapay');
  return mod.fedapayProvider;
}

export async function getActiveProvider(): Promise<PaymentProvider> {
  const settings = await getPlatformSettings();
  const key = (settings.active_payment_provider ?? 'fedapay') as ProviderKey;
  const provider = await loadProvider(key);

  // Fallback gracieux : si le provider actif n'est pas configure (cles manquantes),
  // on bascule sur l'autre. Evite de bloquer si Paul change la setting avant
  // d'avoir mis les cles dans Railway.
  if (!provider.isConfigured()) {
    const other = key === 'fedapay' ? 'kkiapay' : 'fedapay';
    const fallback = await loadProvider(other);
    if (fallback.isConfigured()) return fallback;
  }
  return provider;
}

export async function getProvider(key: ProviderKey): Promise<PaymentProvider> {
  return loadProvider(key);
}
