/**
 * ユーザー管理・API トークンの更新系。サーバー側でだけ使う。docs/spec.md §2・§3・§6-2
 *
 * - すべて admin のみ（user:manage）。Server Action（checkActionPermission）で検査したうえで、
 *   ここでも操作したユーザーのロールを検査する（二重の確認。結合テストはこの関数を直接呼ぶ）
 * - 自分自身の無効化・ロール変更は不可（spec §3。管理者がいなくなる・自分を締め出すのを防ぐ）
 * - デモ用アカウント（prisma/seed-data.ts の DEMO_USERS）は無効化・ロール変更・パスワード再設定を拒否する
 *   （公開デモでは admin のパスワードも公開するため、閲覧者が他の閲覧者のデモを壊せないようにする）
 * - 更新と操作履歴（AuditLog）は同じトランザクションで書く。トランザクションの中で、操作する admin と対象の行を
 *   id の順に FOR NO KEY UPDATE でロックし（同じユーザーへの操作（無効化とトークン発行など）を直列にする）、
 *   操作する admin がいまも有効な admin かを確かめ直す（認可の後に降格・無効化されていたら拒否）
 * - 有効な admin が 0 人になる変更（最後の有効な admin の降格・無効化）は拒否する。admin の顔ぶれを変えうる操作
 *   （ロール変更・無効化／再有効化）はアドバイザリロックで直列にしてから数える
 */
import { hashPassword } from "better-auth/crypto";

import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { generateApiToken } from "@/lib/auth/api-token";
import { ROLE_LABELS, type Role } from "@/lib/auth/permissions";
import {
  authErrorMessage,
  authorize,
  type SessionUser,
} from "@/lib/auth/session";

import { DEMO_USERS } from "../../../prisma/seed-data";
import {
  apiTokenCreateSchema,
  passwordResetSchema,
  userCreateSchema,
  userFieldErrors,
  userRoleSchema,
  type UserFieldErrors,
} from "./schema";

export type UserMutationError = {
  ok: false;
  error: string;
  fieldErrors?: UserFieldErrors;
};
export type UserMutationResult<T = null> =
  { ok: true; data: T } | UserMutationError;

/** 操作履歴の targetType（ログインの記録と同じ "user"） */
export const USER_TARGET_TYPE = "user";
export const API_TOKEN_TARGET_TYPE = "api_token";

/** 1 ユーザーが持てる有効な（失効していない）トークンの数の上限（公開デモで無制限に作られないように） */
export const MAX_ACTIVE_API_TOKENS_PER_USER = 10;

const DEMO_USER_IDS: ReadonlySet<string> = new Set(DEMO_USERS.map((u) => u.id));

/**
 * デモ用アカウント（シードの admin／staff／viewer）か。ID で判定する
 * （ID はシードで固定・画面から変えられない。メールアドレスで判定すると、メール変更で保護を外せてしまう）
 */
export function isProtectedDemoUser(userId: string): boolean {
  return DEMO_USER_IDS.has(userId);
}

export const DEMO_USER_PROTECTED_MESSAGE =
  "デモ用アカウントは変更できません（ほかの閲覧者もデモで使うため）。新しいユーザーを登録して試してください";

const SELF_MESSAGES = {
  role: "自分自身のロールは変更できません",
  deactivate: "自分自身を無効にすることはできません",
} as const;

const NOT_FOUND: UserMutationError = {
  ok: false,
  error: "ユーザーが見つかりません",
};
const DONE: UserMutationResult = { ok: true, data: null };
const FORBIDDEN: UserMutationError = {
  ok: false,
  error: authErrorMessage(403),
};
const TOKEN_NOT_FOUND: UserMutationError = {
  ok: false,
  error: "API トークンが見つかりません",
};
export const LAST_ADMIN_MESSAGE =
  "有効な管理者が 1 人もいなくなるため、この変更はできません";

/** PostgreSQL の integer（int4）の上限。これを超える ID は DB に渡さない（例外にせず「見つかりません」） */
const MAX_INT4 = 2_147_483_647;

export function isTokenId(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= MAX_INT4
  );
}

const INVALID_INPUT_MESSAGE =
  "入力内容に誤りがあります。各項目を確認してください";

function checkAdmin(
  user: SessionUser | null,
): { ok: true; user: SessionUser } | UserMutationError {
  const result = authorize(user, "user:manage");
  return result.ok
    ? result
    : { ok: false, error: authErrorMessage(result.status) };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

function invalid(fieldErrors: UserFieldErrors): UserMutationError {
  return { ok: false, error: INVALID_INPUT_MESSAGE, fieldErrors };
}

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

interface LockedUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  isActive: boolean;
}

