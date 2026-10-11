import type { Metadata } from "next";
import Link from "next/link";

import { requirePermission } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db";
import { listProductCategories } from "@/lib/products/queries";
import { EMPTY_PRODUCT_FORM } from "@/lib/products/schema";

import { createProductAction } from "../actions";
import { ProductForm } from "../product-form";

export const metadata: Metadata = { title: "商品の登録 | StockFlow" };

/** 商品の登録（admin／staff）。spec §2 */
export default async function NewProductPage() {
  await requirePermission("master:edit");
  const categories = await listProductCategories(getPrisma());
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Link
          href="/products"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          ← 商品一覧
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">商品の登録</h1>
      </div>
      <ProductForm
        defaultValues={EMPTY_PRODUCT_FORM}
        categories={categories}
        submitLabel="登録する"
        cancelHref="/products"
        action={createProductAction}
      />
    </div>
  );
}
