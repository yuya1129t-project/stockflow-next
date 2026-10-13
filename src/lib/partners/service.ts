/**
 * 取引先の更新系（登録・編集・無効化／再有効化）。サーバー側でだけ使う。
 *
 * - 権限は Server Action（checkActionPermission）で検査したうえで、ここでも操作したユーザーのロールを
 *   検査する（二重の確認。結合テストはこの関数を直接呼んで権限を確かめる）
 * - 入力は必ずここで Zod スキーマ（画面と共通）で検証する
 * - 更新と操作履歴（AuditLog）は同じトランザクションで書く（spec §3）
 */
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import {
  authErrorMessage,
  authorize,
  type SessionUser,
} from "@/lib/auth/session";
import type { Action } from "@/lib/auth/permissions";

import {
  formatPostalCode,
  hasPartnerRole,
  PARTNER_FIELD_LABELS,
  PARTNER_FIELDS,
  PARTNER_KIND_LABELS,
  partnerFieldErrors,
  partnerInputSchema,
  type PartnerFieldErrors,
  type PartnerInput,
} from "./schema";

export type PartnerMutationError = {
  ok: false;
  error: string;
  fieldErrors?: PartnerFieldErrors;
};
export type PartnerMutationResult<T = null> =
  { ok: true; data: T } | PartnerMutationError;

/** 操作履歴の targetType */
export const PARTNER_TARGET_TYPE = "partner";

