"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";

import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { ROLE_LABELS, ROLES } from "@/lib/auth/permissions";
import {
  emptyUserForm,
  USER_FIELD_LABELS,
  USER_LIMITS,
  userCreateSchema,
  type UserCreateFormValues,
  type UserCreateInput,
  type UserField,
} from "@/lib/users/schema";

import { createUserAction } from "./actions";

interface FieldSpec {
  name: Exclude<UserField, "role">;
  type: string;
  maxLength: number;
  autoComplete: string;
  hint?: string;
}

const FIELDS: FieldSpec[] = [
  {
    name: "name",
    type: "text",
    maxLength: USER_LIMITS.name,
    autoComplete: "off",
  },
  {
    name: "email",
    type: "email",
    maxLength: USER_LIMITS.email,
    autoComplete: "off",
    hint: "ログインに使います。ほかのユーザーと重複できません",
  },
  {
    name: "password",
    type: "password",
    maxLength: USER_LIMITS.passwordMax,
    autoComplete: "new-password",
    hint: `${USER_LIMITS.passwordMin}文字以上。登録した本人に伝えてください`,
  },
];

/**
 * ユーザーの登録フォーム（React Hook Form＋Zod）。
 * 画面側の検証は補助で、同じスキーマでサーバー側（Server Action）でも必ず検証する
 */
export function UserForm() {
  const form = useForm<UserCreateFormValues, unknown, UserCreateInput>({
    resolver: zodResolver(userCreateSchema),
    defaultValues: emptyUserForm(),
    mode: "onTouched",
  });
  const [formError, setFormError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const { errors } = form.formState;

  const onSubmit = form.handleSubmit(() => {
    setFormError(undefined);
    const values = form.getValues();
    startTransition(async () => {
      // 成功時は Server Action 側で詳細画面へ移動する
      const result = await createUserAction(values);
      setFormError(result.error);
      for (const [field, messages] of Object.entries(
        result.fieldErrors ?? {},
      )) {
        if (messages?.[0]) {
          form.setError(field as UserField, { message: messages[0] });
        }
      }
    });
  });

  const roleError = errors.role?.message;

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

      <div className="grid gap-4">
        {FIELDS.map((field) => {
          const id = `user-${field.name}`;
          const error = errors[field.name]?.message;
          return (
            <div key={field.name} className="grid gap-1.5">
              <Label htmlFor={id}>
                {USER_FIELD_LABELS[field.name]}
                <span className="text-xs font-normal text-destructive">
                  必須
                </span>
              </Label>
              <Input
                id={id}
                type={field.type}
                maxLength={field.maxLength}
                autoComplete={field.autoComplete}
                aria-invalid={error ? true : undefined}
                aria-describedby={`${id}-message`}
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

        <div className="grid gap-1.5">
          <Label htmlFor="user-role">
            {USER_FIELD_LABELS.role}
            <span className="text-xs font-normal text-destructive">必須</span>
          </Label>
          <NativeSelect
            id="user-role"
            className="w-full sm:w-60"
            aria-invalid={roleError ? true : undefined}
            aria-describedby="user-role-message"
            {...form.register("role")}
          >
            {ROLES.map((role) => (
              <NativeSelectOption key={role} value={role}>
                {ROLE_LABELS[role]}（{role}）
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <p
            id="user-role-message"
            className={
              roleError
                ? "text-xs text-destructive"
                : "text-xs text-muted-foreground"
            }
          >
            {roleError ??
              "できる操作はロールで決まります（あとで変更できます）"}
          </p>
        </div>
      </div>

      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "登録中…" : "登録する"}
        </Button>
        <Link href="/users" className={buttonVariants({ variant: "outline" })}>
          キャンセル
        </Link>
      </div>
    </form>
  );
}
