# Donia · Backend API

Node 22 + Express + Prisma + Postgres. Déployé sur Railway (compte Novek, projet `donia-prod`).

## Stack
- **Runtime** : Node ≥ 20
- **HTTP** : Express 4 + helmet + cors + express-rate-limit + pino
- **DB** : Postgres (via Prisma 5)
- **Auth** : JWT (jsonwebtoken) + bcrypt (bcryptjs) + sessions tracées en DB
- **Validation** : Zod
- **Paiements** : FedaPay (à wirer) + webhooks
- **Emails** : Resend (à wirer)

## Dev local

```bash
# 1. Installer
cd backend
npm install

# 2. DB Postgres (option A : Docker)
docker run -d --name donia-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16

# 3. Config env
cp .env.example .env
# édite .env : DATABASE_URL et JWT_SECRET au minimum

# 4. Schéma + seed
npm run db:migrate           # crée les tables + migration initiale
npm run db:seed              # insère Awa, Kofi, Marie + 2 cards + 1 cagnotte

# 5. Run
npm run dev                  # tsx watch, hot reload
```

Le serveur tourne sur `http://localhost:3000`. Test :
```bash
curl http://localhost:3000/health
curl -X POST http://localhost:3000/v1/auth/login -H "Content-Type: application/json" \
  -d '{"identifier":"+22990123456","password":"demo1234"}'
```

## Endpoints

| Méthode | Chemin | Auth | Description |
|---|---|---|---|
| GET | `/health` | — | Liveness |
| POST | `/v1/auth/signup` | — | Créer un compte (+ wallet + referral code) |
| POST | `/v1/auth/login` | — | Login email OU téléphone |
| POST | `/v1/auth/otp/send` | — | Envoyer OTP (SMS / WhatsApp / Email) |
| POST | `/v1/auth/otp/verify` | — | Vérifier OTP |
| POST | `/v1/auth/forgot-password` | — | Demander reset code |
| POST | `/v1/auth/reset-password` | — | Reset avec OTP |
| POST | `/v1/auth/logout` | ✅ | Révoquer la session |
| GET | `/v1/me` | ✅ | Profil + wallet + KYC |
| PATCH | `/v1/me` | ✅ | Update profil |
| GET | `/v1/wallet` | ✅ | Balance |
| POST | `/v1/wallet/topup/mobile-money` | ✅ | Init payin FedaPay |
| POST | `/v1/wallet/topup/code` | ✅ | Recharger via code (avec commission 5%) |
| GET | `/v1/wallet/topup/recent` | ✅ | 5 dernières recharges |
| POST | `/v1/cards` | ✅ | Créer + envoyer une carte (débit + delivery) |
| GET | `/v1/cards/:id` | ✅ | Détail carte (sender/recipient only) |
| POST | `/v1/cards/:code/redeem` | ✅ | Convertir (5% commission + bonus parrain 1%) |
| POST | `/v1/cards/:id/react` | ✅ | Réaction emoji (❤️ 🎉 🙏 😍 ✨) |
| POST | `/v1/cards/:id/resend` | ✅ | Renvoyer le lien WhatsApp/Email |
| GET | `/v1/transactions` | ✅ | Historique paginé |
| GET | `/v1/notifications` | ✅ | Notifications paginées |
| POST | `/v1/notifications/mark-read` | ✅ | Marquer comme lu |
| GET | `/v1/referral` | ✅ | Stats parrainage |
| POST | `/v1/cagnottes` | ✅ | Créer une cagnotte |
| GET | `/v1/cagnottes/mine` | ✅ | Mes cagnottes |
| GET | `/v1/cagnottes/:id` | ✅ | Détail cagnotte + contributeurs |
| POST | `/v1/cagnottes/:id/contribute` | ✅ | Contribuer (débit wallet) |
| POST | `/v1/kyc` | ✅ | Soumettre une pièce d'identité |
| GET | `/v1/kyc` | ✅ | Dernière soumission |

Auth = header `Authorization: Bearer <JWT>`.

## Modèle économique (en code)

- **Envoi** : gratuit. Le sender débite `amount` exact (cf. `routes/cards.ts:POST /`).
- **Conversion** : 5% commission (`COMMISSION_RATE` env). Le receiver reçoit `amount - commission` (cf. `routes/cards.ts:POST /:code/redeem`).
- **Parrainage** : 1% sur les commissions de chaque filleul (`REFERRAL_RATE` env). Crédité automatiquement sur `wallet.balanceReferral`.

## Déploiement Railway

1. **Créer un nouveau projet** dans le compte **Novek** Railway : `donia-prod`
2. Ajouter un service **Postgres** (Railway le provisionne)
3. Ajouter un service **GitHub** pointant vers ce dossier `backend/` (root directory : `backend`)
4. **Env variables à set** dans Railway :
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (référence Railway au service Postgres)
   - `JWT_SECRET` = longue chaîne aléatoire ≥ 32 chars → générer : `openssl rand -base64 48`
   - `NODE_ENV=production`
   - `COMMISSION_RATE=0.05`
   - `REFERRAL_RATE=0.01`
   - `CARD_CODE_PREFIX=DON-2026`
   - `CORS_ORIGINS=https://admin.donia.app,https://donia.app` (à ajuster)
   - `FEDAPAY_*` (quand compte créé)
   - `RESEND_API_KEY` + `EMAIL_FROM` (quand domaine vérifié)
5. **Deploy** : Railway exécute automatiquement `npm run db:deploy && npm start` (cf. `railway.toml`)
6. Vérifier `https://<railway-url>/health` → `{ "ok": true }`

## TODO production

- [ ] Wirer **FedaPay** (lib `fedapay-node`) — payin Mobile Money + payout
- [ ] Wirer **Resend** + templates React Email
- [ ] Wirer **WhatsApp Cloud API** pour OTP + delivery des cartes
- [ ] Wirer **Twilio** pour SMS OTP (fallback)
- [ ] Upload S3/R2 + signed URLs pour KYC docs
- [ ] Notifications push (Expo Push API ou FCM)
- [ ] Jobs background (BullMQ) pour delivery resilient
- [ ] Tests (vitest + supertest)
- [ ] Endpoints admin (séparé sous `/v1/admin/*` avec rôle ADMIN)
- [ ] Endpoint `DELETE /v1/me` (obligation Google Play 2024)
