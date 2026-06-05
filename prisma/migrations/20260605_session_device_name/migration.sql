-- Add deviceName to Session for friendly display in "Appareils connectés"
ALTER TABLE "Session"
  ADD COLUMN IF NOT EXISTS "deviceName" TEXT;
