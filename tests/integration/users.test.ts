/**
 * ユーザー管理・API トークン・操作履歴の結合テスト（実 DB = DATABASE_URL_TEST）。docs/spec.md §2・§3・§5・§6-2
 * 前提: pnpm db:test:reset でテスト用 DB にマイグレーションとシードを適用済み
 *
 * デモユーザーは書き換えない（保護の確認では、拒否されて何も変わらないことを確かめる）。
 * 登録・変更はこのファイル専用のユーザー（メールアドレスが zu- で始まる）で行い、
 * 作ったユーザーとその操作履歴は終了時に削除する（他のテストファイルのシード件数の確認に影響させない）
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import { listAuditLogs, auditLogFilterOptions } from "@/lib/audit-logs/queries";
import {
  DEFAULT_AUDIT_LOG_LIST_PARAMS,
  type AuditLogListParams,
} from "@/lib/audit-logs/search-params";
import { hashApiToken } from "@/lib/auth/api-token";
import {
  API_TOKEN_LAST_USED_INTERVAL_MS,
  authenticateApiToken,
} from "@/lib/auth/api-token-auth";
import { createAuth, type Auth } from "@/lib/auth/auth";
import { USER_INACTIVE_CODE } from "@/lib/auth/constants";
import { getSessionUser, type SessionUser } from "@/lib/auth/session";
import { jstDateString } from "@/lib/dashboard/period";
import { listUsers } from "@/lib/users/queries";
import {
  API_TOKEN_TARGET_TYPE,
  changeUserRole,
  createUser,
  DEMO_USER_PROTECTED_MESSAGE,
  issueApiToken,
  MAX_ACTIVE_API_TOKENS_PER_USER,
  resetUserPassword,
  revokeApiToken,
  setUserActive,
  USER_TARGET_TYPE,
} from "@/lib/users/service";

import { DEMO_PASSWORD, DEMO_USERS } from "../../prisma/seed-data";
import { connectTestDb, SETUP_HINT } from "./test-db";

let prisma: PrismaClient;
let auth: Auth;
const startedAt = new Date();

const [ADMIN, STAFF, VIEWER] = DEMO_USERS.map(
  ({ id, name, email, role }): SessionUser => ({ id, name, email, role }),
);

/** このファイルで作るユーザーのメールアドレスの接頭辞 */
const PREFIX = "zu-";
const PASSWORD = "zu-pass-1234";
let seq = 0;

function newUserInput(overrides: Record<string, string> = {}) {
  seq += 1;
  return {
    name: `結合テストユーザー ${seq}`,
    email: `${PREFIX}${Date.now()}-${seq}@example.com`,
    role: "staff",
    password: PASSWORD,
    ...overrides,
  };
}

async function testUserIds(): Promise<string[]> {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: PREFIX } },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

async function cleanUp() {
  const ids = await testUserIds();
  const tokens = await prisma.apiToken.findMany({
    where: { userId: { in: ids } },
    select: { id: true },
  });
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { userId: { in: ids } },
        { targetType: USER_TARGET_TYPE, targetId: { in: ids } },
        {
          targetType: API_TOKEN_TARGET_TYPE,
          targetId: { in: tokens.map((t) => String(t.id)) },
        },
      ],
    },
  });
  // セッション・アカウント・トークンは User の削除で消える（onDelete: Cascade）
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  prisma = await connectTestDb();
  if ((await prisma.user.count()) === 0) {
    throw new Error(`テスト用 DB にシードが入っていません。${SETUP_HINT}`);
  }
  auth = createAuth(prisma);
  await cleanUp();
});

afterAll(async () => {
  if (!prisma) return;
  try {
    await cleanUp();
    // デモ用アカウントでログインを確かめたときのセッションとログイン履歴を片付ける
    const demoIds = DEMO_USERS.map((u) => u.id);
    await prisma.session.deleteMany({
      where: { userId: { in: demoIds }, createdAt: { gte: startedAt } },
    });
    await prisma.auditLog.deleteMany({
      where: {
        userId: { in: demoIds },
        action: "login",
        createdAt: { gte: startedAt },
      },
    });
  } finally {
    await prisma.$disconnect();
  }
});

/** 登録して SessionUser を返す（actor は ADMIN） */
async function registerUser(
  overrides: Record<string, string> = {},
): Promise<SessionUser> {
  const input = newUserInput(overrides);
  const result = await createUser(prisma, ADMIN, input);
  if (!result.ok) throw new Error(result.error);
  return {
    id: result.data.id,
    name: input.name,
    email: input.email,
    role: input.role as SessionUser["role"],
  };
}

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

