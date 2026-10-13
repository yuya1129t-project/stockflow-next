/**
 * ダッシュボード・CSV 出力・スマホ幅の表示・取引先の郵便番号検索（画面からの API 呼び出しをモック）
 */
import { readFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

import { STORAGE_STATE } from "./helpers";

test.describe("staff", () => {
  test.use({ storageState: STORAGE_STATE.staff });

  test("ダッシュボードが表示される", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { level: 1, name: "ダッシュボード" }),
    ).toBeVisible();
    const main = page.getByRole("main");
    for (const title of [
      /今月の受注額/,
      /未出荷の受注/,
      /発注点を下回る商品/,
      /入荷待ち/,
    ]) {
      await expect(main.getByText(title).first()).toBeVisible();
    }
    // シードには発注点を下回る商品があるので、在庫画面へのリンクが出る
    await expect(
      main.getByRole("link", { name: "在庫を見る" }).first(),
    ).toBeVisible();
  });

  test("商品の CSV を出力できる（UTF-8 の BOM 付き・見出し行あり）", async ({
    page,
  }) => {
    await page.goto("/products");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: "CSV 出力" }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^products_\d{8}\.csv$/);

    const bytes = await readFile(await download.path());
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = bytes.subarray(3).toString("utf8").split("\r\n");
    expect(lines[0]).toBe(
      "商品コード,商品名,カテゴリ,単位,売価,仕入単価,発注点,現在庫,状態",
    );
    // シードの商品が 1 行以上ある（最後は改行で終わる）
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.at(-1)).toBe("");
  });

  test("取引先の郵便番号から住所を入力できる（API はモック）", async ({
    page,
  }) => {
    // 外部 API（zipcloud）には依存しない: 画面から呼ぶ自前の API の応答をモックする
    const requested: string[] = [];
    await page.route("**/api/partners/address-lookup?**", async (route) => {
      requested.push(
        new URL(route.request().url()).searchParams.get("postalCode") ?? "",
      );
      await route.fulfill({
        json: { postalCode: "0000001", addresses: ["デモ県サンプル市中央"] },
      });
    });

    await page.goto("/partners/new");
    await page.locator("#partner-postalCode").fill("000-0001");
    await page.getByRole("button", { name: "住所を検索" }).click();

    await expect(page.locator("#partner-address")).toHaveValue(
      "デモ県サンプル市中央",
    );
    await expect(page.locator("#partner-lookup-message")).toContainText(
      "住所を入力しました",
    );
    expect(requested).toEqual(["0000001"]);
  });
});

/** 横スクロールが出ていない（文書の幅が画面の幅に収まっている） */
async function expectNoHorizontalScroll(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

test.describe("スマホ幅（375px）", () => {
  test.use({
    storageState: STORAGE_STATE.staff,
    viewport: { width: 375, height: 812 },
  });

  for (const [path, heading] of [
    ["/", "ダッシュボード"],
    ["/products", "商品"],
    ["/sales-orders", "受注"],
  ] as const) {
    test(`${heading}（${path}）に横スクロールが出ない`, async ({ page }) => {
      await page.goto(path);
      await expect(
        page.getByRole("heading", { level: 1, name: heading }),
      ).toBeVisible();
      await expectNoHorizontalScroll(page);
    });
  }
});
