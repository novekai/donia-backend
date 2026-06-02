// Templates email — HTML simple, optimisés pour mobile + Gmail dark mode
// Plus tard on migrera sur @react-email/components pour des templates plus riches.

import { env } from '../config/env';

type OtpEmailArgs = {
  code: string;
  expiresInMinutes?: number;
};

export function otpEmailTemplate({ code, expiresInMinutes = 10 }: OtpEmailArgs): {
  subject: string;
  html: string;
  text: string;
} {
  const codeSpaced = code.split('').join(' '); // "1 2 3 4 5 6" for accessibility
  return {
    subject: `Donia — Ton code de connexion : ${code}`,
    text: `Ton code Donia : ${code}\n\nIl expire dans ${expiresInMinutes} minutes.\n\nSi tu n'as pas demandé ce code, ignore ce message.\n\n— L'équipe Donia`,
    html: `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Code Donia</title>
</head>
<body style="margin:0;padding:0;background:#FDF7F6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#FDF7F6;">
    <tr>
      <td align="center" style="padding:40px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:480px;background:#FFFFFF;border-radius:24px;overflow:hidden;box-shadow:0 4px 16px rgba(42,15,26,0.08);">

          <!-- Header indigo -->
          <tr>
            <td align="center" style="background:linear-gradient(135deg,#41087B 0%,#2A0454 100%);padding:36px 24px;color:#FDF7F6;">
              <div style="font-family:Georgia,'Times New Roman',serif;font-size:36px;font-weight:500;letter-spacing:-1px;">
                Don<span style="font-style:italic;color:#F4486F;">i</span>a
              </div>
              <div style="margin-top:6px;font-size:13px;color:#F9A01C;font-style:italic;">Le cadeau qui se partage ✨</div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:32px 28px;color:#2A0F1A;">
              <h1 style="margin:0 0 8px;font-size:22px;font-weight:600;color:#2A0F1A;">Ton code de connexion</h1>
              <p style="margin:0 0 24px;font-size:14px;color:#6F4A5A;line-height:1.5;">
                Entre ce code dans Donia pour confirmer ton identité. Il expire dans ${expiresInMinutes} minutes.
              </p>

              <!-- Code -->
              <div style="background:#F8E6E2;border-radius:16px;padding:20px;text-align:center;margin-bottom:24px;">
                <div style="font-family:'Courier New',monospace;font-size:36px;font-weight:700;letter-spacing:6px;color:#F4486F;">
                  ${code}
                </div>
                <div style="margin-top:6px;font-size:11px;color:#6F4A5A;font-style:italic;">
                  ${codeSpaced}
                </div>
              </div>

              <p style="margin:0 0 8px;font-size:13px;color:#6F4A5A;line-height:1.5;">
                Si tu n'as pas demandé ce code, ignore ce message — quelqu'un a probablement saisi ton email par erreur.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 28px 28px;border-top:1px solid #F8E6E2;color:#B59AA5;font-size:11px;line-height:1.6;">
              <div style="font-style:italic;margin-bottom:4px;">— L'équipe Donia</div>
              <div>Cartes cadeaux Mobile Money · Afrique de l'Ouest</div>
              <div style="margin-top:8px;">Bénin · Côte d'Ivoire · Sénégal · Togo</div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
  };
}

type CardReceivedArgs = {
  recipientName?: string;
  senderName: string;
  amount: string;
  redeemCode: string;
  message?: string;
  appLink?: string;
};

export function cardReceivedTemplate(args: CardReceivedArgs): { subject: string; html: string; text: string } {
  const link = args.appLink ?? 'https://donia.app';
  return {
    subject: `${args.senderName} t'a envoyé ${args.amount} FCFA sur Donia 🎁`,
    text: `${args.senderName} t'a envoyé un cadeau Donia de ${args.amount} FCFA.\n\nTon code de retrait : ${args.redeemCode}\n\n${args.message ? `Message : « ${args.message} »\n\n` : ''}Ouvre Donia pour convertir ton cadeau : ${link}\n\n— L'équipe Donia`,
    html: `<!DOCTYPE html>
<html lang="fr"><body style="margin:0;padding:0;background:#FDF7F6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
<table cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#FDF7F6;"><tr><td align="center" style="padding:40px 20px;">
<table cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:480px;background:#FFFFFF;border-radius:24px;overflow:hidden;box-shadow:0 4px 16px rgba(42,15,26,0.08);">
  <tr><td style="background:linear-gradient(135deg,#F4486F 0%,#D62E55 100%);padding:32px 24px;color:#FDF7F6;text-align:center;">
    <div style="font-size:48px;margin-bottom:10px;">🎁</div>
    <div style="font-family:Georgia,serif;font-size:24px;font-weight:500;">${args.senderName} t'a envoyé</div>
    <div style="font-family:Georgia,serif;font-size:42px;font-weight:700;letter-spacing:-1px;margin-top:8px;">${args.amount} <span style="font-size:18px;font-weight:500;opacity:0.85;">FCFA</span></div>
  </td></tr>
  <tr><td style="padding:28px 28px 8px;color:#2A0F1A;">
    ${args.message ? `<div style="background:#F8E6E2;border-radius:12px;padding:14px 16px;font-style:italic;color:#2A0F1A;line-height:1.5;margin-bottom:24px;">« ${args.message} »</div>` : ''}
    <p style="margin:0 0 8px;font-size:14px;color:#6F4A5A;">Ton code de retrait :</p>
    <div style="background:#41087B;border-radius:12px;padding:16px;text-align:center;color:#FDF7F6;font-family:'Courier New',monospace;font-size:22px;font-weight:700;letter-spacing:2px;margin-bottom:24px;">
      ${args.redeemCode}
    </div>
    <a href="${link}" style="display:block;background:linear-gradient(135deg,#F4486F 0%,#D62E55 100%);color:#FDF7F6;text-decoration:none;padding:16px 24px;border-radius:14px;text-align:center;font-weight:600;font-size:15px;margin-bottom:16px;">Ouvrir Donia →</a>
    <p style="margin:0;font-size:12px;color:#B59AA5;line-height:1.5;">Conserve ce code — il permet la conversion de ton cadeau en argent sur Mobile Money ou sur ton solde Donia. Commission de 5% sur la conversion.</p>
  </td></tr>
  <tr><td style="padding:20px 28px 28px;border-top:1px solid #F8E6E2;color:#B59AA5;font-size:11px;">
    <div style="font-style:italic;margin-bottom:4px;">— L'équipe Donia</div>
    <div>Bénin · Côte d'Ivoire · Sénégal · Togo</div>
  </td></tr>
</table></td></tr></table></body></html>`,
  };
}
