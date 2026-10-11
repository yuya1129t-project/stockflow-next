import type { Metadata } from "next";
import Link from "next/link";

import { requirePermission } from "@/lib/auth/guards";
import {
  PRODUCT_CSV_HEADERS,
  PRODUCT_IMPORT_MAX_BYTES,
  PRODUCT_IMPORT_MAX_ROWS,
} from "@/lib/products/csv";
import { PRODUCT_FIELD_LABELS, PRODUCT_FIELDS } from "@/lib/products/schema";

import { ImportForm } from "./import-form";

export const metadata: Metadata = { title: "商品の CSV 取込 | StockFlow" };

/** 商品の CSV 取込（admin／staff）。spec §7 */
export default async function ProductImportPage() {
  await requirePermission("csv:import");
  const required: string[] = PRODUCT_FIELDS.map((f) => PRODUCT_FIELD_LABELS[f]);
  const ignored = PRODUCT_CSV_HEADERS.filter((h) => !required.includes(h));

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Link
          href="/products"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          ← 商品一覧
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">
          商品の CSV 取込
        </h1>
      </div>

      <div className="max-w-2xl space-y-2 rounded-xl border p-4 text-sm">
        <p className="font-medium">取込のルール</p>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li>
            文字コードは UTF-8（BOM の有無は問いません）。1 行目は見出し行で、
            {required.map((h) => `「${h}」`).join("")}
            の列が必要です（列の順番は問いません）
          </li>
          <li>
            商品コードが登録済みなら上書き更新、未登録なら新規登録します。
            {ignored.map((h) => `「${h}」`).join("")}
            などそれ以外の列は読み飛ばします（有効／無効は CSV
            では変更しません）
          </li>
          <li>
            <strong className="font-medium text-foreground">
              1 行でもエラーがあれば、1 件も取り込みません
            </strong>
            。エラーは行番号付きで表示します
          </li>
          <li>
            データ行は {PRODUCT_IMPORT_MAX_ROWS.toLocaleString("ja-JP")}{" "}
            行まで、ファイルは {PRODUCT_IMPORT_MAX_BYTES / 1024}KB までです
          </li>
          <li>
            商品一覧の「CSV
            出力」で出力したファイルを編集して、そのまま取り込めます
          </li>
        </ul>
      </div>

      <ImportForm />
    </div>
  );
}
