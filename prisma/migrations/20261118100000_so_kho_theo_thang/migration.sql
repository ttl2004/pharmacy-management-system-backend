-- Phát sinh sổ kho theo tháng (giờ VN) cho báo cáo nhập–xuất–tồn: tồn đầu kỳ không phải quét toàn bộ sổ kho.
-- Chỉ thêm bảng, không đụng dữ liệu cũ. Bảng được dựng lười khi gọi báo cáo; xoá trắng an toàn (sẽ dựng lại).
CREATE TABLE "stock_movement_monthly" (
    "branchId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "month" DATE NOT NULL,
    "quantity" BIGINT NOT NULL,
    "value" BIGINT NOT NULL,

    CONSTRAINT "stock_movement_monthly_pkey" PRIMARY KEY ("branchId","productId","month")
);

CREATE INDEX "stock_movement_monthly_month_idx" ON "stock_movement_monthly"("month");

CREATE TABLE "stock_movement_monthly_built" (
    "month" DATE NOT NULL,
    "builtAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movement_monthly_built_pkey" PRIMARY KEY ("month")
);
