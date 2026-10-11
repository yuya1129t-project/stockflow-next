"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";

import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  PRODUCT_FIELD_LABELS,
  PRODUCT_LIMITS,
  productInputSchema,
  type ProductField,
  type ProductFormValues,
  type ProductInput,
} from "@/lib/products/schema";
import type { MutationError } from "@/lib/products/service";

interface FieldSpec {
  name: ProductField;
  placeholder?: string;
  maxLength?: number;
  numeric?: boolean;
  hint?: string;
}

const FIELDS: FieldSpec[] = [
  {
    name: "code",
    placeholder: "P-0001",
    maxLength: PRODUCT_LIMITS.code,
    hint: "半角英数字・ハイフン・アンダースコア。ほかの商品と重複できません",
  },
  { name: "name", maxLength: PRODUCT_LIMITS.name },
  { name: "category", maxLength: PRODUCT_LIMITS.category },
  {
    name: "unit",
    placeholder: "個／箱／kg など",
    maxLength: PRODUCT_LIMITS.unit,
  },
  { name: "salesPrice", numeric: true, hint: "円（税抜）" },
  { name: "purchasePrice", numeric: true, hint: "円（税抜）" },
  {
    name: "reorderPoint",
    numeric: true,
    hint: "現在庫がこの数を下回ると「発注点割れ」として表示します",
  },
];

/**
 * 商品の登録・編集フォーム（React Hook Form＋Zod）。
 * 画面側の検証は補助で、同じスキーマでサーバー側（Server Action）でも必ず検証する
 */
export function ProductForm({
  defaultValues,
  categories,
  submitLabel,
  cancelHref,
  action,
}: {
  defaultValues: ProductFormValues;
  categories: string[];
  submitLabel: string;
  cancelHref: string;
  /** 成功時は Server Action 側で画面を移動する。失敗時はエラーが返る */
  action: (values: ProductFormValues) => Promise<MutationError | void>;
}) {
  const form = useForm<ProductFormValues, unknown, ProductInput>({
    resolver: zodResolver(productInputSchema),
    defaultValues,
    mode: "onTouched",
  });
  const [formError, setFormError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const { errors } = form.formState;

  const onSubmit = form.handleSubmit(() => {
    setFormError(undefined);
    // サーバーには検証前の値（文字列）を送り、サーバー側で同じスキーマで検証する
    const values = form.getValues();
    startTransition(async () => {
      const result = await action(values);
      if (!result) return;
      setFormError(result.error);
      for (const [field, messages] of Object.entries(
        result.fieldErrors ?? {},
      )) {
        if (messages?.[0]) {
          form.setError(field as ProductField, { message: messages[0] });
        }
      }
    });
  });

  return (
    <form onSubmit={onSubmit} noValidate className="max-w-xl space-y-5">
      {formError && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {formError}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {FIELDS.map((field) => {
          const id = `product-${field.name}`;
          const error = errors[field.name]?.message;
          return (
            <div
              key={field.name}
              className={
                field.name === "name" || field.name === "code"
                  ? "grid gap-1.5 sm:col-span-2"
                  : "grid gap-1.5"
              }
            >
              <Label htmlFor={id}>
                {PRODUCT_FIELD_LABELS[field.name]}
                <span className="text-xs font-normal text-destructive">
                  必須
                </span>
              </Label>
              <Input
                id={id}
                inputMode={field.numeric ? "numeric" : undefined}
                placeholder={field.placeholder}
                maxLength={field.maxLength}
                list={
                  field.name === "category" ? "product-categories" : undefined
                }
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
      <datalist id="product-categories">
        {categories.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>

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
  );
}
