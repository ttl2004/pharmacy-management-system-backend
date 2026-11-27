-- Nhập thuốc từ ảnh tờ HDSD (PHA-5): thuốc nhập tay (MANUAL) cùng bảng với thuốc DQG, thêm 5 trường từ tờ HDSD,
-- bảng bản nháp dùng chung. Dữ liệu cũ: mọi thuốc hiện có là DQG (DEFAULT 'DQG').

-- CreateEnum
CREATE TYPE "DrugSource" AS ENUM ('DQG', 'MANUAL');

-- CreateEnum
CREATE TYPE "DrugLeafletDraftStatus" AS ENUM ('PROCESSING', 'READY', 'FAILED', 'SAVED', 'DISCARDED');

-- AlterTable
ALTER TABLE "drugs" ADD COLUMN     "dosageFormText" VARCHAR(250),
ADD COLUMN     "interactions" TEXT,
ADD COLUMN     "leafletImageUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "overdose" TEXT,
ADD COLUMN     "pregnancyLactation" TEXT,
ADD COLUMN     "shelfLife" VARCHAR(100),
ADD COLUMN     "source" "DrugSource" NOT NULL DEFAULT 'DQG',
ALTER COLUMN "syncedAt" DROP NOT NULL;

-- CreateTable
CREATE TABLE "drug_leaflet_drafts" (
    "id" UUID NOT NULL,
    "extractionId" VARCHAR(64) NOT NULL,
    "status" "DrugLeafletDraftStatus" NOT NULL DEFAULT 'PROCESSING',
    "error" TEXT,
    "imageCount" INTEGER NOT NULL,
    "productId" UUID,
    "drugId" UUID,
    "savedAt" TIMESTAMPTZ(3),
    "savedBy" UUID,
    "discardedAt" TIMESTAMPTZ(3),
    "discardedBy" UUID,
    "imagesCopiedAt" TIMESTAMPTZ(3),
    "feedbackSentAt" TIMESTAMPTZ(3),
    "feedbackPayload" JSONB,
    "followUpAttempts" INTEGER NOT NULL DEFAULT 0,
    "followUpError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID,
    "updatedAt" TIMESTAMPTZ(3),
    "updatedBy" UUID,

    CONSTRAINT "drug_leaflet_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "drug_leaflet_drafts_status_createdAt_idx" ON "drug_leaflet_drafts"("status", "createdAt");

-- CreateIndex
CREATE INDEX "drugs_source_idx" ON "drugs"("source");

-- AddForeignKey
ALTER TABLE "drug_leaflet_drafts" ADD CONSTRAINT "drug_leaflet_drafts_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drug_leaflet_drafts" ADD CONSTRAINT "drug_leaflet_drafts_drugId_fkey" FOREIGN KEY ("drugId") REFERENCES "drugs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Viết tay - Prisma không khai được SEQUENCE nhưng cũng không xoá nó ở migration sau.
-- Mã thuốc MANUAL: 'MANUAL-' + 6 chữ số từ sequence này (MANUAL-000001).
CREATE SEQUENCE "drug_manual_code_seq";
