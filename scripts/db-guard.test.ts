import { describe, expect, it } from "vitest";

import {
  checkDestructiveTarget,
  checkTestDbTarget,
  formatDbTarget,
  parseDbUrl,
} from "./db-guard";

const DEV =
  "postgresql://stockflow:stockflow@localhost:54329/stockflow?schema=public";
const TEST =
  "postgresql://stockflow:stockflow@localhost:54329/stockflow_test?schema=public";
const noEnv = {};

describe("parseDbUrl / formatDbTarget", () => {
  it("host・port・DB 名に正規化し、パスワードを含めずに表示する", () => {
    const target = parseDbUrl("postgresql://u:secret@LocalHost/stockflow_test");
    expect(target).toEqual({
      host: "localhost",
      port: "5432",
      database: "stockflow_test",
      schema: "public",
    });
    expect(formatDbTarget(target)).toBe("localhost:5432/stockflow_test");
    expect(formatDbTarget(parseDbUrl("postgres://u:p@[::1]:5433/db"))).toBe(
      "[::1]:5433/db",
    );
  });

  it("PostgreSQL 以外の URL は例外", () => {
    expect(() => parseDbUrl("mysql://localhost/db")).toThrow();
    expect(() => parseDbUrl("not a url")).toThrow();
  });
});

describe("checkDestructiveTarget", () => {
  it("ローカル（localhost／127.0.0.1／::1）は許可", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      expect(
        checkDestructiveTarget(`postgresql://u:p@${host}:5432/stockflow`, noEnv)
          .ok,
      ).toBe(true);
    }
  });

  it("ローカル以外のホストは拒否し、STOCKFLOW_ALLOW_DESTRUCTIVE_SEED=1 のときだけ許可", () => {
    const url = "postgresql://u:p@db.example.com:5432/stockflow";
    const denied = checkDestructiveTarget(url, noEnv);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.reason).toContain("db.example.com:5432/stockflow");
      expect(denied.reason).not.toContain("u:p");
    }
    expect(
      checkDestructiveTarget(url, { STOCKFLOW_ALLOW_DESTRUCTIVE_SEED: "true" })
        .ok,
    ).toBe(false);
    expect(
      checkDestructiveTarget(url, { STOCKFLOW_ALLOW_DESTRUCTIVE_SEED: "1" }).ok,
    ).toBe(true);
  });

  it("URL がない・解釈できないときは拒否", () => {
    expect(checkDestructiveTarget(undefined, noEnv).ok).toBe(false);
    expect(checkDestructiveTarget("::", noEnv).ok).toBe(false);
  });
});

describe("checkTestDbTarget", () => {
  it("_test で終わるローカルの別 DB は許可", () => {
    expect(checkTestDbTarget(TEST, DEV, noEnv).ok).toBe(true);
    expect(checkTestDbTarget(TEST, undefined, noEnv).ok).toBe(true);
  });

  it("DB 名が _test で終わらなければ拒否（latest・contest・test_db など）", () => {
    for (const name of [
      "latest",
      "contest",
      "test_db",
      "stockflow",
      "stockflow_testing",
    ]) {
      const url = `postgresql://u:p@localhost:54329/${name}`;
      expect(checkTestDbTarget(url, DEV, noEnv).ok, name).toBe(false);
    }
  });

  it("クエリや認証情報が違っても、開発用 DB と同じ host・port・DB なら拒否", () => {
    const dev =
      "postgresql://stockflow:stockflow@localhost:54329/stockflow_test?schema=public";
    const variants = [
      "postgresql://stockflow:stockflow@localhost:54329/stockflow_test?schema=public&application_name=x",
      "postgresql://other:pass@localhost:54329/stockflow_test",
      "postgres://stockflow:stockflow@127.0.0.1:54329/stockflow_test",
      "postgresql://stockflow:stockflow@[::1]:54329/stockflow_test?sslmode=disable",
    ];
    for (const url of variants) {
      expect(checkTestDbTarget(url, dev, noEnv).ok, url).toBe(false);
    }
  });

  it("ポートが違えば別の DB とみなす", () => {
    const dev = "postgresql://u:p@localhost:54329/stockflow_test";
    expect(
      checkTestDbTarget(
        "postgresql://u:p@localhost:5432/stockflow_test",
        dev,
        noEnv,
      ).ok,
    ).toBe(true);
  });

  it("ローカル以外のホストは拒否", () => {
    const url = "postgresql://u:p@db.example.com:5432/stockflow_test";
    expect(checkTestDbTarget(url, DEV, noEnv).ok).toBe(false);
  });

  it("DATABASE_URL_TEST が未設定なら拒否", () => {
    expect(checkTestDbTarget(undefined, DEV, noEnv).ok).toBe(false);
  });
});
