-- CreateTable
CREATE TABLE "sales_daily" (
    "branchId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "channel" "OrderChannel" NOT NULL,
    "orderCount" INTEGER NOT NULL DEFAULT 0,
    "revenue" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_daily_pkey" PRIMARY KEY ("branchId","date","channel")
);

-- CreateTable
CREATE TABLE "sales_daily_product" (
    "branchId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "channel" "OrderChannel" NOT NULL,
    "productId" UUID NOT NULL,
    "qtyBase" INTEGER NOT NULL DEFAULT 0,
    "revenue" BIGINT NOT NULL DEFAULT 0,
    "cogsAmount" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "sales_daily_product_pkey" PRIMARY KEY ("branchId","date","channel","productId")
);

-- CreateIndex
CREATE INDEX "sales_daily_date_idx" ON "sales_daily"("date");

-- CreateIndex
CREATE INDEX "sales_daily_product_date_branchId_idx" ON "sales_daily_product"("date", "branchId");

-- AddForeignKey
ALTER TABLE "sales_daily" ADD CONSTRAINT "sales_daily_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_daily_product" ADD CONSTRAINT "sales_daily_product_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_daily_product" ADD CONSTRAINT "sales_daily_product_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
