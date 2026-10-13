/**
 * 受注の更新系（作成・編集・ステータス変更・出荷）。サーバー側でだけ使う。docs/spec.md §2〜§4
 *
 * - 権限は Server Action（checkActionPermission）で検査したうえで、ここでも操作したユーザーのロールを検査する
 * - 入力は必ずここで Zod スキーマ（画面と共通）で検証する。金額は明細から計算する（画面から送られた合計は使わない）
 * - 伝票・明細・入出庫・操作履歴（AuditLog）は同じトランザクションで書く
 *
 * 同時実行（発注 src/lib/purchase-orders/service.ts と同じ作り）:
 * - 作成・編集: 顧客の行と明細の商品の行を FOR SHARE でロックしてから種別・有効を検査する（src/lib/orders/locks.ts）
 * - 編集・ステータス変更（出荷以外）: 受注の行を FOR NO KEY UPDATE でロックしてから状態を読む。
 *   画面を開いた時点の updatedAt と比べ、変わっていれば保存・変更しない（他の人の更新を上書きしない）
 * - 出荷: withStockTransaction の中で `updateMany({ where: { id, status: "confirmed", updatedAt } })` の件数を見てから
 *   全明細の出庫を一度に記録する。同時に 2 回出荷しても、2 本目は 1 本目の確定を待ってから WHERE を評価し直して
 *   0 件になるので、二重に出庫しない。在庫が 1 行でも足りなければ InsufficientStockError でトランザクションごと
 *   取り消し（状態も confirmed のまま）、不足する商品と数量を返す。
 *   出荷のトランザクションでは lockProductsForLines（FOR SHARE）を使わない（ロックの引き上げでデッドロックするため。
 *   商品のロックは recordStockMovements が id の順に FOR NO KEY UPDATE で取る）
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
  isValidDbId,
  orderFieldErrors,
  type OrderFieldErrors,
  type OrderLineInput,
} from "@/lib/orders/schema";
import {
  conflictMessage,
  isSameVersion,
  parseExpectedUpdatedAt,
} from "@/lib/orders/versions";
import {
  recordStockMovements,
  withStockTransaction,
} from "@/lib/stock/movements";
import {
  InsufficientStockError,
  type ReorderPointCrossing,
  type StockShortage,
} from "@/lib/stock/rules";

import {
  checkDueDate,
  salesOrderInputSchema,
  type SalesOrderInput,
} from "./schema";
import { shortageMessage } from "./shortages";
import {
  checkSalesOrderTransition,
  isSalesOrderEditable,
  isSalesOrderStatus,
  SALES_ORDER_STATUS_LABELS,
  type SalesOrderStatus,
} from "./status";

export type SalesOrderMutationError = {
  ok: false;
  error: string;
  fieldErrors?: OrderFieldErrors;
  /** 編集・ステータス変更の競合（画面を開いた後に他の人が更新した） */
  conflict?: true;
  /** 出荷で在庫が足りなかった商品（出荷は行っていない） */
  shortages?: StockShortage[];
};
export type SalesOrderMutationResult<T = null> =
  { ok: true; data: T } | SalesOrderMutationError;

/** 操作履歴の targetType */
export const SALES_ORDER_TARGET_TYPE = "sales_order";
/** 操作履歴の action（ステータス変更。出荷を含む） */
export const SALES_ORDER_STATUS_ACTION = "status_change";

const INVALID_INPUT_MESSAGE =
  "入力内容に誤りがあります。各項目を確認してください";
const NOT_FOUND: SalesOrderMutationError = {
  ok: false,
  error: "受注が見つかりません",
};
export const CONFLICT_MESSAGE = conflictMessage("受注", "保存していません");
export const STATUS_CONFLICT_MESSAGE = conflictMessage(
  "受注",
  "ステータスは変更していません",
);

/**
 * トランザクションの timeout（作成・編集・ステータス変更・出荷で共通）。顧客・商品・受注の行のロック待ちを含む
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
  data: SalesOrderInput;
  amounts: OrderAmounts;
};

function validate(input: unknown): Validated | SalesOrderMutationError {
  const parsed = salesOrderInputSchema.safeParse(input);
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

function fieldError(field: string, message: string): SalesOrderMutationError {
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
 * 受注を作成する（draft）。受注日は作成した日（Asia/Tokyo）で、番号は SO-受注日-連番
 */
