import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requirePermission } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { getProduct, listProductCategories } from "@/lib/products/queries";
import { toProductFormValues } from "@/lib/products/schema";

import { updateProductAction } from "../../actions";
import { ProductForm } from "../../product-form";
import { parseProductId } from "../product-id";

export const metadata: Metadata = { title: "商品の編集 | StockFlow" };

/** 商品の編集（admin／staff）。spec §2 */
export default async function EditProductPage({
  params,
}: PageProps<"/products/[id]/edit">) {
  await requirePermission("master:edit");
  const id = parseProductId((await params).id);
  if (id === null) notFound();
  const db = getPrisma();
  const [product, categories] = await Promise.all([
    getProduct(db, id),
    listProductCategories(db),
  ]);
  if (!product) notFound();

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Link
          href={`/products/${id}`}
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          ← 商品の詳細
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">
          商品の編集
          <span className="ml-2 font-mono text-base font-normal text-muted-foreground">
            {product.code}
          </span>
        </h1>
      </div>
      <ProductForm
        defaultValues={toProductFormValues(product)}
        categories={categories}
        submitLabel="保存する"
        cancelHref={`/products/${id}`}
        action={updateProductAction.bind(null, id)}
      />
    </div>
  );
}
