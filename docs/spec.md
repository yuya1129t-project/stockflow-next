# StockFlow 共通仕様書（受発注・在庫管理） v1.1 / 2026-10-11

同じ業務仕様を ① Next.js＋TypeScript ② Laravel ③ Python（FastAPI）で実装する。3本とも、この仕様を各リポジトリの `docs/spec.md` にコピーして使う。データはすべて架空のダミー。

## 1. 想定
- 小規模な卸・小売事業者（架空）の社内業務システム。倉庫は1か所
- 利用者は社内のスタッフ数名。PC のブラウザで使う（スマホ幅でも崩れない）
- 金額は円の整数。消費税は 10%、受注・発注の1件ごとに税額を計算し、1円未満は切り捨て
- 日時は Asia/Tokyo で表示

## 2. ロールと権限
| 機能 | admin | staff | viewer |
|---|---|---|---|
| ダッシュボード・各一覧・詳細の閲覧 | ○ | ○ | ○ |
| 商品・取引先の登録・編集 | ○ | ○ | × |
| 商品・取引先の無効化（論理削除） | ○ | × | × |
| 受注・発注の作成・編集・ステータス変更 | ○ | ○ | × |
| 在庫の棚卸調整 | ○ | ○ | × |
| CSV 出力 | ○ | ○ | ○ |
| CSV 取込（商品） | ○ | ○ | × |
| ユーザー管理 | ○ | × | × |
| 操作履歴の閲覧 | ○ | × | × |

- 権限は**サーバー側で必ず検査**する（画面でボタンを隠すだけにしない）。権限外は 403
- 未ログインはログイン画面へ。API は 401

## 3. データ
| エンティティ | 主な項目 | ルール |
|---|---|---|
| User | email（一意）, name, role, password（ハッシュ）, isActive | 無効ユーザーはログイン不可。自分自身の無効化・ロール変更は不可 |
| Product 商品 | code（一意, 例 P-0001）, name, category, unit（個/箱/kg 等）, salesPrice, purchasePrice, reorderPoint（発注点）, isActive | 価格・発注点は0以上の整数。無効商品は新規の受注・発注で選べない |
| Partner 取引先 | code（一意, 例 C-0001／S-0001）, name, kind（customer/supplier/both）, postalCode, address, phone, email, isActive | 郵便番号は7桁（ハイフン有無どちらも受け付け、保存はハイフンなし） |
| SalesOrder 受注 | number（SO-YYYYMMDD-NNN）, customerId, orderDate, dueDate, status, note, 明細[], subtotal, tax, total | 顧客は kind が customer か both |
| SalesOrderLine | productId, quantity（1以上）, unitPrice | 明細の単価は受注時点の値を保存（商品マスタ変更の影響を受けない） |
| PurchaseOrder 発注 | number（PO-YYYYMMDD-NNN）, supplierId, orderDate, expectedDate, status, note, 明細[], subtotal, tax, total | 仕入先は kind が supplier か both |
| PurchaseOrderLine | productId, quantity, unitPrice | 同上 |
| StockMovement 入出庫 | productId, type（in/out/adjust）, quantity（符号付き）, reason, refType, refId, userId, createdAt | 現在庫 = 入出庫の合計。履歴は更新・削除しない |
| AuditLog 操作履歴 | userId, action, targetType, targetId, summary, createdAt | 登録・更新・ステータス変更・ログインを記録 |

## 4. ステータス遷移
受注: `draft（下書き）→ confirmed（確定）→ shipped（出荷済）`、`draft／confirmed → cancelled（取消）`
- 明細の編集は draft のときだけ
- confirmed には明細が1行以上必要
- shipped にするとき、全明細の在庫が足りていることを確認し、出庫（out）を**同一トランザクション**で記録。1行でも不足なら全体を中止し、不足する商品と数量を表示
- shipped と cancelled は最終状態（戻せない）

発注: `draft → ordered（発注済）→ received（入荷済）`、`draft／ordered → cancelled`
- received にするとき、全明細の入庫（in）を同一トランザクションで記録

棚卸調整: 実数を入力 → 差分を adjust として記録。理由は必須

