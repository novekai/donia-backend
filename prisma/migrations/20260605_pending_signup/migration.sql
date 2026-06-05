-- PendingSignup : signups en attente de vérification OTP. Le User n'existe pas tant
-- que l'OTP n'est pas validé. Permet d'éviter d'avoir des comptes "fantômes" non confirmés.
CREATE TABLE IF NOT EXISTS "PendingSignup" (
  "id" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "email" TEXT,
  "whatsapp" TEXT,
  "name" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "sex" "Sex",
  "dob" TIMESTAMP(3),
  "city" TEXT,
  "country" TEXT NOT NULL DEFAULT 'BJ',
  "referredBy" TEXT,
  "deviceName" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PendingSignup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PendingSignup_phone_key" ON "PendingSignup"("phone");
CREATE INDEX IF NOT EXISTS "PendingSignup_expiresAt_idx" ON "PendingSignup"("expiresAt");
