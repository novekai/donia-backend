// Plain-text templates pour les messages WhatsApp (envoyés via WAHA).
// WhatsApp gère un sous-ensemble du markdown : *gras*, _italique_, ~barré~, ```code```
// On évite les emojis "OS-specific" et on garde un ton chaleureux.

type OtpArgs = {
  code: string;
  expiresInMinutes?: number;
};

export function whatsAppOtp({ code, expiresInMinutes = 10 }: OtpArgs): string {
  return [
    `*Donia* — Ton code de connexion`,
    ``,
    `🔐  *${code}*`,
    ``,
    `Il expire dans ${expiresInMinutes} minutes.`,
    `Si tu n'as pas demandé ce code, ignore ce message.`,
    ``,
    `— L'équipe Donia`,
  ].join('\n');
}

type CardArgs = {
  recipientName?: string;
  senderName: string;
  amount: string;          // already formatted "10 000"
  redeemCode: string;
  message?: string;
  redeemUrl?: string;      // optional deep link / web fallback
};

export function whatsAppCardDelivery(args: CardArgs): string {
  const hello = args.recipientName ? `Salut ${args.recipientName} 👋` : 'Salut 👋';
  const messageBlock = args.message
    ? [`💌  _« ${args.message} »_`, ``]
    : [];
  const cta = args.redeemUrl
    ? [`Pour la convertir en Mobile Money :`, `${args.redeemUrl}`, ``, `Ou tape le code dans l'app Donia :`, `*${args.redeemCode}*`]
    : [`Pour la convertir en Mobile Money, ouvre l'app Donia et tape ce code :`, `*${args.redeemCode}*`];

  return [
    hello,
    ``,
    `🎁  *${args.senderName}* t'a envoyé une carte Donia de *${args.amount} FCFA*.`,
    ``,
    ...messageBlock,
    ...cta,
    ``,
    `📲  Pas encore l'app ? Télécharge-la : https://doniia.com`,
    ``,
    `— L'équipe Donia`,
  ].join('\n');
}

type CagnotteInviteArgs = {
  cagnotteOwner: string;
  cagnotteTitle: string;
  inviteUrl: string;
};

export function whatsAppCagnotteInvite(args: CagnotteInviteArgs): string {
  return [
    `Salut 👋`,
    ``,
    `*${args.cagnotteOwner}* a lancé une cagnotte sur Donia :`,
    `_« ${args.cagnotteTitle} »_`,
    ``,
    `Tu peux y contribuer du montant que tu veux ici :`,
    `${args.inviteUrl}`,
    ``,
    `— L'équipe Donia`,
  ].join('\n');
}
