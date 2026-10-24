-- CreateEnum
CREATE TYPE "PriceBookPolicy" AS ENUM ('ALLOW', 'WARN', 'BLOCK');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "priceBookId" UUID,
ADD COLUMN     "priceBookName" VARCHAR(100);

-- CreateTable
CREATE TABLE "price_books" (
    "id" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID,
    "updatedAt" TIMESTAMPTZ(3),
    "updatedBy" UUID,
    "name" VARCHAR(100) NOT NULL,
    "startAt" TIMESTAMPTZ(3) NOT NULL,
    "endAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "outOfBookPolicy" "PriceBookPolicy" NOT NULL DEFAULT 'ALLOW',
    "formulaBase" VARCHAR(50),
    "formulaOp" VARCHAR(1),
    "formulaAmount" INTEGER,
    "formulaUnit" VARCHAR(3),

    CONSTRAINT "price_books_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_book_branches" (
    "priceBookId" UUID NOT NULL,
    "branchId" UUID NOT NULL,

    CONSTRAINT "price_book_branches_pkey" PRIMARY KEY ("priceBookId","branchId")
);

-- CreateTable
CREATE TABLE "price_book_users" (
    "priceBookId" UUID NOT NULL,
    "userId" UUID NOT NULL,

    CONSTRAINT "price_book_users_pkey" PRIMARY KEY ("priceBookId","userId")
);

-- CreateTable
CREATE TABLE "price_book_items" (
    "priceBookId" UUID NOT NULL,
    "productUnitId" UUID NOT NULL,
    "price" INTEGER NOT NULL,

    CONSTRAINT "price_book_items_pkey" PRIMARY KEY ("priceBookId","productUnitId")
);

-- CreateIndex
CREATE UNIQUE INDEX "price_books_name_key" ON "price_books"("name");

-- CreateIndex
CREATE INDEX "price_book_branches_branchId_idx" ON "price_book_branches"("branchId");

-- CreateIndex
CREATE INDEX "price_book_users_userId_idx" ON "price_book_users"("userId");

-- CreateIndex
CREATE INDEX "price_book_items_productUnitId_idx" ON "price_book_items"("productUnitId");

-- CreateIndex
CREATE INDEX "orders_priceBookId_idx" ON "orders"("priceBookId");

-- AddForeignKey
ALTER TABLE "price_book_branches" ADD CONSTRAINT "price_book_branches_priceBookId_fkey" FOREIGN KEY ("priceBookId") REFERENCES "price_books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_book_branches" ADD CONSTRAINT "price_book_branches_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_book_users" ADD CONSTRAINT "price_book_users_priceBookId_fkey" FOREIGN KEY ("priceBookId") REFERENCES "price_books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_book_users" ADD CONSTRAINT "price_book_users_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_book_items" ADD CONSTRAINT "price_book_items_priceBookId_fkey" FOREIGN KEY ("priceBookId") REFERENCES "price_books"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_book_items" ADD CONSTRAINT "price_book_items_productUnitId_fkey" FOREIGN KEY ("productUnitId") REFERENCES "product_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_priceBookId_fkey" FOREIGN KEY ("priceBookId") REFERENCES "price_books"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
--  PHẦN VIẾT TAY — Prisma không khai được; viết ở đây, không đưa vào schema.
-- ============================================================

-- Tên bảng giá duy nhất không phân biệt hoa thường ("Giá sỉ" và "giá SỈ" là một).
CREATE UNIQUE INDEX "price_books_name_lower_key" ON "price_books" (lower("name"));

-- Giá ≥ 0; thời gian hiệu lực hợp lệ; công thức hoặc có đủ 4 trường hoặc không có trường nào.
ALTER TABLE "price_book_items" ADD CONSTRAINT "price_book_items_price_chk" CHECK ("price" >= 0);
ALTER TABLE "price_books"
  ADD CONSTRAINT "price_books_range_chk" CHECK ("endAt" > "startAt"),
  ADD CONSTRAINT "price_books_formula_chk" CHECK (
    ("formulaBase" IS NULL AND "formulaOp" IS NULL AND "formulaAmount" IS NULL AND "formulaUnit" IS NULL)
    OR ("formulaBase" IS NOT NULL AND "formulaOp" IN ('+', '-') AND "formulaAmount" >= 0 AND "formulaUnit" IN ('vnd', '%'))
  );
