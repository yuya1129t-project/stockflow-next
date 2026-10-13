/**
 * ログイン画面（未ログインの状態）。正しいパスワードでのログインは e2e/auth.setup.ts、
 * ログアウトは e2e/logout.spec.ts（ほかのテストのあとに実行）で確かめる
 */
import { expect, test } from "@playwright/test";

import { demoAccount, submitLogin } from "./helpers";

// ログインを試すテストは再試行しない（試行回数制限の 60 秒に 5 回を、再試行で使い切らないため）
test.describe.configure({ retries: 0 });

test("間違ったパスワードではログインできず、エラーを表示する", async ({
  page,
}) => {
  await submitLogin(page, demoAccount("staff").email, "wrong-password-0000");

  await expect(page.locator("form").getByRole("alert")).toHaveText(
    "メールアドレスまたはパスワードが正しくありません",
  );
  await expect(page).toHaveURL(/\/login$/);
  // ログインしていないので、画面を開くとログイン画面に戻される
  await page.goto("/products");
  await expect(page).toHaveURL(/\/login\?callbackUrl=%2Fproducts$/);
});

test("未ログインで画面を開くとログイン画面へ移動する", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "StockFlow" })).toBeVisible();
});
