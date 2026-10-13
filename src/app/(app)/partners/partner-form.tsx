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
import { ADDRESS_LOOKUP_MESSAGES } from "@/lib/partners/address-lookup";
import {
  normalizePostalCode,
  PARTNER_FIELD_LABELS,
  PARTNER_KIND_LABELS,
  PARTNER_KINDS,
  PARTNER_LIMITS,
  partnerInputSchema,
  type PartnerField,
  type PartnerFormValues,
  type PartnerInput,
  type PartnerKind,
} from "@/lib/partners/schema";
import type { PartnerMutationError } from "@/lib/partners/service";

/** 住所検索の状態 */
type LookupState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; message: string }
  | { status: "choices"; addresses: string[] }
  | { status: "error"; message: string };

/** 画面側の待ち時間の上限（サーバー側は 3 秒で打ち切る。通信の詰まりで押しっぱなしにならないための保険） */
const CLIENT_TIMEOUT_MS = 8_000;

/** 住所検索の API を呼ぶ（/api/partners/address-lookup。失敗はメッセージにする） */
async function fetchAddresses(
  postalCode: string,
): Promise<{ ok: true; addresses: string[] } | { ok: false; message: string }> {
  try {
    const response = await fetch(
      `/api/partners/address-lookup?postalCode=${encodeURIComponent(postalCode)}`,
      { signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS), cache: "no-store" },
    );
    const body: unknown = await response.json().catch(() => null);
    if (response.ok) {
      const addresses = (body as { addresses?: unknown } | null)?.addresses;
      if (
        Array.isArray(addresses) &&
        addresses.length > 0 &&
        addresses.every((a) => typeof a === "string")
      ) {
        return { ok: true, addresses };
      }
      return { ok: false, message: ADDRESS_LOOKUP_MESSAGES.invalid_response };
    }
    const error = (body as { error?: unknown } | null)?.error;
    return {
      ok: false,
      message:
        typeof error === "string" ? error : ADDRESS_LOOKUP_MESSAGES.unavailable,
    };
  } catch (error) {
    const timedOut =
      (error as { name?: unknown } | null)?.name === "TimeoutError";
    return {
      ok: false,
      message: ADDRESS_LOOKUP_MESSAGES[timedOut ? "timeout" : "unavailable"],
    };
  }
}

interface FieldSpec {
  name: Exclude<PartnerField, "kind" | "postalCode">;
  placeholder?: string;
  maxLength?: number;
  required?: boolean;
  type?: string;
  inputMode?: "tel" | "email";
  autoComplete?: string;
  hint?: string;
  wide?: boolean;
}

const CODE_FIELD: FieldSpec = {
  name: "code",
  placeholder: "C-0001",
  maxLength: PARTNER_LIMITS.code,
  required: true,
  hint: "半角英数字・ハイフン・アンダースコア。ほかの取引先と重複できません",
};
const NAME_FIELD: FieldSpec = {
  name: "name",
  maxLength: PARTNER_LIMITS.name,
  required: true,
  wide: true,
};
const ADDRESS_FIELD: FieldSpec = {
  name: "address",
  maxLength: PARTNER_LIMITS.address,
  hint: "郵便番号から入力したあと、番地・建物名を続けて入力してください",
  wide: true,
};
const CONTACT_FIELDS: FieldSpec[] = [
  {
    name: "phone",
    type: "tel",
    inputMode: "tel",
    placeholder: "03-1234-5678",
    maxLength: PARTNER_LIMITS.phone,
    hint: "ハイフンは任意",
  },
  {
    name: "email",
    type: "email",
    inputMode: "email",
    placeholder: "info@example.com",
    maxLength: PARTNER_LIMITS.email,
  },
];

/**
 * 取引先の登録・編集フォーム（React Hook Form＋Zod）。
 * 画面側の検証は補助で、同じスキーマでサーバー側（Server Action）でも必ず検証する。
 * 郵便番号の「住所を検索」で住所欄を埋める（外部 API はサーバー側から呼ぶ。失敗しても手入力できる）
 */
