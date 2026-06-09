-- Cagnotte : permettre le partage public + contribution sans compte Donia.
-- Le contributeur peut payer directement via Mobile Money (FedaPay/KKiaPay).
-- Le retrait par l organisateur preleve une commission (defaut 3%).
ALTER TABLE "Cagnotte" ADD COLUMN IF NOT EXISTS "publicCode" TEXT;
ALTER TABLE "Cagnotte" ADD COLUMN IF NOT EXISTS "commissionPercent" DECIMAL(5,2) NOT NULL DEFAULT 3.00;
ALTER TABLE "Cagnotte" ADD COLUMN IF NOT EXISTS "withdrawnAt" TIMESTAMP(3);
ALTER TABLE "Cagnotte" ADD COLUMN IF NOT EXISTS "withdrawnAmount" DECIMAL(14,2);

CREATE UNIQUE INDEX IF NOT EXISTS "Cagnotte_publicCode_key" ON "Cagnotte"("publicCode");

-- CagnotteContribution : permettre contributeur sans compte Donia.
ALTER TABLE "CagnotteContribution" ALTER COLUMN "contributorId" DROP NOT NULL;
ALTER TABLE "CagnotteContribution" ADD COLUMN IF NOT EXISTS "contributorName" TEXT;
ALTER TABLE "CagnotteContribution" ADD COLUMN IF NOT EXISTS "contributorPhone" TEXT;
ALTER TABLE "CagnotteContribution" ADD COLUMN IF NOT EXISTS "txId" TEXT;
ALTER TABLE "CagnotteContribution" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'CONFIRMED';
-- Status : 'PENDING' (paiement public en cours), 'CONFIRMED' (paiement valide), 'FAILED'

CREATE INDEX IF NOT EXISTS "CagnotteContribution_txId_idx" ON "CagnotteContribution"("txId");
CREATE INDEX IF NOT EXISTS "CagnotteContribution_status_idx" ON "CagnotteContribution"("status");

-- Backfill : generer un publicCode pour les cagnottes existantes (id slice 8 chars).
UPDATE "Cagnotte" SET "publicCode" = substr("id", 1, 8) WHERE "publicCode" IS NULL;
