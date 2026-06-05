-- Add privacy fields and preferred language to User
-- Defensive : utilise IF NOT EXISTS pour rejouer sans planter
-- si une tentative précédente a déjà créé certaines colonnes.
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "showEmailPublic" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "showPhonePublic" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "showAvatarPublic" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "preferredLanguage" TEXT NOT NULL DEFAULT 'fr-FR';