export function PartnerForm({
  defaultValues,
  codeSuggestions,
  submitLabel,
  cancelHref,
  action,
}: {
  defaultValues: PartnerFormValues;
  /** 登録画面だけ: 種別ごとの次のコード。種別を変えたら、コードを触っていなければ差し替える */
  codeSuggestions?: Record<PartnerKind, string>;
  submitLabel: string;
  cancelHref: string;
  /** 成功時は Server Action 側で画面を移動する。失敗時はエラーが返る */
  action: (values: PartnerFormValues) => Promise<PartnerMutationError | void>;
}) {
  const form = useForm<PartnerFormValues, unknown, PartnerInput>({
    resolver: zodResolver(partnerInputSchema),
    defaultValues,
    mode: "onTouched",
  });
  const [formError, setFormError] = useState<string>();
  const [lookup, setLookup] = useState<LookupState>({ status: "idle" });
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
          form.setError(field as PartnerField, { message: messages[0] });
        }
      }
    });
  });

  const kindField = form.register("kind", {
    onChange: (event: { target: { value: string } }) => {
      if (!codeSuggestions) return;
      const code = form.getValues("code").trim();
      // コードが空か、どれかの種別の提案のまま（利用者が書き換えていない）なら、新しい種別の提案に差し替える
      if (code === "" || Object.values(codeSuggestions).includes(code)) {
        const next = codeSuggestions[event.target.value as PartnerKind];
        if (next) form.setValue("code", next, { shouldValidate: true });
      }
    },
  });

  function fillAddress(address: string) {
    form.setValue("address", address, {
      shouldDirty: true,
      shouldValidate: true,
    });
    setLookup({
      status: "done",
      message: "住所を入力しました。番地・建物名を続けて入力してください",
    });
    form.setFocus("address");
  }

  async function searchAddress() {
    const postalCode = normalizePostalCode(form.getValues("postalCode"));
    if (!postalCode) {
      setLookup({
        status: "error",
        message: ADDRESS_LOOKUP_MESSAGES.invalid_postal_code,
      });
      return;
    }
    setLookup({ status: "loading" });
    const result = await fetchAddresses(postalCode);
    if (!result.ok) {
      setLookup({ status: "error", message: result.message });
      return;
    }
    if (result.addresses.length === 1) {
      fillAddress(result.addresses[0]);
    } else {
      setLookup({ status: "choices", addresses: result.addresses });
    }
  }

  function textField(field: FieldSpec) {
    const id = `partner-${field.name}`;
    const error = errors[field.name]?.message;
    return (
      <div
        key={field.name}
        className={field.wide ? "grid gap-1.5 sm:col-span-2" : "grid gap-1.5"}
      >
        <Label htmlFor={id}>
          {PARTNER_FIELD_LABELS[field.name]}
          {field.required && (
            <span className="text-xs font-normal text-destructive">必須</span>
          )}
        </Label>
        <Input
          id={id}
          type={field.type}
          inputMode={field.inputMode}
          placeholder={field.placeholder}
          maxLength={field.maxLength}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-message`}
          {...form.register(field.name)}
        />
        <p
          id={`${id}-message`}
          className={
            error ? "text-xs text-destructive" : "text-xs text-muted-foreground"
          }
        >
          {error ?? field.hint}
        </p>
      </div>
    );
  }

  const kindError = errors.kind?.message;
  const postalError = errors.postalCode?.message;
  const lookupMessage =
    lookup.status === "done" || lookup.status === "error"
      ? lookup.message
      : lookup.status === "choices"
        ? "候補が複数あります。選んでください（該当がなければ住所を手入力してください）"
        : lookup.status === "loading"
          ? "検索中…"
          : undefined;

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
        <div className="grid gap-1.5">
          <Label htmlFor="partner-kind">
            {PARTNER_FIELD_LABELS.kind}
            <span className="text-xs font-normal text-destructive">必須</span>
          </Label>
          <NativeSelect
            id="partner-kind"
            className="w-full"
            aria-invalid={kindError ? true : undefined}
            aria-describedby="partner-kind-message"
            {...kindField}
          >
            {PARTNER_KINDS.map((kind) => (
              <NativeSelectOption key={kind} value={kind}>
                {PARTNER_KIND_LABELS[kind]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <p
            id="partner-kind-message"
            className={
              kindError
                ? "text-xs text-destructive"
                : "text-xs text-muted-foreground"
            }
          >
            {kindError ?? "顧客は受注、仕入先は発注で選べます"}
          </p>
        </div>
        {textField(CODE_FIELD)}
        {textField(NAME_FIELD)}

        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor="partner-postalCode">
            {PARTNER_FIELD_LABELS.postalCode}
          </Label>
          <div className="flex gap-2">
            <Input
              id="partner-postalCode"
              inputMode="numeric"
              placeholder="123-4567"
              maxLength={8}
              autoComplete="off"
              className="w-36"
              aria-invalid={postalError ? true : undefined}
              aria-describedby="partner-postalCode-message partner-lookup-message"
              {...form.register("postalCode", {
                onChange: () => {
                  if (lookup.status !== "loading") {
                    setLookup({ status: "idle" });
                  }
                },
              })}
            />
            <Button
              type="button"
              variant="outline"
              onClick={searchAddress}
              disabled={lookup.status === "loading"}
            >
              {lookup.status === "loading" ? "検索中…" : "住所を検索"}
            </Button>
          </div>
          <p
            id="partner-postalCode-message"
            className={
              postalError
                ? "text-xs text-destructive"
                : "text-xs text-muted-foreground"
            }
          >
            {postalError ??
              "7桁（ハイフンは任意）。「住所を検索」で住所欄に入力します"}
          </p>
          <p
            id="partner-lookup-message"
            aria-live="polite"
            className={
              lookup.status === "error"
                ? "text-xs text-destructive"
                : "text-xs text-muted-foreground"
            }
          >
            {lookupMessage}
          </p>
          {lookup.status === "choices" && (
            <ul className="flex flex-wrap gap-2">
              {lookup.addresses.map((address) => (
                <li key={address}>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => fillAddress(address)}
                  >
                    {address}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {textField(ADDRESS_FIELD)}
        {CONTACT_FIELDS.map(textField)}
      </div>

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