/** admin の顔ぶれを変えうる操作を直列にするアドバイザリロック（トランザクションの終わりで外れる） */
const ADMIN_SET_LOCK_KEY = "stockflow:admin-set";

async function lockAdminSet(tx: Tx): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ADMIN_SET_LOCK_KEY}))`;
}

/**
 * 操作する admin（actor）と対象の行を id の順に FOR NO KEY UPDATE でロックしてから読み、
 * actor がいまも有効な admin かを確かめ直す（id の順にそろえるのは、2 人の admin が互いを操作したときのデッドロックを避けるため）。
 * 対象がなければ target は null
 */
async function lockActorAndTarget(
  tx: Tx,
  actorId: string,
  targetId: string,
): Promise<{ ok: true; target: LockedUser | null } | UserMutationError> {
  for (const id of [...new Set([actorId, targetId])].sort()) {
    await tx.$queryRaw`SELECT "id" FROM "user" WHERE "id" = ${id} FOR NO KEY UPDATE`;
  }
  const rows = await tx.user.findMany({
    where: { id: { in: [actorId, targetId] } },
    select: { id: true, name: true, email: true, role: true, isActive: true },
  });
  const actor = rows.find((u) => u.id === actorId);
  if (!actor?.isActive || actor.role !== "admin") return FORBIDDEN;
  return { ok: true, target: rows.find((u) => u.id === targetId) ?? null };
}

/** 変更後に有効な admin が 0 人になるか（lockAdminSet の後に呼ぶ） */
async function removesLastAdmin(
  tx: Tx,
  target: LockedUser,
  next: { role: Role; isActive: boolean },
): Promise<boolean> {
  const wasAdmin = target.isActive && target.role === "admin";
  const staysAdmin = next.isActive && next.role === "admin";
  if (!wasAdmin || staysAdmin) return false;
  const others = await tx.user.count({
    where: { isActive: true, role: "admin", id: { not: target.id } },
  });
  return others === 0;
}

function userLabel(user: { name: string; email: string }): string {
  return `「${user.name}」（${user.email}）`;
}

/** ユーザーを登録する（Better Auth と同じ方式でハッシュ化した credential アカウントを作る） */
export async function createUser(
  db: PrismaClient,
  actor: SessionUser | null,
  input: unknown,
): Promise<UserMutationResult<{ id: string }>> {
  const auth = checkAdmin(actor);
  if (!auth.ok) return auth;
  const parsed = userCreateSchema.safeParse(input);
  if (!parsed.success) return invalid(userFieldErrors(parsed.error));
  const { name, email, role, password } = parsed.data;
  // ハッシュ化（scrypt）は遅いので、トランザクションの外で行う
  const passwordHash = await hashPassword(password);
  const id = crypto.randomUUID();
  try {
    const created = await db.$transaction(async (tx) => {
      const locked = await lockActorAndTarget(tx, auth.user.id, auth.user.id);
      if (!locked.ok) return locked;
      await tx.user.create({
        data: {
          id,
          name,
          email,
          role,
          isActive: true,
          // admin が登録したアドレスとして扱う（確認メールの仕組みは持たない）
          emailVerified: true,
          accounts: {
            create: {
              id: `${id}_credential`,
              // Better Auth のメール＋パスワード認証と同じく accountId = userId
              accountId: id,
              providerId: "credential",
              password: passwordHash,
            },
          },
        },
      });
      await tx.auditLog.create({
        data: {
          userId: auth.user.id,
          action: "create",
          targetType: USER_TARGET_TYPE,
          targetId: id,
          summary: `ユーザー${userLabel({ name, email })}を${ROLE_LABELS[role]}として登録しました`,
        },
      });
      return null;
    });
    if (created) return created;
    return { ok: true, data: { id } };
  } catch (error) {
    if (isUniqueViolation(error)) {
      const message = `メールアドレス「${email}」はすでに登録されています`;
      return { ok: false, error: message, fieldErrors: { email: [message] } };
    }
    throw error;
  }
}

/** ロールを変更する（自分自身・デモ用アカウントは不可） */
export async function changeUserRole(
  db: PrismaClient,
  actor: SessionUser | null,
  userId: string,
  input: unknown,
): Promise<UserMutationResult> {
  const auth = checkAdmin(actor);
  if (!auth.ok) return auth;
  const parsed = userRoleSchema.safeParse(input);
  if (!parsed.success) return invalid(userFieldErrors(parsed.error));
  const role: Role = parsed.data.role;
  if (userId === auth.user.id) return { ok: false, error: SELF_MESSAGES.role };
  if (isProtectedDemoUser(userId)) {
    return { ok: false, error: DEMO_USER_PROTECTED_MESSAGE };
  }
  return db.$transaction(async (tx): Promise<UserMutationResult> => {
    await lockAdminSet(tx);
    const locked = await lockActorAndTarget(tx, auth.user.id, userId);
    if (!locked.ok) return locked;
    const target = locked.target;
    if (!target) return NOT_FOUND;
    if (target.role === role) return DONE;
    if (
      await removesLastAdmin(tx, target, { role, isActive: target.isActive })
    ) {
      return { ok: false, error: LAST_ADMIN_MESSAGE };
    }
    await tx.user.update({ where: { id: userId }, data: { role } });
    await tx.auditLog.create({
      data: {
        userId: auth.user.id,
        action: "role_change",
        targetType: USER_TARGET_TYPE,
        targetId: userId,
        summary: `ユーザー${userLabel(target)}のロールを変更しました（${ROLE_LABELS[target.role]} → ${ROLE_LABELS[role]}）`,
      },
    });
    return DONE;
  });
}

/**
 * ユーザーを無効化（isActive = false）または再有効化する（自分自身・デモ用アカウントは不可）。
 * 無効化では、そのユーザーの全セッションを削除し、有効な API トークンをすべて失効させる
 * （再有効化してもトークンは戻らない。必要なら発行し直す）。
 * 再有効化でも全セッションを削除する: 無効化と同時に進んでいたログインが無効化の後にセッションを作っていた場合
 * （Better Auth の検証と INSERT の間は止められない）、そのセッションが再有効化で使えるようにならないようにする
 */
export async function setUserActive(
  db: PrismaClient,
  actor: SessionUser | null,
  userId: string,
  isActive: boolean,
): Promise<UserMutationResult> {
  const auth = checkAdmin(actor);
  if (!auth.ok) return auth;
  if (userId === auth.user.id) {
    return { ok: false, error: SELF_MESSAGES.deactivate };
  }
  if (isProtectedDemoUser(userId)) {
    return { ok: false, error: DEMO_USER_PROTECTED_MESSAGE };
  }
  return db.$transaction(async (tx): Promise<UserMutationResult> => {
    await lockAdminSet(tx);
    const locked = await lockActorAndTarget(tx, auth.user.id, userId);
    if (!locked.ok) return locked;
    const target = locked.target;
    if (!target) return NOT_FOUND;
    if (target.isActive === isActive) return DONE;
    if (await removesLastAdmin(tx, target, { role: target.role, isActive })) {
      return { ok: false, error: LAST_ADMIN_MESSAGE };
    }
    await tx.user.update({ where: { id: userId }, data: { isActive } });
    const sessions = await tx.session.deleteMany({ where: { userId } });
    let detail = `（セッション ${sessions.count} 件を削除）`;
    if (!isActive) {
      const tokens = await tx.apiToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      detail = `（ログイン中のセッション ${sessions.count} 件を終了、API トークン ${tokens.count} 件を失効）`;
    }
    await tx.auditLog.create({
      data: {
        userId: auth.user.id,
        action: isActive ? "reactivate" : "deactivate",
        targetType: USER_TARGET_TYPE,
        targetId: userId,
        summary: `ユーザー${userLabel(target)}を${isActive ? "再度有効に" : "無効に"}しました${detail}`,
      },
    });
    return DONE;
  });
}

/**
 * パスワードを再設定する（admin が新しいパスワードを設定する。デモ用アカウントは不可）。
 * 対象のセッションは、自分自身の再設定でもすべて終了する（古いパスワードで入った人・漏れた Cookie を締め出す。
 * 自分の場合は操作したセッションも終わるので、画面はログイン画面へ戻す）。
 * revokeTokens（既定 true）なら、対象の有効な API トークンも同じトランザクションで失効させる
 */
export async function resetUserPassword(
  db: PrismaClient,
  actor: SessionUser | null,
  userId: string,
  input: unknown,
): Promise<UserMutationResult> {
  const auth = checkAdmin(actor);
  if (!auth.ok) return auth;
  if (isProtectedDemoUser(userId)) {
    return { ok: false, error: DEMO_USER_PROTECTED_MESSAGE };
  }
  const parsed = passwordResetSchema.safeParse(input);
  if (!parsed.success) return invalid(userFieldErrors(parsed.error));
  const { password, revokeTokens } = parsed.data;
  const passwordHash = await hashPassword(password);
  return db.$transaction(async (tx): Promise<UserMutationResult> => {
    const locked = await lockActorAndTarget(tx, auth.user.id, userId);
    if (!locked.ok) return locked;
    const target = locked.target;
    if (!target) return NOT_FOUND;
    const updated = await tx.account.updateMany({
      where: { userId, providerId: "credential" },
      data: { password: passwordHash },
    });
    if (updated.count === 0) {
      await tx.account.create({
        data: {
          id: `${userId}_credential`,
          accountId: userId,
          providerId: "credential",
          userId,
          password: passwordHash,
        },
      });
    }
    const sessions = await tx.session.deleteMany({ where: { userId } });
    let detail = `（ログイン中のセッション ${sessions.count} 件を終了`;
    if (revokeTokens) {
      const tokens = await tx.apiToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      detail += `、API トークン ${tokens.count} 件を失効`;
    }
    detail += "）";
    await tx.auditLog.create({
      data: {
        userId: auth.user.id,
        action: "password_reset",
        targetType: USER_TARGET_TYPE,
        targetId: userId,
        // パスワード（平文・ハッシュ）は履歴に残さない
        summary: `ユーザー${userLabel(target)}のパスワードを再設定しました${detail}`,
      },
    });
    return DONE;
  });
}

/**
 * API トークンを発行する。平文（token）は戻り値でだけ返し、DB にはハッシュだけを保存する。
 * 無効なユーザーには発行しない。デモ用アカウントにも発行できる（REST API を試せるように）
 */
export async function issueApiToken(
  db: PrismaClient,
  actor: SessionUser | null,
  userId: string,
  input: unknown,
): Promise<UserMutationResult<{ id: number; token: string }>> {
  const auth = checkAdmin(actor);
  if (!auth.ok) return auth;
  const parsed = apiTokenCreateSchema.safeParse(input);
  if (!parsed.success) return invalid(userFieldErrors(parsed.error));
  const { name } = parsed.data;
  const { token, tokenHash } = generateApiToken();
  return db.$transaction(
    async (tx): Promise<UserMutationResult<{ id: number; token: string }>> => {
      const locked = await lockActorAndTarget(tx, auth.user.id, userId);
      if (!locked.ok) return locked;
      const target = locked.target;
      if (!target) return NOT_FOUND;
      if (!target.isActive) {
        return {
          ok: false,
          error: "無効なユーザーには API トークンを発行できません",
        };
      }
      const active = await tx.apiToken.count({
        where: { userId, revokedAt: null },
      });
      if (active >= MAX_ACTIVE_API_TOKENS_PER_USER) {
        return {
          ok: false,
          error: `有効な API トークンは 1 ユーザーにつき ${MAX_ACTIVE_API_TOKENS_PER_USER} 件までです。使っていないトークンを失効させてから発行してください`,
        };
      }
      const created = await tx.apiToken.create({
        data: { userId, name, tokenHash },
        select: { id: true },
      });
      await tx.auditLog.create({
        data: {
          userId: auth.user.id,
          action: "token_create",
          targetType: API_TOKEN_TARGET_TYPE,
          targetId: String(created.id),
          summary: `ユーザー${userLabel(target)}の API トークン「${name}」を発行しました`,
        },
      });
      return { ok: true, data: { id: created.id, token } };
    },
  );
}

/** API トークンを失効させる（revokedAt を設定する。行は消さない） */
export async function revokeApiToken(
  db: PrismaClient,
  actor: SessionUser | null,
  userId: string,
  tokenId: number,
): Promise<UserMutationResult> {
  const auth = checkAdmin(actor);
  if (!auth.ok) return auth;
  if (!isTokenId(tokenId)) return TOKEN_NOT_FOUND;
  return db.$transaction(async (tx): Promise<UserMutationResult> => {
    const locked = await lockActorAndTarget(tx, auth.user.id, userId);
    if (!locked.ok) return locked;
    const target = locked.target;
    const token = target
      ? await tx.apiToken.findFirst({ where: { id: tokenId, userId } })
      : null;
    if (!target || !token) return TOKEN_NOT_FOUND;
    if (token.revokedAt !== null) return DONE;
    await tx.apiToken.update({
      where: { id: tokenId },
      data: { revokedAt: new Date() },
    });
    await tx.auditLog.create({
      data: {
        userId: auth.user.id,
        action: "token_revoke",
        targetType: API_TOKEN_TARGET_TYPE,
        targetId: String(tokenId),
        summary: `ユーザー${userLabel(target)}の API トークン「${token.name}」を失効させました`,
      },
    });
    return DONE;
  });
}