async function signInError(email: string, password: string) {
  try {
    await auth.api.signInEmail({ body: { email, password } });
  } catch (error) {
    const e = error as { statusCode?: number; body?: { code?: string } };
    return { status: e.statusCode, code: e.body?.code };
  }
  throw new Error("ログインが成功してしまいました");
}

function bearer(token: string): Request {
  return new Request("http://localhost/api/v1/products", {
    headers: { authorization: `Bearer ${token}` },
  });
}

async function issue(user: SessionUser, name = "テスト用トークン") {
  const result = await issueApiToken(prisma, ADMIN, user.id, { name });
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

describe("ユーザーの登録", () => {
  it("登録したユーザーでログインでき、ロールが取れる（Better Auth と同じ方式のハッシュ）。操作履歴に残る", async () => {
    const input = newUserInput({
      role: "viewer",
      email: `${PREFIX}Upper-${Date.now()}@Example.com`,
    });
    const result = await createUser(prisma, ADMIN, input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const saved = await prisma.user.findUniqueOrThrow({
      where: { id: result.data.id },
      include: { accounts: true },
    });
    // メールアドレスは小文字で保存（Better Auth のログインと同じ照合）
    expect(saved.email).toBe(input.email.toLowerCase());
    expect(saved).toMatchObject({ role: "viewer", isActive: true });
    expect(saved.accounts).toHaveLength(1);
    expect(saved.accounts[0]).toMatchObject({
      providerId: "credential",
      accountId: saved.id,
    });
    expect(saved.accounts[0].password).not.toContain(PASSWORD);

    // 大文字を混ぜたメールアドレスでもログインできる
    const headers = await signIn(input.email, PASSWORD);
    expect(await getSessionUser(auth, headers)).toEqual({
      id: saved.id,
      name: input.name,
      email: saved.email,
      role: "viewer",
    });

    const log = await prisma.auditLog.findFirst({
      where: { targetType: USER_TARGET_TYPE, targetId: saved.id },
    });
    expect(log).toMatchObject({ userId: ADMIN.id, action: "create" });
    expect(log?.summary).not.toContain(PASSWORD);
  });

  it("メールアドレスの重複（大文字・小文字の違いも同じ扱い）は項目のエラー", async () => {
    const user = await registerUser();
    const result = await createUser(
      prisma,
      ADMIN,
      newUserInput({ email: user.email.toUpperCase() }),
    );
    expect(result).toEqual({
      ok: false,
      error: `メールアドレス「${user.email}」はすでに登録されています`,
      fieldErrors: {
        email: [`メールアドレス「${user.email}」はすでに登録されています`],
      },
    });
    // デモアカウントのメールアドレスも重複
    const demo = await createUser(
      prisma,
      ADMIN,
      newUserInput({ email: ADMIN.email }),
    );
    expect(demo.ok).toBe(false);
    if (!demo.ok) expect(demo.fieldErrors?.email).toBeDefined();
  });

  it("入力エラーは登録しない", async () => {
    const before = await prisma.user.count();
    const result = await createUser(
      prisma,
      ADMIN,
      newUserInput({ password: "short", role: "owner" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors?.password).toEqual([
        "初期パスワードは8文字以上で入力してください",
      ]);
      expect(result.fieldErrors?.role).toBeDefined();
    }
    expect(await prisma.user.count()).toBe(before);
  });

  it("一覧にはデモ用アカウントの印が付く", async () => {
    const users = await listUsers(prisma);
    expect(
      users
        .filter((u) => u.isDemo)
        .map((u) => u.id)
        .sort(),
    ).toEqual(DEMO_USERS.map((u) => u.id).sort());
  });
});

describe("ロール変更", () => {
  it("変更でき、ログイン中のセッションにも次のリクエストから反映される。操作履歴に前後のロール", async () => {
    const user = await registerUser({ role: "viewer" });
    const headers = await signIn(user.email, PASSWORD);
    expect((await getSessionUser(auth, headers))?.role).toBe("viewer");

    expect(
      await changeUserRole(prisma, ADMIN, user.id, { role: "staff" }),
    ).toEqual({ ok: true, data: null });
    expect((await getSessionUser(auth, headers))?.role).toBe("staff");

    const log = await prisma.auditLog.findFirst({
      where: {
        action: "role_change",
        targetType: USER_TARGET_TYPE,
        targetId: user.id,
      },
    });
    expect(log?.summary).toContain("閲覧者 → 担当者");
  });

  it("同じロールなら何もしない（操作履歴も残さない）", async () => {
    const user = await registerUser({ role: "staff" });
    expect(
      await changeUserRole(prisma, ADMIN, user.id, { role: "staff" }),
    ).toEqual({ ok: true, data: null });
    expect(
      await prisma.auditLog.count({
        where: { action: "role_change", targetId: user.id },
      }),
    ).toBe(0);
  });

  it("自分自身のロールは変更できない", async () => {
    const admin = await registerUser({ role: "admin" });
    expect(
      await changeUserRole(prisma, admin, admin.id, { role: "viewer" }),
    ).toEqual({ ok: false, error: "自分自身のロールは変更できません" });
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).role,
    ).toBe("admin");
  });

  it("不正なロール・存在しないユーザーはエラー", async () => {
    const user = await registerUser();
    const invalid = await changeUserRole(prisma, ADMIN, user.id, {
      role: "root",
    });
    expect(invalid.ok).toBe(false);
    expect(
      await changeUserRole(prisma, ADMIN, "no_such_user", { role: "staff" }),
    ).toEqual({ ok: false, error: "ユーザーが見つかりません" });
  });
});

describe("無効化・再有効化", () => {
  it("無効化するとログイン中のセッションが切れ、API トークンも使えなくなり、ログインもできない", async () => {
    const user = await registerUser();
    const headers = await signIn(user.email, PASSWORD);
    expect(await getSessionUser(auth, headers)).not.toBeNull();
    const { id: tokenId, token } = await issue(user);
    expect((await authenticateApiToken(bearer(token), { db: prisma })).ok).toBe(
      true,
    );

    expect(await setUserActive(prisma, ADMIN, user.id, false)).toEqual({
      ok: true,
      data: null,
    });

    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    expect(await getSessionUser(auth, headers)).toBeNull();
    const revoked = await prisma.apiToken.findUniqueOrThrow({
      where: { id: tokenId },
    });
    expect(revoked.revokedAt).not.toBeNull();
    expect(await authenticateApiToken(bearer(token), { db: prisma })).toEqual({
      ok: false,
    });
    expect(await signInError(user.email, PASSWORD)).toMatchObject({
      status: 403,
      code: USER_INACTIVE_CODE,
    });
    const log = await prisma.auditLog.findFirst({
      where: { action: "deactivate", targetId: user.id },
    });
    expect(log?.summary).toContain(
      "セッション 1 件を終了、API トークン 1 件を失効",
    );

    // 再有効化: ログインできるが、失効したトークンは戻らない
    expect(await setUserActive(prisma, ADMIN, user.id, true)).toEqual({
      ok: true,
      data: null,
    });
    await signIn(user.email, PASSWORD);
    expect(await authenticateApiToken(bearer(token), { db: prisma })).toEqual({
      ok: false,
    });
    expect(
      await prisma.auditLog.count({
        where: { action: "reactivate", targetId: user.id },
      }),
    ).toBe(1);
  });

  it("再有効化でもセッションをすべて削除する（無効化と競合して作られたセッションを使えるようにしない）", async () => {
    const user = await registerUser();
    await setUserActive(prisma, ADMIN, user.id, false);
    // 無効化と同時に進んでいたログインが、無効化の後に作ったセッションの代わり
    await prisma.session.create({
      data: {
        id: `zu-race-${user.id}`,
        token: `zu-race-token-${user.id}`,
        userId: user.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    expect(await setUserActive(prisma, ADMIN, user.id, true)).toEqual({
      ok: true,
      data: null,
    });
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
  });

  it("自分自身は無効にできない", async () => {
    const admin = await registerUser({ role: "admin" });
    expect(await setUserActive(prisma, admin, admin.id, false)).toEqual({
      ok: false,
      error: "自分自身を無効にすることはできません",
    });
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: admin.id } }))
        .isActive,
    ).toBe(true);
  });

  it("無効なユーザーには API トークンを発行できない", async () => {
    const user = await registerUser();
    await setUserActive(prisma, ADMIN, user.id, false);
    expect(await issueApiToken(prisma, ADMIN, user.id, { name: "x" })).toEqual({
      ok: false,
      error: "無効なユーザーには API トークンを発行できません",
    });
  });
});

