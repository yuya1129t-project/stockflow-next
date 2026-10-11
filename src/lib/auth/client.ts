/**
 * ブラウザから使う Better Auth のクライアント（/api/auth/* を同じオリジンに送る）。
 * ログインは HTTP の /api/auth/sign-in/email を経由させ、Better Auth の試行回数制限を効かせる
 */
import { createAuthClient } from "better-auth/client";

export const authClient = createAuthClient();
