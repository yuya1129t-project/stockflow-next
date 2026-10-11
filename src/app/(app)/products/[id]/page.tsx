import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth/guards";
import { can } from "@/lib/auth/permissions";
import { getPrisma } from "@/lib/db";
import { formatNumber } from "@/lib/format";
import { getProduct } from "@/lib/products/queries";
import { PRODUCT_FIELD_LABELS } from "@/lib/products/schema";

import { ProductActiveToggle } from "./active-toggle";
import { parseProductId } from "./product-id";

export const metadata: Metadata = { title: "商品の詳細 | StockFlow" };

const SAVED_MESSAGES: Record<string, string> = {
  created: "商品を登録しました",
  updated: "商品を保存しました",
};

/** 商品の詳細（全ロール閲覧可）。編集は admin／staff、無効化・再有効化は admin のみ */
export default async function ProductDetailPage({
  params,
  searchParams,
}: PageProps<"/products/[id]">) {
  const user = await requirePermission("view");
  const id = parseProductId((await params).id);
  if (id === null) notFound();
  const product = await getProduct(getPrisma(), id);
  if (!product) notFound();
  const saved = (await searchParams).saved;
  const savedMessage =
    typeof saved === "string" ? SAVED_MESSAGES[saved] : undefined;
  const low = product.isActive && product.stock < product.reorderPoint;

  const rows: [string, ReactNode][] = [
    [
      PRODUCT_FIELD_LABELS.code,
      <span key="code" className="font-mono">
        {product.code}
      </span>,
    ],
    [PRODUCT_FIELD_LABELS.name, product.name],
    [PRODUCT_FIELD_LABELS.category, product.category],
    [PRODUCT_FIELD_LABELS.unit, product.unit],
    [PRODUCT_FIELD_LABELS.salesPrice, `${formatNumber(product.salesPrice)} 円`],
    [
      PRODUCT_FIELD_LABELS.purchasePrice,
      `${formatNumber(product.purchasePrice)} 円`,
    ],
    [
      PRODUCT_FIELD_LABELS.reorderPoint,
      `${formatNumber(product.reorderPoint)} ${product.unit}`,
    ],
    [
      "現在庫",
      <span
        key="stock"
        className={
          low
            ? "inline-flex items-center gap-1.5 font-semibold text-destructive"
            : undefined
        }
      >
        {formatNumber(product.stock)} {product.unit}
        {low && <Badge variant="destructive">発注点割れ</Badge>}
      </span>,
    ],
    [
      "状態",
      product.isActive ? (
        "有効"
      ) : (
        <Badge key="status" variant="outline">
          無効
        </Badge>
      ),
    ],
  ];

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Link
          href="/products"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          ← 商品一覧
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">{product.name}</h1>
      </div>

      {savedMessage && (
        <p
          role="status"
          className="rounded-lg border border-emerald-600/30 bg-emerald-600/5 px-3 py-2 text-sm"
        >
          {savedMessage}
        </p>
      )}

      <dl className="grid max-w-xl grid-cols-[8rem_1fr] gap-x-4 gap-y-2 rounded-xl border p-4 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="flex flex-wrap gap-2">
        {can(user.role, "master:edit") && (
          <Link
            href={`/products/${product.id}/edit`}
            className={buttonVariants()}
          >
            編集する
          </Link>
        )}
        {can(user.role, "master:deactivate") && (
          <ProductActiveToggle
            id={product.id}
            code={product.code}
            name={product.name}
            isActive={product.isActive}
          />
        )}
      </div>
    </div>
  );
}
