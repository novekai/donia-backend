-- Birthday : nouveaux champs sur User pour profil + visibilite granulaire + carte auto.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "birthdayNote" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "birthdayShowAge" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "birthdayAutoCard" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "birthdayAutoCardAmount" INTEGER NOT NULL DEFAULT 500;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "birthdayVisibility" TEXT NOT NULL DEFAULT 'contacts';
-- 'public' = tout le monde voit | 'contacts' = uniquement mes Cercles | 'private' = personne
