/**
 * 受注・発注のステータス遷移と在庫（staff）。各テストで商品を作り、その商品の在庫だけを確かめる
 */
import { expect, test } from "@playwright/test";

import {
  adjustStock,
  changeStatus,
  createProduct,
  createSalesOrder,
  expectStock,
  STORAGE_STATE,
  statusText,
} from "./helpers";

test.use({ storageState: STORAGE_STATE.staff });

test("受注を作成 → 確定 → 出荷すると在庫が減る", async ({ page }) => {
  const product = await createProduct(page);
  await adjustStock(page, product.id, 10);

  const orderId = await createSalesOrder(page, product.id, 3);
  await expect(statusText(page)).toHaveText("下書き");

  await changeStatus(page, "確定する");
  await page.waitForURL(`/sales-orders/${orderId}?saved=confirmed`);
  await expect(page.getByRole("status")).toHaveText("確定しました");
  await expect(statusText(page)).toHaveText("確定");

  await changeStatus(page, "出荷済にする");
  await page.waitForURL(`/sales-orders/${orderId}?saved=shipped`);
  await expect(statusText(page)).toHaveText("出荷済");

  await expectStock(page, product.id, 7);
  // 入出庫履歴の最新に出庫（-3）が残る
  const latest = page.getByRole("table").getByRole("row").nth(1);
  await expect(latest.getByRole("cell").nth(1)).toHaveText(/^出庫/);
  await expect(latest.getByRole("cell").nth(2)).toHaveText(/^[-−]3$/);
  await expect(latest.getByRole("cell").nth(3)).toHaveText(/の出荷$/);
});

test("発注を作成 → 発注済 → 入荷すると在庫が増える", async ({ page }) => {
  const product = await createProduct(page);
  await expectStock(page, product.id, 0);

  await page.goto("/purchase-orders/new");
  await page.locator("#purchase-order-supplierId").selectOption({ index: 1 });
  // 作成画面は空の明細が 1 行ある状態で始まる
  await page
    .locator("#purchase-order-line-0-product")
    .selectOption(String(product.id));
  // 単価は商品の仕入単価が入る
  await expect(page.locator("#purchase-order-line-0-unitPrice")).toHaveValue(
    "800",
  );
  await page.locator("#purchase-order-line-0-quantity").fill("12");
  await page.getByRole("button", { name: "下書きを保存する" }).click();
  await page.waitForURL(/\/purchase-orders\/\d+\?saved=created$/);
  const orderId = Number(new URL(page.url()).pathname.split("/")[2]);
  await expect(statusText(page)).toHaveText("下書き");

  await changeStatus(page, "発注済にする");
  await page.waitForURL(`/purchase-orders/${orderId}?saved=ordered`);
  await expect(statusText(page)).toHaveText("発注済");

  await changeStatus(page, "入荷済にする");
  await page.waitForURL(`/purchase-orders/${orderId}?saved=received`);
  await expect(statusText(page)).toHaveText("入荷済");

  await expectStock(page, product.id, 12);
});

test("在庫が足りないと出荷できず、不足を表示してステータスは変わらない", async ({
  page,
}) => {
  const product = await createProduct(page);
  await adjustStock(page, product.id, 2);

  const orderId = await createSalesOrder(page, product.id, 5);
  await changeStatus(page, "確定する");
  await page.waitForURL(`/sales-orders/${orderId}?saved=confirmed`);

  await changeStatus(page, "出荷済にする");
  const dialog = page.getByRole("dialog");
  const alert = dialog.getByRole("alert");
  await expect(alert).toContainText(
    "在庫が足りない商品が 1 品目あるため、出荷しませんでした",
  );
  // 不足の一覧（商品・必要数・現在庫・不足数）
  const row = alert.getByRole("row", { name: product.code });
  await expect(row.getByRole("cell")).toHaveText([
    `${product.code} ${product.name}`,
    "5 個",
    "2 個",
    "3 個",
  ]);

  // ダイアログを閉じて読み直しても確定のまま、在庫も変わらない
  await dialog.getByRole("button", { name: "キャンセル" }).click();
  await page.goto(`/sales-orders/${orderId}`);
  await expect(statusText(page)).toHaveText("確定");
  await expectStock(page, product.id, 2);
});