describe("パスワード再設定", () => {
  it("新しいパスワードでだけログインでき、対象のセッションは終了する。履歴にパスワードを残さない", async () => {
    const user = await registerUser();
    const headers = await signIn(user.email, PASSWORD);
    const newPassword = "zu-new-pass-9876";
    expect(
      await resetUserPassword(prisma, ADMIN, user.id, {
        password: newPassword,
      }),
    ).toEqual({ ok: true, data: null });

    expect(await getSessionUser(auth, headers)).toBeNull();
    expect(await signInError(user.email, PASSWORD)).toMatchObject({
      status: 401,
    });
    await signIn(user.email, newPassword);

    const log = await prisma.auditLog.findFirstOrThrow({
      where: { action: "password_reset", targetId: user.id },
    });
    expect(log.summary).not.toContain(newPassword);
  });

  it("自分自身の再設定でも、別々にログインした自分のセッションをすべて終了する", async () => {
    const admin = await registerUser({ role: "admin" });
    const cookieA = await signIn(admin.email, PASSWORD);
    const cookieB = await signIn(admin.email, PASSWORD);
    expect((await getSessionUser(auth, cookieA))?.id).toBe(admin.id);
    expect((await getSessionUser(auth, cookieB))?.id).toBe(admin.id);

    const newPassword = "zu-self-new-5555";
    expect(
      await resetUserPassword(prisma, admin, admin.id, {
        password: newPassword,
      }),
    ).toEqual({ ok: true, data: null });

    expect(await getSessionUser(auth, cookieA)).toBeNull();
    expect(await getSessionUser(auth, cookieB)).toBeNull();
    expect(await prisma.session.count({ where: { userId: admin.id } })).toBe(0);
    await signIn(admin.email, newPassword);
  });

  it("既定では API トークンもすべて失効させ、件数を操作履歴に残す", async () => {
    const user = await registerUser();
    const { token } = await issue(user);
    expect(
      await resetUserPassword(prisma, ADMIN, user.id, {
        password: "zu-new-pass-1111",
      }),
    ).toEqual({ ok: true, data: null });
    expect(await authenticateApiToken(bearer(token), { db: prisma })).toEqual({
      ok: false,
    });
    const log = await prisma.auditLog.findFirstOrThrow({
      where: { action: "password_reset", targetId: user.id },
    });
    expect(log.summary).toContain("API トークン 1 件を失効");
  });

  it("「API トークンもすべて失効する」をオフにすると、トークンは残る", async () => {
    const user = await registerUser();
    const { token } = await issue(user);
    expect(
      await resetUserPassword(prisma, ADMIN, user.id, {
        password: "zu-new-pass-2222",
        revokeTokens: false,
      }),
    ).toEqual({ ok: true, data: null });
    expect((await authenticateApiToken(bearer(token), { db: prisma })).ok).toBe(
      true,
    );
    const log = await prisma.auditLog.findFirstOrThrow({
      where: { action: "password_reset", targetId: user.id },
    });
    expect(log.summary).not.toContain("API トークン");
  });

  it("短いパスワードは項目のエラー", async () => {
    const user = await registerUser();
    expect(
      await resetUserPassword(prisma, ADMIN, user.id, { password: "1234" }),
    ).toEqual({
      ok: false,
      error: "入力内容に誤りがあります。各項目を確認してください",
      fieldErrors: {
        password: ["新しいパスワードは8文字以上で入力してください"],
      },
    });
  });
});

