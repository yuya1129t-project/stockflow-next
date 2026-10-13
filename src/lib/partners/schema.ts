/**
 * 取引先の入力検証（Zod）。docs/spec.md §3「Partner」・§8。
 *
 * 画面（React Hook Form）と Server Action で同じスキーマを使う。入力はすべて文字列（フォームの値）で受け取る。
 * 郵便番号・住所・電話番号・メールアドレスは任意（空なら null で保存する）。
 * DB やフレームワークに依存しない純粋なモジュール（クライアントからも import できる）
 */
import { z } from "zod";
import { SINGLE_LINE, singleLineMessage } from "@/lib/validation/text";

/** 項目名（画面のラベル・エラー文・操作履歴で共通） */
export const PARTNER_FIELD_LABELS = {
  code: "取引先コード",
  name: "取引先名",
  kind: "種別",
  postalCode: "郵便番号",
  address: "住所",
  phone: "電話番号",
  email: "メールアドレス",
} as const;

export type PartnerField = keyof typeof PARTNER_FIELD_LABELS;

export const PARTNER_FIELDS = Object.keys(
  PARTNER_FIELD_LABELS,
) as PartnerField[];

export const PARTNER_KINDS = ["customer", "supplier", "both"] as const;
export type PartnerKind = (typeof PARTNER_KINDS)[number];

export const PARTNER_KIND_LABELS: Record<PartnerKind, string> = {
  customer: "顧客",
  supplier: "仕入先",
  both: "顧客・仕入先",
};

/** 取引先の役割（受注の顧客・発注の仕入先） */
export type PartnerRole = "customer" | "supplier";

/**
 * その役割を持つ種別（spec §3: 顧客は customer か both、仕入先は supplier か both）。
 * 一覧の絞り込みと、受注・発注（#7・#8）の取引先の選択肢で使う
 */
export function partnerKindsFor(role: PartnerRole): PartnerKind[] {
  return [role, "both"];
}

/** 種別がその役割を持つか */
export function hasPartnerRole(kind: PartnerKind, role: PartnerRole): boolean {
  return partnerKindsFor(role).includes(kind);
}

/** 文字数の上限 */
export const PARTNER_LIMITS = {
  code: 20,
  name: 100,
  address: 200,
  phone: 20,
  email: 254,
} as const;

function requiredText(field: PartnerField, max: number) {
  const label = PARTNER_FIELD_LABELS[field];
  return (
    z
      .string({ error: `${label}を入力してください` })
      .trim()
      // 空のときは形式のエラーを重ねて出さない
      .min(1, { error: `${label}を入力してください`, abort: true })
      .max(max, `${label}は${max}文字以内で入力してください`)
      .regex(SINGLE_LINE, singleLineMessage(label))
  );
}

/**
 * 任意の項目: 前後の空白を除き、空なら null。空でなければ schema で検証する
 */
function optional<T extends z.ZodType<unknown, string>>(
  field: PartnerField,
  schema: T,
) {
  return z
    .string({ error: `${PARTNER_FIELD_LABELS[field]}の形式が正しくありません` })
    .trim()
    .transform((value) => (value === "" ? undefined : value))
    .pipe(schema.optional())
    .transform((value) => value ?? null);
}

/** 全角の数字を半角にし、ハイフンに見える文字（全角ハイフン・長音記号など）を "-" に揃える */
function normalizeDigitsAndHyphens(value: string): string {
  return value
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[－‐‑–—−ー─]/g, "-");
}

/**
 * 郵便番号を「ハイフンなしの 7 桁」にする（123-4567・1234567・全角も受け付ける）。形式が違えば null。
 * 住所検索（zipcloud）と保存で同じ解釈をする
 */
export function normalizePostalCode(value: string): string | null {
  const normalized = normalizeDigitsAndHyphens(value.trim());
  const match = /^(\d{3})-?(\d{4})$/.exec(normalized);
  return match ? `${match[1]}${match[2]}` : null;
}

/** 保存した郵便番号（7 桁）を表示用に「123-4567」にする */
export function formatPostalCode(value: string | null): string {
  if (!value) return "";
  return /^\d{7}$/.test(value)
    ? `${value.slice(0, 3)}-${value.slice(3)}`
    : value;
}

export const POSTAL_CODE_FORMAT_MESSAGE =
  "郵便番号は7桁の数字で入力してください（例 123-4567）";

