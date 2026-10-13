/**
 * ロールごとの権限（画面の出し分けと、直接 URL で開いたときの 403）。読み取りだけのテスト
 */
import { expect, test, type Page } from "@playwright/test";

import { STORAGE_STATE } from "./helpers";

/** 画面を開いて 403（権限なし）になることを確かめる */
async function expectForbidden(page: Page, path: string) {
  const response = await page.goto(path);
  expect(response?.status()).toBe(403);
  await expect(
    page.getByRole("heading", { name: "この画面を表示する権限がありません" }),
  ).toBeVisible();
}

test.describe("viewer", () => {
  test.use({ storageState: STORAGE_STATE.viewer });

  test("一覧・詳細は見られるが、登録・編集のボタンがない", async ({ page }) => {
    await page.goto("/products");
    await expect(
      page.getByRole("heading", { level: 1, name: "商品" }),
    ).toBeVisible();
    await expect(page.getByRole("table")).toBeVisible();
    await expect(page.getByRole("link", { name: "CSV 出力" })).toBeVisible();
    await expect(page.getByRole("link", { name: "新規登録" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "CSV 取込" })).toHaveCount(0);

    // 商品の詳細（シードの 1 件目）にも編集・無効化の操作がない
    await page.goto("/products/1");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: "編集する" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "無効にする" })).toHaveCount(
      0,
    );

    for (const path of ["/partners", "/sales-orders", "/purchase-orders"]) {
      await page.goto(path);
      await expect(page.getByRole("table")).toBeVisible();
      await expect(page.getByRole("link", { name: /新規|作成/ })).toHaveCount(
        0,
      );
    }

    // 在庫の詳細に棚卸調整のフォームがない
    await page.goto("/stock/1");
    await expect(
      page.getByRole("heading", { name: "入出庫履歴" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "棚卸調整" })).toHaveCount(
      0,
    );

    // ユーザー管理・操作履歴はメニューに出ない
    const nav = page.getByRole("navigation").first();
    await expect(nav.getByRole("link", { name: "商品" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "ユーザー管理" })).toHaveCount(
      0,
    );
    await expect(nav.getByRole("link", { name: "操作履歴" })).toHaveCount(0);
  });

  test("登録・編集の画面を直接 URL で開くと 403", async ({ page }) => {
    for (const path of [
      "/products/new",
      "/products/1/edit",
      "/products/import",
      "/partners/new",
      "/partners/1/edit",
      "/sales-orders/new",
      "/purchase-orders/new",
    ]) {
      await expectForbidden(page, path);
    }
  });

  test("ユーザー管理・操作履歴は 403", async ({ page }) => {
    await expectForbidden(page, "/users");
    await expectForbidden(page, "/audit-logs");
  });
});

test.describe("staff", () => {
  test.use({ storageState: STORAGE_STATE.staff });

  test("ユーザー管理・操作履歴は 403", async ({ page }) => {
    await expectForbidden(page, "/users");
    await expectForbidden(page, "/users/new");
    await expectForbidden(page, "/audit-logs");
  });
});

test.describe("admin", () => {
  test.use({ storageState: STORAGE_STATE.admin });

  test("ユーザー管理・操作履歴を開ける", async ({ page }) => {
    const nav = page.getByRole("navigation").first();
    await page.goto("/");
    await nav.getByRole("link", { name: "ユーザー管理" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "ユーザー管理" }),
    ).toBeVisible();
    await expect(page.getByRole("main")).toContainText("staff@example.com");

    await nav.getByRole("link", { name: "操作履歴" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "操作履歴" }),
    ).toBeVisible();
    // ログインは操作履歴に記録されている（e2e/auth.setup.ts のログイン）
    await expect(page.getByRole("table")).toContainText("ログインしました");
  });
});
