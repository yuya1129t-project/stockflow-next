"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useState, useTransition } from "react";
import { useForm, useWatch } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatNumber, formatSignedNumber } from "@/lib/format";
import {
  EMPTY_STOCK_ADJUST_FORM,
  STOCK_ADJUST_FIELD_LABELS,
  STOCK_ADJUST_LIMITS,
  stockAdjustSchema,
  type StockAdjustField,
  type StockAdjustFormValues,
  type StockAdjustInput,
} from "@/lib/stock/schema";

import { adjustStockAction } from "../actions";

/**
 * 棚卸調整のフォーム（admin／staff のみ表示）。実数を入力すると現在庫との差分を adjust で記録する。
 * 画面側の検証は補助で、同じスキーマでサーバー側でも検証し、権限もサーバー側で検査する
 */
export function StockAdjustForm({
  productId,
  currentStock,
  unit,
}: {
  productId: number;
  currentStock: number;
  unit: string;
}) {
  const form = useForm<StockAdjustFormValues, unknown, StockAdjustInput>({
    resolver: zodResolver(stockAdjustSchema),
    defaultValues: EMPTY_STOCK_ADJUST_FORM,
    mode: "onTouched",
  });
  const [result, setResult] = useState<{
    kind: "success" | "info" | "error";
    message: string;
  }>();
  const [pending, startTransition] = useTransition();
  const { errors } = form.formState;
  const actual = useWatch({ control: form.control, name: "actualQuantity" });
  const parsedActual = stockAdjustSchema.shape.actualQuantity.safeParse(
    actual ?? "",
  );
  const preview = parsedActual.success
    ? parsedActual.data - currentStock
    : null;

  const onSubmit = form.handleSubmit(() => {
    setResult(undefined);
    // サーバーには検証前の値（文字列）を送り、サーバー側で同じスキーマで検証する
    const values = form.getValues();
    startTransition(async () => {
      const response = await adjustStockAction(productId, values);
      if (response.ok) {
        setResult({
          kind: response.recorded ? "success" : "info",
          message: response.message,
        });
        if (response.recorded) form.reset(EMPTY_STOCK_ADJUST_FORM);
        return;
      }
      setResult({ kind: "error", message: response.error });
      for (const [field, messages] of Object.entries(
        response.fieldErrors ?? {},
      )) {
        if (messages?.[0]) {
          form.setError(field as StockAdjustField, { message: messages[0] });
        }
      }
    });
  });

  const fields: {
    name: StockAdjustField;
    hint: string;
    numeric?: boolean;
    maxLength?: number;
  }[] = [
    {
      name: "actualQuantity",
      numeric: true,
      hint:
        preview === null
          ? `数えた在庫の数（${unit}）。現在庫 ${formatNumber(currentStock)}${unit}`
          : preview === 0
            ? "現在庫と同じです（記録しません）"
            : `差分 ${formatSignedNumber(preview)}${unit} を記録します`,
    },
    {
      name: "reason",
      maxLength: STOCK_ADJUST_LIMITS.reason,
      hint: "例: 定期棚卸、破損による廃棄",
    },
  ];

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="max-w-xl space-y-4 rounded-xl border p-4"
    >
      {result && (
        <p
          role={result.kind === "error" ? "alert" : "status"}
          className={
            result.kind === "error"
              ? "rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
              : result.kind === "success"
                ? "rounded-lg border border-emerald-600/30 bg-emerald-600/5 px-3 py-2 text-sm"
                : "rounded-lg border px-3 py-2 text-sm"
          }
        >
          {result.message}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
        {fields.map((field) => {
          const id = `stock-adjust-${field.name}`;
          const error = errors[field.name]?.message;
          return (
            <div key={field.name} className="grid content-start gap-1.5">
              <Label htmlFor={id}>
                {STOCK_ADJUST_FIELD_LABELS[field.name]}
                <span className="text-xs font-normal text-destructive">
                  必須
                </span>
              </Label>
              <Input
                id={id}
                inputMode={field.numeric ? "numeric" : undefined}
                maxLength={field.maxLength}
                autoComplete="off"
                aria-invalid={error ? true : undefined}
                aria-describedby={`${id}-message`}
                className={
                  field.numeric ? "text-right tabular-nums" : undefined
                }
                {...form.register(field.name)}
              />
              <p
                id={`${id}-message`}
                className={
                  error
                    ? "text-xs text-destructive"
                    : "text-xs text-muted-foreground"
                }
              >
                {error ?? field.hint}
              </p>
            </div>
          );
        })}
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "記録中…" : "調整を記録する"}
      </Button>
    </form>
  );
}
