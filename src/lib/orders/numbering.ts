/**
 * 伝票番号の採番（受注 SO-YYYYMMDD-NNN／発注 PO-YYYYMMDD-NNN）。spec §3
 *
 * - 番号の日付は伝票の日付（受注日・発注日。作成した日の Asia/Tokyo の日付）。NNN はその日の 001 からの連番
 * - 連番は document_sequence（kind＋date ごとに最後の番号）を
 *   `INSERT … ON CONFLICT (kind, date) DO UPDATE SET "lastNumber" = "lastNumber" + 1 RETURNING` の 1 文で進める。
 *   同じ日の 2 本目以降は行ロックで順番待ちになるので、同時に作成しても番号は重複しない
 * - 伝票の INSERT と同じトランザクションで呼ぶ（作成が失敗すれば番号も戻る。欠番を作らない）
 * - 1 日に 999 件を超えたら桁を増やす（PO-20261013-1000）。エラーにはしない（業務を止めない）
 */
import type { Prisma } from "@/generated/prisma/client";

export type DocumentKind = "SO" | "PO";

/** 伝票番号の書式（date は "YYYY-MM-DD"、sequence は 1 以上） */
export function formatDocumentNumber(
  kind: DocumentKind,
  date: string,
  sequence: number,
): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new RangeError(`日付は YYYY-MM-DD で指定してください: ${date}`);
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new RangeError(`連番は 1 以上の整数で指定してください: ${sequence}`);
  }
  return `${kind}-${date.replaceAll("-", "")}-${String(sequence).padStart(3, "0")}`;
}

/**
 * 次の伝票番号を採番する（トランザクションの中で呼ぶ）。date は伝票の日付（"YYYY-MM-DD"）
 */
export async function nextDocumentNumber(
  tx: Prisma.TransactionClient,
  kind: DocumentKind,
  date: string,
): Promise<string> {
  const [row] = await tx.$queryRaw<{ lastNumber: number }[]>`
    INSERT INTO "document_sequence" ("kind", "date", "lastNumber")
    VALUES (${kind}::"DocumentKind", ${date}::date, 1)
    ON CONFLICT ("kind", "date")
    DO UPDATE SET "lastNumber" = "document_sequence"."lastNumber" + 1
    RETURNING "lastNumber"`;
  return formatDocumentNumber(kind, date, row.lastNumber);
}
