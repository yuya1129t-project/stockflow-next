-- 同じ伝票に同じ商品の明細を重複させない（受注・発注。数量は 1 行にまとめる）

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_line_salesOrderId_productId_key" ON "sales_order_line"("salesOrderId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_order_line_purchaseOrderId_productId_key" ON "purchase_order_line"("purchaseOrderId", "productId");
