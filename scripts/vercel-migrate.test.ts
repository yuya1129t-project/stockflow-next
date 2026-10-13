import { describe, expect, it } from "vitest";

import { planDeployMigration } from "./vercel-migrate";

const DIRECT = "postgresql://u:p@ep-example.ap-southeast-1.aws.neon.tech/db";

describe("planDeployMigration", () => {
  it("本番（VERCEL_ENV=production）で DIRECT_URL があればマイグレーションする", () => {
    expect(
      planDeployMigration({ VERCEL_ENV: "production", DIRECT_URL: DIRECT }),
    ).toEqual({ action: "migrate" });
  });

  it("本番で DIRECT_URL が未設定・空ならエラー", () => {
    expect(planDeployMigration({ VERCEL_ENV: "production" }).action).toBe(
      "error",
    );
    expect(
      planDeployMigration({ VERCEL_ENV: "production", DIRECT_URL: "" }).action,
    ).toBe("error");
  });

  it("プレビュー・ローカル（VERCEL_ENV が production 以外・未設定）は何もしない", () => {
    expect(
      planDeployMigration({ VERCEL_ENV: "preview", DIRECT_URL: DIRECT }).action,
    ).toBe("skip");
    expect(planDeployMigration({ VERCEL_ENV: "development" }).action).toBe(
      "skip",
    );
    expect(planDeployMigration({}).action).toBe("skip");
  });
});