describe("デモ用アカウントの保護", () => {
  it.each(DEMO_USERS)(
    "$email はロール変更・無効化・パスワード再設定を拒否する（何も変わらない）",
    async (demo) => {
      // デモの admin 以外の管理者が操作しても拒否する
      const otherAdmin = await registerUser({ role: "admin" });
      const before = await prisma.user.findUniqueOrThrow({
        where: { id: demo.id },
        include: { accounts: true },
      });
      const logsBefore = await prisma.auditLog.count({
        where: { targetType: USER_TARGET_TYPE, targetId: demo.id },
      });
      const protectedError = {
        ok: false,
        error: DEMO_USER_PROTECTED_MESSAGE,
      };

      expect(
        await changeUserRole(prisma, otherAdmin, demo.id, {
          role: demo.role === "viewer" ? "admin" : "viewer",
        }),
      ).toEqual(protectedError);
      expect(await setUserActive(prisma, otherAdmin, demo.id, false)).toEqual(
        protectedError,
      );
      expect(
        await resetUserPassword(prisma, otherAdmin, demo.id, {
          password: "hijacked-1234",
        }),
      ).toEqual(protectedError);

      const after = await prisma.user.findUniqueOrThrow({
        where: { id: demo.id },
        include: { accounts: true },
      });
      expect(after.role).toBe(before.role);
      expect(after.isActive).toBe(true);
      expect(after.email).toBe(before.email);
      expect(after.accounts[0].password).toBe(before.accounts[0].password);
      expect(
        await prisma.auditLog.count({
          where: { targetType: USER_TARGET_TYPE, targetId: demo.id },
        }),
      ).toBe(logsBefore);
      // デモのパスワードでログインできるまま
      await signIn(demo.email, DEMO_PASSWORD);
    },
  );

  it("デモの admin 自身の操作は、自分自身の制限が先に効く", async () => {
    expect(
      await changeUserRole(prisma, ADMIN, ADMIN.id, { role: "viewer" }),
    ).toEqual({ ok: false, error: "自分自身のロールは変更できません" });
    expect(await setUserActive(prisma, ADMIN, ADMIN.id, false)).toEqual({
      ok: false,
      error: "自分自身を無効にすることはできません",
    });
  });
});

