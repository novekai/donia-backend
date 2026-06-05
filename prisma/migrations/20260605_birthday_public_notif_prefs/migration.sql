-- Birthday public flag + notification channel preferences on User
-- Defensive : utilise IF NOT EXISTS pour rejouer sans planter.
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "birthdayPublic" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "notifPushEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "notifEmailEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "notifWhatsAppEnabled" BOOLEAN NOT NULL DEFAULT true;
