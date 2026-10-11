/**
 * 結合テスト用の DB 接続（DATABASE_URL_TEST）。
 * 接続できないときは、原因と対処が分かるメッセージで失敗させる。
 */
import "dotenv/config";

import type { PrismaClient } from "@/generated/prisma/client";
import { createPrismaClient } from "@/lib/db";

import { checkTestDbTarget, formatDbTarget } from "../../scripts/db-guard";

const SETUP_HINT =
  "docker compose up -d で PostgreSQL を起動し、pnpm db:test:reset でマイグレーションとシードを適用してください";

export async function connectTestDb(): Promise<PrismaClient> {
  const url = process.env.DATABASE_URL_TEST;
  // 開発用 DB などに誤って接続しないよう、with-test-db.ts と同じ判定を通す
  const guard = checkTestDbTarget(url, process.env.DATABASE_URL);
  if (!guard.ok) {
    throw new Error(`結合テストを中止しました: ${guard.reason}`);
  }
  const target = formatDbTarget(guard.target);
  const prisma = createPrismaClient(url!);
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    await prisma.$disconnect();
    const code = (error as { code?: unknown }).code;
    const reason = `${code ? `[${String(code)}] ` : ""}${error instanceof Error ? error.message.trim() : String(error)}`;
    throw new Error(
      `テスト用 DB（${target}）に接続できません。${SETUP_HINT}。\n原因: ${reason}`,
      { cause: error },
    );
  }
  return prisma;
}

export { SETUP_HINT };
