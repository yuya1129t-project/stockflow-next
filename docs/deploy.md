# デモ環境の公開手順（Vercel ＋ Neon）

StockFlow のデモを **Vercel（Hobby）＋ Neon（無料枠）** に公開する手順です。上から順に実行してください。

- アプリ側の準備（`vercel.json`・`pnpm vercel-build`・日次リセットの `/api/cron/reset-demo`）はリポジトリに入っています。ここでの作業は、各サービスの画面での設定だけです
- 画面の項目名は 2026-10 時点のものです。表記が変わっていたら、同じ意味の項目を選んでください
- **秘密の値（接続文字列・`BETTER_AUTH_SECRET`・`CRON_SECRET`）はリポジトリ・Issue・PR・スクリーンショットに書かないでください**（最後の「秘密の値の扱い」）

## 全体の構成

| 役割 | サービス | 設定 |
| --- | --- | --- |
| アプリ（Next.js） | Vercel（Hobby） | Functions のリージョン `sin1`（シンガポール。`vercel.json`） |
| DB（PostgreSQL 17） | Neon（Free） | リージョン AWS Asia Pacific (Singapore)（`aws-ap-southeast-1`） |
| 日次リセット | Vercel Cron | 毎日 18:00 UTC（日本時間 3 時台。`vercel.json`） |

アプリと DB を同じシンガポールに置くのは、1 画面で何度も DB に問い合わせるため、往復の遅延を小さくするためです（Vercel の既定のリージョンは米国東部）。

### 環境変数の一覧（Vercel の Production に設定する）

| 名前 | 値 | 作り方 |
| --- | --- | --- |
| `DATABASE_URL` | Neon の**プール接続**（ホスト名に `-pooler` が付く）の URL | 手順 1-3 |
| `DIRECT_URL` | Neon の**直接接続**（`-pooler` なし）の URL。マイグレーション用 | 手順 1-3 |
| `BETTER_AUTH_SECRET` | ランダムな 32 バイト以上の文字列 | `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | 公開 URL（例 `https://stockflow-next.vercel.app`）。末尾の `/` なし | 手順 2-3 |
| `CRON_SECRET` | ランダムな文字列（日次リセットの認証） | `openssl rand -hex 32` |
| `STOCKFLOW_ALLOW_DESTRUCTIVE_SEED` | `1` | 固定（デモ環境の DB のリセットを許可する） |
| `ENABLE_EXPERIMENTAL_COREPACK` | `1` | 固定（`package.json` の `packageManager` の pnpm を使う） |

`STOCKFLOW_SLACK_WEBHOOK_URL`（発注点割れの通知）は**設定しません**（未設定なら通知しない）。

## 1. Neon（DB）

### 1-1. アカウント作成

1. https://neon.tech を開き、「Sign up」から登録する（GitHub アカウントなどで登録できます）
2. プランは **Free** のまま（クレジットカードの登録は不要）

### 1-2. プロジェクト作成

1. 「New Project」（初回は登録直後に作成画面が出ます）
2. 次のように入力して作成する
   - **Project name:** `stockflow`（任意）
   - **Postgres version:** **17**（ローカル・CI と同じ）
   - **Cloud provider / Region:** **AWS** の **Asia Pacific (Singapore)**（`aws-ap-southeast-1`）
   - Database name は既定の `neondb` のままでよい

### 1-3. 接続文字列（2 つ）を控える

1. プロジェクトのダッシュボードで「**Connect**」を押す
2. Branch は `main`、Database は `neondb`、Role は既定（`neondb_owner`）のまま
3. 「**Connection pooling**」を **オン** にした状態の接続文字列 → `DATABASE_URL` に使う（ホスト名が `ep-xxxx-pooler.ap-southeast-1.aws.neon.tech` のように `-pooler` を含む）
4. 「**Connection pooling**」を **オフ** にした状態の接続文字列 → `DIRECT_URL` に使う（ホスト名に `-pooler` がない）
5. どちらも末尾の `sslmode=require` を **`sslmode=verify-full`** に書き換える（DB ドライバー（node-postgres）は `require` を `verify-full` として扱い、警告を出すため。意味は同じで、証明書を検証して暗号化します）。`channel_binding=require` は付いたままでかまいません（node-postgres は読みません）

```text
DATABASE_URL = postgresql://neondb_owner:********@ep-xxxx-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=verify-full&channel_binding=require
DIRECT_URL   = postgresql://neondb_owner:********@ep-xxxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=verify-full&channel_binding=require
```

接続文字列にはパスワードが含まれます。控えるのはパスワードマネージャーなど、リポジトリの外にしてください。

