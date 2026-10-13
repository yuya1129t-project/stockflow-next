/**
 * 取引先の読み取り（一覧・詳細・次のコードの提案）。サーバー側でだけ使う
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";

import {
  nextPartnerCode,
  PARTNER_CODE_PREFIXES,
  PARTNER_KINDS,
  partnerKindsFor,
  type PartnerKind,
} from "./schema";
import { PARTNERS_PER_PAGE, type PartnerListParams } from "./search-params";

export interface PartnerListItem {
  id: number;
  code: string;
  name: string;
  kind: PartnerKind;
  postalCode: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  isActive: boolean;
}

export interface PartnerListResult {
  items: PartnerListItem[];
  total: number;
  /** 実際に表示したページ（範囲外を指定されたら最終ページに丸める） */
  page: number;
  totalPages: number;
  perPage: number;
}

const SELECT = {
  id: true,
  code: true,
  name: true,
  kind: true,
  postalCode: true,
  address: true,
  phone: true,
  email: true,
  isActive: true,
} as const satisfies Prisma.PartnerSelect;

/**
 * LIKE の特殊文字（% _ \）をエスケープする。
 * Prisma の contains は % _ をワイルドカードのまま渡すため、文字として検索するにはここで外す
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * 一覧の種別の絞り込み: 「顧客」は customer と both、「仕入先」は supplier と both（spec §3 の顧客・仕入先の定義）。
 * 「顧客・仕入先」は both だけ
 */
export function kindFilter(kind: PartnerKind): PartnerKind[] {
  return kind === "both" ? ["both"] : partnerKindsFor(kind);
}

function where({
  q,
  kind,
  status,
}: Pick<PartnerListParams, "q" | "kind" | "status">): Prisma.PartnerWhereInput {
  const conditions: Prisma.PartnerWhereInput[] = [];
  if (q) {
    const contains = escapeLike(q);
    conditions.push({
      OR: [
        { code: { contains, mode: "insensitive" } },
        { name: { contains, mode: "insensitive" } },
      ],
    });
  }
  if (kind) conditions.push({ kind: { in: kindFilter(kind) } });
  if (status === "active") conditions.push({ isActive: true });
  if (status === "inactive") conditions.push({ isActive: false });
  return { AND: conditions };
}

/** 一覧（検索・絞り込み・並べ替え・ページ送り） */
export async function listPartners(
  db: PrismaClient,
  params: PartnerListParams,
): Promise<PartnerListResult> {
  const filter = where(params);
  const total = await db.partner.count({ where: filter });
  const perPage = PARTNERS_PER_PAGE;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(params.page, totalPages);
  // 並べ替えの列は PARTNER_SORT_KEYS（ホワイトリスト）。同じ値の行の順番が変わらないよう最後にコードで並べる
  const orderBy: Prisma.PartnerOrderByWithRelationInput[] =
    params.sort === "code"
      ? [{ code: params.order }]
      : [{ [params.sort]: params.order }, { code: "asc" }];
  const items = await db.partner.findMany({
    where: filter,
    select: SELECT,
    orderBy,
    skip: (page - 1) * perPage,
    take: perPage,
  });
  return { items, total, page, totalPages, perPage };
}

/** 詳細。無ければ null */
export async function getPartner(
  db: PrismaClient,
  id: number,
): Promise<PartnerListItem | null> {
  return db.partner.findUnique({ where: { id }, select: SELECT });
}

/** 登録画面で提案する次のコード（種別ごと。例 C-0013） */
export async function suggestPartnerCodes(
  db: PrismaClient,
): Promise<Record<PartnerKind, string>> {
  const rows = await db.partner.findMany({
    where: {
      OR: PARTNER_KINDS.map((kind) => ({
        code: { startsWith: PARTNER_CODE_PREFIXES[kind] },
      })),
    },
    select: { code: true },
  });
  const codes = rows.map((r) => r.code);
  return Object.fromEntries(
    PARTNER_KINDS.map((kind) => [kind, nextPartnerCode(kind, codes)]),
  ) as Record<PartnerKind, string>;
}
