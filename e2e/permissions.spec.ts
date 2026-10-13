/**
 * ロールごとの権限（画面の出し分けと、直接 URL で開いたときの 403）。読み取りだけのテスト
 */
import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  createPurchaseOrder,
  createSalesOrder,
  STORAGE_STATE,
} from "./helpers";

/** シードの商品（下書きの明細に使うだけで、在庫は変えない） */
const SEED_PRODUCT_ID = 1;

/** 画面を開いて 403（権限なし）になることを確かめる */
async function expectForbidden(page: Page, path: string) {
  const response = await page.goto(path);
  expect(response?.status()).toBe(403);
  await expect(
    page.getByRole("heading", { name: "この画面を表示する権限がありません" }),
  ).toBeVisible();
}

/** 画面と、その画面での登録・編集・ステータス変更などの操作（staff にはあり、viewer にはない） */
interface ControlCheck {
  /** 開く画面。伝票は staff のページで選ぶか作る（そのときは name でテスト名を付ける） */
  path: string | ((page: Page) => Promise<string>);
  name?: string;
  controls: (page: Page) => Locator[];
}

/**
 * 一覧を絞り込んで、最初の伝票の詳細画面のパスを返す。受注日の古い順にして、ほかのテストが作って
 * ステータスを進めている伝票（今日の日付）ではなく、シードの伝票（確定・発注済は過去の日付にもある）を選ぶ
 */
function firstOrderPath(
  list: string,
  base: "sales-orders" | "purchase-orders",
) {
  return async (page: Page) => {
    await page.goto(list);
    const href = await page
      .locator(`table a[href^="/${base}/"]`)
      .first()
      .getAttribute("href", { timeout: 10_000 });
    expect(href).toMatch(new RegExp(`^/${base}/\\d+$`));
    return href!;
  };
}

const CONTROL_CHECKS: ControlCheck[] = [
  {
    path: "/products",
    controls: (page) => [
      page.getByRole("link", { name: "新規登録" }),
      page.getByRole("link", { name: "CSV 取込" }),
    ],
  },
  {
    // 無効化は admin のみ（staff にもない）ので、編集だけを比べる
    path: "/products/1",
    controls: (page) => [page.getByRole("link", { name: "編集する" })],
  },
  {
    path: "/partners",
    controls: (page) => [page.getByRole("link", { name: "新規登録" })],
  },
  {
    path: "/partners/1",
    controls: (page) => [page.getByRole("link", { name: "編集する" })],
  },
  {
    path: "/sales-orders",
    controls: (page) => [page.getByRole("link", { name: "新規作成" })],
  },
  {
    name: "受注の詳細（下書き）",
    // 下書きはシードに安定したものがない（受注は今日の 1 件だけ、発注はない）ので、ここで作る
    path: async (staff) =>
      `/sales-orders/${await createSalesOrder(staff, SEED_PRODUCT_ID, 1)}`,
    controls: (page) => [
      page.getByRole("link", { name: "編集する" }),
      page.getByRole("button", { name: "確定する" }),
      page.getByRole("button", { name: "取り消す" }),
    ],
  },
  {
    name: "受注の詳細（確定）",
    path: firstOrderPath(
      "/sales-orders?status=confirmed&sort=orderDate&order=asc",
      "sales-orders",
    ),
    controls: (page) => [page.getByRole("button", { name: "出荷済にする" })],
  },
  {
    path: "/purchase-orders",
    controls: (page) => [page.getByRole("link", { name: "新規作成" })],
  },
  {
    name: "発注の詳細（下書き）",
    path: async (staff) =>
      `/purchase-orders/${await createPurchaseOrder(staff, SEED_PRODUCT_ID, 1)}`,
    controls: (page) => [
      page.getByRole("link", { name: "編集する" }),
      page.getByRole("button", { name: "発注済にする" }),
    ],
  },
  {
    name: "発注の詳細（発注済）",
    path: firstOrderPath(
      "/purchase-orders?status=ordered&sort=orderDate&order=asc",
      "purchase-orders",
    ),
    controls: (page) => [page.getByRole("button", { name: "入荷済にする" })],
  },
  {
    path: "/stock/1",
    controls: (page) => [
      page.getByRole("heading", { name: "棚卸調整" }),
      page.getByRole("button", { name: "調整を記録する" }),
    ],
  },
];

test.describe("viewer", () => {
  test.use({ storageState: STORAGE_STATE.viewer });

  for (const check of CONTROL_CHECKS) {
    const name = check.name ?? check.path;
    test(`${name}: 見られるが、登録・編集・ステータス変更の操作がない（staff と比べる）`, async ({
      page,
      browser,
    }) => {
      // 対照: 同じ画面を staff で開くと操作がある（ラベルが変わってテストが空振りしていないこと）
      const staffContext = await browser.newContext({
        storageState: STORAGE_STATE.staff,
      });
      let path: string;
      try {
        const staff = await staffContext.newPage();
        path =
          typeof check.path === "string" ? check.path : await check.path(staff);
        await staff.goto(path);
        for (const control of check.controls(staff)) {
          await expect(control.first()).toBeVisible();
        }
      } finally {
        await staffContext.close();
      }

      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      for (const control of check.controls(page)) {
        await expect(control).toHaveCount(0);
      }
    });
  }

  test("CSV 出力はでき、ユーザー管理・操作履歴はメニューに出ない", async ({
    page,
  }) => {
    await page.goto("/products");
    await expect(page.getByRole("link", { name: "CSV 出力" })).toBeVisible();

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
    // ログインは操作履歴に記録されている（e2e/auth.setup.ts のログイン）。ほかのテストの操作で
    // 1 ページ目から押し出されないよう、操作＝ログインで絞り込む
    await page.goto("/audit-logs?action=login");
    const rows = page.getByRole("table").getByRole("row");
    for (const name of ["デモ管理者", "デモ担当者", "デモ閲覧者"]) {
      await expect(
        rows.filter({ hasText: name }).filter({ hasText: "ログインしました" }),
      ).not.toHaveCount(0);
    }
  });
});
