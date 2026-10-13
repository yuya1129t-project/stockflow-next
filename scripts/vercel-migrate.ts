/**
 * Vercel のビルド（`pnpm vercel-build`）で、`next build` の前にマイグレーションを適用する。docs/deploy.md
 *
 * - 本番（VERCEL_ENV=production）のときだけ `prisma migrate deploy` を実行する。
 *   プレビュー（PR のブランチ）のビルドでは実行しない（未マージのマイグレーションを本番の DB に当てないため）
 * - 本番では直接接続の DIRECT_URL を必須にする（Neon のプール接続（PgBouncer）経由ではマイグレーションしない）
 * - ローカルで `pnpm vercel-build` を実行しても VERCEL_ENV がないので何もしない（`pnpm build` と同じ）
 */
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

type Env = Record<string, string | undefined>;

export type MigrationPlan =
  | { action: "skip"; message: string }
  | { action: "migrate" }
  | { action: "error"; message: string };

export function planDeployMigration(env: Env): MigrationPlan {
  if (env.VERCEL_ENV !== "production") {
    return {
      action: "skip",
      message: `本番のビルドではないので、マイグレーションは適用しません（VERCEL_ENV=${env.VERCEL_ENV ?? "未設定"}）`,
    };
  }
  if (!env.DIRECT_URL) {
    return {
      action: "error",
      message:
        "環境変数 DIRECT_URL が設定されていません（Neon の直接接続の URL。docs/deploy.md）",
    };
  }
  return { action: "migrate" };
}

function main() {
  const plan = planDeployMigration(process.env);
  if (plan.action === "skip") {
    console.log(plan.message);
    return;
  }
  if (plan.action === "error") {
    console.error(`中止しました: ${plan.message}`);
    process.exit(1);
  }
  // prisma.config.ts が DIRECT_URL を優先して使う
  const result = spawnSync("prisma", ["migrate", "deploy"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
