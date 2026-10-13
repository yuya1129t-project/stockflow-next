/**
 * 操作履歴の一覧（絞り込み・ページ送り）。サーバー側でだけ使う。権限の検査は呼び出し側（画面のガード）で行う
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";

import {
  AUDIT_LOGS_PER_PAGE,
  auditLogDateRange,
  type AuditLogListParams,
} from "./search-params";

export interface AuditLogListItem {
  id: number;
  createdAt: Date;
  action: string;
  targetType: string | null;
  targetId: string | null;
  summary: string;
  user: { id: string; name: string } | null;
}

export interface AuditLogListResult {
  items: AuditLogListItem[];
  total: number;
  /** 範囲外のページを指定されたら最後のページに寄せる */
  page: number;
  perPage: number;
  totalPages: number;
}

function whereOf(params: AuditLogListParams): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = {};
  if (params.userId) where.userId = params.userId;
  if (params.action) where.action = params.action;
  if (params.targetType) where.targetType = params.targetType;
  const range = auditLogDateRange(params.from, params.to);
  if (range.gte || range.lt) where.createdAt = range;
  return where;
}

/** 新しい順の一覧 */
export async function listAuditLogs(
  db: PrismaClient,
  params: AuditLogListParams,
): Promise<AuditLogListResult> {
  const where = whereOf(params);
  const perPage = AUDIT_LOGS_PER_PAGE;
  const total = await db.auditLog.count({ where });
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(params.page, totalPages);
  const items = await db.auditLog.findMany({
    where,
    select: {
      id: true,
      createdAt: true,
      action: true,
      targetType: true,
      targetId: true,
      summary: true,
      user: { select: { id: true, name: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * perPage,
    take: perPage,
  });
  return { items, total, page, perPage, totalPages };
}

/** 絞り込みの選択肢（記録されている操作・対象の種類と、ユーザーの一覧） */
export async function auditLogFilterOptions(db: PrismaClient): Promise<{
  actions: string[];
  targetTypes: string[];
  users: { id: string; name: string; email: string }[];
}> {
  const [actions, targetTypes, users] = await Promise.all([
    db.auditLog.findMany({
      distinct: ["action"],
      select: { action: true },
      orderBy: { action: "asc" },
    }),
    db.auditLog.findMany({
      where: { targetType: { not: null } },
      distinct: ["targetType"],
      select: { targetType: true },
      orderBy: { targetType: "asc" },
    }),
    db.user.findMany({
      select: { id: true, name: true, email: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  ]);
  return {
    actions: actions.map((a) => a.action),
    targetTypes: targetTypes.flatMap((t) =>
      t.targetType ? [t.targetType] : [],
    ),
    users,
  };
}
