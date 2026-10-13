/**
 * 発注の更新系（作成・編集・ステータス変更）。サーバー側でだけ使う。docs/spec.md §2〜§4
 *
 * - 権限は Server Action（checkActionPermission）で検査したうえで、ここでも操作したユーザーのロールを検査する
 * - 入力は必ずここで Zod スキーマ（画面と共通）で検証する。金額は明細から計算する（画面から送られた合計は使わない）
 * - 伝票・明細・入出庫・操作履歴（AuditLog）は同じトランザクションで書く
 *
 * 同時実行:
 * - 作成・編集: 仕入先の行と明細の商品の行を FOR SHARE でロックしてから種別・有効を検査する（src/lib/orders/locks.ts）
 * - 編集・ステータス変更（入荷以外）: 発注の行を FOR NO KEY UPDATE でロックしてから状態を読む。
 *   編集は画面を開いた時点の updatedAt と比べ、変わっていれば保存しない（他の人の更新を上書きしない）
 * - 入荷: withStockTransaction の中で `updateMany({ where: { id, status: "ordered" } })` の件数を見てから入庫を記録する。
 *   同時に 2 回入荷しても、2 本目は 1 本目の確定を待ってから WHERE を評価し直して 0 件になるので、二重に入庫しない
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { Action } from "@/lib/auth/permissions";
import {
  authErrorMessage,
  authorize,
  type SessionUser,
} from "@/lib/auth/session";
import { formatNumber } from "@/lib/format";
import { calcOrderAmounts, type OrderAmounts } from "@/lib/orders/amounts";
import {
  formatDateOnly,
  parseDateOnly,
  todayInTokyo,
} from "@/lib/orders/dates";
import {
  checkLineProducts,
  lockPartnerForRole,
  lockProductsForLines,
} from "@/lib/orders/locks";
import { nextDocumentNumber } from "@/lib/orders/numbering";
import {
  conflictMessage,
  isSameVersion,
  parseExpectedUpdatedAt,
} from "@/lib/orders/versions";
import {
  isValidDbId,
  orderFieldErrors,
  type OrderFieldErrors,
  type OrderLineInput,
} from "@/lib/orders/schema";
import {
  recordStockMovements,
  withStockTransaction,
} from "@/lib/stock/movements";

import {
  checkExpectedDate,
  purchaseOrderInputSchema,
  type PurchaseOrderInput,
} from "./schema";
import {
  checkPurchaseOrderTransition,
  isPurchaseOrderEditable,
  isPurchaseOrderStatus,
  PURCHASE_ORDER_STATUS_LABELS,
  type PurchaseOrderStatus,
} from "./status";

export type PurchaseOrderMutationError = {
  ok: false;
  error: string;
  fieldErrors?: OrderFieldErrors;
  /** 編集の競合（画面を開いた後に他の人が更新した） */
  conflict?: true;
};
export type PurchaseOrderMutationResult<T = null> =
  { ok: true; data: T } | PurchaseOrderMutationError;

/** 操作履歴の targetType */
export const PURCHASE_ORDER_TARGET_TYPE = "purchase_order";
/** 操作履歴の action（ステータス変更） */
export const PURCHASE_ORDER_STATUS_ACTION = "status_change";

const INVALID_INPUT_MESSAGE =
  "入力内容に誤りがあります。各項目を確認してください";
const NOT_FOUND: PurchaseOrderMutationError = {
  ok: false,
  error: "発注が見つかりません",
};
export const CONFLICT_MESSAGE = conflictMessage("発注", "保存していません");
export const STATUS_CONFLICT_MESSAGE = conflictMessage(
  "発注",
  "ステータスは変更していません",
);

/**
 * トランザクションの timeout（作成・編集・ステータス変更・入荷で共通）。取引先・商品・発注の行のロック待ちを含む
 * （在庫の記録や CSV 取込が同じ商品のロックを持っている間は待つ）。Prisma の既定は 5 秒
 */
const TX_TIMEOUT_MS = 15_000;

function checkRole(
  user: SessionUser | null,
  action: Action,
): { ok: true; user: SessionUser } | { ok: false; error: string } {
  const result = authorize(user, action);
  return result.ok
    ? result
    : { ok: false, error: authErrorMessage(result.status) };
}

type Validated = {
  ok: true;
  data: PurchaseOrderInput;
  amounts: OrderAmounts;
};

function validate(input: unknown): Validated | PurchaseOrderMutationError {
  const parsed = purchaseOrderInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: INVALID_INPUT_MESSAGE,
      fieldErrors: orderFieldErrors(parsed.error),
    };
  }
  // スキーマで合計の上限を検査済みなので null にはならない
  const amounts = calcOrderAmounts(parsed.data.lines)!;
  return { ok: true, data: parsed.data, amounts };
}

