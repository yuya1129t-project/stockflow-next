/**
 * ユーザー管理・API トークンの入力検証（Zod）。docs/spec.md §3「User」・§6-2・§8。
 *
 * 画面（React Hook Form）と Server Action で同じスキーマを使う。入力はすべて文字列（フォームの値）で受け取る。
 * DB やフレームワークに依存しない純粋なモジュール（クライアントからも import できる）
 */
import { z } from "zod";

import { ROLES } from "@/lib/auth/permissions";
import { SINGLE_LINE, singleLineMessage } from "@/lib/validation/text";

/** 項目名（画面のラベル・エラー文で共通） */
export const USER_FIELD_LABELS = {
  name: "名前",
  email: "メールアドレス",
  role: "ロール",
  password: "初期パスワード",
} as const;

export type UserField = keyof typeof USER_FIELD_LABELS;

/**
 * 文字数の上限。パスワードは Better Auth の既定（minPasswordLength 8・maxPasswordLength 128）に合わせる
 * （ログインは Better Auth が検査するので、ここで登録できてもログインできない長さを作らない）
 */
export const USER_LIMITS = {
  name: 100,
  email: 254,
  passwordMin: 8,
  passwordMax: 128,
  tokenName: 50,
} as const;

function requiredText(label: string, max: number) {
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
 * パスワード。前後の空白も含めてそのまま使う（trim しない）。
 * 文字の種類は制限しないが、制御文字（改行・タブなど）は入力の誤りとして拒否する
 */
export function passwordSchema(label: string) {
  return z
    .string({ error: `${label}を入力してください` })
    .min(1, { error: `${label}を入力してください`, abort: true })
    .min(
      USER_LIMITS.passwordMin,
      `${label}は${USER_LIMITS.passwordMin}文字以上で入力してください`,
    )
    .max(
      USER_LIMITS.passwordMax,
      `${label}は${USER_LIMITS.passwordMax}文字以内で入力してください`,
    )
    .regex(SINGLE_LINE, singleLineMessage(label));
}

const roleSchema = z.enum(ROLES, { error: "ロールを選択してください" });

export const userCreateSchema = z.object({
  name: requiredText(USER_FIELD_LABELS.name, USER_LIMITS.name),
  email: z
    .string({ error: "メールアドレスを入力してください" })
    .trim()
    // Better Auth はログイン時にメールアドレスを小文字にして照合する。保存も小文字に揃える
    .toLowerCase()
    .min(1, { error: "メールアドレスを入力してください", abort: true })
    .max(
      USER_LIMITS.email,
      `メールアドレスは${USER_LIMITS.email}文字以内で入力してください`,
    )
    .pipe(
      z.email("メールアドレスの形式が正しくありません（例 user@example.com）"),
    ),
  role: roleSchema,
  password: passwordSchema(USER_FIELD_LABELS.password),
});

/** フォームから受け取る値（すべて文字列） */
export type UserCreateFormValues = z.input<typeof userCreateSchema>;
/** 検証後の値 */
export type UserCreateInput = z.output<typeof userCreateSchema>;

/** 項目ごとのエラー（Server Action から画面へ返す） */
export type UserFieldErrors = Partial<Record<UserField, string[]>>;

export function userFieldErrors(error: z.ZodError): UserFieldErrors {
  return z.flattenError(error).fieldErrors as UserFieldErrors;
}

export function emptyUserForm(): UserCreateFormValues {
  return { name: "", email: "", role: "viewer", password: "" };
}

/** ロール変更 */
export const userRoleSchema = z.object({ role: roleSchema });

/** パスワード再設定（admin が新しいパスワードを設定する） */
export const passwordResetSchema = z.object({
  password: passwordSchema("新しいパスワード"),
  /** 対象の API トークンもすべて失効させる（画面の既定はオン） */
  revokeTokens: z
    .boolean({ error: "API トークンの失効の指定が正しくありません" })
    .default(true),
});
export type PasswordResetFormValues = z.input<typeof passwordResetSchema>;

/** API トークンの発行（名前を付ける） */
export const apiTokenCreateSchema = z.object({
  name: requiredText("トークンの名前", USER_LIMITS.tokenName),
});
export type ApiTokenCreateFormValues = z.input<typeof apiTokenCreateSchema>;
