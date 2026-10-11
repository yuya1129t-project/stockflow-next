/**
 * 認証とロール権限の結合テスト（実 DB = DATABASE_URL_TEST）。docs/spec.md §2・§3
 * 前提: pnpm db:test:reset でテスト用 DB にマイグレーションとシードを適用済み
 *
 * 無効化のテストはデモユーザーを書き換えず、このファイルで作る一時ユーザーで行う（終了時に削除）
 */
import { hashPassword } from "better-auth/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import { createAuth, type Auth } from "@/lib/auth/auth";
import { USER_INACTIVE_CODE } from "@/lib/auth/constants";
import {
  authorize,
  authorizeRequest,
  getSessionUser,
  loginErrorMessage,
} from "@/lib/auth/session";

import { DEMO_PASSWORD, DEMO_USERS } from "../../prisma/seed-data";
import { connectTestDb, SETUP_HINT } from "./test-db";

let prisma: PrismaClient;
let auth: Auth;
const startedAt = new Date();

const [ADMIN, STAFF, VIEWER] = DEMO_USERS;

/** このファイルで作る一時ユーザー（staff） */
const TEMP_USER = {
  id: "auth_test_temp",
  name: "テスト用一時ユーザー",
  email: "auth-test-temp@example.com",
  role: "staff" as const,
};
const TEMP_PASSWORD = "temp-pass-5678";

async function removeTempUser() {
  await prisma.auditLog.deleteMany({ where: { userId: TEMP_USER.id } });
  await prisma.user.deleteMany({ where: { id: TEMP_USER.id } });
}

beforeAll(async () => {
  prisma = await connectTestDb();
  if ((await prisma.user.count()) === 0) {
    throw new Error(`テスト用 DB にシードが入っていません。${SETUP_HINT}`);
  }
  auth = createAuth(prisma);

  await removeTempUser();
  await prisma.user.create({
    data: {
      ...TEMP_USER,
      emailVerified: true,
      isActive: true,
      accounts: {
        create: {
          id: `${TEMP_USER.id}_credential`,
          accountId: TEMP_USER.id,
          providerId: "credential",
          password: await hashPassword(TEMP_PASSWORD),
        },
      },
    },
  });
});

afterAll(async () => {
  if (!prisma) return;
  try {
    await removeTempUser();
    // このテストで作ったデモユーザーのセッションとログイン履歴を片付ける
    await prisma.session.deleteMany({
      where: { createdAt: { gte: startedAt } },
    });
    await prisma.auditLog.deleteMany({
      where: { action: "login", createdAt: { gte: startedAt } },
    });
  } finally {
    await prisma.$disconnect();
  }
});

/** ログインして、以降のリクエストに付ける Cookie ヘッダーを返す */
async function signIn(email: string, password: string): Promise<Headers> {
  const { headers } = await auth.api.signInEmail({
    body: { email, password },
    returnHeaders: true,
  });
  const cookie = headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  expect(cookie).toContain("session_token=");
  return new Headers({ cookie });
}

/** サインインの失敗を { status, code } で受け取る */
async function signInError(email: string, password: string) {
  try {
    await auth.api.signInEmail({ body: { email, password } });
  } catch (error) {
    const e = error as { statusCode?: number; body?: { code?: string } };
    return { status: e.statusCode, code: e.body?.code, error };
  }
  throw new Error("ログインが成功してしまいました");
}

describe("ログイン", () => {
  it.each(DEMO_USERS)(
    "デモアカウント $email（$role）は正しいパスワードでログインでき、ロールが取れる",
    async (demo) => {
      const headers = await signIn(demo.email, DEMO_PASSWORD);
      const user = await getSessionUser(auth, headers);
      expect(user).toEqual({
        id: demo.id,
        name: demo.name,
        email: demo.email,
        role: demo.role,
      });
    },
  );

  it("間違ったパスワードではログインできない（401・日本語のメッセージ）", async () => {
    const result = await signInError(ADMIN.email, "wrong-password");
    expect(result.status).toBe(401);
    expect(result.code).toBe("INVALID_EMAIL_OR_PASSWORD");
    expect(loginErrorMessage(result.error)).toBe(
      "メールアドレスまたはパスワードが正しくありません",
    );
  });

  it("存在しないメールアドレスではログインできない", async () => {
    const result = await signInError("nobody@example.com", DEMO_PASSWORD);
    expect(result.code).toBe("INVALID_EMAIL_OR_PASSWORD");
  });

  it("ログインは操作履歴（AuditLog）に記録される", async () => {
    const before = new Date();
    await signIn(STAFF.email, DEMO_PASSWORD);
    const logs = await prisma.auditLog.findMany({
      where: { userId: STAFF.id, action: "login", createdAt: { gte: before } },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      targetType: "user",
      targetId: STAFF.id,
      summary: "ログインしました",
    });
  });

  it("失敗したログインはセッションも操作履歴も作らない", async () => {
    const before = new Date();
    await signInError(VIEWER.email, "wrong-password");
    expect(
      await prisma.session.count({
        where: { userId: VIEWER.id, createdAt: { gte: before } },
      }),
    ).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: { userId: VIEWER.id, createdAt: { gte: before } },
      }),
    ).toBe(0);
  });
});

