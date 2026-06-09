-- Newsletter subscribers (capture email via popup site web).
-- Sources : "popup" (auto), "footer" (manuel), "blog", "api".
CREATE TABLE IF NOT EXISTS "NewsletterSubscriber" (
  "id"             TEXT PRIMARY KEY,
  "email"          TEXT NOT NULL,
  "source"         TEXT NOT NULL DEFAULT 'popup',
  "ipHash"         TEXT,
  "country"        TEXT,
  "referrer"       TEXT,
  "utmSource"      TEXT,
  "utmMedium"      TEXT,
  "utmCampaign"    TEXT,
  "userAgent"      TEXT,
  "unsubscribedAt" TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "NewsletterSubscriber_email_key" ON "NewsletterSubscriber"("email");
CREATE INDEX IF NOT EXISTS "NewsletterSubscriber_createdAt_idx" ON "NewsletterSubscriber"("createdAt" DESC);
CREATE INDEX IF NOT EXISTS "NewsletterSubscriber_source_idx" ON "NewsletterSubscriber"("source");

-- Site visits (tracking analytique anonyme, pas d'email lie).
-- Stocke seulement les signaux non-PII : pays, device, OS, navigateur, referrer, UTM.
CREATE TABLE IF NOT EXISTS "SiteVisit" (
  "id"           TEXT PRIMARY KEY,
  "path"         TEXT NOT NULL,
  "sessionId"    TEXT,
  "ipHash"       TEXT,
  "country"      TEXT,
  "referrer"     TEXT,
  "utmSource"    TEXT,
  "utmMedium"    TEXT,
  "utmCampaign"  TEXT,
  "deviceType"   TEXT,
  "os"           TEXT,
  "browser"      TEXT,
  "language"     TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "SiteVisit_createdAt_idx" ON "SiteVisit"("createdAt" DESC);
CREATE INDEX IF NOT EXISTS "SiteVisit_path_idx" ON "SiteVisit"("path");
CREATE INDEX IF NOT EXISTS "SiteVisit_country_idx" ON "SiteVisit"("country");
CREATE INDEX IF NOT EXISTS "SiteVisit_sessionId_idx" ON "SiteVisit"("sessionId");
