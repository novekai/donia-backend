-- Add privacy fields and preferred language to User
ALTER TABLE "User"
  ADD COLUMN "showEmailPublic" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "showPhonePublic" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "showAvatarPublic" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "preferredLanguage" TEXT NOT NULL DEFAULT 'fr-FR';
