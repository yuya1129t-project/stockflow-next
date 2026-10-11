import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";

/** 接続先を指定して Prisma Client を作る（Prisma 7 はドライバーアダプター経由で接続する） */
export function createPrismaClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * アプリで使う Prisma Client（DATABASE_URL に接続）。
 *
 * 開発時はホットリロードのたびに接続プールが増えないよう globalThis に 1 つだけ保持する。
 * 最初に使われたときに作るので、import しただけでは DB に接続しない。
 */
export function getPrisma(): PrismaClient {
  if (!globalForPrisma.prisma) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "環境変数 DATABASE_URL が設定されていません（.env.example を参照）",
      );
    }
    globalForPrisma.prisma = createPrismaClient(url);
  }
  return globalForPrisma.prisma;
}
