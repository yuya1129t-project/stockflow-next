// Prisma CLI の設定（Prisma 7）。.env は自動で読まれないため dotenv で読み込む
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    // `prisma db seed` で実行する（migrate dev / reset では自動実行されない）
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // env() は未設定だと例外になり、DB 不要の `prisma generate`（postinstall・CI）まで失敗するため process.env を使う
    url: process.env.DATABASE_URL,
  },
});
