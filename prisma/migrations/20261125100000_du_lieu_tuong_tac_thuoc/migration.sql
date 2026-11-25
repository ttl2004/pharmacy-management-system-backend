-- Migration du_lieu_tuong_tac_thuoc: 4 bảng dữ liệu tham chiếu tương tác thuốc (DDInter), CHỈ ĐỌC, nạp từ CSV bằng
-- `npm run import:interaction-data`. Không khoá ngoại (cố ý) và không đụng bảng nào đang có.

-- CreateTable
CREATE TABLE "ddinter_interactions_final" (
    "InteractionID" INTEGER NOT NULL,
    "DDInterID_A" VARCHAR(20) NOT NULL,
    "Drug_A" TEXT NOT NULL,
    "DDInterID_B" VARCHAR(20) NOT NULL,
    "Drug_B" TEXT NOT NULL,
    "Level" VARCHAR(20) NOT NULL,
    "Interaction" TEXT,
    "Management" TEXT,

    CONSTRAINT "ddinter_interactions_final_pkey" PRIMARY KEY ("InteractionID")
);

-- CreateTable
CREATE TABLE "drug_disease_interactions" (
    "id" INTEGER NOT NULL,
    "drug_id" VARCHAR(20) NOT NULL,
    "drug_name" TEXT NOT NULL,
    "level" INTEGER,
    "severity" VARCHAR(20) NOT NULL,
    "disease_name" TEXT NOT NULL,
    "description" TEXT,
    "references" TEXT,

    CONSTRAINT "drug_disease_interactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drug_food_interactions" (
    "id" INTEGER NOT NULL,
    "drug_id" VARCHAR(20) NOT NULL,
    "drug_name" TEXT NOT NULL,
    "level" INTEGER,
    "severity" VARCHAR(20) NOT NULL,
    "food_name" TEXT NOT NULL,
    "description" TEXT,
    "management" TEXT,
    "mechanism" TEXT,
    "references" TEXT,

    CONSTRAINT "drug_food_interactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "national_drug_ddinter_mapping" (
    "registration_number" VARCHAR(100) NOT NULL,
    "drug_name" TEXT NOT NULL,
    "drug_group" VARCHAR(50) NOT NULL,
    "inferred_route" VARCHAR(20),
    "ingredient_text_raw" TEXT,
    "ingredient_order" INTEGER NOT NULL,
    "ingredient_name" TEXT,
    "ingredient_alternates" TEXT,
    "match_method" VARCHAR(30) NOT NULL,
    "ddinter_id" VARCHAR(20),
    "ddinter_drug" TEXT,
    "confidence" DOUBLE PRECISION,
    "needs_review" BOOLEAN NOT NULL,
    "suggested_ddinter_id" VARCHAR(20),
    "suggested_ddinter_drug" TEXT,
    "suggested_score" DOUBLE PRECISION,

    CONSTRAINT "national_drug_ddinter_mapping_pkey" PRIMARY KEY ("registration_number","ingredient_order")
);

-- CreateIndex
CREATE INDEX "ddinter_interactions_final_DDInterID_A_DDInterID_B_idx" ON "ddinter_interactions_final"("DDInterID_A", "DDInterID_B");

-- CreateIndex
CREATE INDEX "drug_disease_interactions_drug_id_idx" ON "drug_disease_interactions"("drug_id");

-- CreateIndex
CREATE INDEX "drug_food_interactions_drug_id_idx" ON "drug_food_interactions"("drug_id");