const postalCodeSchema = z.string().transform((value, ctx) => {
  const normalized = normalizePostalCode(value);
  if (normalized === null) {
    ctx.addIssue({ code: "custom", message: POSTAL_CODE_FORMAT_MESSAGE });
    return z.NEVER;
  }
  return normalized;
});

/** 電話番号: 半角数字とハイフン。0 で始まり、数字は 10〜11 桁（全角は半角にして保存する） */
const phoneSchema = z.string().transform((value, ctx) => {
  const normalized = normalizeDigitsAndHyphens(value);
  const digits = normalized.replace(/-/g, "");
  if (
    normalized.length > PARTNER_LIMITS.phone ||
    !/^0\d*(-\d+){0,2}$/.test(normalized) ||
    digits.length < 10 ||
    digits.length > 11
  ) {
    ctx.addIssue({
      code: "custom",
      message:
        "電話番号は 0 から始まる 10〜11 桁の数字で入力してください（ハイフンは任意。例 03-1234-5678）",
    });
    return z.NEVER;
  }
  return normalized;
});

const emailSchema = z
  .string()
  .max(
    PARTNER_LIMITS.email,
    `メールアドレスは${PARTNER_LIMITS.email}文字以内で入力してください`,
  )
  .pipe(
    z.email("メールアドレスの形式が正しくありません（例 info@example.com）"),
  );

const addressSchema = z
  .string()
  .max(
    PARTNER_LIMITS.address,
    `住所は${PARTNER_LIMITS.address}文字以内で入力してください`,
  )
  .regex(SINGLE_LINE, singleLineMessage("住所"));

export const partnerInputSchema = z.object({
  code: requiredText("code", PARTNER_LIMITS.code)
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
      "取引先コードは半角英数字・ハイフン（-）・アンダースコア（_）で入力してください（先頭は英数字）",
    )
    // 大文字に揃える（c-0001 と C-0001 を別の取引先にしない）
    .toUpperCase(),
  name: requiredText("name", PARTNER_LIMITS.name),
  kind: z.enum(PARTNER_KINDS, { error: "種別を選択してください" }),
  postalCode: optional("postalCode", postalCodeSchema),
  address: optional("address", addressSchema),
  phone: optional("phone", phoneSchema),
  email: optional("email", emailSchema),
});

/** フォームから受け取る値（すべて文字列） */
export type PartnerFormValues = z.input<typeof partnerInputSchema>;
/** 検証後の値（任意の項目は空なら null） */
export type PartnerInput = z.output<typeof partnerInputSchema>;

/** 項目ごとのエラー（Server Action から画面へ返す） */
export type PartnerFieldErrors = Partial<Record<PartnerField, string[]>>;

/** 検証エラーを項目ごとのメッセージにする */
export function partnerFieldErrors(error: z.ZodError): PartnerFieldErrors {
  return z.flattenError(error).fieldErrors as PartnerFieldErrors;
}

/** 新規登録フォームの初期値 */
export function emptyPartnerForm(
  kind: PartnerKind = "customer",
  code = "",
): PartnerFormValues {
  return {
    code,
    name: "",
    kind,
    postalCode: "",
    address: "",
    phone: "",
    email: "",
  };
}

/** 保存済みの取引先をフォームの値にする（編集画面の初期値。郵便番号は 123-4567 の形で表示） */
export function toPartnerFormValues(partner: PartnerInput): PartnerFormValues {
  return {
    code: partner.code,
    name: partner.name,
    kind: partner.kind,
    postalCode: formatPostalCode(partner.postalCode),
    address: partner.address ?? "",
    phone: partner.phone ?? "",
    email: partner.email ?? "",
  };
}

/** 種別ごとのコードの接頭辞（登録画面で次のコードを提案する） */
export const PARTNER_CODE_PREFIXES: Record<PartnerKind, string> = {
  customer: "C-",
  supplier: "S-",
  both: "B-",
};

/**
 * 次の取引先コードを提案する（例 既存が C-0001〜C-0012 なら C-0013）。
 * 「接頭辞＋数字」の形のコードだけを見て、最大の番号＋1 を 4 桁以上で返す
 */
export function nextPartnerCode(
  kind: PartnerKind,
  existingCodes: readonly string[],
): string {
  const prefix = PARTNER_CODE_PREFIXES[kind];
  let max = 0;
  for (const code of existingCodes) {
    if (!code.startsWith(prefix)) continue;
    const rest = code.slice(prefix.length);
    if (/^\d{1,9}$/.test(rest)) max = Math.max(max, Number(rest));
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}
