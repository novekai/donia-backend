-- Ajoute senderPhone (alternative au senderEmail) sur AnonymousMessage.
-- Le formulaire web capture obligatoirement l'un des deux pour permettre
-- de notifier l'expediteur a l'anniversaire du destinataire ("Cercle").
ALTER TABLE "AnonymousMessage" ADD COLUMN IF NOT EXISTS "senderPhone" TEXT;
