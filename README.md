# StockFlow（Next.js）

受発注・在庫管理の社内業務システム（デモ）です。小規模な卸・小売事業者を想定し、商品・取引先・受注・発注・在庫をブラウザで管理します。

[![CI](https://github.com/yuya1129t-project/stockflow-next/actions/workflows/ci.yml/badge.svg)](https://github.com/yuya1129t-project/stockflow-next/actions/workflows/ci.yml)

## このリポジトリについて

- 自社開発（個人の公開成果物）です。業務仕様は [docs/spec.md](docs/spec.md) にまとめています
- 実装は Claude Code が行い、要件整理・設計判断・レビュー・テスト確認は本人が行っています
- **データはすべて架空です**（実在の会社・人物・取引とは関係ありません）

## 主な機能

現時点では初期構築（土台）と DB スキーマ・シードデータまでです。以下は今後の Issue で実装する予定の機能です。

| 機能                   | 内容                                                                   | 状態 |
| ---------------------- | ---------------------------------------------------------------------- | ---- |
| 認証・ロール権限       | admin／staff／viewer。権限はサーバー側で検査                           | 予定 |
| 商品マスタ             | 一覧・検索・登録・編集・無効化、CSV 出力・取込                         | 予定 |
| 取引先マスタ           | 一覧・登録・編集、郵便番号から住所を自動入力（外部 API）               | 予定 |
| 受注                   | 明細編集、税計算（1 件ごとに切り捨て）、ステータス遷移、出荷で在庫引当 | 予定 |
| 発注                   | 明細編集、ステータス遷移、入荷で在庫加算                               | 予定 |
| 在庫                   | 現在庫一覧（発注点割れの強調）、入出庫履歴、棚卸調整                   | 予定 |
| ダッシュボード         | 今月の受注額・未出荷数・発注点割れ・入荷待ち                           | 予定 |
| ユーザー管理・操作履歴 | ユーザー・ロール管理、API トークン、操作履歴の閲覧                     | 予定 |
| 外部向け REST API      | `/api/v1`（Bearer 認証）、OpenAPI 3.1                                  | 予定 |
| 通知                   | 発注点割れを Webhook で通知                                            | 予定 |

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

DB を作り直したいときは `docker compose down -v` でボリュームごと削除してから起動し直します。

### DB 関連のコマンド

| コマンド             | 内容                                                                               |
| -------------------- | ---------------------------------------------------------------------------------- |
| `pnpm db:migrate`    | スキーマ変更からマイグレーションを作成して開発用 DB に適用（`prisma migrate dev`） |
| `pnpm db:reset`      | 開発用 DB を作り直してシードを投入（**開発用 DB のデータはすべて消えます**）       |
| `pnpm db:seed`       | シードだけを投入し直す（アプリのテーブルを空にしてから投入）                       |
| `pnpm db:test:reset` | テスト用 DB（`DATABASE_URL_TEST`）にマイグレーションを適用してシードを投入         |
| `pnpm db:generate`   | Prisma Client を生成（`pnpm install` 時にも自動で実行）                            |

- スキーマは `prisma/schema.prisma`、マイグレーションは `prisma/migrations/`。数量 > 0・価格 ≥ 0 などの CHECK 制約はマイグレーション SQL に直接書いています
- Prisma Client の生成物（`src/generated/prisma`）はコミットしません

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
- `User`／`Session`／`Account`／`Verification` は Better Auth のスキーマに合わせています（認証は #3 で実装予定）
- `StockMovement` の `refType`＋`refId` で発生元の受注・発注を指します（棚卸調整は空）

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

（#11 で追加予定）

## 開発の進め方

1. GitHub Issue でタスクを切る（1 Issue = 1 ブランチ = 1 PR）
2. `feat/<issue番号>-<短い名前>` ブランチで実装
3. PR を作成し、レビュー 2 本の指摘に対応
4. CI（lint・型チェック・テスト・ビルド）が緑であることを確認
5. main にマージ
