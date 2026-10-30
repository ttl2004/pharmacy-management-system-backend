-- Viết tay: trigram cho tìm kiếm ILIKE. Supabase đặt extension ở schema "extensions"; ghi rõ schema của opclass
-- để migration chạy được cả khi search_path chỉ có schema riêng (vd schema e2e).
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

-- AlterTable
ALTER TABLE "drugs" ADD COLUMN     "contraindications" TEXT,
ADD COLUMN     "dosage" TEXT,
ADD COLUMN     "effects" TEXT,
ADD COLUMN     "indications" TEXT,
ADD COLUMN     "sideEffects" TEXT,
ADD COLUMN     "storage" TEXT,
ADD COLUMN     "warnings" TEXT;

-- CreateIndex
CREATE INDEX "drugs_name_trgm_idx" ON "drugs" USING GIN ("name" extensions.gin_trgm_ops);

-- CreateIndex
CREATE INDEX "drugs_code_trgm_idx" ON "drugs" USING GIN ("code" extensions.gin_trgm_ops);

-- CreateIndex
CREATE INDEX "drugs_ingredients_trgm_idx" ON "drugs" USING GIN ("ingredients" extensions.gin_trgm_ops);

-- CreateIndex
CREATE INDEX "drugs_registration_number_trgm_idx" ON "drugs" USING GIN ("registrationNumber" extensions.gin_trgm_ops);
