/**
 * E2E の共通部品（ロールごとの storageState・テスト用データの作成・画面の読み取り）。
 *
 * テストは並列に実行するので、在庫を変えるテストは自分で商品を作り、その商品だけを操作する
 * （シードの商品の在庫には依存しない）
 */
import { expect, type Page } from "@playwright/test";

import { DEMO_PASSWORD, DEMO_USERS } from "../prisma/seed-data";

export type Role = "admin" | "staff" | "viewer";

/** ロールごとのログイン状態（e2e/auth.setup.ts が作る。コミットしない） */
export const STORAGE_STATE: Record<Role, string> = {
  admin: "e2e/.auth/admin.json",
  staff: "e2e/.auth/staff.json",
  viewer: "e2e/.auth/viewer.json",
};

export function demoAccount(role: Role) {
  const user = DEMO_USERS.find((u) => u.role === role);
  if (!user) throw new Error(`デモ用アカウントがありません: ${role}`);
  return { email: user.email, name: user.name, password: DEMO_PASSWORD };
}

/** ログイン画面でメールアドレスとパスワードを入力して送信する */
export async function submitLogin(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("メールアドレス").fill(email);
  await page.getByLabel("パスワード").fill(password);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
}

let sequence = 0;

/** 並列のテスト・繰り返しの実行で重ならない商品コード（半角英数字・ハイフン。20 文字以内） */
function uniqueCode(): string {
  sequence += 1;
  const time = Date.now().toString(36).toUpperCase();
  const random = Math.floor(Math.random() * 36 ** 3)
    .toString(36)
    .toUpperCase()
    .padStart(3, "0");
  return `E2E-${time}-${random}${sequence}`.slice(0, 20);
}

export interface CreatedProduct {
  id: number;
  code: string;
  name: string;
}

/** 商品を登録画面から作る（admin／staff のページで呼ぶ）。在庫は 0 から始まる */
export async function createProduct(
  page: Page,
  options: { reorderPoint?: number } = {},
): Promise<CreatedProduct> {
  const code = uniqueCode();
  const name = `E2E テスト商品 ${code}`;
  await page.goto("/products/new");
  await page.locator("#product-code").fill(code);
  await page.locator("#product-name").fill(name);
  await page.locator("#product-category").fill("E2E");
  await page.locator("#product-unit").fill("個");
  await page.locator("#product-salesPrice").fill("1200");
  await page.locator("#product-purchasePrice").fill("800");
  await page
    .locator("#product-reorderPoint")
    .fill(String(options.reorderPoint ?? 0));
  await page.getByRole("button", { name: "登録する" }).click();
  await page.waitForURL(/\/products\/\d+\?saved=created$/);
  const id = Number(new URL(page.url()).pathname.split("/")[2]);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
  return { id, code, name };
}

/** 在庫画面（商品ごと）の「現在庫」の表示（例 "10 個"） */
export function currentStockText(page: Page) {
  return page
    .locator("dt", { hasText: /^現在庫$/ })
    .locator("xpath=following-sibling::dd[1]");
}

/** 在庫画面を開いて現在庫を確認する */
export async function expectStock(
  page: Page,
  productId: number,
  quantity: number,
) {
  await page.goto(`/stock/${productId}`);
  await expect(currentStockText(page)).toHaveText(
    new RegExp(`^${quantity.toLocaleString("ja-JP")} 個`),
  );
}

/** 棚卸調整で現在庫を指定の数にする（admin／staff） */
export async function adjustStock(
  page: Page,
  productId: number,
  quantity: number,
) {
  await page.goto(`/stock/${productId}`);
  await page.locator("#stock-adjust-actualQuantity").fill(String(quantity));
  await page.locator("#stock-adjust-reason").fill("E2E の準備");
  await page.getByRole("button", { name: "調整を記録する" }).click();
  await expect(page.getByRole("status")).toBeVisible();
  await expectStock(page, productId, quantity);
}

/** 受注を 1 明細で作成する（下書き）。作成後の詳細画面の URL から ID を返す */
export async function createSalesOrder(
  page: Page,
  productId: number,
  quantity: number,
): Promise<number> {
  await page.goto("/sales-orders/new");
  await page.locator("#sales-order-customerId").selectOption({ index: 1 });
  // 作成画面は空の明細が 1 行ある状態で始まる
  await page
    .locator("#sales-order-line-0-product")
    .selectOption(String(productId));
  await page.locator("#sales-order-line-0-quantity").fill(String(quantity));
  await page.getByRole("button", { name: "下書きを保存する" }).click();
  await page.waitForURL(/\/sales-orders\/\d+\?saved=created$/);
  await expect(page.getByRole("status")).toHaveText(
    "受注を作成しました（下書き）",
  );
  return Number(new URL(page.url()).pathname.split("/")[2]);
}

/** 発注を 1 明細で作成する（下書き）。作成後の詳細画面の URL から ID を返す */
export async function createPurchaseOrder(
  page: Page,
  productId: number,
  quantity: number,
): Promise<number> {
  await page.goto("/purchase-orders/new");
  await page.locator("#purchase-order-supplierId").selectOption({ index: 1 });
  // 作成画面は空の明細が 1 行ある状態で始まる
  await page
    .locator("#purchase-order-line-0-product")
    .selectOption(String(productId));
  await page.locator("#purchase-order-line-0-quantity").fill(String(quantity));
  await page.getByRole("button", { name: "下書きを保存する" }).click();
  await page.waitForURL(/\/purchase-orders\/\d+\?saved=created$/);
  return Number(new URL(page.url()).pathname.split("/")[2]);
}

/** 詳細画面のステータス変更ボタンを押し、確認ダイアログで実行する */
export async function changeStatus(page: Page, action: string) {
  await page.getByRole("button", { name: action }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: action }).click();
}

/** 詳細画面の「ステータス」の表示 */
export function statusText(page: Page) {
  return page
    .locator("dt", { hasText: /^ステータス$/ })
    .locator("xpath=following-sibling::dd[1]");
}

/** CSV（RFC 4180。引用符・引用の中のカンマと改行に対応）を行と列に分ける。最後の改行のあとの空行は含めない */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        cell += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
    } else {
      cell += c;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
