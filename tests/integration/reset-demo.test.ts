/**
 * 日次リセット（GET /api/cron/reset-demo）を実 DB（テスト用 DB）で確かめる。
 * リセットはテスト用 DB をシード直後の状態に戻す（pnpm db:test:reset と同じ内容）。
 * 前提: pnpm db:test:reset でテスト用 DB にマイグレーションとシードを適用済み
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { GET } from "@/app/api/cron/reset-demo/route";
import type { PrismaClient } from "@/generated/prisma/client";

import { connectTestDb } from "./test-db";

const SECRET = "integration-cron-secret-0123456789";

let prisma: PrismaClient;

beforeAll(async () => {
  prisma = await connectTestDb();
});

afterAll(async () => {
  await prisma?.$disconnect();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function cronRequest(secret = SECRET) {
  return new Request("http://localhost:3000/api/cron/reset-demo", {
    headers: { authorization: `Bearer ${secret}` },
  });
}

describe("GET /api/cron/reset-demo（実 DB）", () => {
  it("閲覧者が加えた変更・セッション・試行回数のカウンターを消して、シード直後の状態に戻す", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("DATABASE_URL", process.env.DATABASE_URL_TEST!);
    vi.spyOn(console, "info").mockImplementation(() => {});

    // 閲覧者の操作の代わりに、商品の追加・ログイン状態・試行回数を作る
    const admin = await prisma.user.findFirstOrThrow({
      where: { role: "admin" },
    });
    await prisma.product.create({
      data: {
        code: "P-RESET-TEST",
        name: "リセットで消える商品",
        category: "テスト",
        unit: "個",
        salesPrice: 100,
        purchasePrice: 50,
        reorderPoint: 0,
      },
    });
    await prisma.session.create({
      data: {
        id: "reset-test-session",
        token: "reset-test-token",
        userId: admin.id,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.rateLimit.create({
      data: {
        id: "reset-test-rate-limit",
        key: "127.0.0.1/sign-in/email",
        count: 5,
        lastRequest: BigInt(Date.now()),
      },
    });

    const res = await GET(cronRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      counts: { users: 3, partners: 20, products: 50, salesOrders: 80 },
    });

    expect(await prisma.product.count()).toBe(50);
    expect(
      await prisma.product.findUnique({ where: { code: "P-RESET-TEST" } }),
    ).toBeNull();
    expect(await prisma.session.count()).toBe(0);
    expect(await prisma.rateLimit.count()).toBe(0);
    expect(await prisma.user.count()).toBe(3);
    // 連番は投入した ID の続きから（リセット後に登録しても ID が衝突しない）
    const created = await prisma.partner.create({
      data: {
        code: "C-RESET-TEST",
        name: "デモ リセット確認",
        kind: "customer",
      },
    });
    expect(created.id).toBe(21);
    await prisma.partner.delete({ where: { id: created.id } });
  });

  it("CRON_SECRET が違えば 401 で、データに触れない", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    vi.stubEnv("DATABASE_URL", process.env.DATABASE_URL_TEST!);
    const before = await prisma.auditLog.count();
    await prisma.auditLog.create({
      data: {
        action: "test",
        targetType: "test",
        summary: "リセットされないことの確認",
      },
    });

    const res = await GET(cronRequest("wrong-secret"));
    expect(res.status).toBe(401);
    expect(await prisma.auditLog.count()).toBe(before + 1);
    await prisma.auditLog.deleteMany({ where: { action: "test" } });
  });

  it("ローカル以外の DB は STOCKFLOW_ALLOW_DESTRUCTIVE_SEED=1 がなければガードで拒否する（500）", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    // 実在しないホスト（.invalid）。ガードで止まるので接続はしない
    vi.stubEnv(
      "DATABASE_URL",
      "postgresql://u:p@db.example.invalid:5432/neondb",
    );
    vi.stubEnv("STOCKFLOW_ALLOW_DESTRUCTIVE_SEED", "");
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await GET(cronRequest());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("db.example.invalid:5432/neondb");
    expect(body.error).toContain("STOCKFLOW_ALLOW_DESTRUCTIVE_SEED=1");
    expect(body.error).not.toContain("u:p");
  });
});
