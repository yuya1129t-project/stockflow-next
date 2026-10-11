/**
 * 認証とロール権限の結合テスト（実 DB = DATABASE_URL_TEST）。docs/spec.md §2・§3
 * 前提: pnpm db:test:reset でテスト用 DB にマイグレーションとシードを適用済み
 *
 * 無効化のテストはデモユーザーを書き換えず、このファイルで作る一時ユーザーで行う（終了時に削除）
 */
import { hashPassword } from "better-auth/crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import { createAuth, SIGN_IN_RATE_LIMIT, type Auth } from "@/lib/auth/auth";
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
/** Better Auth の baseURL（BETTER_AUTH_URL）。HTTP 経由のテストの Origin に使う */
const BASE_URL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
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

  /** 一時ユーザーでログインし、その Cookie とセッション ID を返す */
  async function signInTempUser() {
    const headers = await signIn(TEMP_USER.email, TEMP_PASSWORD);
    const session = await prisma.session.findFirstOrThrow({
      where: { userId: TEMP_USER.id },
      orderBy: { createdAt: "desc" },
    });
    expect(await getSessionUser(auth, headers)).not.toBeNull();
    return { headers, sessionId: session.id };
  }

  async function setTempUserActive(isActive: boolean) {
    await prisma.user.update({
      where: { id: TEMP_USER.id },
      data: { isActive },
    });
  }

  it("ログイン中に無効化されると、HTTP の /get-session は未ログインを返し、Cookie を失効させ、そのセッションを削除する", async () => {
    const { headers, sessionId } = await signInTempUser();
    await setTempUserActive(false);
    try {
      // 無効化しただけではセッションは残っている（このあと最初のアクセスで消える）
      expect(
        await prisma.session.findUnique({ where: { id: sessionId } }),
      ).not.toBeNull();

      // 無効化後の最初のアクセスを HTTP の経路だけで行う
      const response = await auth.handler(
        new Request(`${BASE_URL}/api/auth/get-session`, { headers }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toBeNull();
      const setCookie = response.headers.getSetCookie().join("\n");
      expect(setCookie).toMatch(/session_token=;[^\n]*Max-Age=0/i);
      expect(
        await prisma.session.findUnique({ where: { id: sessionId } }),
      ).toBeNull();
    } finally {
      await setTempUserActive(true);
    }
    // 再度有効化しても、古い Cookie では戻れない
    const again = await auth.handler(
      new Request(`${BASE_URL}/api/auth/get-session`, { headers }),
    );
    expect(await again.json()).toBeNull();
  });

  it("ログイン中に無効化されると、サーバーのガードは未ログイン（401）として拒否し、そのセッションを削除する", async () => {
    const { headers, sessionId } = await signInTempUser();
    await setTempUserActive(false);
    try {
      expect(
        await prisma.session.findUnique({ where: { id: sessionId } }),
      ).not.toBeNull();

      // 無効化後の最初のアクセスをサーバーのガードの経路だけで行う
      const result = await authorizeRequest(auth, headers, "view");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(401);
      expect(
        await prisma.session.findUnique({ where: { id: sessionId } }),
      ).toBeNull();
    } finally {
      await setTempUserActive(true);
    }
    // 再度有効化しても、古い Cookie では戻れない
    expect(await getSessionUser(auth, headers)).toBeNull();
  });
});

describe("ログアウト", () => {
  it("ログアウトするとセッションが削除され、同じ Cookie では未ログインになる", async () => {
    const headers = await signIn(STAFF.email, DEMO_PASSWORD);
    const session = await prisma.session.findFirstOrThrow({
      where: { userId: STAFF.id },
      orderBy: { createdAt: "desc" },
    });
    expect(await getSessionUser(auth, headers)).not.toBeNull();

    await auth.api.signOut({ headers });

    expect(
      await prisma.session.findUnique({ where: { id: session.id } }),
    ).toBeNull();
    expect(await getSessionUser(auth, headers)).toBeNull();
  });
});

