"use client";

/**
 * 受注・発注の明細編集（行の追加・削除、商品の選択、数量・単価、小計・税・合計の自動表示）。
 *
 * React Hook Form の FormProvider の中で使い、フォームの値の `lines`（OrderLineFormValues[]）を編集する。
 * 金額の表示は画面の補助で、保存する金額はサーバーで明細から計算し直す（src/lib/orders/amounts.ts の同じ関数）
 */
import type { ComponentProps } from "react";
import { useFieldArray, useFormContext, useWatch } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { formatNumber } from "@/lib/format";
import { calcOrderAmounts, lineAmount } from "@/lib/orders/amounts";
import {
  EMPTY_ORDER_LINE,
  ORDER_LINE_LIMITS,
  orderLineSchema,
  type LineProductOption,
  type OrderLineFormValues,
} from "@/lib/orders/schema";

type LinesForm = { lines: OrderLineFormValues[] };

export function OrderLinesEditor({
  products,
  priceLabel,
  idPrefix,
}: {
  products: LineProductOption[];
  /** 単価の初期値の名前（発注は「仕入単価」、受注は「売価」） */
  priceLabel: string;
  /** 入力欄の id の接頭辞（例 "purchase-order"） */
  idPrefix: string;
}) {
  const {
    control,
    register,
    setValue,
    formState: { errors },
  } = useFormContext<LinesForm>();
  const { fields, append, remove } = useFieldArray({ control, name: "lines" });
  const lines = useWatch({ control, name: "lines" }) ?? [];
  const byId = new Map(products.map((p) => [String(p.id), p]));

  // 入力が正しい行だけで計算する（入力途中の行は含めない）
  const parsed = lines.map((line) => orderLineSchema.safeParse(line));
  const validLines = parsed.flatMap((r) => (r.success ? [r.data] : []));
  const incomplete = validLines.length < lines.length;
  const amounts = calcOrderAmounts(validLines);
  const linesError =
    (errors.lines as { root?: { message?: string } } | undefined)?.root
      ?.message ?? errors.lines?.message;

  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">明細</legend>
      {linesError && (
        <p role="alert" className="text-sm text-destructive">
          {linesError}
        </p>
      )}
      {fields.length === 0 && (
        <p className="rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
          明細がありません。「行を追加」で商品を選んでください（下書きは明細なしでも保存できますが、発注済にするには
          1 行以上必要です）
        </p>
      )}
      <ol className="space-y-3">
        {fields.map((field, index) => {
          const rowErrors = errors.lines?.[index];
          const id = (name: string) => `${idPrefix}-line-${index}-${name}`;
          const product = byId.get(lines[index]?.productId ?? "");
          const result = parsed[index];
          const amount = result?.success ? lineAmount(result.data) : null;
          const productField = register(`lines.${index}.productId`, {
            onChange: (event: { target: { value: string } }) => {
              const selected = byId.get(event.target.value);
              // 単価の初期値は商品の単価（発注は仕入単価）。あとから書き換えられる
              if (selected) {
                setValue(`lines.${index}.unitPrice`, String(selected.price), {
                  shouldValidate: true,
                });
              }
            },
          });
          return (
            <li
              key={field.id}
              className="grid gap-3 rounded-xl border p-3 sm:grid-cols-[1fr_7rem_8rem_8rem_auto] sm:items-start"
            >
              <div className="grid min-w-0 gap-1">
                <label htmlFor={id("product")} className="text-xs">
                  {index + 1} 行目 商品
                </label>
                <NativeSelect
                  id={id("product")}
                  className="w-full"
                  aria-invalid={rowErrors?.productId ? true : undefined}
                  aria-describedby={`${id("product")}-message`}
                  {...productField}
                >
                  <NativeSelectOption value="">
                    選択してください
                  </NativeSelectOption>
                  {products.map((p) => (
                    <NativeSelectOption key={p.id} value={String(p.id)}>
                      {p.code} {p.name}
                      {p.isActive ? "" : "（無効）"}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
                <p
                  id={`${id("product")}-message`}
                  className={
                    rowErrors?.productId
                      ? "text-xs text-destructive"
                      : "text-xs text-muted-foreground"
                  }
                >
                  {rowErrors?.productId?.message ??
                    (product
                      ? `${priceLabel} ${formatNumber(product.price)} 円／${product.unit}`
                      : " ")}
                </p>
              </div>
              <NumberField
                id={id("quantity")}
                label={`数量${product ? `（${product.unit}）` : ""}`}
                error={rowErrors?.quantity?.message}
                {...register(`lines.${index}.quantity`)}
              />
              <NumberField
                id={id("unitPrice")}
                label="単価（円）"
                error={rowErrors?.unitPrice?.message}
                {...register(`lines.${index}.unitPrice`)}
              />
              <div className="grid gap-1">
                <span className="text-xs">金額（円）</span>
                <output
                  htmlFor={`${id("quantity")} ${id("unitPrice")}`}
                  className="flex h-8 items-center justify-end text-sm tabular-nums"
                >
                  {amount === null ? "—" : formatNumber(amount)}
                </output>
              </div>
              <div className="sm:pt-5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => remove(index)}
                  aria-label={`${index + 1} 行目を削除`}
                >
                  削除
                </Button>
              </div>
            </li>
          );
        })}
      </ol>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={fields.length >= ORDER_LINE_LIMITS.lines}
        onClick={() => append({ ...EMPTY_ORDER_LINE })}
      >
        行を追加
      </Button>

      <dl
        aria-live="polite"
        className="ml-auto grid max-w-xs grid-cols-[1fr_auto] gap-x-6 gap-y-1 rounded-xl border p-3 text-sm"
      >
        <dt className="text-muted-foreground">小計</dt>
        <dd className="text-right tabular-nums">
          {amounts ? `${formatNumber(amounts.subtotal)} 円` : "—"}
        </dd>
        <dt className="text-muted-foreground">消費税（10%）</dt>
        <dd className="text-right tabular-nums">
          {amounts ? `${formatNumber(amounts.tax)} 円` : "—"}
        </dd>
        <dt className="font-medium">合計</dt>
        <dd className="text-right font-medium tabular-nums">
          {amounts ? `${formatNumber(amounts.total)} 円` : "—"}
        </dd>
        {(incomplete || !amounts) && (
          <dd className="col-span-2 text-xs text-muted-foreground">
            {amounts
              ? "入力が終わっていない行は計算に含めていません"
              : "合計が上限を超えています"}
          </dd>
        )}
      </dl>
    </fieldset>
  );
}

function NumberField({
  id,
  label,
  error,
  ...props
}: {
  id: string;
  label: string;
  error?: string;
} & ComponentProps<"input">) {
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-xs">
        {label}
      </label>
      <Input
        id={id}
        inputMode="numeric"
        autoComplete="off"
        className="text-right tabular-nums"
        aria-invalid={error ? true : undefined}
        aria-describedby={`${id}-message`}
        {...props}
      />
      <p id={`${id}-message`} className="text-xs text-destructive">
        {error}
      </p>
    </div>
  );
}