export async function createSalesOrder(
  db: PrismaClient,
  user: SessionUser | null,
  input: unknown,
  now: Date = new Date(),
): Promise<SalesOrderMutationResult<{ id: number; number: string }>> {
  const auth = checkRole(user, "order:edit");
  if (!auth.ok) return auth;
  const parsed = validate(input);
  if (!parsed.ok) return parsed;
  const { data, amounts } = parsed;
  const orderDateText = todayInTokyo(now);
  const orderDate = parseDateOnly(orderDateText)!;
  const dateError = checkDueDate(orderDate, data.dueDate);
  if (dateError) return fieldError("dueDate", dateError);

  return db.$transaction(
    async (
      tx,
    ): Promise<SalesOrderMutationResult<{ id: number; number: string }>> => {
      const customer = await lockPartnerForRole(
        tx,
        data.customerId,
        "customer",
      );
      if (!customer.ok) return fieldError("customerId", customer.message);
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
      const number = await nextDocumentNumber(tx, "SO", orderDateText);
      const created = await tx.salesOrder.create({
        data: {
          number,
          customerId: data.customerId,
          orderDate,
          dueDate: data.dueDate,
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
          targetType: SALES_ORDER_TARGET_TYPE,
          targetId: String(created.id),
          summary: `受注 ${number} を作成しました（顧客 ${customer.partner.code}「${customer.partner.name}」・明細 ${data.lines.length} 行・合計 ${formatNumber(amounts.total)} 円）`,
        },
      });
      return { ok: true, data: { id: created.id, number } };
    },
    { timeout: TX_TIMEOUT_MS },
  );
}