> **なぜ 2 つか:** Vercel の関数はリクエストのたびに増えたり止まったりするので、アプリは Neon の接続プール（PgBouncer）経由で接続します（`DATABASE_URL`）。マイグレーション（`prisma migrate deploy`）はプール経由では正しく動かない操作があるため、直接接続（`DIRECT_URL`）で行います（`prisma.config.ts` が `DIRECT_URL` を優先して使います）。

## 2. Vercel（アプリ）

### 2-1. アカウント作成

1. https://vercel.com を開き、「Sign Up」→ プランは **Hobby** → **Continue with GitHub** で登録する
2. GitHub 側で Vercel にリポジトリへのアクセスを許可する（`yuya1129t-project/stockflow-next` だけを選べば十分です）

### 2-2. リポジトリのインポート

1. ダッシュボードの「Add New…」→「Project」
2. 「Import Git Repository」で `stockflow-next` の「Import」
3. 設定画面で次を確認する（**まだ「Deploy」は押さない**）
   - **Project Name:** `stockflow-next`（公開 URL が `https://<Project Name>.vercel.app` になります）
   - **Framework Preset:** Next.js（自動で選ばれます）
   - **Root Directory:** `./`
   - **Build and Output Settings:** 変更しない。Build Command はリポジトリの `vercel.json` の `pnpm vercel-build`（`prisma migrate deploy` → `next build`）が使われます

### 2-3. 環境変数

同じ設定画面の「Environment Variables」に、上の「環境変数の一覧」の 7 つを入れる。

- 値を作るコマンド（ローカルのターミナルで実行し、出力をそのまま貼る）

  ```bash
  openssl rand -base64 32   # BETTER_AUTH_SECRET
  openssl rand -hex 32      # CRON_SECRET
  ```

- `BETTER_AUTH_URL` は `https://<Project Name>.vercel.app`（例 `https://stockflow-next.vercel.app`）。名前が使われていて別の URL になった場合は、手順 2-5 で直します
- インポート画面で入れた環境変数は全環境（Production・Preview・Development）に入ることがあります。デプロイ後に「Settings」→「Environment Variables」で、**すべて Production だけ**になっているか確認し、Preview・Development の分は外してください（プレビュー（PR のブランチ）から本番の DB に接続させないため）

### 2-4. デプロイ

1. 「Deploy」を押す。ビルドのログで次の順に進むことを確認する
   - `pnpm install`（`postinstall` で Prisma Client を生成）
   - `prisma migrate deploy`（初回は Neon の空の DB にテーブルを作る。`All migrations have been successfully applied.`）
   - `next build`
2. 完了したら「Continue to Dashboard」

この時点では DB にデータがない（ユーザーもいない）ので、まだログインできません。手順 3 でデータを入れます。

### 2-5. 公開 URL・リージョンの確認

1. プロジェクトの「Settings」→「Domains」で、公開 URL（`xxxx.vercel.app`）を確認する。`BETTER_AUTH_URL` と違っていたら、「Environment Variables」で `BETTER_AUTH_URL` を直し、「Deployments」→ 最新のデプロイの「…」→「**Redeploy**」（環境変数の変更は、新しいデプロイから反映されます）
2. 「Settings」→「Functions」の **Function Region** が **Singapore (sin1)** になっていることを確認する（`vercel.json` の `regions` で指定しています。Hobby でもリージョン 1 つの指定はできます）
3. 「Settings」→「Cron Jobs」に `/api/cron/reset-demo`（`0 18 * * *`）が表示されることを確認する

### 2-6. プレビューのビルドを止める（推奨）

Vercel は PR のブランチごとにプレビューをビルドします。プレビューには環境変数を入れていないので画面は動かず（マイグレーションも本番以外では実行しません）、意味がありません。

- 「Settings」→「Git」→「**Ignored Build Step**」で「**Only build production**」を選ぶ（main へのマージのときだけビルドする）

## 3. 初回のデータ投入

Neon の DB にデモデータ（シード）を入れます。**日次リセットと同じ処理（`/api/cron/reset-demo`）を 1 回呼ぶ方法を推奨します。** DB の接続文字列を手元のパソコンで扱わずに済み、日次リセットの設定（`CRON_SECRET`・`STOCKFLOW_ALLOW_DESTRUCTIVE_SEED`）の確認も兼ねられるためです。

### 方法 A（推奨）: Vercel の画面から Cron を実行する

1. 「Settings」→「Cron Jobs」→ `/api/cron/reset-demo` の「**Run**」を押す
2. 「View Logs」（または「Logs」）で `デモデータをリセットしました（ep-xxxx-pooler…:5432/neondb、NNNms）` が出ていれば成功

### 方法 B: curl で呼ぶ

`CRON_SECRET` をコマンドの履歴に残さないよう、`read -s` で入力してから呼びます。

