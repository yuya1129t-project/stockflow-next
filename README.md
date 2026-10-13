# StockFlow（Next.js）

受発注・在庫管理の社内業務システム（デモ）です。小規模な卸・小売事業者を想定し、商品・取引先・受注・発注・在庫をブラウザで管理します。

[![CI](https://github.com/yuya1129t-project/stockflow-next/actions/workflows/ci.yml/badge.svg)](https://github.com/yuya1129t-project/stockflow-next/actions/workflows/ci.yml)

## このリポジトリについて

- 自社開発（個人の公開成果物）です。業務仕様は [docs/spec.md](docs/spec.md) にまとめています
- 実装は Claude Code が行い、要件整理・設計判断・レビュー・テスト確認は本人が行っています
- **データはすべて架空です**（実在の会社・人物・取引とは関係ありません）

## 主な機能

現時点では初期構築（土台）、DB スキーマ・シードデータ、認証とロール権限、商品マスタ、取引先マスタ、在庫、ダッシュボード、発注、受注、発注点割れの通知、ユーザー管理・操作履歴・API トークン、外部向け REST API までです。「予定」の機能は今後の Issue で実装します

| 機能                   | 内容                                                                   | 状態   |
| ---------------------- | ---------------------------------------------------------------------- | ------ |
| 認証・ロール権限       | admin／staff／viewer。権限はサーバー側で検査                           | 実装済 |
| 商品マスタ             | 一覧・検索・登録・編集・無効化、CSV 出力・取込                         | 実装済 |
| 取引先マスタ           | 一覧・検索・登録・編集・無効化、郵便番号から住所を自動入力（外部 API） | 実装済 |
| 受注                   | 明細編集、税計算（1 件ごとに切り捨て）、ステータス遷移、出荷で在庫引当 | 実装済 |
| 発注                   | 明細編集、税計算（1 件ごとに切り捨て）、ステータス遷移、入荷で在庫加算 | 実装済 |
| 在庫                   | 現在庫一覧（発注点割れの強調）、入出庫履歴、棚卸調整                   | 実装済 |
| ダッシュボード         | 今月の受注額・未出荷数・発注点割れ・入荷待ち                           | 実装済 |
| ユーザー管理・操作履歴 | ユーザー・ロール管理、API トークン、操作履歴の閲覧                     | 実装済 |
| 外部向け REST API      | `/api/v1`（Bearer 認証）、OpenAPI 3.1                                  | 実装済 |
| 通知                   | 発注点割れを Webhook で通知                                            | 実装済 |

## 技術スタック

| 区分           | 採用技術                                           |
| -------------- | -------------------------------------------------- |
| フレームワーク | Next.js 16（App Router）／React 19                 |
| 言語           | TypeScript（strict）                               |
| UI             | Tailwind CSS 4／shadcn/ui                          |
| データベース   | PostgreSQL 17（ローカルは Docker Compose）         |
| ORM            | Prisma 7                                           |
| テスト         | Vitest                                             |
| 静的解析・整形 | ESLint（Next.js の flat config）／Prettier         |
| CI             | GitHub Actions（lint・型チェック・テスト・ビルド） |
| 実行環境       | Node.js 24 LTS／pnpm                               |

## ローカル開発

前提: Node.js 24（`.nvmrc`）、pnpm（`corepack enable pnpm` で `package.json` の版が使われます）、Docker。

```bash
# 1. 環境変数（ローカル用のダミー値）
cp .env.example .env

# 2. PostgreSQL を起動（ホスト側ポート 54329。DB は stockflow と stockflow_test）
docker compose up -d

# 3. 依存パッケージをインストール（postinstall で Prisma Client を src/generated/prisma に生成）
pnpm install

# 4. 開発用 DB を作り直してシードを投入（マイグレーション適用 → シード）
pnpm db:reset

# 5. 開発サーバーを起動 → http://localhost:3000
pnpm dev
```

http://localhost:3000 を開くとログイン画面が表示されます（デモ用アカウントは下の「認証と権限」）。3000 以外のポートで起動するときは、`.env` の `BETTER_AUTH_URL` もそのポートに合わせてください（例 `BETTER_AUTH_URL=http://localhost:3100 pnpm dev --port 3100`）。

DB を作り直したいときは `docker compose down -v` でボリュームごと削除してから起動し直します。

### DB 関連のコマンド

| コマンド             | 内容                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `pnpm db:migrate`    | スキーマ変更からマイグレーションを作成して開発用 DB に適用（`prisma migrate dev`）               |
| `pnpm db:reset`      | 接続先を確認してから開発用 DB を作り直し、シードを投入（**開発用 DB のデータはすべて消えます**） |
| `pnpm db:seed`       | シードだけを投入し直す（このアプリの 15 テーブルを空にしてから投入。他のテーブルには触れません） |
| `pnpm db:test:reset` | テスト用 DB（`DATABASE_URL_TEST`）にマイグレーションを適用してシードを投入                       |
| `pnpm db:generate`   | Prisma Client を生成（`pnpm install` 時にも自動で実行）                                          |

- スキーマは `prisma/schema.prisma`、マイグレーションは `prisma/migrations/`。数量 > 0・価格 ≥ 0 などの CHECK 制約はマイグレーション SQL に直接書いています
- Prisma Client の生成物（`src/generated/prisma`）はコミットしません
- データを消去するコマンド（`db:seed`・`db:reset`・`db:test:reset`）は、実行前に接続先の `host:port/DB` を表示し、接続先がローカル（`localhost`／`127.0.0.1`／`::1`）以外なら中止します。デモ環境の定期リセットなど意図した場合だけ `STOCKFLOW_ALLOW_DESTRUCTIVE_SEED=1` を設定してください
- テスト用 DB は、DB 名が `_test` で終わり、開発用 DB（`DATABASE_URL`）と別の DB であることを確認してから使います（`scripts/db-guard.ts`。結合テストの接続時も同じ確認をします）

### シードデータ

`prisma/seed-data.ts` で生成します（**すべて架空**）。

- 商品 50・取引先 20（顧客 12・仕入先 8）・受注 80・発注 40・入出庫履歴・デモユーザー 3 人（admin／staff／viewer）
- 取引先名には必ず「デモ」か「サンプル」を含め、メールは `example.com`／`example.jp`、電話番号・郵便番号は `000` 始まりの実在しない形式にしています
- 乱数は固定シードで、日付は実行日（JST）から過去約 90 日に分布します。いつ実行しても、日付がずれるだけで同じ内容になります
- 入出庫は時系列で生成し、どの時点でも在庫が負になりません。出荷済みの受注には出庫、入荷済みの発注には入庫が対応します。一部の商品は発注点を下回る状態にしています

### ER 図

```mermaid
erDiagram
    User ||--o{ Session : "ログイン"
    User ||--o{ Account : "認証情報"
    User ||--o{ ApiToken : "発行"
    User |o--o{ StockMovement : "記録"
    User |o--o{ AuditLog : "操作"
    Partner ||--o{ SalesOrder : "顧客"
    Partner ||--o{ PurchaseOrder : "仕入先"
    SalesOrder ||--|{ SalesOrderLine : "明細"
    PurchaseOrder ||--|{ PurchaseOrderLine : "明細"
    Product ||--o{ SalesOrderLine : "受注明細"
    Product ||--o{ PurchaseOrderLine : "発注明細"
    Product ||--o{ StockMovement : "入出庫"

    User {
        string id PK
        string email UK
        string name
        Role role "admin / staff / viewer"
        boolean isActive
    }
    Session {
        string id PK
        string token UK
        string userId FK
        datetime expiresAt
    }
    Account {
        string id PK
        string userId FK
        string providerId "credential など"
        string password "ハッシュ"
    }
    Verification {
        string id PK
        string identifier
        string value
        datetime expiresAt
    }
    ApiToken {
        int id PK
        string userId FK
        string name
        string tokenHash UK
        datetime lastUsedAt
        datetime revokedAt
    }
    Product {
        int id PK
        string code UK "P-0001"
        string name
        string category
        string unit
        int salesPrice
        int purchasePrice
        int reorderPoint
        boolean isActive
    }
    Partner {
        int id PK
        string code UK "C-0001 / S-0001"
        string name
        PartnerKind kind "customer / supplier / both"
        string postalCode "7桁"
        string address
        string phone
        string email
        boolean isActive
    }
    SalesOrder {
        int id PK
        string number UK "SO-YYYYMMDD-NNN"
        int customerId FK
        date orderDate
        date dueDate
        SalesOrderStatus status "draft / confirmed / shipped / cancelled"
        int subtotal
        int tax
        int total
    }
    SalesOrderLine {
        int id PK
        int salesOrderId FK
        int productId FK
        int quantity
        int unitPrice
    }
    PurchaseOrder {
        int id PK
        string number UK "PO-YYYYMMDD-NNN"
        int supplierId FK
        date orderDate
        date expectedDate
        PurchaseOrderStatus status "draft / ordered / received / cancelled"
        int subtotal
        int tax
        int total
    }
    PurchaseOrderLine {
        int id PK
        int purchaseOrderId FK
        int productId FK
        int quantity
        int unitPrice
    }
    StockMovement {
        int id PK
        int productId FK
        StockMovementType type "in / out / adjust"
        int quantity "符号付き"
        string reason
        StockRefType refType "sales_order / purchase_order"
        int refId
        string userId FK
        datetime createdAt
    }
    AuditLog {
        int id PK
        string userId FK
        string action
        string targetType
        string targetId
        string summary
        datetime createdAt
    }
    DocumentSequence {
        DocumentKind kind PK "SO / PO"
        date date PK
        int lastNumber
    }
```

- 現在庫は `StockMovement.quantity` の合計です（在庫数の列は持ちません）
- `User`／`Session`／`Account`／`Verification` は Better Auth のスキーマに合わせています（認証の設計は下の「認証と権限」）
- `StockMovement` の `refType`＋`refId` で発生元の受注・発注を指します（棚卸調整は空）

## 認証と権限

### デモ用アカウント

ログイン画面にも表示しています（クリックすると入力欄に入ります）。値は `prisma/seed-data.ts` の `DEMO_USERS`／`DEMO_PASSWORD` の 1 か所で定義し、ログイン画面はそこから読み込んでいます。

この 3 つのアカウントは**保護されていて、ロール変更・無効化・パスワード再設定はできません**（公開デモでは admin のパスワードも公開するため、閲覧者が他の閲覧者のデモを壊せないようにしています。詳しくは「ユーザー管理」）。ユーザー管理を試すときは、新しいユーザーを登録してください。

| ロール | メールアドレス     | パスワード       | できること                                                   |
| ------ | ------------------ | ---------------- | ------------------------------------------------------------ |
| admin  | admin@example.com  | `demo-pass-1234` | すべて（ユーザー管理・操作履歴の閲覧・商品等の無効化を含む） |
| staff  | staff@example.com  | `demo-pass-1234` | 閲覧、商品・取引先・受注・発注の登録・編集、棚卸調整、CSV    |
| viewer | viewer@example.com | `demo-pass-1234` | 閲覧と CSV 出力のみ                                          |

### 設計

- **認証:** [Better Auth](https://www.better-auth.com/) 1.7（メール＋パスワード、Prisma アダプター、DB セッション）。設定は `src/lib/auth/auth.ts`
  - 公開のサインアップは無効です（ユーザー登録は admin が「ユーザー管理」で行う）
  - `role`・`isActive` はクライアントから設定できない項目（`input: false`）として登録しています
  - 無効ユーザー（`isActive = false`）はログインできません。ログイン中に無効化された場合も、セッションを取得するたびに DB の `isActive` を確認するので、次のリクエストから未ログインとして扱い、そのセッションを削除します（Cookie へのセッションのキャッシュは使っていません）
  - ログインは操作履歴（`audit_log`、action = `login`）に記録します
  - HTTP で公開する Better Auth のエンドポイントは `/api/auth/sign-in/email`・`/api/auth/sign-out`・`/api/auth/get-session` だけです（それ以外は 404）
  - **ログインの試行回数制限:** ログイン画面は HTTP の `/api/auth/sign-in/email` を経由します（Better Auth の制限は HTTP の経路にだけ効くため）。同じ IP から 60 秒に 5 回まで、超えると 429（画面には「試行回数が多すぎます…」と表示）。カウンターは Vercel の複数インスタンスでも共有できるよう DB（`rate_limit` テーブル）に置き、IP は Vercel が上書きする `x-forwarded-for` から取ります。制限は本番・開発で有効、自動テストでは既定で無効です（制限のテストでは有効にして検証）
- **権限:** ロール × 操作の対応表を `src/lib/auth/permissions.ts` の **1 か所**にまとめ、`can(role, action)` で判定します。表が docs/spec.md §2 と一致することは単体テストで spec の表を読み込んで確認しています
- **検査はサーバー側:** メニューの出し分けは表示の補助で、権限は必ずサーバー側のガード関数（`src/lib/auth/guards.ts`）で検査します
  - 画面: `requireUser()`／`requirePermission(action)`。未ログインはログイン画面へ（ログイン後に元の画面へ戻ります）、権限外は `forbidden()` で HTTP 403 を返し、403 の画面（`src/app/(app)/forbidden.tsx`）を表示します
    - `forbidden()` を使うため、`next.config.ts` で実験的な設定 `experimental.authInterrupts` を有効にしています（Next.js 16 で画面から HTTP 403 を返す手段がこれしかないため）
  - Server Action: `checkActionPermission(action)`。画面遷移はせず `{ ok: false, error }` を返すので、フォームの入力内容を消さずにエラーを表示できます
  - Route Handler: `requireApiPermission(request, action)`。未ログインは 401、権限外は 403 を JSON で返します
  - REST API（`/api/v1`）: Bearer トークンだけで認証します（Cookie のセッションは使いません。下の「REST API」）
  - `src/proxy.ts`（Next.js 16 で Middleware から改名された Proxy）は、セッション Cookie が無いときにログイン画面へ送る楽観的なチェックだけを行います（ログイン画面と `/api-docs` は対象外）

## 商品マスタ

画面は `/products`（一覧）・`/products/new`（登録）・`/products/[id]`（詳細）・`/products/[id]/edit`（編集）・`/products/import`（CSV 取込）。

- **一覧:** 商品コード・商品名・カテゴリのキーワード検索、カテゴリでの絞り込み、無効な商品の表示切り替え、並べ替え（商品コード・商品名・カテゴリ・売価・発注点・現在庫）、20 件ずつのページ送り。検索条件は URL のクエリに持つので、URL の共有やブラウザの「戻る」で同じ一覧を再現できます
  - 現在庫は入出庫（`stock_movement`）の合計です。商品ごとに問い合わせず（N+1 にしない）、入出庫を商品ごとに集計した結果を 1 本の SQL で結合しています（`src/lib/products/queries.ts`）。現在庫が発注点を下回る有効な商品は「発注点割れ」として強調します
- **登録・編集:** React Hook Form＋Zod。Zod のスキーマ（`src/lib/products/schema.ts`）を画面と Server Action・CSV 取込で共有し、サーバー側で必ず検証します（エラーは日本語）。価格・発注点は 0 以上の整数（全角数字・3 桁区切りのカンマも受け付けます）。商品コードは大文字に揃えて保存し（`p-0001` と `P-0001` は同じ商品）、重複は「商品コード「…」はすでに登録されています」と表示します。商品名・カテゴリ・単位は 1 行の文字列で、改行・タブなどの制御文字はエラーです
- **無効化（論理削除）:** admin のみ。詳細画面から無効化・再有効化できます（確認ダイアログあり）
- **権限:** 登録・編集・CSV 取込は admin／staff、無効化は admin のみ（spec §2）。Server Action は `checkActionPermission` で検査し、更新処理の本体（`src/lib/products/service.ts`）でも操作したユーザーのロールを再度検査します
- **操作履歴:** 登録（`create`）・更新（`update`、変更した項目と前後の値）・無効化（`deactivate`）・再有効化（`reactivate`）・CSV 取込（商品ごとの `create`／`update` と、件数の要約の `import` 1 件）を `audit_log` に記録します。更新と履歴は同じトランザクションで書きます

### CSV

| 項目       | 出力（一覧の「CSV 出力」）                                                                             | 取込（`/products/import`）                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| 権限       | 全ロール（`csv:export`）                                                                               | admin／staff（`csv:import`）                                                            |
| 文字コード | UTF-8（BOM 付き。Excel で文字化けしない）                                                              | UTF-8（BOM の有無は問わない）。Shift_JIS などはエラー                                   |
| 列         | 商品コード・商品名・カテゴリ・単位・売価・仕入単価・発注点・現在庫・状態                               | 商品コード〜発注点の 7 列が必須（順番は問わない）。現在庫・状態などほかの列は読み飛ばす |
| 範囲       | 表示中の絞り込み条件・並び順を反映（ページ送りはせず全件）                                             | 商品コード（大文字に揃えて照合）が既存なら更新、なければ新規。有効／無効は変更しない    |
| 上限       | 10,000 件（超えると出力せず 413「件数が多すぎます。絞り込んでから…」。一覧でもボタンを無効にして表示） | データ 1,000 行・ファイル 512KB（512KB を超えるファイルは送信前に画面で止める）         |

- 出力は `GET /api/products/export?…`（一覧と同じクエリ）。読み取りだけで副作用はありません
- 出力では `=`・`+`・`-`・`@`（とタブ・CR）で始まる文字列のセル（`'` が並んだ後にこれらが続くものを含む）の先頭に `'` を 1 つ付けて、表計算ソフトで数式として実行されないようにしています（CSV インジェクション対策）。取込では `'` の後にこれらが続くセルから `'` を 1 つ外すので、元から `'` で始まる値も含めて、出力した CSV を編集してそのまま取り込めます
- 出力は取込の上限（1,000 行）を超えても出力できます。1,000 件を超える CSV を取り込むときは、ファイルを分けてください
- 取込は 1 行でもエラーがあれば全体を取り込まず、行番号・項目・内容の一覧を表示します。次もエラーです
  - ファイル内の商品コードの重複
  - 列の数が見出し行と違う行（囲んでいない `1,200` などで列がずれたまま取り込まないため）
  - RFC 4180 に沿わない引用（閉じた `"` の直後に文字が続く・囲んでいない項目の途中の `"`・閉じていない `"`）
- 書き込みは 1 トランザクションです。更新は `UPDATE … FROM (VALUES …)` で 500 行ずつまとめて実行します（ローカルの Docker の DB で、既存 1,000 件の更新を含む取込が約 1.6 秒）
- CSV の読み書きは外部ライブラリを使わず、小さな純粋関数（`src/lib/csv.ts`）にして単体テストしています

## 取引先マスタ

画面は `/partners`（一覧）・`/partners/new`（登録）・`/partners/[id]`（詳細）・`/partners/[id]/edit`（編集）。

- **一覧:** 取引先コード・取引先名のキーワード検索、種別での絞り込み（spec §3 に合わせ、「顧客」は顧客と顧客・仕入先、「仕入先」は仕入先と顧客・仕入先、「顧客・仕入先」は両方の役割を持つものだけ。受注・発注の取引先選択でも使えるよう `partnerKindsFor` として用意）、無効な取引先の表示切り替え、並べ替え（取引先コード・取引先名・種別）、20 件ずつのページ送り。検索条件は URL のクエリに持ちます
- **登録・編集:** React Hook Form＋Zod。スキーマ（`src/lib/partners/schema.ts`）を画面と Server Action で共有し、サーバー側で必ず検証します
  - 取引先コードは大文字に揃えて保存し（`c-0001` と `C-0001` は同じ取引先）、重複は「取引先コード「…」はすでに登録されています」と表示します。登録画面では種別に応じて次のコード（顧客 `C-0013`・仕入先 `S-0009`・顧客・仕入先 `B-0001` のように、既存の最大番号＋1）を初期値として提案します
  - 郵便番号は 7 桁（`123-4567`・`1234567`・全角も受け付け、保存はハイフンなし）。電話番号は 0 から始まる 10〜11 桁（ハイフンは任意）。郵便番号・住所・電話番号・メールアドレスは任意で、空なら未登録（null）にします。取引先名・住所は 1 行の文字列で、改行・タブなどの制御文字はエラーです
  - 種別は、使用中の受注・発注と矛盾する変更（受注があるのに顧客の役割を外す、発注があるのに仕入先の役割を外す）を種別のエラーとして拒否します
- **無効化（論理削除）:** admin のみ。詳細画面から無効化・再有効化できます（確認ダイアログあり）
- **権限:** 登録・編集は admin／staff、無効化は admin のみ（spec §2）。Server Action は `checkActionPermission` で検査し、更新処理の本体（`src/lib/partners/service.ts`）でも操作したユーザーのロールを再度検査します
- **操作履歴:** 登録（`create`）・更新（`update`、変更した項目と前後の値）・無効化（`deactivate`）・再有効化（`reactivate`）を `audit_log`（`targetType = partner`）に記録します。更新と履歴は同じトランザクションで書きます

### 郵便番号から住所を入力（外部 API 連携）

- 郵便番号を入れて「住所を検索」を押すと、住所欄に都道府県・市区町村・町域を入れます（候補が複数あれば選べます）。番地・建物名は続けて手入力します
- 外部 API は [zipcloud](https://zipcloud.ibsnet.co.jp/doc/api)（無料・API キー不要）。ブラウザから直接は呼ばず、サーバー側の Route Handler `GET /api/partners/address-lookup?postalCode=…` から呼びます（`src/lib/partners/address-lookup.ts`）
  - ログイン必須で、取引先を登録・編集できるロール（admin／staff）だけが使えます（未ログインは 401、権限外は 403）。読み取りだけで副作用はありません
  - 負荷対策: 郵便番号ごとの結果（住所・該当なし）をメモリにキャッシュし（1 日・最大 1,000 件）、ユーザーごとに 1 分 30 回までに制限します（超えると 429）。どちらもサーバーのメモリ上にあるため、**サーバーのインスタンスごとに効きます**（Vercel などで複数のインスタンスが動くと、インスタンス間では共有しません）
  - タイムアウトは 3 秒（`AbortSignal.timeout`）。リダイレクトはたどりません。応答は Zod で型を検証してから使い、想定と違う形・問い合わせと違う郵便番号の結果・制御文字や長すぎる値は使いません
  - 応答: 200 `{ postalCode, addresses }`／400 形式エラー／404 該当なし／429 回数超過／502 失敗・不正な応答／504 タイムアウト。失敗したときは画面に「…住所を手入力してください」と表示し、そのまま手入力して保存できます（住所検索は保存の条件ではありません）。失敗の原因はサーバー側のログ（`console.warn`。郵便番号・利用者の情報は含めない）に残します
  - 検索中に郵便番号・住所を書き換えたときは、古い検索結果で上書きしません（リクエストの識別子と入力で判定）
- テストでは外部 API を呼びません。`fetch` をモックにして、正常・複数候補・該当なし・タイムアウト（応答の途中を含む）・HTTP エラー・通信エラー・不正な応答（JSON でない・型が違う・別の郵便番号）を確認しています（`src/lib/partners/address-lookup.test.ts`・`address-lookup-limits.test.ts`・`src/app/api/partners/address-lookup/route.test.ts`）

## 在庫

画面は `/stock`（現在庫一覧）・`/stock/[productId]`（商品ごとの現在庫・棚卸調整・入出庫履歴。商品の詳細からも開けます）。

- **現在庫一覧:** 商品一覧と同じ検索・並べ替え・ページ送り（URL のクエリ）に、「発注点割れのみ」の絞り込みを加えたものです。発注点割れ（有効な商品で 現在庫 < 発注点）は行の色と赤字・バッジで強調します。集計は商品一覧の SQL（`src/lib/products/queries.ts`）をそのまま使います
- **入出庫履歴:** 日時（Asia/Tokyo）・種別（入庫／出庫／棚卸調整）・数量（符号付き）・理由・参照元の伝票番号・担当者を新しい順に 20 件ずつ。伝票番号は表示中のページの分をまとめて引きます。受注・発注の詳細へのリンクです
- **棚卸調整:** admin／staff（spec §2）。実数（0 以上の整数）と理由（必須）を入力すると、現在庫との差分を `adjust` として記録し、操作履歴（`audit_log`、action = `stock_adjust`）に前後の在庫・差分・理由を残します。差分が 0 のときは記録せず、その旨を表示します。権限は Server Action と本体（`src/lib/stock/service.ts`）の両方で検査します

### 在庫の整合性

- 在庫数の列は持たず、現在庫は常に入出庫（`stock_movement`）の合計です。入出庫は追記だけで、更新・削除しません
- 入出庫の記録は共通モジュール `src/lib/stock/movements.ts` の `recordStockMovements(tx, userId, entries)` に集めています（棚卸調整・発注の入荷・受注の出荷で使用）。`tx` は `withStockTransaction(db, async (tx) => …)`（READ COMMITTED のトランザクション）が渡すものだけを受け付けます。通常の `PrismaClient` は型エラーになり、型を外して渡しても実行時に例外になります（トランザクションの外ではロックが効かないため）。伝票の更新なども同じ `tx` で書けます。複数商品をまとめて受け取り、次の順で処理します
  1. 対象商品の `product` 行を **id の順に `SELECT … FOR NO KEY UPDATE`** でロックしてから、現在庫を集計する
  2. 記録後に在庫が負になる商品が 1 つでもあれば、不足する商品と数量を持つ `InsufficientStockError` を投げる（呼び出し側のトランザクションごと取り消される）
  3. 入出庫を INSERT し、商品ごとの前後の在庫と「発注点以上 → 未満」に変わった商品の一覧を返す（発注点割れの通知で使う）
- READ COMMITTED のまま「合計を確認 → INSERT」すると、同時に出庫した 2 つのトランザクションが両方とも確認を通って在庫が負になります。行ロックで同じ商品の記録を順番に処理し、後のトランザクションは先の記録を含めた合計で判定します。結合テストで、2 つ目のトランザクションが 1 つ目のロックを待っている状態（`pg_blocking_pids`）を確かめてから 1 つ目を確定させ、在庫が負にならないことを確かめています（ロックを外すとこのテストは失敗します）
- デッドロックについて:
  - ロックは `FOR UPDATE` ではなく `FOR NO KEY UPDATE` です。受注・発注の明細の INSERT は、外部キーの検査で商品行に `FOR KEY SHARE` を取ります。`FOR UPDATE` だとこれと競合し、明細を入力の順番で INSERT する処理とロックの順番が逆になってデッドロックし得ます。`FOR NO KEY UPDATE` は `FOR KEY SHARE` と競合せず、在庫の記録同士・商品の更新とは競合するので、在庫の記録は直列のままです
  - 商品行を複数ロックする処理は「対象の全商品を一度に id の順でロックする」にそろえています（在庫の記録と商品の CSV 取込）。この範囲では、複数商品を逆の順番で記録してもデッドロックしません。同じトランザクションの中で、別の商品のロックをあとから追加しないでください
- 棚卸調整の差分も、ロックを取った後の現在庫から求めます（画面を開いた後に入出庫があっても、記録後の在庫は入力した実数になります）

## ダッシュボード

ログイン後のトップ（`/`）。全ロールが閲覧できます。

- **今月の受注額:** 確定（confirmed）・出荷済（shipped）の受注の合計（税込の total）。「今月」は Asia/Tokyo の暦月で、受注日基準です。前月の同じ集計との差と増減率を出します（前月が 0 円なら増減率は出さない）
- **未出荷の受注:** 確定済の件数と、そのうち納期を過ぎたもの（件数と納期の古い順の数件）
- **発注点を下回る商品:** 在庫一覧の「発注点割れ」と同じ定義（有効な商品で 現在庫 < 発注点。SQL の条件は `src/lib/products/queries.ts` の 1 か所）。件数と不足の大きい順の数件、在庫一覧へのリンク
- **入荷待ちの発注:** 発注済（ordered）の件数と、入荷予定日の近い順の数件。予定日を過ぎたものは強調します
- **月別の受注額:** 直近 6 か月の棒グラフ。依存を増やさないよう CSS で描き、数値は表でも見られます
- 集計は `src/lib/dashboard/queries.ts` で、すべて DB 側で行います（件ごとに問い合わせない）。月・日の境界は `src/lib/dashboard/period.ts` で Asia/Tokyo の暦から求め、DB の date 型の列とは `YYYY-MM-DD` の文字列を `::date` にして比べます（サーバーや DB の TimeZone 設定で 1 日ずれないように）
- 受注・発注の番号は詳細へのリンクです（リンク先は `src/lib/dashboard/paths.ts`）

## 発注

画面は `/purchase-orders`（一覧）・`/purchase-orders/new`（作成）・`/purchase-orders/[id]`（詳細・ステータス操作）・`/purchase-orders/[id]/edit`（編集。下書きのみ）。閲覧は全ロール、作成・編集・ステータス変更は admin／staff（spec §2。Server Action と本体 `src/lib/purchase-orders/service.ts` の両方で検査）。

- **一覧:** 発注番号（部分一致）・仕入先・ステータス・発注日の期間で絞り込み、並べ替え（発注日・番号・仕入先・入荷予定日・合計）、20 件ずつのページ送り。条件は URL のクエリに持ちます
- **CSV 出力:** `GET /api/purchase-orders/export?…`（一覧と同じクエリ）。1 行 = 発注 1 件（発注番号・発注日・入荷予定日・仕入先・ステータス・明細数・小計・消費税・合計・備考）。BOM 付き UTF-8、数式になる値の無害化、上限 10,000 件（超えたら 413）は商品の CSV 出力と同じです
- **作成・編集:** 仕入先（種別が仕入先か顧客・仕入先で有効なもの）・入荷予定日（任意。発注日以降）・備考と、明細（商品・数量・単価）。明細は行の追加・削除ができ、商品を選ぶと単価に仕入単価が入ります（書き換え可）。明細の単価は保存した値で固定し、あとで商品の仕入単価を変えても変わりません。下書きは明細 0 行でも保存できます
  - 無効な商品は新しく選べません（編集で、もとから明細にある商品はその後に無効になっていても残せます）。同じ商品の明細は 1 行だけです（検証エラー。DB でも `@@unique([purchaseOrderId, productId])`。受注の明細にも同じ制約を付けました）
  - 編集の競合: 画面を開いた時点の `updatedAt` を送り、保存の時点で変わっていれば「他の人がこの発注を更新しました…」と表示して保存しません。ステータス変更も同じで、詳細画面に表示した時点の `updatedAt` と比べ、変わっていれば変更しません（見ていない明細のまま発注済にしない）。比べる部品は `src/lib/orders/versions.ts`（受注と共有）
- **ステータス:** `draft（下書き）→ ordered（発注済）→ received（入荷済）`、`draft／ordered → cancelled（取消）`。発注済には明細が 1 行以上必要で、入荷済と取消は最終状態です。詳細画面に、状態と権限に応じたボタンと確認ダイアログを出します
- **操作履歴:** 作成（`create`）・更新（`update`、変更点）・ステータス変更（`status_change`）を `audit_log`（targetType = `purchase_order`）に、伝票の書き込みと同じトランザクションで記録します

### 設計（受注と共有する部品は `src/lib/orders/`）

- **採番:** `PO-YYYYMMDD-NNN`。日付は発注日で、発注日は作成した日（Asia/Tokyo）です（番号の日付と一致させるため入力では変えません）。連番は `document_sequence` を `INSERT … ON CONFLICT (kind, date) DO UPDATE SET "lastNumber" = "lastNumber" + 1 RETURNING "lastNumber"` の 1 文で進めます（`src/lib/orders/numbering.ts`）。同じ日の採番は行ロックで順番待ちになるので、同時に作成しても番号は重複しません。伝票の作成と同じトランザクションなので、作成が失敗すれば番号も戻ります。1 日に 999 件を超えたら桁を増やします（`PO-20261013-1000`）。このとき番号は文字列として並べるので、番号の並べ替えや一覧の既定の並び（発注日→番号）では、同じ日の `…-1000` 以降が `…-999` より前（昇順）や後（降順）に来ます（件数から見て実害はないとして、そのままにしています）
- **金額:** 小計 = Σ 数量 × 単価、税 = 小計の 10%（伝票 1 件ごとに 1 円未満切り捨て。`calcTax`）、合計 = 小計 + 税（`src/lib/orders/amounts.ts`）。金額は必ずサーバーで明細から計算して保存し、画面から送られた値は使いません（画面の自動表示にも同じ関数を使います）。途中は BigInt で計算し、合計の上限は 999,999,999 円です
- **二重入荷の防止:** 入荷は `withStockTransaction` の中で、まず `updateMany({ where: { id, status: "ordered", updatedAt: 表示した時点の値 }, data: { status: "received" } })` を実行し、更新件数が 0 なら何も記録せずに理由を返します。同時に 2 回入荷しても、2 本目は 1 本目の確定を待ってから条件を評価し直して 0 件になるので、入庫は 1 回だけです。そのうえで全明細の入庫（`in`、refType = `purchase_order`・refId = 発注 ID）を `recordStockMovements` で一度に記録します。結合テストで、2 本の入荷がロック待ちに入ったことを `pg_blocking_pids` で確かめてから同時に進め、入庫が 1 回だけであることを確かめています
- **取引先・商品の検査:** 作成・編集のトランザクションの中で、仕入先の行と明細の商品の行（id の順にまとめて）を `FOR SHARE` でロックしてから、種別・有効を検査します（`src/lib/orders/locks.ts`）。この FOR SHARE は在庫を記録するトランザクション（出荷・入荷）では使えません（同じ商品で 2 本が FOR NO KEY UPDATE への引き上げを互いに待ってデッドロックするため。`withStockTransaction` の中で呼ぶと例外にしています）。在庫を記録するときに商品を検査するなら `lockProductsForStock` の結果を使います。取引先の編集も行を `FOR NO KEY UPDATE` でロックしてから受注・発注の件数を数えるようにしたので、「発注の作成」と「仕入先の役割を外す種別変更」が同時に走っても、どちらかが他方の確定を待ってから判定します（結合テストあり）
- **編集・ステータス変更（入荷以外）:** 発注の行を `FOR NO KEY UPDATE` でロックしてから状態を読みます（同じ発注への同時の編集・状態変更を直列にする）。作成・編集・ステータス変更・入荷のトランザクションの timeout は、ロック待ちを含めて 15 秒です
- これらのロックは、それぞれ外すと落ちる結合テストで確かめています（入荷と取消の同時実行、明細 0 行への編集と発注済への変更の前後、商品の無効化と作成、作成と在庫の記録のロックの順番）

## 受注

画面は `/sales-orders`（一覧）・`/sales-orders/new`（作成）・`/sales-orders/[id]`（詳細・ステータス操作）・`/sales-orders/[id]/edit`（編集。下書きのみ）。発注と同じ構成・同じ共有部品（`src/lib/orders/`・`src/components/orders/`）で作っています。閲覧と CSV 出力は全ロール、作成・編集・ステータス変更は admin／staff（spec §2。Server Action と本体 `src/lib/sales-orders/service.ts` の両方で検査）。

- **一覧・CSV 出力:** 受注番号・顧客・ステータス・受注日の期間で絞り込み、並べ替え（受注日・番号・顧客・納期・合計）、ページ送り。CSV は `GET /api/sales-orders/export?…`（形式・上限は発注と同じ）
- **作成・編集:** 顧客（種別が顧客か顧客・仕入先で有効なもの）・納期（任意。受注日以降）・備考と明細。商品を選ぶと単価に売価が入ります（書き換え可。保存した値で固定）。番号は `SO-YYYYMMDD-NNN`（受注日＝作成した日）。編集・ステータス変更は詳細画面を開いた時点の `updatedAt` と比べ、変わっていれば行いません
- **ステータス:** `draft（下書き）→ confirmed（確定）→ shipped（出荷済）`、`draft／confirmed → cancelled（取消）`。確定には明細が 1 行以上必要で、出荷済と取消は最終状態です
- **出荷（在庫引当）:** `withStockTransaction` の中で次の順に行います
  - `updateMany({ where: { id, status: "confirmed", updatedAt: 表示した時点の値 } })` の件数が 0 なら何もしない（同時に 2 回出荷しても、2 本目は 1 本目の確定後に条件を評価し直して 0 件になる＝二重出荷の防止）
  - 全明細の出庫（`out`、負の数量、refType = `sales_order`・refId = 受注 ID）を `recordStockMovements` に一度に渡す。商品の行は id の順に `FOR NO KEY UPDATE` でロックされるので、別々の受注が同じ商品を同時に出荷しても、後の出荷は先の出庫を含めた在庫で判定します
  - 1 行でも在庫が足りなければ `InsufficientStockError` でトランザクションごと取り消し（状態も確定のまま）、確認ダイアログに不足する商品と「必要数・現在庫・不足数」を表示します
  - 出荷のトランザクションでは `lockProductsForLines`（FOR SHARE）を使いません（ロックの引き上げでデッドロックするため）。出荷時に商品が無効になっていても出荷できます（無効の制限は新規の受注で選べないこと）
  - 出荷の結果には「発注点以上 → 未満」に変わった商品（`fellBelowReorderPoint`）を含めて返します（下の「発注点割れの通知」で使う）
- **操作履歴:** 作成（`create`）・更新（`update`）・ステータス変更（`status_change`。出荷は出庫した品目数を含む）を `audit_log`（targetType = `sales_order`）に、伝票の書き込みと同じトランザクションで記録します
- 結合テスト（`tests/integration/sales-orders.test.ts`）で、在庫不足の全体中止、同時の二重出荷、別々の受注の同時出荷（`pg_blocking_pids` でロック待ちを確かめてから進める）などを確かめています。条件付き更新・商品と受注の行ロックをそれぞれ外すと、該当するテストが落ちます

## 発注点割れの通知

入出庫の結果、有効な商品の現在庫が「発注点以上 → 発注点未満」に変わったとき、Slack Incoming Webhook 形式で通知します（spec §6-3。`src/lib/notifications/reorder-point.ts`）。

### 設定

| 環境変数                      | 内容                                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `STOCKFLOW_SLACK_WEBHOOK_URL` | Slack の Incoming Webhook の URL（`https://hooks.slack.com/services/…`）。**未設定（空）なら通知しません**（デモは未設定）         |
| `BETTER_AUTH_URL`             | 既存の「アプリの URL」。通知に付ける在庫画面へのリンク（`/stock/[productId]`）の基準に使います（http／https でなければリンクなし） |

- Webhook URL は秘密情報として扱ってください（`.env` やホスティングの環境変数に置き、コミットしない）
- `https` 以外の URL（`http` など）・認証情報を含む URL には送りません（設定ミスで平文で送らないため）。送信のたびにサーバーのログ（`console.error`）と操作履歴に「設定が不正」として残します

### 挙動

- **対象:** 棚卸調整と受注の出荷。発注の入荷は在庫が増えるだけなので対象外です。もとから発注点割れの商品・発注点以上のままの商品・無効な商品は通知しません（判定は在庫の共通モジュールの `fellBelowReorderPoint`）
- **1 回の操作で 1 通:** 出荷で複数の商品が発注点を下回ったら 1 通にまとめます。本文は、きっかけ（「棚卸調整」／「受注 SO-… の出荷」）と、商品ごとの商品コード・商品名（在庫画面へのリンク）・現在庫・発注点・変更前の在庫です。商品名・単位などの入力値は `&`・`<`・`>` をエスケープし、Slack の自動解析（`@here` などのメンション化・リンク化）を止める `verbatim: true` の blocks にだけ入れます。通知のプレビューに使われるトップレベルの `text` は件数ときっかけだけです（`verbatim` を指定できないため）。21 件目以降は「ほか N 件」にまとめ、在庫一覧の発注点割れへのリンクを付けます
- **送るタイミング:** 業務処理のトランザクションが確定した後、Server Action が応答を返した後に Next.js の `after()` で送ります（Slack の応答待ちで画面の操作を遅らせないため。Vercel では `waitUntil` で応答後も実行されます）
- **失敗しても業務処理は取り消しません:** タイムアウトは 3 秒、リダイレクトはたどりません。HTTP エラー・タイムアウト・通信エラーのときは、操作履歴（`audit_log`、action = `notify_failed`、targetType は棚卸調整なら `product`・出荷なら `sales_order`）に、きっかけ・商品コード・原因の種類（HTTP エラーはステータスコード）を記録します。Webhook URL・応答本文は記録しません。成功は記録しません
- **テスト:** 外部へは送りません（`fetch` をモック）。単体テスト（`src/lib/notifications/reorder-point.test.ts`）で本文の組み立て・URL の検証・成功／HTTP エラー／タイムアウト／リダイレクト／通信エラーを、結合テスト（`tests/integration/reorder-notifications.test.ts`）で Server Action から呼んだときの通知する／しない境界（跨いだとき・跨がないとき・無効な商品・未設定）と、送信に失敗しても出荷・棚卸調整が取り消されず操作履歴に失敗が残ることを確かめています

## ユーザー管理

画面は `/users`（一覧）・`/users/new`（登録）・`/users/[id]`（詳細: ロール変更・無効化／再有効化・パスワード再設定・API トークン）。admin のみ（spec §2）。権限は画面のガード（`requirePermission("user:manage")`）・Server Action（`checkActionPermission`）・本体（`src/lib/users/service.ts`）の 3 か所で検査します。

- **一覧:** 名前・メールアドレス・ロール・状態・作成日。デモ用アカウントと自分自身には印を付けます（社内の数名を想定し、ページ送りはしません）
- **登録:** 名前・メールアドレス・ロール・初期パスワード（8〜128 文字。Better Auth の既定に合わせています）。パスワードは Better Auth と同じ方式（`better-auth/crypto` の `hashPassword`）でハッシュ化し、credential アカウント（`accountId = userId`）を作ります。メールアドレスは小文字に揃えて保存し（Better Auth はログイン時に小文字で照合するため）、重複は「メールアドレス「…」はすでに登録されています」と項目のエラーにします
- **ロール変更:** ロールはセッション取得のたびに DB から読むので、ログイン中のユーザーにも次のリクエストから効きます
- **無効化:** ユーザーを無効にすると、同じトランザクションでそのユーザーの全セッションを削除し、有効な API トークンをすべて失効（`revokedAt`）させます。再有効化してもトークンは戻りません（必要なら発行し直す）。再有効化でもそのユーザーのセッションをすべて削除します（下の「残るリスク」）。API トークンの検証でもユーザーの有効を確認します（二重の確認）
- **パスワード再設定:** admin が新しいパスワードを設定します。対象のセッションは、自分自身の再設定でもすべて終了します（自分の場合は再設定の後にログイン画面へ戻ります）。「API トークンもすべて失効する」（既定はオン）を付けると、対象の有効なトークンも同じトランザクションで失効させ、件数を操作履歴に残します。パスワードは操作履歴に残しません
- **自分自身のロール変更・無効化は不可**（spec §3）
- **デモ用アカウントの保護:** シードのデモ用アカウント（admin／staff／viewer）は、ロール変更・無効化・パスワード再設定を拒否します（「デモ用アカウントは変更できません…」）。判定はユーザー ID（`DEMO_USERS` の `demo_admin` など）で行います。ID はシードで固定され画面から変えられないので、DB の列（フラグ）のように書き換えて保護を外すことができません。メールアドレス・名前を変更する機能は持っていません。API トークンはデモ用アカウントにも発行・失効できます（REST API を試せるように）
- 更新のトランザクションでは、操作する admin と対象のユーザーの行を **id の順に** `FOR NO KEY UPDATE` でロックしてから行います（無効化とトークン発行が同時に走っても、無効なユーザーにトークンが残らない。結合テストで発行がロックを待つことを `pg_blocking_pids` で確かめています）
  - 操作する admin の現在のロール・有効を同じトランザクションの中で確かめ直し、認可の後に降格・無効化されていたら拒否します
  - 有効な admin が 0 人になる変更（最後の有効な admin の降格・無効化）は拒否します。admin の顔ぶれを変えうる操作（ロール変更・無効化／再有効化）は `pg_advisory_xact_lock` で直列にしています（2 人の admin が同時に互いを降格しても、片方だけが成功する）
- **操作履歴:** 登録（`create`）・ロール変更（`role_change`）・無効化（`deactivate`）・再有効化（`reactivate`）・パスワード再設定（`password_reset`）を targetType = `user` で、トークンの発行（`token_create`）・失効（`token_revoke`）を targetType = `api_token` で記録します。更新と同じトランザクションで書きます

### API トークン（spec §6-2）

- ユーザーの詳細画面で、名前を付けて発行・一覧（名前・作成日時・最終使用・失効状態）・失効ができます。トークン本体は**発行した直後に 1 回だけ**表示し（コピーボタンあり）、DB には SHA-256 のハッシュ（`tokenHash`、一意）だけを保存します。有効なトークンは 1 ユーザーあたり 10 件までです（1 人のユーザーに大量に発行されないための上限です。ユーザーを登録できる admin は、ユーザーを増やせばそれ以上発行できるので、全体の件数の上限ではありません。公開デモでは日次リセットで消えます）
- 形式は `sf_` ＋ 32 バイトの乱数の base64url（43 文字）です（`src/lib/auth/api-token.ts`）。256 ビットの乱数なので、パスワードのようなソルトや遅いハッシュは使いません
- REST API（#11）で使う検証関数は `authenticateApiToken(request)`（`src/lib/auth/api-token-auth.ts`）です。`Authorization: Bearer <token>` を取り出し、形式を確かめてからハッシュで検索し、失効済み・ユーザー無効なら拒否します。成功すると `{ ok: true, user, tokenId }`（`user` は画面のセッションと同じ `SessionUser`。ロールは毎回 DB から読むので、ロール変更がすぐ効く）、失敗はすべて `{ ok: false }` で理由を区別しません（トークンの存在や状態を推測させないため、呼び出し側は同じ 401 を返す）
  - 比べるのはハッシュどうし（DB の一意索引での検索）なので、文字列比較の時間差からトークンを推測するタイミング攻撃は問題になりません
  - `lastUsedAt` は 5 分以上たっていたときだけ更新します（リクエストのたびに書き込まない）

### 残るリスク（セキュリティ）

- ログインと、パスワード再設定・無効化が数ミリ秒の差で重なると、古いパスワード（または無効化の直前）で検証を通ったログインが、再設定・無効化の後にセッションを作ることがあります。Better Auth にはパスワードの検証からセッションの INSERT までの間に同期点を入れる手段がないため、完全には防いでいません（成立には古いパスワードを知っている必要があります）。無効化中のセッションは使えず（`isActive` を毎回確認）、再有効化のときもセッションをすべて削除するので、無効化と重なって作られたセッションが後から使えるようになることはありません

## 操作履歴

画面は `/audit-logs`。admin のみ（spec §2）。

- 日時・ユーザー・操作・対象・内容（summary）を新しい順に 50 件ずつ。ユーザー・操作・対象の種類・期間（Asia/Tokyo の日付。両端を含む）で絞り込めます。条件は URL のクエリに持ちます
- 操作・対象の種類の選択肢は、記録されている値から作ります（新しい種類の操作が増えても選べる。表示名がないものは記録された値をそのまま表示）
- 対象が商品・取引先・受注・発注・ユーザーなら、詳細画面へのリンクにします（`auditTargetPath`）

## テスト

```bash
pnpm test              # 単体テスト＋結合テスト（Vitest）
pnpm test:unit         # 単体テストのみ（DB 不要）
pnpm test:integration  # 結合テストのみ（実 DB = DATABASE_URL_TEST）
pnpm lint              # ESLint
pnpm typecheck         # 型チェック
pnpm build             # 本番ビルド
pnpm format            # Prettier で整形
```

結合テスト（`tests/integration/`）はテスト用 DB（`stockflow_test`）を使います。先に `docker compose up -d` と `pnpm db:test:reset` を実行してください。DB に接続できないときは、その旨と対処を示すエラーで失敗します。CI では PostgreSQL 17 のサービスを起動し、`pnpm db:test:reset` のあとに全テストを実行しています。

## デモ

（#14 で追加予定）

## REST API

外部のシステムから商品・在庫・受注を参照し、受注を登録するための API です（docs/spec.md §6-2。② Laravel・③ FastAPI 版と同じ仕様）。

| メソッド | パス                                                    | 内容                     | 権限                 |
| -------- | ------------------------------------------------------- | ------------------------ | -------------------- |
| GET      | `/api/v1/products?q=&page=&perPage=`                    | 商品一覧（現在庫を含む） | admin／staff／viewer |
| GET      | `/api/v1/products/{code}/stock`                         | 商品の現在庫と発注点     | admin／staff／viewer |
| GET      | `/api/v1/sales-orders?status=&from=&to=&page=&perPage=` | 受注一覧                 | admin／staff／viewer |
| GET      | `/api/v1/sales-orders/{number}`                         | 受注詳細（明細を含む）   | admin／staff／viewer |
| POST     | `/api/v1/sales-orders`                                  | 受注の登録（下書き）     | admin／staff         |
| GET      | `/api/v1/openapi.json`                                  | OpenAPI 3.1 の定義       | 認証不要             |

- **ドキュメント:** http://localhost:3000/api-docs （Swagger UI。ログインなしで閲覧できます）。定義のスナップショットは [docs/openapi.json](docs/openapi.json)
- **認証:** `Authorization: Bearer <token>` だけです。画面のログイン（Cookie）では使えません（ブラウザが自動で送る Cookie で API を動かせないようにして、CSRF の余地をなくすため）。失敗は理由（ヘッダーなし・形式違い・失効・ユーザー無効など）を区別せず、同じ 401（`WWW-Authenticate: Bearer realm="StockFlow API"`）を返します
- **権限:** トークンの持ち主の**現在の**ロールに従います（ロール変更・無効化は次のリクエストから効く）。viewer は参照のみ、受注の登録は admin／staff
- **形式:** 一覧は `{ data, meta: { page, perPage, total } }`（perPage は既定 20・上限 100。全件数を超えるページは空の data）。金額・数量は整数、日付は `YYYY-MM-DD`、日時は ISO 8601（UTC）。商品・取引先・受注はコード・番号で表し、内部の ID は出しません。コード・番号の大文字・小文字は区別しません
- **エラー:** RFC 9457（`application/problem+json`。`type` は `about:blank`、`title` は HTTP のステータスの説明、`detail` は日本語）。400（検証エラーは `errors` に項目ごとの内容。本文の項目は JSON Pointer の `pointer`、クエリは `parameter`）／401／403／404／413（本文が 64KB を超える）／415（JSON 以外）。画面の一覧と違い、不正なクエリ（`perPage=101` など）は既定値に置き換えずに 400 にします
- **受注の登録:** 顧客コード・商品コード・数量（・納期・備考）を送ると、draft で作成します。単価は商品マスタの売価です。画面と同じ受注の service（`src/lib/sales-orders/service.ts`）を通すので、検証（顧客の種別・有効、商品の有効・重複、納期、合計の上限）・ロック・採番・金額の計算・操作履歴は画面と同じです。操作履歴の内容に「REST API（トークン #ID）から作成」と残ります。余分な項目・型違い（数量を文字列で送るなど）は 400 です

### トークンの発行

1. admin でログインし、「ユーザー管理」→ 使うユーザー（API の権限はこのユーザーのロール）の詳細を開く
2. 「API トークン」に名前を入れて発行する。表示されたトークン（`sf_` で始まる）は**この 1 回しか表示されない**ので控える（DB にはハッシュだけを保存します）
3. 不要になったら同じ画面で失効させる

### 例（curl）

```bash
TOKEN=sf_...   # 発行したトークン

# 商品一覧（検索・ページ送り）
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/v1/products?q=P-00&perPage=5"

# 商品の現在庫と発注点
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/v1/products/P-0001/stock

# 受注一覧（下書き・期間で絞り込み）と詳細
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/v1/sales-orders?status=draft&from=2026-10-01&to=2026-10-31"
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/v1/sales-orders/SO-20261013-001

# 受注の登録（staff／admin のトークン）
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"customerCode":"C-0001","dueDate":"2026-10-31","note":"API から登録","lines":[{"productCode":"P-0001","quantity":3}]}' \
  http://localhost:3000/api/v1/sales-orders
```

### 実装と OpenAPI の定義

- 入出力のスキーマは Zod で 1 か所（`src/lib/api/v1/schemas.ts`）に定義し、OpenAPI 3.1 の定義（`src/lib/api/v1/openapi.ts`）は `z.toJSONSchema` で組み立てます（手書きの JSON Schema と食い違わないように）
- `docs/openapi.json` はそのスナップショットです。API を変えたら `pnpm openapi:generate` で書き出してコミットします（一致しないと単体テストが落ちます）
- 食い違いの検出: 結合テスト（`tests/integration/rest-api.test.ts`）で、各エンドポイントの実際の応答（成功・エラーとも）を `docs/openapi.json` のスキーマで検証します（Zod とは別の実装の [ajv](https://ajv.js.org/)（JSON Schema 2020-12）で、公開する JSON そのものを確かめます。開発時の依存のみ）。定義にないステータス・Content-Type・項目の過不足・型違いはテストが落ち、定義した応答をすべてテストで返したことも確認します。Route Handler のパス・メソッドと定義の一致は単体テストで確かめます
- `/api-docs` の Swagger UI は依存に入れず、jsDelivr から版を固定し SRI（`integrity`）付きで読み込みます。この画面の応答にだけ CSP（スクリプトはその版の CDN と初期化スクリプトのハッシュだけ、通信は同じオリジンだけ）を付けています
- 残る制限: API 独自の回数制限はありません（トークンは admin が発行したものだけ）。CORS は許可していないので、ほかのオリジンのブラウザからは呼べません（サーバー間の利用を想定）

## 開発の進め方

1. GitHub Issue でタスクを切る（1 Issue = 1 ブランチ = 1 PR）
2. `feat/<issue番号>-<短い名前>` ブランチで実装
3. PR を作成し、レビュー 2 本の指摘に対応
4. CI（lint・型チェック・テスト・ビルド）が緑であることを確認
5. main にマージ
