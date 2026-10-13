"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useState, useTransition } from "react";
import { FormProvider, useForm, type FieldPath } from "react-hook-form";

import { OrderLinesEditor } from "@/components/orders/order-lines-editor";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { ORDER_LINE_LIMITS, type LineProductOption } from "@/lib/orders/schema";
import {
  PURCHASE_ORDER_FIELD_LABELS,
  purchaseOrderInputSchema,
  type PurchaseOrderFormValues,
  type PurchaseOrderInput,
} from "@/lib/purchase-orders/schema";
import type { PurchaseOrderMutationError } from "@/lib/purchase-orders/service";
import type { SupplierOption } from "@/lib/purchase-orders/queries";

/**
 * 発注の作成・編集フォーム（React Hook Form＋Zod）。
 * 画面側の検証・金額の表示は補助で、同じスキーマでサーバー側（Server Action）でも検証し、金額はサーバーで計算する
 */
export function PurchaseOrderForm({
  defaultValues,
  orderDate,
  suppliers,
  products,
  submitLabel,
  cancelHref,
  reloadHref,
  action,
}: {
  defaultValues: PurchaseOrderFormValues;
  /** 発注日（作成は今日。表示のみ） */
  orderDate: string;
  suppliers: SupplierOption[];
  products: LineProductOption[];
  submitLabel: string;
  cancelHref: string;
  /** 競合したときに開き直す画面（編集のみ） */
  reloadHref?: string;
  /** 成功時は Server Action 側で画面を移動する。失敗時はエラーが返る */
  action: (
    values: PurchaseOrderFormValues,
  ) => Promise<PurchaseOrderMutationError | void>;
}) {
  const form = useForm<PurchaseOrderFormValues, unknown, PurchaseOrderInput>({
    resolver: zodResolver(purchaseOrderInputSchema),
    defaultValues,
    mode: "onTouched",
  });
  const [formError, setFormError] = useState<{
    message: string;
    conflict: boolean;
  }>();
  const [pending, startTransition] = useTransition();
  const { errors } = form.formState;

  const onSubmit = form.handleSubmit(() => {
    setFormError(undefined);
    // サーバーには検証前の値（文字列）を送り、サーバー側で同じスキーマで検証する
    const values = form.getValues();
    startTransition(async () => {
      const result = await action(values);
      if (!result) return;
      setFormError({
        message: result.error,
        conflict: result.conflict === true,
      });
      for (const [path, messages] of Object.entries(result.fieldErrors ?? {})) {
        if (!messages?.[0]) continue;
        // 明細全体のエラーは lines.root に置く（react-hook-form の配列の項目のエラーの置き場所）
        const name = path === "lines" ? "lines.root" : path;
        form.setError(name as FieldPath<PurchaseOrderFormValues>, {
          message: messages[0],
        });
      }
    });
  });

  const supplierError = errors.supplierId?.message;
  const expectedDateError = errors.expectedDate?.message;
  const noteError = errors.note?.message;

  return (
    <FormProvider {...form}>
      <form onSubmit={onSubmit} noValidate className="max-w-4xl space-y-5">
        {formError && (
          <div
            role="alert"
            className="space-y-1 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            <p>{formError.message}</p>
            {formError.conflict && reloadHref && (
              // 再読み込みすると入力中の内容は消える（最新の内容から編集し直す）
              <a href={reloadHref} className="underline underline-offset-4">
                最新の内容で編集し直す
              </a>
            )}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="purchase-order-supplierId">
              {PURCHASE_ORDER_FIELD_LABELS.supplierId}
              <span className="text-xs font-normal text-destructive">必須</span>
            </Label>
            <NativeSelect
              id="purchase-order-supplierId"
              className="w-full sm:w-96"
              aria-invalid={supplierError ? true : undefined}
              aria-describedby="purchase-order-supplierId-message"
              {...form.register("supplierId")}
            >
              <NativeSelectOption value="">選択してください</NativeSelectOption>
              {suppliers.map((s) => (
                <NativeSelectOption key={s.id} value={String(s.id)}>
                  {s.code} {s.name}
                  {s.isActive ? "" : "（無効）"}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <p
              id="purchase-order-supplierId-message"
              className={
                supplierError
                  ? "text-xs text-destructive"
                  : "text-xs text-muted-foreground"
              }
            >
              {supplierError ??
                "種別が「仕入先」か「顧客・仕入先」の有効な取引先"}
            </p>
          </div>
          <div className="grid content-start gap-1.5">
            <span className="text-sm font-medium">
              {PURCHASE_ORDER_FIELD_LABELS.orderDate}
            </span>
            <p className="flex h-8 items-center text-sm tabular-nums">
              {orderDate.replaceAll("-", "/")}
            </p>
            <p className="text-xs text-muted-foreground">
              作成した日（伝票番号の日付と同じ）
            </p>
          </div>
          <div className="grid content-start gap-1.5">
            <Label htmlFor="purchase-order-expectedDate">
              {PURCHASE_ORDER_FIELD_LABELS.expectedDate}
            </Label>
            <Input
              id="purchase-order-expectedDate"
              type="date"
              className="w-44"
              aria-invalid={expectedDateError ? true : undefined}
              aria-describedby="purchase-order-expectedDate-message"
              {...form.register("expectedDate")}
            />
            <p
              id="purchase-order-expectedDate-message"
              className={
                expectedDateError
                  ? "text-xs text-destructive"
                  : "text-xs text-muted-foreground"
              }
            >
              {expectedDateError ?? "任意。発注日以降"}
            </p>
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label htmlFor="purchase-order-note">
              {PURCHASE_ORDER_FIELD_LABELS.note}
            </Label>
            <textarea
              id="purchase-order-note"
              rows={2}
              maxLength={ORDER_LINE_LIMITS.note}
              className="w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive md:text-sm dark:bg-input/30"
              aria-invalid={noteError ? true : undefined}
              aria-describedby="purchase-order-note-message"
              {...form.register("note")}
            />
            <p
              id="purchase-order-note-message"
              className={
                noteError
                  ? "text-xs text-destructive"
                  : "text-xs text-muted-foreground"
              }
            >
              {noteError ?? `任意。${ORDER_LINE_LIMITS.note}文字以内`}
            </p>
          </div>
        </div>

        <OrderLinesEditor
          products={products}
          priceLabel="仕入単価"
          confirmLabel="発注済"
          idPrefix="purchase-order"
        />

        <div className="flex gap-2">
          <Button type="submit" disabled={pending}>
            {pending ? "保存中…" : submitLabel}
          </Button>
          <Link
            href={cancelHref}
            className={buttonVariants({ variant: "outline" })}
          >
            キャンセル
          </Link>
        </div>
      </form>
    </FormProvider>
  );
}