```bash
read -rs CRON_SECRET   # Vercel に設定した CRON_SECRET を貼り付けて Enter（画面には表示されません）
curl -sS -H "Authorization: Bearer $CRON_SECRET" https://stockflow-next.vercel.app/api/cron/reset-demo
unset CRON_SECRET
```

成功すると次のような JSON が返ります（件数は固定、`durationMs` は所要時間）。

```json
{"ok":true,"target":"ep-xxxx-pooler.ap-southeast-1.aws.neon.tech:5432/neondb","counts":{"users":3,"partners":20,"products":50,"salesOrders":80,"purchaseOrders":40,"stockMovements":303},"durationMs":850}
```

| 応答 | 原因と対処 |
| --- | --- |
| 401 `認証に失敗しました` | `CRON_SECRET` が違う・未設定。Vercel の値を確認し、変えたら Redeploy |
| 500 `シードを中止しました: ローカル以外の DB …` | `STOCKFLOW_ALLOW_DESTRUCTIVE_SEED=1` が Production に入っていない。入れて Redeploy |
| 500 `デモデータのリセットに失敗しました` | DB に接続できない・テーブルがない。Vercel の「Logs」で詳細を見る（下の「トラブル時に見るところ」） |

> **ローカルからシードする方法は推奨しません。** `DIRECT_URL` と `STOCKFLOW_ALLOW_DESTRUCTIVE_SEED=1` を手元の `.env` やシェルに入れると、ほかのコマンド（`pnpm db:reset` など）まで本番の DB に向く危険があるためです。どうしても必要なときは、`.env` は変えずに 1 回のコマンドだけ `DATABASE_URL='<direct の URL>' STOCKFLOW_ALLOW_DESTRUCTIVE_SEED=1 pnpm db:seed` とし、実行後にシェルを閉じてください。

## 4. 動作確認

公開 URL（`https://stockflow-next.vercel.app` など）を開いて確認します。デモ用アカウントは README の「デモ」の節（パスワードはすべて `demo-pass-1234`）。

- [ ] ログイン画面が表示される（初回や 5 分以上アクセスがなかった後は、Neon の復帰で数秒かかることがあります）
- [ ] **admin** でログインできる。ダッシュボードに数値とグラフが出る。メニューに「ユーザー管理」「操作履歴」がある
- [ ] **staff** でログインし、受注を登録 → 確定 → 出荷できる。出荷した商品の「在庫」の現在庫が減り、入出庫履歴に出庫が記録される
- [ ] **viewer** でログインすると、登録・編集のボタンが出ない（閲覧と CSV 出力のみ）
- [ ] `/api-docs` がログインなしで開き、Swagger UI に API の一覧が表示される
- [ ] （任意）admin で「ユーザー管理」→ ユーザーの詳細 → API トークンを発行し、`curl -s -H "Authorization: Bearer <トークン>" https://<公開 URL>/api/v1/products?perPage=1` で JSON が返る。確認後はトークンを失効させる
- [ ] （任意）ブラウザの開発者ツール →「Application」→「Cookies」で、セッションの Cookie が `__Secure-better-auth.session_token`（Secure・HttpOnly）になっている（`BETTER_AUTH_URL` が `https://` なら自動でそうなります）

## 5. 日次リセットの確認

- 毎日 18:00 UTC（日本時間 3:00）の回に、Vercel Cron が `/api/cron/reset-demo` を呼びます。**Hobby では指定した時刻の 1 時間のうちのどこかで実行されます**（日本時間 3:00〜3:59 ごろ）
- 翌日に次のどちらかで確認する
  - 「Settings」→「Cron Jobs」→「View Logs」、または「Logs」でパス `/api/cron/reset-demo` を絞り込み、200 と `デモデータをリセットしました…` が出ている
  - 前日に登録したデータ（例: テスト用の商品）が消え、件数がシード直後（商品 50 など）に戻っている
- リセットで消えるもの: 閲覧者が登録・変更したデータ、操作履歴、**ログイン中のセッション（全員がログアウトされます）**、発行した API トークン、ログインの試行回数のカウンター。デモ用アカウント 3 つとシードデータは毎回同じ内容で作り直されます（日付はリセットした日を基準に過去約 90 日）

## 6. トラブル時に見るところ