describe("API トークン", () => {
  it("発行 → 検証に成功し、持ち主のユーザーが返る。DB にはハッシュだけを保存する", async () => {
    const user = await registerUser({ role: "viewer" });
    const { id, token } = await issue(user, "在庫連携");
    expect(token).toMatch(/^sf_[A-Za-z0-9_-]{43}$/);

    const row = await prisma.apiToken.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      userId: user.id,
      name: "在庫連携",
      tokenHash: hashApiToken(token),
      lastUsedAt: null,
      revokedAt: null,
    });
    expect(JSON.stringify(row)).not.toContain(token.slice(3));

    const result = await authenticateApiToken(bearer(token), { db: prisma });
    expect(result).toEqual({ ok: true, tokenId: id, user });

    const log = await prisma.auditLog.findFirstOrThrow({
      where: { targetType: API_TOKEN_TARGET_TYPE, targetId: String(id) },
    });
    expect(log.action).toBe("token_create");
    expect(log.summary).not.toContain(token);
  });

  it("lastUsedAt は使用時に記録し、一定間隔の中では書き込まない", async () => {
    const user = await registerUser();
    const { id, token } = await issue(user);
    const t0 = new Date("2026-10-13T00:00:00Z");
    await authenticateApiToken(bearer(token), { db: prisma, now: t0 });
    const lastUsed = async () =>
      (await prisma.apiToken.findUniqueOrThrow({ where: { id } })).lastUsedAt;
    expect(await lastUsed()).toEqual(t0);

    const t1 = new Date(t0.getTime() + API_TOKEN_LAST_USED_INTERVAL_MS - 1000);
    await authenticateApiToken(bearer(token), { db: prisma, now: t1 });
    expect(await lastUsed()).toEqual(t0);

    const t2 = new Date(t0.getTime() + API_TOKEN_LAST_USED_INTERVAL_MS + 1000);
    await authenticateApiToken(bearer(token), { db: prisma, now: t2 });
    expect(await lastUsed()).toEqual(t2);
  });

  it("失効後は検証に失敗する（失効しても行は残る）", async () => {
    const user = await registerUser();
    const { id, token } = await issue(user);
    expect(await revokeApiToken(prisma, ADMIN, user.id, id)).toEqual({
      ok: true,
      data: null,
    });
    expect(await authenticateApiToken(bearer(token), { db: prisma })).toEqual({
      ok: false,
    });
    expect(
      (await prisma.apiToken.findUniqueOrThrow({ where: { id } })).revokedAt,
    ).not.toBeNull();
    // 2 回目は何もしない
    expect(await revokeApiToken(prisma, ADMIN, user.id, id)).toEqual({
      ok: true,
      data: null,
    });
    expect(
      await prisma.auditLog.count({
        where: { action: "token_revoke", targetId: String(id) },
      }),
    ).toBe(1);
  });

  it("別のユーザーの ID を指定しても失効できない", async () => {
    const owner = await registerUser();
    const other = await registerUser();
    const { id, token } = await issue(owner);
    expect(await revokeApiToken(prisma, ADMIN, other.id, id)).toEqual({
      ok: false,
      error: "API トークンが見つかりません",
    });
    expect((await authenticateApiToken(bearer(token), { db: prisma })).ok).toBe(
      true,
    );
  });

  it("トークンが失効していなくても、持ち主が無効なら検証に失敗する", async () => {
    const user = await registerUser();
    const { id, token } = await issue(user);
    // 無効化の処理を通さず（トークンを失効させずに）ユーザーだけを無効にする
    await prisma.user.update({
      where: { id: user.id },
      data: { isActive: false },
    });
    expect(
      (await prisma.apiToken.findUniqueOrThrow({ where: { id } })).revokedAt,
    ).toBeNull();
    expect(await authenticateApiToken(bearer(token), { db: prisma })).toEqual({
      ok: false,
    });
  });

  it("範囲外の tokenId は例外にせず「見つかりません」", async () => {
    const user = await registerUser();
    for (const tokenId of [2 ** 31, 2 ** 40, 0, -1, 1.5]) {
      expect(await revokeApiToken(prisma, ADMIN, user.id, tokenId)).toEqual({
        ok: false,
        error: "API トークンが見つかりません",
      });
    }
  });

  it("権限はトークンの持ち主のいまのロールに従う", async () => {
    const user = await registerUser({ role: "staff" });
    const { token } = await issue(user);
    await changeUserRole(prisma, ADMIN, user.id, { role: "viewer" });
    const result = await authenticateApiToken(bearer(token), { db: prisma });
    expect(result.ok && result.user.role).toBe("viewer");
  });

  it.each([
    ["ヘッダーなし", null],
    ["Bearer でない", "Basic dXNlcjpwYXNz"],
    ["不正な形式", "Bearer sf_short"],
    ["存在しない（形式は正しい）", `Bearer sf_${"A".repeat(43)}`],
  ])("%s は失敗（理由を区別しない同じ応答）", async (_, authorization) => {
    const request = new Request("http://localhost/api/v1/products", {
      headers: authorization ? { authorization } : {},
    });
    expect(await authenticateApiToken(request, { db: prisma })).toEqual({
      ok: false,
    });
  });

  it(`有効なトークンは 1 ユーザー ${MAX_ACTIVE_API_TOKENS_PER_USER} 件まで（失効させれば発行できる）`, async () => {
    const user = await registerUser();
    const issued = [];
    for (let i = 0; i < MAX_ACTIVE_API_TOKENS_PER_USER; i++) {
      issued.push(await issue(user, `t${i}`));
    }
    const over = await issueApiToken(prisma, ADMIN, user.id, { name: "over" });
    expect(over.ok).toBe(false);
    await revokeApiToken(prisma, ADMIN, user.id, issued[0].id);
    expect(
      (await issueApiToken(prisma, ADMIN, user.id, { name: "again" })).ok,
    ).toBe(true);
  });

  it("デモ用アカウントにも発行・失効できる（REST API を試せるように）", async () => {
    const result = await issueApiToken(prisma, ADMIN, VIEWER.id, {
      name: "zu-demo",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    try {
      expect(
        await authenticateApiToken(bearer(result.data.token), { db: prisma }),
      ).toMatchObject({ ok: true, user: { id: VIEWER.id, role: "viewer" } });
      expect(
        await revokeApiToken(prisma, ADMIN, VIEWER.id, result.data.id),
      ).toEqual({ ok: true, data: null });
    } finally {
      await prisma.auditLog.deleteMany({
        where: {
          targetType: API_TOKEN_TARGET_TYPE,
          targetId: String(result.data.id),
        },
      });
      await prisma.apiToken.delete({ where: { id: result.data.id } });
    }
  });
});

