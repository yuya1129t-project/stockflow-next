/**
 * デモデータの日次リセット（GET /api/cron/reset-demo）。docs/spec.md §9、docs/deploy.md。
 *
 * Vercel Cron（vercel.json の crons。1 日 1 回）から呼ばれ、`pnpm db:seed` と同じ処理
 * （prisma/reset-demo-data.ts）でアプリのテーブルを空にしてシードを投入し直す。
 *
 * - 認証は `Authorization: Bearer <CRON_SECRET>`（Vercel Cron の仕様）。不一致・CRON_SECRET 未設定は 401
 * - 接続先は DATABASE_URL。ローカル以外の DB は STOCKFLOW_ALLOW_DESTRUCTIVE_SEED=1 がないと
 *   ガード（scripts/db-guard.ts）で拒否し、500 を返す（データには触れない）
 * - セッション・API トークン・ログインの試行回数（rate_limit）も消える（全員がログアウトされる）
 */
import { NextResponse } from "next/server";

import { isAuthorizedCronRequest } from "@/lib/cron/auth";

import {
  DemoResetRefusedError,
  resetDemoData,
} from "../../../../../prisma/reset-demo-data";

/**
 * 関数の実行時間の上限（秒）。リセットはローカルで 0.15〜0.25 秒。Neon の自動停止からの復帰（数秒）を
 * 見込んでも十分な値で、Vercel Hobby の上限（Fluid Compute なし 60 秒・あり 300 秒）を超えない
 */
export const maxDuration = 60;

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request, process.env.CRON_SECRET)) {
    return NextResponse.json(
      { ok: false, error: "認証に失敗しました" },
      { status: 401, headers: NO_STORE },
    );
  }

  const startedAt = Date.now();
  try {
    const result = await resetDemoData({ url: process.env.DATABASE_URL });
    const durationMs = Date.now() - startedAt;
    console.info(
      `デモデータをリセットしました（${result.target}、${durationMs}ms）`,
    );
    return NextResponse.json(
      { ok: true, ...result, durationMs },
      { headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof DemoResetRefusedError) {
      console.error(error.message);
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500, headers: NO_STORE },
      );
    }
    console.error("デモデータのリセットに失敗しました", error);
    return NextResponse.json(
      { ok: false, error: "デモデータのリセットに失敗しました" },
      { status: 500, headers: NO_STORE },
    );
  }
}
