/**
 * REST API の受注の登録（POST /api/v1/sales-orders）。サーバー専用。
 *
 * 本文（顧客コード・商品コード・数量・納期・備考）を salesOrderCreateSchema で検査し、コードを ID に解決してから、
 * 画面と同じ受注の service（createSalesOrder）で作成する。検証（顧客の種別・有効、商品の有効・重複、数量、納期、
 * 合計の上限）・ロック・採番・金額の計算・操作履歴は service が画面と同じ規則で行う。単価は商品マスタの売価。
 *
 * コードの解決はトランザクションの外で行う（存在の確認と売価の読み取りだけ）。種別・有効は service がトランザクションの
 * 中で行をロックしてから検査し直すので、その間に無効化されても作成されない。売価だけは読み取りから作成までの間の変更が
 * 反映されない（リクエストを受けた時点の売価になる）
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { authErrorMessage, type SessionUser } from "@/lib/auth/session";
import {
  getSalesOrder,
  type SalesOrderDetail,
} from "@/lib/sales-orders/queries";
import { createSalesOrder } from "@/lib/sales-orders/service";

import { forbiddenProblem } from "./auth";
import { problem, validationProblem } from "./responses";
import { toJsonPointer, zodFieldErrors } from "./request";
import {
  salesOrderCreateSchema,
  type ProblemFieldError,
  type SalesOrderCreateBody,
} from "./schemas";

export type CreateResult =
  { ok: true; order: SalesOrderDetail } | { ok: false; response: Response };

/** service の項目のキー（customerId・lines.0.productId など）を本文の JSON Pointer にする */
export function servicePointer(key: string): string {
  const path = key === "_form" ? [] : key.split(".");
  if (path[0] === "customerId") path[0] = "customerCode";
  // 明細の商品（unitPrice は商品マスタの売価から決まるので、商品の誤りとして示す）
  if (
    path[0] === "lines" &&
    (path[2] === "productId" || path[2] === "unitPrice")
  ) {
    path[2] = "productCode";
  }
  return toJsonPointer(path);
}

async function resolveCodes(
  db: PrismaClient,
  body: SalesOrderCreateBody,
): Promise<
  | {
      ok: true;
      customerId: number;
      lines: { productId: number; quantity: number; unitPrice: number }[];
    }
  | { ok: false; errors: ProblemFieldError[] }
> {
  const customerCode = body.customerCode.trim().toUpperCase();
  const productCodes = body.lines.map((l) =>
    l.productCode.trim().toUpperCase(),
  );
  const [customer, products] = await Promise.all([
    db.partner.findUnique({
      where: { code: customerCode },
      select: { id: true },
    }),
    db.product.findMany({
      where: { code: { in: [...new Set(productCodes)] } },
      select: { id: true, code: true, salesPrice: true },
    }),
  ]);
  const errors: ProblemFieldError[] = [];
  if (!customer) {
    errors.push({
      pointer: "#/customerCode",
      detail: `顧客「${customerCode}」が見つかりません`,
    });
  }
  const byCode = new Map(products.map((p) => [p.code, p]));
  const lines = body.lines.flatMap((line, index) => {
    const product = byCode.get(productCodes[index]);
    if (!product) {
      errors.push({
        pointer: toJsonPointer(["lines", index, "productCode"]),
        detail: `商品「${productCodes[index]}」が見つかりません`,
      });
      return [];
    }
    return [
      {
        productId: product.id,
        quantity: line.quantity,
        unitPrice: product.salesPrice,
      },
    ];
  });
  if (errors.length > 0 || !customer) return { ok: false, errors };
  return { ok: true, customerId: customer.id, lines };
}

/** 受注を登録する（本文の検証 → コードの解決 → service で作成） */
export async function createSalesOrderFromApi(
  db: PrismaClient,
  user: SessionUser,
  tokenId: number,
  input: unknown,
): Promise<CreateResult> {
  const parsed = salesOrderCreateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      response: validationProblem(zodFieldErrors(parsed.error, input)),
    };
  }
  const resolved = await resolveCodes(db, parsed.data);
  if (!resolved.ok) {
    return { ok: false, response: validationProblem(resolved.errors) };
  }

  const result = await createSalesOrder(
    db,
    user,
    {
      customerId: resolved.customerId,
      dueDate: parsed.data.dueDate ?? "",
      note: parsed.data.note ?? "",
      lines: resolved.lines,
    },
    new Date(),
    { apiTokenId: tokenId },
  );
  if (!result.ok) {
    if (result.fieldErrors) {
      return {
        ok: false,
        response: validationProblem(
          Object.entries(result.fieldErrors).flatMap(([key, messages]) =>
            messages.map((detail) => ({
              pointer: servicePointer(key),
              detail,
            })),
          ),
        ),
      };
    }
    // 項目に結びつかない失敗は権限（認可の後にロールが変わった）だけ。念のためその他は 400
    return {
      ok: false,
      response:
        result.error === authErrorMessage(403)
          ? forbiddenProblem()
          : problem(400, result.error),
    };
  }
  const order = await getSalesOrder(db, result.data.id);
  if (!order)
    throw new Error(`作成した受注 ${result.data.number} が読めません`);
  return { ok: true, order };
}
