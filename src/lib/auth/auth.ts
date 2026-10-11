/**
 * Better Auth の設定（メール＋パスワード、Prisma アダプター、DB セッション）。サーバー専用。
 *
 * - role / isActive は additionalFields に input: false で登録（クライアントから設定させない）
 * - 公開のサインアップは無効（ユーザー登録は admin が行う。#10）
 * - 無効ユーザー（isActive = false）は、セッション作成前のフックでログインを拒否する
 * - 既存セッションを持つユーザーが無効化された場合に備え、セッション取得（/get-session）のたびに
 *   isActive を確認し、無効ならセッションを削除して「未ログイン」として返す
 *   （cookieCache は使わないので、セッション取得のたびに DB から user を読み直す）
 * - ログインは操作履歴（AuditLog）に記録する（spec §3）
 * - ログインの試行回数を制限する（rateLimit。HTTP の /api/auth/* だけに効くので、画面のログインも
 *   HTTP の /api/auth/sign-in/email を経由する）。カウンターは複数インスタンスで共有できるよう DB に置く
 */
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
import { nextCookies } from "better-auth/next-js";

import type { PrismaClient } from "@/generated/prisma/client";
import { getPrisma } from "@/lib/db";

import { USER_INACTIVE_CODE } from "./constants";
import { ROLES } from "./permissions";

/** ログインの試行回数の上限（同じ IP から 60 秒に 5 回まで） */
export const SIGN_IN_RATE_LIMIT = { window: 60, max: 5 } as const;

/** テストで設定の一部を切り替えるためのオプション（アプリからは指定しない） */
export interface CreateAuthOptions {
  /** 試行回数の制限。既定はテスト（NODE_ENV=test）以外で有効。本番では常に有効 */
  rateLimit?: boolean;
  /** サインアップを有効にする（input: false の確認用。アプリでは常に無効） */
  enableSignUp?: boolean;
}

export function createAuth(
  prisma: PrismaClient,
  options: CreateAuthOptions = {},
) {
  const isProduction = process.env.NODE_ENV === "production";
  return betterAuth({
    // secret / baseURL は環境変数 BETTER_AUTH_SECRET / BETTER_AUTH_URL から読む
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !options.enableSignUp,
    },
    rateLimit: {
      enabled:
        isProduction || (options.rateLimit ?? process.env.NODE_ENV !== "test"),
      // Vercel の複数インスタンスでも共有できるよう DB（rate_limit テーブル）に置く
      storage: "database",
      customRules: { "/sign-in/email": SIGN_IN_RATE_LIMIT },
    },
    advanced: {
      ipAddress: {
        // Vercel は x-forwarded-for をクライアントの IP で上書きする（外部から送られた値は転送しない）。
        // Vercel 以外のプロキシの背後で動かす場合は、そのプロキシに合わせて見直す
        ipAddressHeaders: ["x-forwarded-for"],
      },
    },
    session: {
      // セッション取得のたびに DB の user（isActive）を確認するため、Cookie へのキャッシュは使わない
      cookieCache: { enabled: false },
    },
    user: {
      additionalFields: {
        role: {
          type: [...ROLES],
          required: false,
          defaultValue: "viewer",
          input: false,
        },
        isActive: {
          type: "boolean",
          required: false,
          defaultValue: true,
          input: false,
        },
      },
    },
    databaseHooks: {
      session: {
        create: {
          // パスワードの確認が済んだあと、セッションを作る直前に呼ばれる
          async before(session) {
            const user = await prisma.user.findUnique({
              where: { id: session.userId },
              select: { isActive: true },
            });
            if (!user?.isActive) {
              throw APIError.from("FORBIDDEN", {
                code: USER_INACTIVE_CODE,
                message: "このアカウントは無効になっています",
              });
            }
          },
          async after(session) {
            await prisma.auditLog.create({
              data: {
                userId: session.userId,
                action: "login",
                targetType: "user",
                targetId: session.userId,
                summary: "ログインしました",
              },
            });
          },
        },
      },
    },
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/get-session") return;
        const returned = ctx.context.returned;
        if (
          !returned ||
          typeof returned !== "object" ||
          !("user" in returned)
        ) {
          return;
        }
        const { session, user } = returned as {
          session: { token: string };
          user: { isActive?: unknown };
        };
        if (user.isActive === true) return;
        // 無効化されたユーザーの既存セッション: 削除して未ログイン扱いにする
        await ctx.context.internalAdapter.deleteSession(session.token);
        deleteSessionCookie(ctx);
        return ctx.json(null);
      }),
    },
    // Server Actions から auth.api を呼んだときに Cookie を設定する（プラグインの最後に置く）
    plugins: [nextCookies()],
  });
}

export type Auth = ReturnType<typeof createAuth>;

const globalForAuth = globalThis as unknown as { auth?: Auth };

/** アプリで使う Better Auth（DATABASE_URL の DB）。最初に使われたときに作る */
export function getAuth(): Auth {
  globalForAuth.auth ??= createAuth(getPrisma());
  return globalForAuth.auth;
}