function fieldError(
  field: string,
  message: string,
): PurchaseOrderMutationError {
  return {
    ok: false,
    error: INVALID_INPUT_MESSAGE,
    fieldErrors: { [field]: [message] },
  };
}

function lineData(lines: readonly OrderLineInput[]) {
  return lines.map(({ productId, quantity, unitPrice }) => ({
    productId,
    quantity,
    unitPrice,
  }));
}

/**
 * 発注を作成する（draft）。発注日は作成した日（Asia/Tokyo）で、番号は PO-発注日-連番
 */
export async function createPurchaseOrder(
  db: PrismaClient,
  user: SessionUser | null,
  input: unknown,
  now: Date = new Date(),
): Promise<PurchaseOrderMutationResult<{ id: number; number: string }>> {
  const auth = checkRole(user, "order:edit");
  if (!auth.ok) return auth;
  const parsed = validate(input);
  if (!parsed.ok) return parsed;
  const { data, amounts } = parsed;
  const orderDateText = todayInTokyo(now);
  const orderDate = parseDateOnly(orderDateText)!;
  const dateError = checkExpectedDate(orderDate, data.expectedDate);
  if (dateError) return fieldError("expectedDate", dateError);

  return db.$transaction(
    async (
      tx,
    ): Promise<PurchaseOrderMutationResult<{ id: number; number: string }>> => {
      const supplier = await lockPartnerForRole(
        tx,
        data.supplierId,
        "supplier",
      );
      if (!supplier.ok) return fieldError("supplierId", supplier.message);
      const products = await lockProductsForLines(
        tx,
        data.lines.map((l) => l.productId),
      );
      const lineErrors = checkLineProducts(data.lines, products);
      if (lineErrors) {
        return {
          ok: false,
          error: INVALID_INPUT_MESSAGE,
          fieldErrors: lineErrors,
        };
      }

      // 採番は検査の後（作成が失敗すればトランザクションごと戻るので欠番にならない）
      const number = await nextDocumentNumber(tx, "PO", orderDateText);
      const created = await tx.purchaseOrder.create({
        data: {
          number,
          supplierId: data.supplierId,
          orderDate,
          expectedDate: data.expectedDate,
          note: data.note,
          ...amounts,
          lines: { createMany: { data: lineData(data.lines) } },
        },
        select: { id: true },
      });
      await tx.auditLog.create({
        data: {
          userId: auth.user.id,
          action: "create",
          targetType: PURCHASE_ORDER_TARGET_TYPE,
          targetId: String(created.id),
          summary: `発注 ${number} を作成しました（仕入先 ${supplier.partner.code}「${supplier.partner.name}」・明細 ${data.lines.length} 行・合計 ${formatNumber(amounts.total)} 円）`,
        },
      });
      return { ok: true, data: { id: created.id, number } };
    },
    { timeout: TX_TIMEOUT_MS },
  );
}

interface ChangeSnapshot {
  supplier: { id: number; code: string };
  expectedDate: Date | null;
  note: string | null;
  lines: readonly { productId: number; quantity: number; unitPrice: number }[];
  total: number;
}

function sameLines(
  a: ChangeSnapshot["lines"],
  b: ChangeSnapshot["lines"],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (line, i) =>
        line.productId === b[i].productId &&
        line.quantity === b[i].quantity &&
        line.unitPrice === b[i].unitPrice,
    )
  );
}

/** 変更点の説明（操作履歴の summary 用）。変更がなければ空配列 */
export function describePurchaseOrderChanges(
  before: ChangeSnapshot,
  after: ChangeSnapshot,
): string[] {
  const changes: string[] = [];
  if (before.supplier.id !== after.supplier.id) {
    changes.push(`仕入先: ${before.supplier.code} → ${after.supplier.code}`);
  }
  const date = (d: Date | null) => (d ? formatDateOnly(d) : "（なし）");
  if (date(before.expectedDate) !== date(after.expectedDate)) {
    changes.push(
      `入荷予定日: ${date(before.expectedDate)} → ${date(after.expectedDate)}`,
    );
  }
  if ((before.note ?? "") !== (after.note ?? "")) changes.push("備考を変更");
  if (!sameLines(before.lines, after.lines)) {
    changes.push(`明細: ${before.lines.length} 行 → ${after.lines.length} 行`);
  }
  if (before.total !== after.total) {
    changes.push(
      `合計: ${formatNumber(before.total)} → ${formatNumber(after.total)} 円`,
    );
  }
  return changes;
}

/** 発注の行を FOR NO KEY UPDATE でロックする（存在すれば true） */
async function lockPurchaseOrder(
  tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0],
  id: number,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: number }[]>`
    SELECT "id" FROM "purchase_order" WHERE "id" = ${id} FOR NO KEY UPDATE`;
  return rows.length > 0;
}