describe("権限（ユーザー管理は admin のみ）", () => {
  it.each([
    ["staff", STAFF],
    ["viewer", VIEWER],
    ["未ログイン", null],
  ] as const)(
    "%s はすべての操作を拒否され、何も変わらない",
    async (_, actor) => {
      const target = await registerUser({ role: "viewer" });
      const { id: tokenId, token } = await issue(target);
      // 拒否された再設定の前後で credential とセッションが変わらないことを確かめるため、先にログインしておく
      const cookie = await signIn(target.email, PASSWORD);
      const credentialBefore = await prisma.account.findMany({
        where: { userId: target.id },
      });
      const sessionsBefore = await prisma.session.findMany({
        where: { userId: target.id },
        orderBy: { id: "asc" },
      });
      const expected =
        actor === null
          ? { ok: false, error: "ログインが必要です" }
          : { ok: false, error: "この操作を行う権限がありません" };
      const usersBefore = await prisma.user.count();
      const logsBefore = await prisma.auditLog.count();

      expect(await createUser(prisma, actor, newUserInput())).toEqual(expected);
      expect(
        await changeUserRole(prisma, actor, target.id, { role: "admin" }),
      ).toEqual(expected);
      expect(await setUserActive(prisma, actor, target.id, false)).toEqual(
        expected,
      );
      expect(
        await resetUserPassword(prisma, actor, target.id, {
          password: "hijacked-1234",
        }),
      ).toEqual(expected);
      expect(
        await issueApiToken(prisma, actor, target.id, { name: "x" }),
      ).toEqual(expected);
      expect(await revokeApiToken(prisma, actor, target.id, tokenId)).toEqual(
        expected,
      );

      expect(await prisma.user.count()).toBe(usersBefore);
      expect(await prisma.auditLog.count()).toBe(logsBefore);
      const after = await prisma.user.findUniqueOrThrow({
        where: { id: target.id },
      });
      expect(after).toMatchObject({ role: "viewer", isActive: true });
      expect(
        (await authenticateApiToken(bearer(token), { db: prisma })).ok,
      ).toBe(true);
      expect(
        await prisma.apiToken.count({ where: { userId: target.id } }),
      ).toBe(1);
      // パスワード・セッションも変わらない: 元の Cookie と元のパスワードが使え、指定した新しいパスワードは使えない
      expect(
        await prisma.account.findMany({ where: { userId: target.id } }),
      ).toEqual(credentialBefore);
      expect(
        await prisma.session.findMany({
          where: { userId: target.id },
          orderBy: { id: "asc" },
        }),
      ).toEqual(sessionsBefore);
      expect((await getSessionUser(auth, cookie))?.id).toBe(target.id);
      expect(await signInError(target.email, "hijacked-1234")).toMatchObject({
        status: 401,
      });
      await signIn(target.email, PASSWORD);
    },
  );
});

