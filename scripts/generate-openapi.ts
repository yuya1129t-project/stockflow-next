/**
 * OpenAPI 3.1 の定義のスナップショット（docs/openapi.json）を書き出す: pnpm openapi:generate
 *
 * 定義の本体は src/lib/api/v1/openapi.ts（/api/v1/openapi.json と同じもの）。API を変えたら実行してコミットする
 * （② Laravel・③ FastAPI 版で同じ API 仕様を使うため。食い違いは単体テスト src/lib/api/v1/openapi.test.ts で検出する）
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { serializeOpenApiDocument } from "../src/lib/api/v1/openapi";

const target = fileURLToPath(new URL("../docs/openapi.json", import.meta.url));
writeFileSync(target, serializeOpenApiDocument());
console.log(`書き出しました: docs/openapi.json`);
