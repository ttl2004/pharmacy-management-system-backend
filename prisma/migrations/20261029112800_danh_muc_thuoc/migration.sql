-- AlterTable
ALTER TABLE "products" ADD COLUMN     "drugId" UUID;

-- CreateTable
CREATE TABLE "drugs" (
    "id" UUID NOT NULL,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID,
    "updatedAt" TIMESTAMPTZ(3),
    "updatedBy" UUID,
    "code" VARCHAR(50) NOT NULL,
    "name" VARCHAR(250) NOT NULL,
    "drugGroup" VARCHAR(100),
    "controlType" VARCHAR(100),
    "isPrescription" BOOLEAN NOT NULL DEFAULT false,
    "registrationNumber" VARCHAR(50),
    "registeredAt" DATE,
    "registrationExpiresAt" DATE,
    "strength" VARCHAR(100),
    "ingredients" TEXT,
    "manufacturerName" VARCHAR(250),
    "countryOfOrigin" VARCHAR(100),
    "packagingSpec" VARCHAR(250),
    "route" VARCHAR(100),
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "syncedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "drugs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "drugs_code_key" ON "drugs"("code");

-- CreateIndex
CREATE INDEX "drugs_name_idx" ON "drugs"("name");

-- CreateIndex
CREATE INDEX "drugs_status_idx" ON "drugs"("status");

-- CreateIndex
CREATE INDEX "products_drugId_idx" ON "products"("drugId");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_drugId_fkey" FOREIGN KEY ("drugId") REFERENCES "drugs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