describe("同時実行と操作者の確かめ直し", () => {
  const WAIT_LIMIT_MS = 10_000;

  async function waitUntil(label: string, condition: () => Promise<boolean>) {
    const deadline = Date.now() + WAIT_LIMIT_MS;
    while (!(await condition())) {
      if (Date.now() > deadline) {
        throw new Error(`「${label}」の状態になりませんでした`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** 観測用の接続から: blocker のロックを待っているセッションがあるか */
  async function someoneBlockedBy(blocker: number): Promise<boolean> {
    const [row] = await prisma.$queryRaw<{ count: number }[]>`
      SELECT COUNT(*)::int AS "count" FROM pg_stat_activity
      WHERE "datname" = current_database()
        AND ${blocker}::int = ANY(pg_blocking_pids("pid"))`;
    return row.count > 0;
  }

  /**
   * デモの admin を含め、keep 以外の有効な admin を一時的に無効にして fn を実行する（終わったら元に戻す）。
   * 「有効な admin が keep の人たちだけ」の環境（デモ用アカウントのない環境）を作るため
   */
  async function withOnlyAdmins(
    keep: SessionUser[],
    fn: () => Promise<void>,
  ): Promise<void> {
    const others = await prisma.user.findMany({
      where: {
        role: "admin",
        isActive: true,
        id: { notIn: keep.map((u) => u.id) },
      },
      select: { id: true },
    });
    const ids = others.map((u) => u.id);
    await prisma.user.updateMany({
      where: { id: { in: ids } },
      data: { isActive: false },
    });
    try {
      await fn();
    } finally {
      await prisma.user.updateMany({
        where: { id: { in: ids } },
        data: { isActive: true },
      });
    }
  }

  async function activeAdminIds(): Promise<string[]> {
    const admins = await prisma.user.findMany({
      where: { role: "admin", isActive: true },
      select: { id: true },
    });
    return admins.map((u) => u.id).sort();
  }

  it("2 人の admin が同時に互いを降格しても、片方だけが成功し、有効な admin は 0 人にならない", async () => {
    const a = await registerUser({ role: "admin" });
    const b = await registerUser({ role: "admin" });
    await withOnlyAdmins([a, b], async () => {
      expect(await activeAdminIds()).toEqual([a.id, b.id].sort());
      const results = await Promise.all([
        changeUserRole(prisma, a, b.id, { role: "viewer" }),
        changeUserRole(prisma, b, a.id, { role: "viewer" }),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toEqual([
        { ok: false, error: "この操作を行う権限がありません" },
      ]);
      expect(await activeAdminIds()).toHaveLength(1);
    });
  });

  it("2 人の admin が同時に互いを無効化しても、片方だけが成功する", async () => {
    const a = await registerUser({ role: "admin" });
    const b = await registerUser({ role: "admin" });
    await withOnlyAdmins([a, b], async () => {
      const results = await Promise.all([
        setUserActive(prisma, a, b.id, false),
        setUserActive(prisma, b, a.id, false),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(await activeAdminIds()).toHaveLength(1);
    });
  });

  it("認可の後に操作者が無効化・降格されていたら、どの操作も拒否して何も変えない", async () => {
    const a = await registerUser({ role: "admin" });
    const b = await registerUser({ role: "admin" });
    const target = await registerUser({ role: "viewer" });
    const { id: tokenId, token } = await issue(target);
    await withOnlyAdmins([a, b], async () => {
      // a の SessionUser（認可を通った時点の値）は admin のまま、DB では無効になっている
      expect(await setUserActive(prisma, b, a.id, false)).toEqual({
        ok: true,
        data: null,
      });
      const forbidden = { ok: false, error: "この操作を行う権限がありません" };
      const logsBefore = await prisma.auditLog.count();
      const usersBefore = await prisma.user.count();
      expect(await createUser(prisma, a, newUserInput())).toEqual(forbidden);
      expect(
        await changeUserRole(prisma, a, target.id, { role: "admin" }),
      ).toEqual(forbidden);
      expect(await setUserActive(prisma, a, target.id, false)).toEqual(
        forbidden,
      );
      expect(
        await resetUserPassword(prisma, a, target.id, {
          password: "hijacked-1234",
        }),
      ).toEqual(forbidden);
      expect(await issueApiToken(prisma, a, target.id, { name: "x" })).toEqual(
        forbidden,
      );
      expect(await revokeApiToken(prisma, a, target.id, tokenId)).toEqual(
        forbidden,
      );
      expect(await prisma.auditLog.count()).toBe(logsBefore);
      expect(await prisma.user.count()).toBe(usersBefore);
      expect(
        await prisma.user.findUniqueOrThrow({ where: { id: target.id } }),
      ).toMatchObject({ role: "viewer", isActive: true });
      expect(
        (await authenticateApiToken(bearer(token), { db: prisma })).ok,
      ).toBe(true);

      // 降格された操作者も同じ
      await setUserActive(prisma, b, a.id, true);
      await changeUserRole(prisma, b, a.id, { role: "staff" });
      expect(
        await changeUserRole(prisma, a, target.id, { role: "staff" }),
      ).toEqual(forbidden);
    });
  });

  it("無効化とトークン発行が同時に走っても、無効なユーザーにトークンが残らない（ユーザー行のロック）", async () => {
    const user = await registerUser();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let lockerPid = 0;
    // 無効化の代わり: ユーザー行をロックしたまま止めておき、発行がロック待ちになってから無効にして確定する
    const locker = prisma.$transaction(
      async (tx) => {
        const [row] = await tx.$queryRaw<{ pid: number }[]>`
          SELECT pg_backend_pid() AS "pid"`;
        await tx.$queryRaw`SELECT "id" FROM "user" WHERE "id" = ${user.id} FOR NO KEY UPDATE`;
        lockerPid = row.pid;
        await gate;
        await tx.user.update({
          where: { id: user.id },
          data: { isActive: false },
        });
      },
      { timeout: 15_000 },
    );
    await waitUntil("ロックを取った", async () => lockerPid !== 0);
    const issuing = issueApiToken(prisma, ADMIN, user.id, { name: "race" });
    try {
      await waitUntil("発行がユーザー行のロックを待っている", () =>
        someoneBlockedBy(lockerPid),
      );
    } finally {
      release();
      await locker;
    }
    expect(await issuing).toEqual({
      ok: false,
      error: "無効なユーザーには API トークンを発行できません",
    });
    expect(await prisma.apiToken.count({ where: { userId: user.id } })).toBe(0);
  });
});

describe("操作履歴の一覧", () => {
  const params = (change: Partial<AuditLogListParams>): AuditLogListParams => ({
    ...DEFAULT_AUDIT_LOG_LIST_PARAMS,
    ...change,
  });

  it("ユーザー・操作・対象の種類・期間で絞り込める（新しい順）", async () => {
    // 操作するのはこのテスト専用の admin（シードの履歴と混ざらないようにする）
    const actor = await registerUser({ role: "admin" });
    const target = await registerUser();
    await changeUserRole(prisma, actor, target.id, { role: "viewer" });
    const issued = await issueApiToken(prisma, actor, target.id, {
      name: "log",
    });
    expect(issued.ok).toBe(true);

    const byActor = await listAuditLogs(prisma, params({ userId: actor.id }));
    expect(byActor.items.map((l) => l.action)).toEqual([
      "token_create",
      "role_change",
    ]);
    expect(byActor.items[0].user).toEqual({ id: actor.id, name: actor.name });

    const byAction = await listAuditLogs(
      prisma,
      params({ userId: actor.id, action: "role_change" }),
    );
    expect(byAction.total).toBe(1);
    expect(byAction.items[0]).toMatchObject({
      targetType: USER_TARGET_TYPE,
      targetId: target.id,
    });

    const byType = await listAuditLogs(
      prisma,
      params({ userId: actor.id, targetType: API_TOKEN_TARGET_TYPE }),
    );
    expect(byType.items.map((l) => l.action)).toEqual(["token_create"]);

    const today = jstDateString(new Date());
    expect(
      (
        await listAuditLogs(
          prisma,
          params({ userId: actor.id, from: today, to: today }),
        )
      ).total,
    ).toBe(2);
    expect(
      (
        await listAuditLogs(
          prisma,
          params({ userId: actor.id, to: "2000-01-01" }),
        )
      ).total,
    ).toBe(0);
    expect(
      (
        await listAuditLogs(
          prisma,
          params({ userId: actor.id, from: "2099-12-31" }),
        )
      ).total,
    ).toBe(0);

    const options = await auditLogFilterOptions(prisma);
    expect(options.actions).toEqual(
      expect.arrayContaining(["role_change", "token_create"]),
    );
    expect(options.targetTypes).toEqual(
      expect.arrayContaining([USER_TARGET_TYPE, API_TOKEN_TARGET_TYPE]),
    );
    expect(options.users.map((u) => u.id)).toContain(actor.id);
  });

  it("ページ送り（範囲外のページは最後のページに寄せる）", async () => {
    const all = await listAuditLogs(prisma, params({}));
    expect(all.items.length).toBeLessThanOrEqual(all.perPage);
    const last = await listAuditLogs(prisma, params({ page: 9999 }));
    expect(last.page).toBe(all.totalPages);
    expect(last.items.length).toBeGreaterThan(0);
  });
});