/**
 * 発注を編集する（draft のときだけ）。expectedUpdatedAt は画面を開いた時点の updatedAt（ISO 8601）で、
 * 保存の時点で変わっていれば保存しない（競合）
 */
export async function updatePurchaseOrder(
  db: PrismaClient,
  user: SessionUser | null,
  id: number,
  input: unknown,
  expectedUpdatedAt: unknown,
): Promise<PurchaseOrderMutationResult> {
  const auth = checkRole(user, "order:edit");
  if (!auth.ok) return auth;
  const parsed = validate(input);
  if (!parsed.ok) return parsed;
  const { data, amounts } = parsed;
  if (!isValidDbId(id)) return NOT_FOUND;
  const expected = parseExpectedUpdatedAt(expectedUpdatedAt);
  if (!expected) return { ok: false, error: CONFLICT_MESSAGE, conflict: true };

  return db.$transaction(
    async (tx): Promise<PurchaseOrderMutationResult> => {
      if (!(await lockPurchaseOrder(tx, id))) return NOT_FOUND;
      const before = await tx.purchaseOrder.findUniqueOrThrow({
        where: { id },
        include: {
          supplier: { select: { id: true, code: true } },
          lines: { orderBy: { id: "asc" } },
        },
      });
      if (!isPurchaseOrderEditable(before.status)) {
        return {
          ok: false,
          error: `この発注は「${PURCHASE_ORDER_STATUS_LABELS[before.status]}」のため編集できません（編集できるのは下書きだけです）`,
        };
      }
      if (!isSameVersion(before.updatedAt, expected)) {
        return { ok: false, error: CONFLICT_MESSAGE, conflict: true };
      }
      const dateError = checkExpectedDate(before.orderDate, data.expectedDate);
      if (dateError) return fieldError("expectedDate", dateError);

      const supplier = await lockPartnerForRole(
        tx,
        data.supplierId,
        "supplier",
      );
      if (!supplier.ok) return fieldError("supplierId", supplier.message);
      const products = await lockProductsForLines(
        tx,
        data.lines.map((l) => l.productId),
      );
      // もとから明細にあった商品は、その後に無効になっていても残せる（新しく選ぶ商品だけ有効を求める）
      const lineErrors = checkLineProducts(
        data.lines,
        products,
        new Set(before.lines.map((l) => l.productId)),
      );
      if (lineErrors) {
        return {
          ok: false,
          error: INVALID_INPUT_MESSAGE,
          fieldErrors: lineErrors,
        };
      }

      const changes = describePurchaseOrderChanges(
        {
          supplier: before.supplier,
          expectedDate: before.expectedDate,
          note: before.note,
          lines: before.lines,
          total: before.total,
        },
        {
          supplier: { id: supplier.partner.id, code: supplier.partner.code },
          expectedDate: data.expectedDate,
          note: data.note,
          lines: data.lines,
          total: amounts.total,
        },
      );
      // 変更がなければ何もしない（操作履歴も残さない）
      if (changes.length === 0) return { ok: true, data: null };

      await tx.purchaseOrderLine.deleteMany({ where: { purchaseOrderId: id } });
      await tx.purchaseOrder.update({
        where: { id },
        data: {
          supplierId: data.supplierId,
          expectedDate: data.expectedDate,
          note: data.note,
          ...amounts,
          lines: { createMany: { data: lineData(data.lines) } },
        },
      });
      await tx.auditLog.create({
        data: {
          userId: auth.user.id,
          action: "update",
          targetType: PURCHASE_ORDER_TARGET_TYPE,
          targetId: String(id),
          summary: `発注 ${before.number} を更新しました（${changes.join("、")}）`,
        },
      });
      return { ok: true, data: null };
    },
    { timeout: TX_TIMEOUT_MS },
  );
}

export interface StatusChangeResult {
  number: string;
  from: PurchaseOrderStatus;
  to: PurchaseOrderStatus;
  /** 入荷で記録した入庫の件数（入荷以外は 0） */
  receivedLines: number;
}

function statusSummary(
  number: string,
  from: PurchaseOrderStatus,
  to: PurchaseOrderStatus,
): string {
  return `発注 ${number} のステータスを「${PURCHASE_ORDER_STATUS_LABELS[from]}」から「${PURCHASE_ORDER_STATUS_LABELS[to]}」に変更しました`;
}

/**
 * ステータスを変更する（spec §4）。to は ordered／received／cancelled。
 * received では全明細の入庫（in）を同じトランザクションで記録する。
 * expectedUpdatedAt は詳細画面に表示した時点の updatedAt（ISO 8601）。変わっていれば変更しない（競合。
 * 他の人が編集した、見ていない明細のまま発注済にしないため）。遷移できない状態なら、競合より先にその理由を返す
 */
