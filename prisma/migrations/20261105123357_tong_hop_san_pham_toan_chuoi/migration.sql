-- CreateTable
CREATE TABLE "sales_daily_product_chain" (
    "date" DATE NOT NULL,
    "channel" "OrderChannel" NOT NULL,
    "productId" UUID NOT NULL,
    "qtyBase" INTEGER NOT NULL DEFAULT 0,
    "revenue" BIGINT NOT NULL DEFAULT 0,
    "cogsAmount" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_daily_product_chain_pkey" PRIMARY KEY ("date","channel","productId")
);

-- CreateIndex
CREATE INDEX "sales_daily_product_chain_date_idx" ON "sales_daily_product_chain"("date");

-- CreateIndex
CREATE INDEX "orders_completedAt_idx" ON "orders"("completedAt");

-- AddForeignKey
ALTER TABLE "sales_daily_product_chain" ADD CONSTRAINT "sales_daily_product_chain_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