interface ChangeSnapshot {
  customer: { id: number; code: string };
  dueDate: Date | null;
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
export function describeSalesOrderChanges(
  before: ChangeSnapshot,
  after: ChangeSnapshot,
): string[] {
  const changes: string[] = [];
  if (before.customer.id !== after.customer.id) {
    changes.push(`顧客: ${before.customer.code} → ${after.customer.code}`);
  }
  const date = (d: Date | null) => (d ? formatDateOnly(d) : "（なし）");
  if (date(before.dueDate) !== date(after.dueDate)) {
    changes.push(`納期: ${date(before.dueDate)} → ${date(after.dueDate)}`);
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

/** 受注の行を FOR NO KEY UPDATE でロックする（存在すれば true） */
async function lockSalesOrder(
  tx: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0],
  id: number,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: number }[]>`
    SELECT "id" FROM "sales_order" WHERE "id" = ${id} FOR NO KEY UPDATE`;
  return rows.length > 0;
}

/**
 * 受注を編集する（draft のときだけ）。expectedUpdatedAt は画面を開いた時点の updatedAt（ISO 8601）で、
 * 保存の時点で変わっていれば保存しない（競合）
 */
export async function updateSalesOrder(
  db: PrismaClient,
  user: SessionUser | null,
  id: number,
  input: unknown,
  expectedUpdatedAt: unknown,
): Promise<SalesOrderMutationResult> {
  const auth = checkRole(user, "order:edit");
  if (!auth.ok) return auth;
  const parsed = validate(input);
  if (!parsed.ok) return parsed;
  const { data, amounts } = parsed;
  if (!isValidDbId(id)) return NOT_FOUND;
  const expected = parseExpectedUpdatedAt(expectedUpdatedAt);
  if (!expected) return { ok: false, error: CONFLICT_MESSAGE, conflict: true };

  return db.$transaction(
    async (tx): Promise<SalesOrderMutationResult> => {
      if (!(await lockSalesOrder(tx, id))) return NOT_FOUND;
      const before = await tx.salesOrder.findUniqueOrThrow({
        where: { id },
        include: {
          customer: { select: { id: true, code: true } },
          lines: { orderBy: { id: "asc" } },
        },
      });
      if (!isSalesOrderEditable(before.status)) {
        return {
          ok: false,
          error: `この受注は「${SALES_ORDER_STATUS_LABELS[before.status]}」のため編集できません（編集できるのは下書きだけです）`,
        };
      }
      if (!isSameVersion(before.updatedAt, expected)) {
        return { ok: false, error: CONFLICT_MESSAGE, conflict: true };
      }
      const dateError = checkDueDate(before.orderDate, data.dueDate);
      if (dateError) return fieldError("dueDate", dateError);

      const customer = await lockPartnerForRole(
        tx,
        data.customerId,
        "customer",
      );
      if (!customer.ok) return fieldError("customerId", customer.message);
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

      const changes = describeSalesOrderChanges(
        {
          customer: before.customer,
          dueDate: before.dueDate,
          note: before.note,
          lines: before.lines,
          total: before.total,
        },
        {
          customer: { id: customer.partner.id, code: customer.partner.code },
          dueDate: data.dueDate,
          note: data.note,
          lines: data.lines,
          total: amounts.total,
        },
      );
      // 変更がなければ何もしない（操作履歴も残さない）
      if (changes.length === 0) return { ok: true, data: null };

      await tx.salesOrderLine.deleteMany({ where: { salesOrderId: id } });
      await tx.salesOrder.update({
        where: { id },
        data: {
          customerId: data.customerId,
          dueDate: data.dueDate,
          note: data.note,
          ...amounts,
          lines: { createMany: { data: lineData(data.lines) } },
        },
      });
      await tx.auditLog.create({
        data: {
          userId: auth.user.id,
          action: "update",
          targetType: SALES_ORDER_TARGET_TYPE,
          targetId: String(id),
          summary: `受注 ${before.number} を更新しました（${changes.join("、")}）`,
        },
      });
      return { ok: true, data: null };
    },
    { timeout: TX_TIMEOUT_MS },
  );
}

export interface StatusChangeResult {
  number: string;
  from: SalesOrderStatus;
  to: SalesOrderStatus;
  /** 出荷で記録した出庫の件数（出荷以外は 0） */
  shippedLines: number;
  /**
   * 出荷で「発注点以上 → 発注点未満」に変わった有効な商品（出荷以外は空配列）。
   * 発注点割れの通知（#12）は、トランザクション確定後に呼び出し側でこれを使って送る
   */
  fellBelowReorderPoint: ReorderPointCrossing[];
}

function statusSummary(
  number: string,
  from: SalesOrderStatus,
  to: SalesOrderStatus,
): string {
  return `受注 ${number} のステータスを「${SALES_ORDER_STATUS_LABELS[from]}」から「${SALES_ORDER_STATUS_LABELS[to]}」に変更しました`;
}

/**
 * ステータスを変更する（spec §4）。to は confirmed／shipped／cancelled。
 * shipped では全明細の出庫（out）を同じトランザクションで記録する（1 行でも在庫が足りなければ全体を中止し、
 * shortages に不足する商品と数量を返す）。
 * expectedUpdatedAt は詳細画面に表示した時点の updatedAt（ISO 8601）。変わっていれば変更しない（競合。
 * 他の人が編集した、見ていない明細のまま確定・出荷しないため）。遷移できない状態なら、競合より先にその理由を返す
 */
export async function changeSalesOrderStatus(
  db: PrismaClient,
  user: SessionUser | null,
  id: number,
  to: unknown,
  expectedUpdatedAt: unknown,
): Promise<SalesOrderMutationResult<StatusChangeResult>> {
  const auth = checkRole(user, "order:edit");
  if (!auth.ok) return auth;
  if (!isSalesOrderStatus(to) || to === "draft") {
    return { ok: false, error: "変更先のステータスが正しくありません" };
  }
  if (!isValidDbId(id)) return NOT_FOUND;
  const expected = parseExpectedUpdatedAt(expectedUpdatedAt);
  if (!expected) {
    return { ok: false, error: STATUS_CONFLICT_MESSAGE, conflict: true };
  }
  if (to === "shipped") {
    return shipSalesOrder(db, auth.user, id, expected);
  }

  return db.$transaction(
    async (tx): Promise<SalesOrderMutationResult<StatusChangeResult>> => {
      if (!(await lockSalesOrder(tx, id))) return NOT_FOUND;
      const order = await tx.salesOrder.findUniqueOrThrow({
        where: { id },
        select: {
          number: true,
          status: true,
          updatedAt: true,
          _count: { select: { lines: true } },
        },
      });
      const check = checkSalesOrderTransition(
        order.status,
        to,
        order._count.lines,
      );
      if (!check.ok) return { ok: false, error: check.message };
      if (!isSameVersion(order.updatedAt, expected)) {
        return { ok: false, error: STATUS_CONFLICT_MESSAGE, conflict: true };
      }
      await tx.salesOrder.update({ where: { id }, data: { status: to } });
      await tx.auditLog.create({
        data: {
          userId: auth.user.id,
          action: SALES_ORDER_STATUS_ACTION,
          targetType: SALES_ORDER_TARGET_TYPE,
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
          shippedLines: 0,
          fellBelowReorderPoint: [],
        },
      };
    },
    { timeout: TX_TIMEOUT_MS },
  );
}

/**
 * 出荷（confirmed → shipped）。全明細を出庫として一度に記録する。
 * 在庫が足りない商品があれば何も書かずに（状態も confirmed のまま）不足する商品と数量を返す
 */
async function shipSalesOrder(
  db: PrismaClient,
  user: SessionUser,
  id: number,
  expected: Date,
): Promise<SalesOrderMutationResult<StatusChangeResult>> {
  try {
    return await withStockTransaction(
      db,
      async (tx): Promise<SalesOrderMutationResult<StatusChangeResult>> => {
        // 条件付き更新で二重出荷を防ぐ（同時に実行された 2 本目は、1 本目の確定後に WHERE を評価し直して 0 件になる）。
        // 画面に表示した時点の updatedAt も条件に入れる（他の人の変更の後なら 0 件 → 競合）
        const updated = await tx.salesOrder.updateMany({
          where: { id, status: "confirmed", updatedAt: expected },
          data: { status: "shipped" },
        });
        if (updated.count === 0) {
          const current = await tx.salesOrder.findUnique({
            where: { id },
            select: {
              status: true,
              _count: { select: { lines: true } },
            },
          });
          if (!current) return NOT_FOUND;
          const check = checkSalesOrderTransition(
            current.status,
            "shipped",
            current._count.lines,
          );
          if (!check.ok) return { ok: false, error: check.message };
          return { ok: false, error: STATUS_CONFLICT_MESSAGE, conflict: true };
        }
        const order = await tx.salesOrder.findUniqueOrThrow({
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
          // confirmed には明細が 1 行以上ある（確定にするときに検査している）。ここに来たらデータの誤り
          throw new Error(`受注 ${order.number} に明細がありません`);
        }
        // 全明細を一度に渡す（商品のロックは id の順にまとめて取られる）。1 行でも在庫が足りなければ
        // InsufficientStockError が投げられ、上の状態の更新も含めてトランザクションごと取り消される
        const recorded = await recordStockMovements(
          tx,
          user.id,
          order.lines.map((line) => ({
            productId: line.productId,
            type: "out" as const,
            quantity: -line.quantity,
            reason: `受注 ${order.number} の出荷`,
            refType: "sales_order" as const,
            refId: id,
          })),
        );
        await tx.auditLog.create({
          data: {
            userId: user.id,
            action: SALES_ORDER_STATUS_ACTION,
            targetType: SALES_ORDER_TARGET_TYPE,
            targetId: String(id),
            summary: `${statusSummary(order.number, "confirmed", "shipped")}（出庫 ${order.lines.length} 品目）`,
          },
        });
        return {
          ok: true,
          data: {
            number: order.number,
            from: "confirmed",
            to: "shipped",
            shippedLines: order.lines.length,
            fellBelowReorderPoint: recorded.fellBelowReorderPoint,
          },
        };
      },
      { timeout: TX_TIMEOUT_MS },
    );
  } catch (error) {
    if (error instanceof InsufficientStockError) {
      return {
        ok: false,
        error: shortageMessage(error.shortages),
        shortages: error.shortages,
      };
    }
    throw error;
  }
}