function checkRole(
  user: SessionUser | null,
  action: Action,
): { ok: true; user: SessionUser } | { ok: false; error: string } {
  const result = authorize(user, action);
  return result.ok
    ? result
    : { ok: false, error: authErrorMessage(result.status) };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

function duplicateCodeError(code: string): PartnerMutationError {
  const message = `取引先コード「${code}」はすでに登録されています`;
  return { ok: false, error: message, fieldErrors: { code: [message] } };
}

const NOT_FOUND: PartnerMutationError = {
  ok: false,
  error: "取引先が見つかりません",
};
const DONE: PartnerMutationResult = { ok: true, data: null };

const INVALID_INPUT_MESSAGE =
  "入力内容に誤りがあります。各項目を確認してください";

function validate(
  input: unknown,
): { ok: true; data: PartnerInput } | PartnerMutationError {
  const parsed = partnerInputSchema.safeParse(input);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : {
        ok: false,
        error: INVALID_INPUT_MESSAGE,
        fieldErrors: partnerFieldErrors(parsed.error),
      };
}

/** 取引先を登録する */
export async function createPartner(
  db: PrismaClient,
  user: SessionUser | null,
  input: unknown,
): Promise<PartnerMutationResult<{ id: number }>> {
  const auth = checkRole(user, "master:edit");
  if (!auth.ok) return auth;
  const parsed = validate(input);
  if (!parsed.ok) return parsed;
  const data = parsed.data;
  try {
    const partner = await db.$transaction(async (tx) => {
      const created = await tx.partner.create({ data });
      await tx.auditLog.create({
        data: {
          userId: auth.user.id,
          action: "create",
          targetType: PARTNER_TARGET_TYPE,
          targetId: String(created.id),
          summary: `取引先 ${data.code}「${data.name}」を登録しました`,
        },
      });
      return created;
    });
    return { ok: true, data: { id: partner.id } };
  } catch (error) {
    if (isUniqueViolation(error)) return duplicateCodeError(data.code);
    throw error;
  }
}

function displayValue(field: keyof PartnerInput, input: PartnerInput): string {
  if (field === "kind") return PARTNER_KIND_LABELS[input.kind];
  if (field === "postalCode")
    return formatPostalCode(input.postalCode) || "（なし）";
  return input[field] ?? "（なし）";
}

/** 変更点の説明（操作履歴の summary 用）。変更がなければ空配列 */
export function describePartnerChanges(
  before: PartnerInput,
  after: PartnerInput,
): string[] {
  return PARTNER_FIELDS.filter((field) => before[field] !== after[field]).map(
    (field) =>
      `${PARTNER_FIELD_LABELS[field]}: ${displayValue(field, before)} → ${displayValue(field, after)}`,
  );
}

function pickInput(partner: PartnerInput): PartnerInput {
  return Object.fromEntries(
    PARTNER_FIELDS.map((field) => [field, partner[field]]),
  ) as PartnerInput;
}

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/**
 * 種別の変更で、使用中の受注・発注と矛盾しないか（spec §3: 受注の顧客は customer か both、
 * 発注の仕入先は supplier か both）。顧客・仕入先の役割を外す変更で、その役割の受注・発注があれば種別のエラー
 */
async function checkKindChange(
  tx: Tx,
  id: number,
  before: PartnerInput["kind"],
  after: PartnerInput["kind"],
): Promise<PartnerMutationError | null> {
  const messages: string[] = [];
  if (
    hasPartnerRole(before, "customer") &&
    !hasPartnerRole(after, "customer")
  ) {
    const count = await tx.salesOrder.count({ where: { customerId: id } });
    if (count > 0) {
      messages.push(
        `受注（${count} 件）で使われているため、顧客の役割を外せません（「顧客」か「顧客・仕入先」にしてください）`,
      );
    }
  }
  if (
    hasPartnerRole(before, "supplier") &&
    !hasPartnerRole(after, "supplier")
  ) {
    const count = await tx.purchaseOrder.count({ where: { supplierId: id } });
    if (count > 0) {
      messages.push(
        `発注（${count} 件）で使われているため、仕入先の役割を外せません（「仕入先」か「顧客・仕入先」にしてください）`,
      );
    }
  }
  if (messages.length === 0) return null;
  return {
    ok: false,
    error: INVALID_INPUT_MESSAGE,
    fieldErrors: { kind: messages },
  };
}

/** 取引先を編集する（取引先コードも変更できる。一意でなければエラー） */
export async function updatePartner(
  db: PrismaClient,
  user: SessionUser | null,
  id: number,
  input: unknown,
): Promise<PartnerMutationResult> {
  const auth = checkRole(user, "master:edit");
  if (!auth.ok) return auth;
  const parsed = validate(input);
  if (!parsed.ok) return parsed;
  const data = parsed.data;
  try {
    return await db.$transaction(async (tx): Promise<PartnerMutationResult> => {
      const before = await tx.partner.findUnique({ where: { id } });
      if (!before) return NOT_FOUND;
      const changes = describePartnerChanges(pickInput(before), data);
      // 変更がなければ何もしない（操作履歴も残さない）
      if (changes.length === 0) return DONE;
      const kindError = await checkKindChange(tx, id, before.kind, data.kind);
      if (kindError) return kindError;
      await tx.partner.update({ where: { id }, data });
      await tx.auditLog.create({
        data: {
          userId: auth.user.id,
          action: "update",
          targetType: PARTNER_TARGET_TYPE,
          targetId: String(id),
          summary: `取引先 ${data.code} を更新しました（${changes.join("、")}）`,
        },
      });
      return DONE;
    });
  } catch (error) {
    if (isUniqueViolation(error)) return duplicateCodeError(data.code);
    throw error;
  }
}

/** 取引先を無効化（isActive = false）または再有効化する。admin のみ（spec §2） */
export async function setPartnerActive(
  db: PrismaClient,
  user: SessionUser | null,
  id: number,
  isActive: boolean,
): Promise<PartnerMutationResult> {
  const auth = checkRole(user, "master:deactivate");
  if (!auth.ok) return auth;
  return db.$transaction(async (tx): Promise<PartnerMutationResult> => {
    const partner = await tx.partner.findUnique({ where: { id } });
    if (!partner) return NOT_FOUND;
    if (partner.isActive === isActive) return DONE;
    await tx.partner.update({ where: { id }, data: { isActive } });
    await tx.auditLog.create({
      data: {
        userId: auth.user.id,
        action: isActive ? "reactivate" : "deactivate",
        targetType: PARTNER_TARGET_TYPE,
        targetId: String(id),
        summary: `取引先 ${partner.code}「${partner.name}」を${isActive ? "再度有効に" : "無効に"}しました`,
      },
    });
    return DONE;
  });
}
