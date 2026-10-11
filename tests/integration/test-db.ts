/**
 * 結合テスト用の DB 接続（DATABASE_URL_TEST）。
 * 接続できないときは、原因と対処が分かるメッセージで失敗させる。
 */
import "dotenv/config";

import type { PrismaClient } from "@/generated/prisma/client";
import { createPrismaClient } from "@/lib/db";

const SETUP_HINT =
  "docker compose up -d で PostgreSQL を起動し、pnpm db:test:reset でマイグレーションとシードを適用してください";

export async function connectTestDb(): Promise<PrismaClient> {
  const url = process.env.DATABASE_URL_TEST;
  if (!url) {
    throw new Error(
      "結合テストには環境変数 DATABASE_URL_TEST が必要です（cp .env.example .env で作成できます）",
    );
  }
  const { host, pathname } = new URL(url);
  const prisma = createPrismaClient(url);
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    await prisma.$disconnect();
    const code = (error as { code?: unknown }).code;
    const reason = `${code ? `[${String(code)}] ` : ""}${error instanceof Error ? error.message.trim() : String(error)}`;
    throw new Error(
      `テスト用 DB（${host}${pathname}）に接続できません。${SETUP_HINT}。\n原因: ${reason}`,
      { cause: error },
    );
  }
  return prisma;
}

export { SETUP_HINT };
