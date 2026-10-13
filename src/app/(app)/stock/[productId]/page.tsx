import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/guards";
import { can } from "@/lib/auth/permissions";
import { purchaseOrderPath, salesOrderPath } from "@/lib/dashboard/paths";
import { getPrisma } from "@/lib/db";
import { formatDateTime, formatNumber, formatSignedNumber } from "@/lib/format";
import { getProduct } from "@/lib/products/queries";
import {
  listStockMovements,
  type StockMovementListItem,
} from "@/lib/stock/queries";
import {
  isBelowReorderPoint,
  STOCK_MOVEMENT_TYPE_LABELS,
} from "@/lib/stock/rules";
import { cn } from "@/lib/utils";

import { parseProductId } from "../../products/[id]/product-id";
import { PageLink } from "../page-link";
import { StockAdjustForm } from "./adjust-form";

export const metadata: Metadata = { title: "入出庫履歴 | StockFlow" };

const REF_LABELS = { sales_order: "受注", purchase_order: "発注" } as const;

/** 参照元の伝票（受注・発注の詳細へのリンク。伝票が見つからなければテキスト） */
function RefCell({ target }: { target: StockMovementListItem["ref"] }) {
  if (!target) return "—";
  const text = `${REF_LABELS[target.type]} ${target.number ?? `#${target.id}`}`;
  if (target.number !== null) {
    return (
      <Link
        href={
          target.type === "sales_order"
            ? salesOrderPath(target.id)
            : purchaseOrderPath(target.id)
        }
        className="underline-offset-4 hover:underline"
      >
        {text}
      </Link>
    );
  }
  return text;
}

function pageHref(productId: number, page: number): string {
  return page > 1 ? `/stock/${productId}?page=${page}` : `/stock/${productId}`;
}

/** 商品ごとの在庫（現在庫・棚卸調整・入出庫履歴）。閲覧は全ロール、棚卸調整は admin／staff（spec §2） */
export default async function StockDetailPage({
  params,
  searchParams,
}: PageProps<"/stock/[productId]">) {
  const user = await requirePermission("view");
  const id = parseProductId((await params).productId);
  if (id === null) notFound();
  const db = getPrisma();
  const product = await getProduct(db, id);
  if (!product) notFound();
  const rawPage = Number((await searchParams).page);
  const history = await listStockMovements(
    db,
    id,
    Number.isSafeInteger(rawPage) && rawPage >= 1 ? rawPage : 1,
  );
  const low = isBelowReorderPoint(product, product.stock);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Link
          href="/stock"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          ← 在庫一覧
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">
          {product.name}
          <span className="ml-2 font-mono text-base font-normal text-muted-foreground">
            {product.code}
          </span>
        </h1>
      </div>

      <dl className="grid max-w-xl grid-cols-[8rem_1fr] gap-x-4 gap-y-2 rounded-xl border p-4 text-sm">
        <dt className="text-muted-foreground">現在庫</dt>
        <dd
          className={cn(
            "inline-flex items-center gap-1.5",
            low && "font-semibold text-destructive",
          )}
        >
          {formatNumber(product.stock)} {product.unit}
          {low && <Badge variant="destructive">発注点割れ</Badge>}
        </dd>
        <dt className="text-muted-foreground">発注点</dt>
        <dd>
          {formatNumber(product.reorderPoint)} {product.unit}
        </dd>
        <dt className="text-muted-foreground">状態</dt>
        <dd>
          {product.isActive ? "有効" : <Badge variant="outline">無効</Badge>}
        </dd>
        <dt className="text-muted-foreground">商品</dt>
        <dd>
          <Link
            href={`/products/${product.id}`}
            className="underline-offset-4 hover:underline"
          >
            商品の詳細を見る
          </Link>
        </dd>
      </dl>

      {can(user.role, "stock:adjust") && (
        <section className="space-y-2">
          <h2 className="text-base font-semibold">棚卸調整</h2>
          <StockAdjustForm
            productId={product.id}
            currentStock={product.stock}
            unit={product.unit}
          />
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-base font-semibold">入出庫履歴</h2>
        <p className="text-sm text-muted-foreground">
          {history.total === 0
            ? "入出庫の履歴はありません"
            : `全 ${formatNumber(history.total)} 件（新しい順）`}
        </p>
        {history.total > 0 && (
          <div className="rounded-xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>日時</TableHead>
                  <TableHead>種別</TableHead>
                  <TableHead className="text-right">数量</TableHead>
                  <TableHead className="hidden sm:table-cell">理由</TableHead>
                  <TableHead className="hidden md:table-cell">参照</TableHead>
                  <TableHead className="hidden md:table-cell">担当者</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.items.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="tabular-nums">
                      {formatDateTime(m.createdAt)}
                    </TableCell>
                    <TableCell>
                      {STOCK_MOVEMENT_TYPE_LABELS[m.type]}
                      {/* スマホ幅では理由の列を出さないので、種別の下に表示する */}
                      {m.reason && (
                        <span className="block max-w-40 text-xs whitespace-normal text-muted-foreground sm:hidden">
                          {m.reason}
                        </span>
                      )}
                    </TableCell>
                    <TableCell
                      className={cn(
                        "text-right tabular-nums",
                        m.quantity < 0 && "text-destructive",
                      )}
                    >
                      {formatSignedNumber(m.quantity)}
                    </TableCell>
                    <TableCell className="hidden max-w-64 whitespace-normal sm:table-cell">
                      {m.reason ?? "—"}
                    </TableCell>
                    <TableCell className="hidden font-mono md:table-cell">
                      <RefCell target={m.ref} />
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {m.userName ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {history.totalPages > 1 && (
          <nav
            aria-label="ページ送り"
            className="flex items-center justify-center gap-2 text-sm"
          >
            <PageLink
              disabled={history.page <= 1}
              href={pageHref(id, history.page - 1)}
            >
              前へ
            </PageLink>
            <span className="tabular-nums">
              {history.page} / {history.totalPages} ページ
            </span>
            <PageLink
              disabled={history.page >= history.totalPages}
              href={pageHref(id, history.page + 1)}
            >
              次へ
            </PageLink>
          </nav>
        )}
      </section>
    </div>
  );
}
