/**
 * DB を消去・初期化する操作（シード投入・migrate reset・テスト用 DB のリセット）の前に、
 * 接続先が安全かを判定する共通モジュール。
 *
 * - 接続 URL はパースして host・port・DB 名に正規化して比べる（認証情報やクエリの違いでは判定を変えない）
 * - ローカル（localhost／127.0.0.1／::1）以外は、STOCKFLOW_ALLOW_DESTRUCTIVE_SEED=1 がない限り拒否する
 *   （デモ環境の定期リセットのジョブでだけ設定する想定）
 */

/** ローカル以外の DB への破壊操作を許可する環境変数 */
export const ALLOW_DESTRUCTIVE_ENV = "STOCKFLOW_ALLOW_DESTRUCTIVE_SEED";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export interface DbTarget {
  /** 小文字・IPv6 の角括弧なし */
  host: string;
  port: string;
  database: string;
  /** URL の schema パラメータ（既定 public） */
  schema: string;
}

export type GuardResult =
  { ok: true; target: DbTarget } | { ok: false; reason: string };

type Env = Record<string, string | undefined>;

/** 接続 URL を host・port・DB 名に正規化する（パスワードは保持しない） */
export function parseDbUrl(url: string): DbTarget {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("DB の接続 URL を解釈できません");
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error(
      `PostgreSQL の接続 URL ではありません（${parsed.protocol}）`,
    );
  }
  return {
    host: parsed.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1"),
    port: parsed.port || "5432",
    database: decodeURIComponent(parsed.pathname.replace(/^\//, "")),
    schema: parsed.searchParams.get("schema") ?? "public",
  };
}

/** 表示用の host:port/db（パスワードは含めない） */
export function formatDbTarget(target: DbTarget): string {
  const host = target.host.includes(":") ? `[${target.host}]` : target.host;
  return `${host}:${target.port}/${target.database}`;
}

export function isLocalHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/** 同じ DB を指すか（ループバックの別名は同じホストとみなす） */
export function isSameDb(a: DbTarget, b: DbTarget): boolean {
  const hostKey = (host: string) => (isLocalHost(host) ? "loopback" : host);
  return (
    hostKey(a.host) === hostKey(b.host) &&
    a.port === b.port &&
    a.database === b.database
  );
}

/** データを消去する操作（シード・migrate reset）を、この接続先に対して行ってよいか */
export function checkDestructiveTarget(
  url: string | undefined,
  env: Env = process.env,
): GuardResult {
  if (!url) {
    return { ok: false, reason: "接続 URL が設定されていません" };
  }
  let target: DbTarget;
  try {
    target = parseDbUrl(url);
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  if (!isLocalHost(target.host) && env[ALLOW_DESTRUCTIVE_ENV] !== "1") {
    return {
      ok: false,
      reason: `ローカル以外の DB（${formatDbTarget(target)}）のデータは消去しません。意図した操作なら ${ALLOW_DESTRUCTIVE_ENV}=1 を設定してください`,
    };
  }
  return { ok: true, target };
}

/**
 * テスト用 DB（DATABASE_URL_TEST）として使ってよいか。
 * 破壊操作の条件に加えて、DB 名が `_test` で終わり、開発用 DB（DATABASE_URL）と別の DB であること。
 */
export function checkTestDbTarget(
  testUrl: string | undefined,
  devUrl: string | undefined,
  env: Env = process.env,
): GuardResult {
  if (!testUrl) {
    return {
      ok: false,
      reason:
        "環境変数 DATABASE_URL_TEST が設定されていません（cp .env.example .env で作成できます）",
    };
  }
  const result = checkDestructiveTarget(testUrl, env);
  if (!result.ok) return result;
  const { target } = result;
  if (!target.database.endsWith("_test")) {
    return {
      ok: false,
      reason: `テスト用 DB の名前は _test で終わる必要があります（${formatDbTarget(target)}）`,
    };
  }
  if (devUrl) {
    let dev: DbTarget | undefined;
    try {
      dev = parseDbUrl(devUrl);
    } catch {
      // 開発用 URL が解釈できなければ比較しない（テスト用 URL の検査は済んでいる）
    }
    if (dev && isSameDb(target, dev)) {
      return {
        ok: false,
        reason: `DATABASE_URL_TEST が開発用 DB（DATABASE_URL）と同じ DB を指しています（${formatDbTarget(target)}）`,
      };
    }
  }
  return result;
}
