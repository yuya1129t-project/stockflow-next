-- 同じ伝票に同じ商品の明細を重複させない（受注・発注。数量は 1 行にまとめる）。
-- 伝票 ID だけの索引は、新しい一意索引の先頭列と重なるので外す

-- DropIndex
DROP INDEX "sales_order_line_salesOrderId_idx";

-- DropIndex
DROP INDEX "purchase_order_line_purchaseOrderId_idx";

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_line_salesOrderId_productId_key" ON "sales_order_line"("salesOrderId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_line_purchaseOrderId_productId_key" ON "purchase_order_line"("purchaseOrderId", "productId");