| 症状 | 見るところ・対処 |
| --- | --- |
| ビルドが `pnpm install` で失敗する | ビルドのログ。`ENABLE_EXPERIMENTAL_COREPACK=1` が入っているか（pnpm の版が `package.json` の `packageManager` と違うと失敗します）。それでも失敗するときは「Settings」→「Build and Deployment」の Install Command を `npx pnpm@12.11.2 install --frozen-lockfile` に変える |
| ビルドが `中止しました: 環境変数 DIRECT_URL が設定されていません` で止まる | `DIRECT_URL` が Production に入っているか |
| ビルドが `prisma migrate deploy` で失敗する（`P1001` など） | `DIRECT_URL` の値（`-pooler` なしのホスト、パスワード、`sslmode`）。Neon の「Monitoring」でプロジェクトが動いているか |
| 画面が 500 になる | Vercel の「Logs」（関数のエラーが出ます）。`DATABASE_URL` が未設定・誤り、データ未投入（手順 3） |
| ログインできない（「メールアドレスまたはパスワードが正しくありません」） | データ未投入（手順 3）。閲覧者が登録したユーザーは日次リセットで消えます |
| 正しいパスワードでも「ログインできませんでした。時間をおいて…」と出る | `BETTER_AUTH_URL` と、開いている URL が違う（デプロイごとの URL `xxxx-<hash>.vercel.app` ではログインできません。公開 URL で開く）。直したら Redeploy |
| 「試行回数が多すぎます」 | 同じ IP から 60 秒に 5 回までの制限です。1 分待つ |
| 最初の表示が遅い | Neon の自動停止からの復帰（下の「無料枠の制限」）。2 回目からは速くなります |
| 日次リセットが動かない | 「Settings」→「Cron Jobs」に表示されているか（Production のデプロイにだけ登録されます）、Logs の 401／500（手順 3 の表） |

DB の中身は Neon の「Tables」で見られます（読むだけにしてください）。

## 7. 無料枠の制限

- **Neon（Free）**
  - 一定時間（既定 5 分）アクセスがないと DB が自動で停止し、次の接続で再開します。再開に数百ミリ秒〜数秒かかるので、しばらく使われていないデモの最初の表示は遅くなります（Free では自動停止を無効にできません）
  - ストレージと月あたりの計算時間に上限があります。デモの規模（数 MB）では通常超えませんが、上限を超えると翌月まで DB が使えなくなります。正確な値は Neon の料金ページで確認してください
- **Vercel（Hobby）**
  - **個人・非商用の利用に限られます。** 求人・案件の応募でポートフォリオとして見せる用途を想定しています（有償のサービスとして提供しない）
  - Cron は **1 日 1 回まで**、実行時刻は**指定した時刻の 1 時間のうちのどこか**です（正確な時刻は保証されません）。Cron は Production のデプロイでだけ動きます
  - 関数の実行時間には上限があります（`/api/cron/reset-demo` は `maxDuration = 60` 秒。リセットはローカルで 0.15〜0.25 秒、Neon でも数秒の想定です）
  - 帯域・関数の実行回数などに月の上限があります。デモの利用では通常超えません

## 8. 秘密の値の扱い

- 接続文字列・`BETTER_AUTH_SECRET`・`CRON_SECRET` は **Vercel の環境変数にだけ**置きます。リポジトリ（`.env.example`・README・このファイル）、Issue・PR・コミットメッセージ、スクリーンショットには書かないでください。`.env` は `.gitignore` 済みです
- 漏れたかもしれないときは
  - Neon: 「Roles」で `neondb_owner` のパスワードを再設定し、新しい接続文字列で `DATABASE_URL`・`DIRECT_URL` を更新して Redeploy
  - `BETTER_AUTH_SECRET`: 作り直して Redeploy（全員がログアウトされます）
  - `CRON_SECRET`: 作り直して Redeploy
- デモ用アカウントのパスワード（`demo-pass-1234`）は公開前提の値です（README・ログイン画面に記載）。デモ用アカウントはロール変更・無効化・パスワード再設定ができないよう保護しています

## 付録: アプリ側の仕組み

| ファイル | 内容 |
| --- | --- |
| `vercel.json` | Build Command（`pnpm vercel-build`）、Functions のリージョン（`sin1`）、Cron（`/api/cron/reset-demo` を `0 18 * * *`） |
| `scripts/vercel-migrate.ts` | `vercel-build` の前半。本番（`VERCEL_ENV=production`）でだけ `prisma migrate deploy` を実行（`DIRECT_URL` 必須）。プレビュー・ローカルでは何もしない |
| `prisma.config.ts` | Prisma CLI の接続先。`DIRECT_URL` があればそちら、なければ `DATABASE_URL` |
| `src/app/api/cron/reset-demo/route.ts` | 日次リセット。`Authorization: Bearer <CRON_SECRET>` を定数時間で比較し、違えば 401 |
| `prisma/reset-demo-data.ts` | リセットの本体（`pnpm db:seed` と共通）。接続先がローカル以外なら `STOCKFLOW_ALLOW_DESTRUCTIVE_SEED=1` がないと中止（`scripts/db-guard.ts`） |
| `src/lib/auth/auth.ts` | `BETTER_AUTH_URL` が `https://` なら Cookie は Secure。ログインの試行回数制限の IP は Vercel が上書きする `x-forwarded-for` から取る |
