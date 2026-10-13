/**
 * ログアウト。ログアウトするとセッションが消えるので、ほかのテストがすべて終わってから実行する
 * （playwright.config.ts の logout プロジェクト）。ログインを増やさないよう viewer のセッションを使う
 */
import { expect, test } from "@playwright/test";

import { STORAGE_STATE } from "./helpers";

test.use({ storageState: STORAGE_STATE.viewer });

test("ログアウトするとログイン画面に戻り、同じ Cookie では画面を開けない", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "ダッシュボード" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "ログアウト" }).click();
  await page.waitForURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "StockFlow" })).toBeVisible();

  // サーバー側でもセッションが消えている（ログアウト前の Cookie を付け直しても入れない）
  const context = await page
    .context()
    .browser()!
    .newContext({ storageState: STORAGE_STATE.viewer });
  try {
    const stale = await context.newPage();
    await stale.goto("/products");
    await expect(stale).toHaveURL(/\/login\?callbackUrl=%2Fproducts$/);
  } finally {
    await context.close();
  }
});
