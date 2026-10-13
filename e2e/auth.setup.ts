/**
 * ロールごとに 1 回だけログインして storageState を保存する（各テストはこれを使い回す）。
 * ログインの試行回数制限（同じ IP から 60 秒に 5 回）に当たらないよう、ログインはここと
 * e2e/auth.spec.ts（パスワード誤り 1 回）だけで行う。ここがロールごとのログインのテストも兼ねる
 */
import { expect, test as setup } from "@playwright/test";

import { demoAccount, STORAGE_STATE, submitLogin, type Role } from "./helpers";

const ROLE_BADGES: Record<Role, string> = {
  admin: "管理者",
  staff: "担当者",
  viewer: "閲覧者",
};

for (const role of ["admin", "staff", "viewer"] as const) {
  setup(`${role} でログインできる`, async ({ page }) => {
    const account = demoAccount(role);
    await submitLogin(page, account.email, account.password);

    // ログイン後はダッシュボード。ヘッダーに名前とロールが出る
    await page.waitForURL("/");
    await expect(
      page.getByRole("heading", { level: 1, name: "ダッシュボード" }),
    ).toBeVisible();
    const header = page.getByRole("banner");
    await expect(header).toContainText(account.name);
    await expect(header.getByTitle(`ロール: ${role}`)).toContainText(
      ROLE_BADGES[role],
    );

    await page.context().storageState({ path: STORAGE_STATE[role] });
  });
}