describe("サインアップ", () => {
  it("公開のサインアップは無効（EMAIL_PASSWORD_SIGN_UP_DISABLED。ユーザーは作られない）", async () => {
    const email = "signup-attempt@example.com";
    const response = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({
          email,
          password: "signup-pass-1234",
          name: "攻撃者",
          role: "admin",
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "EMAIL_PASSWORD_SIGN_UP_DISABLED",
    });
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  it("サインアップで role / isActive を送っても採用されず、既定値（viewer・有効）で保存される（input: false）", async () => {
    // input: false を単独で確かめるため、テスト専用にサインアップを有効にしたインスタンスを使う
    const signUpAuth = createAuth(prisma, { enableSignUp: true });
    const email = "signup-role-check@example.com";
    try {
      await signUpAuth.api.signUpEmail({
        body: {
          email,
          password: "signup-pass-1234",
          name: "攻撃者",
          // @ts-expect-error role は input: false なので型の上でも渡せない
          role: "admin",
          isActive: false,
        },
      });
      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(user.role).toBe("viewer");
      expect(user.isActive).toBe(true);
    } finally {
      // サインアップ後の自動ログインで作られた操作履歴とユーザーを片付ける（セッションは連鎖削除）
      await prisma.auditLog.deleteMany({ where: { user: { email } } });
      await prisma.user.deleteMany({ where: { email } });
    }
  });

  it("ログイン中のユーザーが自分の role / isActive を書き換えようとしても反映されない（input: false）", async () => {
    const headers = await signIn(VIEWER.email, DEMO_PASSWORD);
    try {
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
    } finally {
      // 失敗して書き換わっていても、後続のテストに影響しないよう元に戻す
      await prisma.user.update({
        where: { id: VIEWER.id },
        data: { role: "viewer", isActive: true },
      });
    }
  });
});

describe("ログインの試行回数制限（HTTP の /api/auth/sign-in/email）", () => {
  // 制限を有効にしたインスタンスで検証する（他のテストのインスタンスは制限なし）。
  // IP は文書用のアドレス帯（RFC 5737）を使い、終わったらカウンターを消す
  const IP = "203.0.113.45";
  const OTHER_IP = "203.0.113.46";
  const keys = [IP, OTHER_IP].map((ip) => `${ip}|/sign-in/email`);

  function signInRequest(ip: string, password: string) {
    return new Request(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: BASE_URL,
        "x-forwarded-for": ip,
      },
      body: JSON.stringify({ email: ADMIN.email, password }),
    });
  }

  it(`同じ IP から ${SIGN_IN_RATE_LIMIT.window} 秒に ${SIGN_IN_RATE_LIMIT.max} 回まで。超えると 429（カウンターは DB に保存）`, async () => {
    const limitedAuth = createAuth(prisma, { rateLimit: true });
    await prisma.rateLimit.deleteMany({ where: { key: { in: keys } } });
    try {
      const statuses: number[] = [];
      let last: Response | undefined;
      for (let i = 0; i < SIGN_IN_RATE_LIMIT.max + 1; i++) {
        last = await limitedAuth.handler(signInRequest(IP, "wrong-password"));
        statuses.push(last.status);
      }
      expect(statuses).toEqual([
        ...Array<number>(SIGN_IN_RATE_LIMIT.max).fill(401),
        429,
      ]);
      expect(Number(last!.headers.get("x-retry-after"))).toBeGreaterThan(0);
      expect(loginErrorMessage({ status: last!.status })).toBe(
        "試行回数が多すぎます。しばらく待ってからもう一度お試しください",
      );

      // 上限に達したあとは、正しいパスワードでも 429
      expect(
        (await limitedAuth.handler(signInRequest(IP, DEMO_PASSWORD))).status,
      ).toBe(429);
      // カウンターは DB（rate_limit）にあり、インスタンスをまたいで共有される
      expect(
        await prisma.rateLimit.findUnique({ where: { key: keys[0] } }),
      ).toMatchObject({ count: SIGN_IN_RATE_LIMIT.max });
      const anotherInstance = createAuth(prisma, { rateLimit: true });
      expect(
        (await anotherInstance.handler(signInRequest(IP, "wrong-password")))
          .status,
      ).toBe(429);
      // 別の IP は影響を受けない
      expect(
        (await limitedAuth.handler(signInRequest(OTHER_IP, "wrong-password")))
          .status,
      ).toBe(401);
    } finally {
      await prisma.rateLimit.deleteMany({ where: { key: { in: keys } } });
    }
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