export async function changePurchaseOrderStatus(
  db: PrismaClient,
  user: SessionUser | null,
  id: number,
  to: unknown,
  expectedUpdatedAt: unknown,
): Promise<PurchaseOrderMutationResult<StatusChangeResult>> {
  const auth = checkRole(user, "order:edit");
  if (!auth.ok) return auth;
  if (!isPurchaseOrderStatus(to) || to === "draft") {
    return { ok: false, error: "変更先のステータスが正しくありません" };
  }
  if (!isValidDbId(id)) return NOT_FOUND;
  const expected = parseExpectedUpdatedAt(expectedUpdatedAt);
  if (!expected) {
    return { ok: false, error: STATUS_CONFLICT_MESSAGE, conflict: true };
  }
  if (to === "received") {
    return receivePurchaseOrder(db, auth.user, id, expected);
  }

  return db.$transaction(
    async (tx): Promise<PurchaseOrderMutationResult<StatusChangeResult>> => {
      if (!(await lockPurchaseOrder(tx, id))) return NOT_FOUND;
      const order = await tx.purchaseOrder.findUniqueOrThrow({
        where: { id },
        select: {
          number: true,
          status: true,
          updatedAt: true,
          _count: { select: { lines: true } },
        },
      });
      const check = checkPurchaseOrderTransition(
        order.status,
        to,
        order._count.lines,
      );
      if (!check.ok) return { ok: false, error: check.message };
      if (!isSameVersion(order.updatedAt, expected)) {
        return { ok: false, error: STATUS_CONFLICT_MESSAGE, conflict: true };
      }
      await tx.purchaseOrder.update({ where: { id }, data: { status: to } });
      await tx.auditLog.create({
        data: {
          userId: auth.user.id,
          action: PURCHASE_ORDER_STATUS_ACTION,
          targetType: PURCHASE_ORDER_TARGET_TYPE,
          targetId: String(id),
          summary: statusSummary(order.number, order.status, to),
        },
      });
      return {
        ok: true,
        data: {
          number: order.number,
          from: order.status,
          to,
          receivedLines: 0,
        },
      };
    },
    { timeout: TX_TIMEOUT_MS },
  );
}

/** 入荷（ordered → received）。全明細を入庫として記録する */
async function receivePurchaseOrder(
  db: PrismaClient,
  user: SessionUser,
  id: number,
  expected: Date,
): Promise<PurchaseOrderMutationResult<StatusChangeResult>> {
  return withStockTransaction(
    db,
    async (tx): Promise<PurchaseOrderMutationResult<StatusChangeResult>> => {
      // 条件付き更新で二重入荷を防ぐ（同時に実行された 2 本目は、1 本目の確定後に WHERE を評価し直して 0 件になる）。
      // 画面に表示した時点の updatedAt も条件に入れる（他の人の変更の後なら 0 件 → 競合）
      const updated = await tx.purchaseOrder.updateMany({
        where: { id, status: "ordered", updatedAt: expected },
        data: { status: "received" },
      });
      if (updated.count === 0) {
        const current = await tx.purchaseOrder.findUnique({
          where: { id },
          select: {
            status: true,
            updatedAt: true,
            _count: { select: { lines: true } },
          },
        });
        if (!current) return NOT_FOUND;
        const check = checkPurchaseOrderTransition(
          current.status,
          "received",
          current._count.lines,
        );
        if (!check.ok) return { ok: false, error: check.message };
        return { ok: false, error: STATUS_CONFLICT_MESSAGE, conflict: true };
      }
      const order = await tx.purchaseOrder.findUniqueOrThrow({
        where: { id },
        select: {
          number: true,
          lines: {
            orderBy: { id: "asc" },
            select: { productId: true, quantity: true },
          },
        },
      });
      if (order.lines.length === 0) {
        // ordered には明細が 1 行以上ある（発注済にするときに検査している）。ここに来たらデータの誤り
        throw new Error(`発注 ${order.number} に明細がありません`);
      }
      // 全明細を一度に渡す（商品のロックは id の順にまとめて取られる）
      await recordStockMovements(
        tx,
        user.id,
        order.lines.map((line) => ({
          productId: line.productId,
          type: "in" as const,
          quantity: line.quantity,
          reason: `発注 ${order.number} の入荷`,
          refType: "purchase_order" as const,
          refId: id,
        })),
      );
      await tx.auditLog.create({
        data: {
          userId: user.id,
          action: PURCHASE_ORDER_STATUS_ACTION,
          targetType: PURCHASE_ORDER_TARGET_TYPE,
          targetId: String(id),
          summary: `${statusSummary(order.number, "ordered", "received")}（入庫 ${order.lines.length} 品目）`,
        },
      });
      return {
        ok: true,
        data: {
          number: order.number,
          from: "ordered",
          to: "received",
          receivedLines: order.lines.length,
        },
      };
    },
    { timeout: TX_TIMEOUT_MS },
  );
}
