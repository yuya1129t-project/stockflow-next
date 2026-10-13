/**
 * README のスクリーンショット（docs/images/*.png）を撮る。
 *
 *   pnpm screenshots                        # http://localhost:3000 の起動中のアプリを撮る
 *   SCREENSHOT_BASE_URL=http://127.0.0.1:3114 pnpm screenshots
 *
 * 前提: アプリが起動していて、シードを投入した DB（pnpm db:reset など）に向いていること。
 * admin でログインし（ログインの試行は 1 回だけ）、デスクトップ幅（1280×800）で撮る。データはすべて架空
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

import { chromium, type Page } from "@playwright/test";

import { DEMO_PASSWORD, DEMO_USERS } from "../prisma/seed-data";

const BASE_URL = process.env.SCREENSHOT_BASE_URL ?? "http://localhost:3000";
const OUT_DIR = path.join(import.meta.dirname, "..", "docs", "images");
const VIEWPORT = { width: 1280, height: 800 };

const admin = DEMO_USERS.find((u) => u.role === "admin")!;

async function shoot(page: Page, name: string) {
  await page.waitForLoadState("networkidle");
  const file = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`保存しました: docs/images/${name}.png`);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      baseURL: BASE_URL,
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      locale: "ja-JP",
      timezoneId: "Asia/Tokyo",
    });
    const page = await context.newPage();

    await page.goto("/login");
    await page.getByLabel("メールアドレス").fill(admin.email);
    await page.getByLabel("パスワード").fill(DEMO_PASSWORD);
    await page.getByRole("button", { name: "ログイン", exact: true }).click();
    await page.waitForURL(`${BASE_URL}/`);

    await shoot(page, "dashboard");

    // 受注詳細: 出荷済みの受注の一覧から先頭の 1 件を開く
    await page.goto("/sales-orders?status=shipped");
    await page
      .getByRole("link", { name: /^SO-\d{8}-\d{3}$/ })
      .first()
      .click();
    await page.waitForURL(/\/sales-orders\/\d+$/);
    await shoot(page, "sales-order-detail");

    await page.goto("/stock");
    await shoot(page, "stock");

    await page.goto("/products");
    await shoot(page, "products");

    await page.goto("/api-docs");
    // Swagger UI が API の一覧を描画するまで待ち、説明文の下のエンドポイントの一覧を写す
    await page.locator(".opblock").first().waitFor();
    await page
      .locator(".opblock-tag")
      .first()
      .evaluate((el) => el.scrollIntoView({ block: "start" }));
    await shoot(page, "api-docs");
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
