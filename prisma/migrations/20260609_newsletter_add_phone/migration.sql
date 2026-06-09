-- Newsletter : permettre de capturer email OU numero WhatsApp.
-- On rend email nullable et on ajoute phone (E.164) nullable + unique partiel.
ALTER TABLE "NewsletterSubscriber" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "NewsletterSubscriber" ADD COLUMN IF NOT EXISTS "phone" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "NewsletterSubscriber_phone_key" ON "NewsletterSubscriber"("phone") WHERE "phone" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "NewsletterSubscriber_phone_idx" ON "NewsletterSubscriber"("phone");