describe("無効ユーザー（isActive = false）", () => {
  it("無効ユーザーは正しいパスワードでもログインできない（403・セッションを作らない）", async () => {
    await prisma.user.update({
      where: { id: TEMP_USER.id },
      data: { isActive: false },
    });
    try {
      const result = await signInError(TEMP_USER.email, TEMP_PASSWORD);
      expect(result.status).toBe(403);
      expect(result.code).toBe(USER_INACTIVE_CODE);
      expect(loginErrorMessage(result.error)).toBe(
        "このアカウントは無効になっています。管理者に連絡してください",
      );
      expect(
        await prisma.session.count({ where: { userId: TEMP_USER.id } }),
      ).toBe(0);
      expect(
        await prisma.auditLog.count({ where: { userId: TEMP_USER.id } }),
      ).toBe(0);
    } finally {
      await prisma.user.update({
        where: { id: TEMP_USER.id },
        data: { isActive: true },
      });
    }
  });

  it("ログイン中のユーザーを無効化すると、以降のリクエストは未ログインとして拒否され、セッションも消える", async () => {
    const headers = await signIn(TEMP_USER.email, TEMP_PASSWORD);
    expect(await getSessionUser(auth, headers)).not.toBeNull();
    expect((await authorizeRequest(auth, headers, "view")).ok).toBe(true);

    await prisma.user.update({
      where: { id: TEMP_USER.id },
      data: { isActive: false },
    });

    // サーバー側のガード
    expect(await getSessionUser(auth, headers)).toBeNull();
    const result = await authorizeRequest(auth, headers, "view");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
    // Better Auth の /get-session（HTTP）も未ログインを返す
    const response = await auth.handler(
      new Request("http://localhost:3000/api/auth/get-session", { headers }),
    );
    expect(await response.json()).toBeNull();
    // セッションは削除済み（再度有効化しても、古い Cookie では戻れない）
    expect(
      await prisma.session.count({ where: { userId: TEMP_USER.id } }),
    ).toBe(0);
    await prisma.user.update({
      where: { id: TEMP_USER.id },
      data: { isActive: true },
    });
    expect(await getSessionUser(auth, headers)).toBeNull();
  });
});

describe("サインアップ", () => {
  it("公開のサインアップ API は無効（ユーザーは作られない）", async () => {
    const email = "signup-attempt@example.com";
    const response = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email,
          password: "signup-pass-1234",
          name: "攻撃者",
        }),
      }),
    );
    expect(response.ok).toBe(false);
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  it("role / isActive を送っても受け付けない（input: false）", async () => {
    const email = "signup-role@example.com";
    await expect(
      auth.api.signUpEmail({
        body: {
          email,
          password: "signup-pass-1234",
          name: "攻撃者",
          // @ts-expect-error role は input: false なので型の上でも渡せない
          role: "admin",
          isActive: true,
        },
      }),
    ).rejects.toThrow();
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  it("ログイン中のユーザーが自分の role / isActive を書き換えようとしても反映されない（input: false）", async () => {
    const headers = await signIn(VIEWER.email, DEMO_PASSWORD);
    await expect(
      auth.api.updateUser({
        // @ts-expect-error role は input: false なので型の上でも渡せない
        body: { role: "admin" },
        headers,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      auth.api.updateUser({
        // @ts-expect-error isActive も input: false
        body: { isActive: false },
        headers,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: VIEWER.id },
    });
    expect(user.role).toBe("viewer");
    expect(user.isActive).toBe(true);
  });
});

describe("ガード関数", () => {
  it("未ログインは 401（JSON）", async () => {
    const result = await authorizeRequest(auth, new Headers(), "view");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(401);
    expect(await result.response.json()).toEqual({
      error: "ログインが必要です",
    });
  });

  it("不正なセッション Cookie は 401", async () => {
    const headers = new Headers({
      cookie: "better-auth.session_token=invalid.token",
    });
    const result = await authorizeRequest(auth, headers, "view");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });

  it("viewer が admin 専用の操作をすると 403（JSON）、閲覧は許可", async () => {
    const headers = await signIn(VIEWER.email, DEMO_PASSWORD);
    for (const action of ["user:manage", "audit:view", "order:edit"] as const) {
      const result = await authorizeRequest(auth, headers, action);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.response.status).toBe(403);
      expect(await result.response.json()).toEqual({
        error: "この操作を行う権限がありません",
      });
    }
    const allowed = await authorizeRequest(auth, headers, "view");
    expect(allowed.ok && allowed.user.role).toBe("viewer");
  });

  it("staff は受注の編集ができ、ユーザー管理は 403", async () => {
    const headers = await signIn(STAFF.email, DEMO_PASSWORD);
    expect((await authorizeRequest(auth, headers, "order:edit")).ok).toBe(true);
    const result = await authorizeRequest(auth, headers, "user:manage");
    expect(!result.ok && result.response.status).toBe(403);
  });

  it("admin はすべての操作ができる", async () => {
    const headers = await signIn(ADMIN.email, DEMO_PASSWORD);
    const user = await getSessionUser(auth, headers);
    for (const action of [
      "user:manage",
      "audit:view",
      "master:deactivate",
    ] as const) {
      expect(authorize(user, action)).toEqual({ ok: true, user });
    }
  });

  it("authorize: 未ログインは 401 相当、権限外は 403 相当", () => {
    expect(authorize(null, "view")).toEqual({ ok: false, status: 401 });
    expect(
      authorize(
        {
          id: VIEWER.id,
          name: VIEWER.name,
          email: VIEWER.email,
          role: "viewer",
        },
        "csv:import",
      ),
    ).toEqual({ ok: false, status: 403 });
  });
});