## 5. 画面
1. ログイン（デモ用に admin／staff／viewer のログイン情報を画面に表示）
2. ダッシュボード: 今月の受注額（shipped と confirmed の合計）、未出荷の受注数、発注点を下回る商品、入荷待ちの発注
3. 商品: 一覧（コード・名前・カテゴリで検索、並べ替え、ページ送り、現在庫と発注点割れの表示）、登録・編集、CSV 出力・取込
4. 取引先: 一覧・検索、登録・編集。郵便番号を入れると住所を自動入力（外部 API。§6）
5. 受注: 一覧（番号・顧客・ステータス・期間で絞り込み、CSV 出力）、作成・編集（明細の行追加・削除、小計・税・合計の自動計算）、詳細とステータス操作
6. 発注: 受注と同じ構成
7. 在庫: 現在庫一覧（発注点割れを強調）、商品ごとの入出庫履歴、棚卸調整
8. ユーザー管理（admin）: 一覧・登録・ロール変更・無効化、API トークンの発行・失効
9. 操作履歴（admin）: 一覧・絞り込み

## 6. 外部 API 連携
- 郵便番号→住所: zipcloud（https://zipcloud.ibsnet.co.jp/doc/api ）を**サーバー側**から呼ぶ
- タイムアウト 3 秒。失敗・該当なしのときは「住所を手入力してください」と表示して手入力を続けられること
- テストでは外部 API をモックする（CI から実 API を叩かない）

## 6-2. 外部向け REST API（3実装で同一仕様）
- ベース `/api/v1`。認証は `Authorization: Bearer <token>`。トークンは admin がユーザーごとに発行（表示は発行時の1回のみ、DB にはハッシュで保存）、失効できる。権限はトークンの持ち主のロールに従う（§2）
- エンドポイント
  - `GET /api/v1/products?q=&page=&perPage=` 商品一覧（現在庫を含む）
  - `GET /api/v1/products/{code}/stock` 商品の現在庫と発注点
  - `GET /api/v1/sales-orders?status=&from=&to=&page=&perPage=` 受注一覧
  - `GET /api/v1/sales-orders/{number}` 受注詳細（明細を含む）
  - `POST /api/v1/sales-orders` 受注の登録（draft で作成。顧客コード・商品コード・数量で指定し、単価は商品マスタから）
- 一覧の応答 `{ data: [...], meta: { page, perPage, total } }`。perPage は既定 20・上限 100
- エラーは RFC 9457（`application/problem+json`）。400 検証エラー（項目ごとの内容を含む）／401／403／404
- OpenAPI 3.1 の定義を `/api/v1/openapi.json` で返し、`/api-docs` で閲覧できる（Swagger UI 等）

## 6-3. 通知
- 入出庫の結果、商品の現在庫が発注点以上 → 発注点未満に変わったとき、Webhook（Slack Incoming Webhook 形式）に通知
- 送信はトランザクション確定後。失敗しても業務処理は取り消さない（操作履歴に失敗を記録）。タイムアウト 3 秒
- Webhook URL は環境変数。未設定なら送らない（デモでは未設定）

## 7. CSV
- 出力: UTF-8（BOM 付き。Excel で文字化けしない）、ヘッダー行あり、表示中の絞り込み条件を反映
- 取込（商品）: code が既存なら更新、なければ新規。1行でもエラーがあれば全体を取り込まず、行番号とエラー内容を一覧表示。上限 1,000 行

## 8. 品質
- 入力検証はサーバー側で必ず行う（画面側の検証は補助）。エラー文は日本語
- テスト: ドメインロジック（税計算・ステータス遷移・在庫引当）の単体テスト、権限・トランザクションの結合テスト（実 DB）、主要フローの E2E（ログイン→受注作成→確定→出荷→在庫が減る 等）
- CI（GitHub Actions）: lint・型チェック（または静的解析）・テスト・ビルド。main へのマージは CI 緑が条件
- 秘密情報はリポジトリに入れない（`.env.example` のみ）

## 9. デモ公開
- シードデータ: 商品 50・取引先 20（顧客 12・仕入先 8）・受注 80・発注 40・入出庫履歴。すべて架空
- デモ用アカウント（admin／staff／viewer）。パスワードはデモ専用の値で、画面と README に記載
- デモデータは1日1回リセット（スケジュール実行）
- 無料枠で運用する
