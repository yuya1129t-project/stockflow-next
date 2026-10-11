/**
 * デモ用シードデータの生成（DB に書き込まない純粋関数）。docs/spec.md §9
 *
 * - すべて架空。取引先名には必ず「デモ」か「サンプル」を含め、メールは example.com / example.jp、
 *   電話番号・郵便番号は 000 始まり（実在しない番号帯）にしている
 * - 乱数は固定シードなので、同じ基準日時なら毎回同じデータになる。日付は基準日（JST）からの相対日数で
 *   決めるため、いつ実行しても「過去約 90 日」に同じ形で分布する
 * - 入出庫は時系列でシミュレーションし、どの時点でも在庫が負にならないようにする
 *   （出荷時に在庫が足りない受注は出荷せず confirmed のまま残す）
 */
import { calcTax } from "../src/lib/tax";

/** デモアカウント共通のパスワード（デモ専用。画面と README に記載する前提の値） */
export const DEMO_PASSWORD = "demo-pass-1234";

/** 乱数のシード（変えるとデータ全体が変わる） */
const RANDOM_SEED = 20261011;

/** シード期間（基準日から何日前までにデータを置くか） */
const PERIOD_DAYS = 90;

export type Role = "admin" | "staff" | "viewer";
export type PartnerKind = "customer" | "supplier" | "both";
export type SalesOrderStatus = "draft" | "confirmed" | "shipped" | "cancelled";
export type PurchaseOrderStatus =
  "draft" | "ordered" | "received" | "cancelled";
export type StockMovementType = "in" | "out" | "adjust";
export type StockRefType = "sales_order" | "purchase_order";

export interface SeedUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export interface SeedPartner {
  id: number;
  code: string;
  name: string;
  kind: PartnerKind;
  postalCode: string;
  address: string;
  phone: string;
  email: string;
}

export interface SeedProduct {
  id: number;
  code: string;
  name: string;
  category: string;
  unit: string;
  salesPrice: number;
  purchasePrice: number;
  reorderPoint: number;
}

export interface SeedLine {
  productId: number;
  quantity: number;
  unitPrice: number;
}

interface SeedOrderBase {
  id: number;
  number: string;
  orderDate: Date;
  note: string | null;
  subtotal: number;
  tax: number;
  total: number;
  createdAt: Date;
  updatedAt: Date;
  lines: SeedLine[];
}

export interface SeedSalesOrder extends SeedOrderBase {
  customerId: number;
  dueDate: Date;
  status: SalesOrderStatus;
}

export interface SeedPurchaseOrder extends SeedOrderBase {
  supplierId: number;
  expectedDate: Date;
  status: PurchaseOrderStatus;
}

export interface SeedStockMovement {
  productId: number;
  type: StockMovementType;
  quantity: number;
  reason: string;
  refType: StockRefType | null;
  refId: number | null;
  userId: string;
  createdAt: Date;
}

export interface SeedDocumentSequence {
  kind: "SO" | "PO";
  date: Date;
  lastNumber: number;
}

export interface SeedData {
  users: SeedUser[];
  partners: SeedPartner[];
  products: SeedProduct[];
  salesOrders: SeedSalesOrder[];
  purchaseOrders: SeedPurchaseOrder[];
  stockMovements: SeedStockMovement[];
  documentSequences: SeedDocumentSequence[];
}

// ---------------------------------------------------------------------------
// 乱数・日付のヘルパー
// ---------------------------------------------------------------------------

/** 固定シードの擬似乱数（mulberry32） */
function createRng(seed: number) {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number =>
    min + Math.floor(next() * (max - min + 1));
  return {
    int,
    chance: (p: number): boolean => next() < p,
    pick: <T>(items: readonly T[]): T => items[int(0, items.length - 1)],
    /** 重み付きで重複なしに count 件選ぶ */
    sampleWeighted: <T>(
      items: readonly T[],
      weight: (item: T) => number,
      count: number,
    ): T[] => {
      const pool = [...items];
      const picked: T[] = [];
      while (picked.length < count && pool.length > 0) {
        const total = pool.reduce((sum, item) => sum + weight(item), 0);
        let r = next() * total;
        let index = 0;
        for (; index < pool.length - 1; index++) {
          r -= weight(pool[index]);
          if (r < 0) break;
        }
        picked.push(pool.splice(index, 1)[0]);
      }
      return picked;
    },
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 日時を JST の暦日（YYYY-MM-DD）にする */
export function toJstDateString(date: Date): string {
  return new Date(date.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** YYYY-MM-DD を DATE 列用の値（UTC 0 時）にする */
function dateOnly(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

function addDays(ymd: string, days: number): string {
  return new Date(dateOnly(ymd).getTime() + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** JST の暦日＋時刻を Date にする */
function jstDateTime(ymd: string, hour: number, minute: number): Date {
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return new Date(`${ymd}T${hh}:${mm}:00.000+09:00`);
}

function minDate(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

// ---------------------------------------------------------------------------
// マスタ（自作の架空リスト）
// ---------------------------------------------------------------------------

const USERS: SeedUser[] = [
  {
    id: "demo_admin",
    name: "デモ管理者",
    email: "admin@example.com",
    role: "admin",
  },
  {
    id: "demo_staff",
    name: "デモ担当者",
    email: "staff@example.com",
    role: "staff",
  },
  {
    id: "demo_viewer",
    name: "デモ閲覧者",
    email: "viewer@example.com",
    role: "viewer",
  },
];

const CUSTOMER_NAMES = [
  "デモ商店 あさひ店",
  "サンプル雑貨 みなと店",
  "デモ文具 ひがし店",
  "サンプルマート にし店",
  "デモ事務用品センター",
  "サンプル商会 きた店",
  "デモストア みなみ店",
  "サンプル文具館",
  "デモ生活雑貨 おか店",
  "サンプルオフィスサプライ",
  "デモ食品マート",
  "サンプル百貨 えき前店",
];

const SUPPLIER_NAMES = [
  "デモ紙製品卸",
  "サンプル文具卸",
  "デモ梱包資材",
  "サンプル日用品卸",
  "デモ飲料卸",
  "サンプル食品卸",
  "デモ事務機器卸",
  "サンプル衛生用品",
];

/** [名前, カテゴリ, 単位, 仕入単価, 仕入先（SUPPLIER_NAMES の添字）] */
const PRODUCT_SOURCE: ReadonlyArray<
  readonly [string, string, string, number, number]
> = [
  ["ボールペン 黒 0.5mm 10本入", "文具", "箱", 480, 1],
  ["ボールペン 赤 0.5mm 10本入", "文具", "箱", 480, 1],
  ["シャープペンシル 0.5mm", "文具", "本", 180, 1],
  ["シャープ替芯 HB 0.5mm", "文具", "個", 70, 1],
  ["消しゴム 小", "文具", "個", 50, 1],
  ["蛍光ペン 5色セット", "文具", "セット", 350, 1],
  ["油性マーカー 黒 太字", "文具", "本", 90, 1],
  ["大学ノート B5 5冊パック", "文具", "パック", 380, 0],
  ["付箋 75×75mm 黄", "文具", "個", 120, 0],
  ["修正テープ 5mm", "文具", "個", 160, 1],
  ["A4コピー用紙 500枚", "事務用品", "冊", 380, 0],
  ["A4コピー用紙 2500枚", "事務用品", "箱", 1850, 0],
  ["クリアファイル A4 10枚入", "事務用品", "袋", 150, 6],
  ["フラットファイル A4 10冊入", "事務用品", "パック", 520, 6],
  ["ホチキス針 No.10 1000本", "事務用品", "箱", 45, 6],
  ["ホチキス 中型", "事務用品", "個", 650, 6],
  ["ダブルクリップ 中 10個入", "事務用品", "箱", 120, 6],
  ["ゼムクリップ 100個入", "事務用品", "箱", 60, 6],
  ["電卓 12桁", "事務用品", "個", 1200, 6],
  ["はさみ 事務用", "事務用品", "個", 280, 6],
  ["段ボール箱 60サイズ 10枚", "梱包資材", "束", 900, 2],
  ["段ボール箱 80サイズ 10枚", "梱包資材", "束", 1300, 2],
  ["段ボール箱 100サイズ 10枚", "梱包資材", "束", 1800, 2],
  ["OPPテープ 48mm×100m", "梱包資材", "巻", 140, 2],
  ["クラフトテープ 50mm×50m", "梱包資材", "巻", 120, 2],
  ["エアクッション 1m×50m", "梱包資材", "巻", 1600, 2],
  ["宅配用ポリ袋 A4 100枚", "梱包資材", "パック", 650, 2],
  ["ストレッチフィルム 500mm×300m", "梱包資材", "巻", 1100, 2],
  ["荷札 100枚", "梱包資材", "箱", 220, 2],
  ["結束バンド 200mm 100本", "梱包資材", "袋", 180, 2],
  ["ハンドソープ 詰替 450ml", "日用品", "個", 210, 7],
  ["アルコール除菌スプレー 500ml", "日用品", "本", 380, 7],
  ["ゴミ袋 45L 50枚", "日用品", "袋", 290, 3],
  ["ペーパータオル 200枚 5個パック", "日用品", "パック", 480, 3],
  ["トイレットペーパー 12ロール", "日用品", "パック", 420, 3],
  ["食器用洗剤 600ml", "日用品", "本", 160, 3],
  ["ニトリル手袋 M 100枚", "日用品", "箱", 700, 7],
  ["不織布マスク 50枚入", "日用品", "箱", 450, 7],
  ["ウェットティッシュ 80枚", "日用品", "個", 140, 3],
  ["雑巾 5枚組", "日用品", "組", 300, 3],
  ["ミネラルウォーター 500ml 24本", "飲料・食品", "ケース", 1100, 4],
  ["緑茶 500ml 24本", "飲料・食品", "ケース", 1700, 4],
  ["インスタントコーヒー 80g", "飲料・食品", "個", 520, 4],
  ["スティックシュガー 100本", "飲料・食品", "袋", 260, 5],
  ["紙コップ 205ml 100個", "飲料・食品", "袋", 320, 5],
  ["個包装クッキー 30個入", "飲料・食品", "箱", 650, 5],
  ["精米 5kg", "飲料・食品", "袋", 2100, 5],
  ["小麦粉 1kg", "飲料・食品", "袋", 190, 5],
  ["上白糖 業務用", "飲料・食品", "kg", 230, 5],
  ["緑茶ティーバッグ 50袋", "飲料・食品", "箱", 480, 4],
];

/**
 * よく売れる商品（product の添字）。期首在庫を少なめにし、入荷済みの発注に含めないことで、
 * 最終的に発注点を下回る商品（ダッシュボード・通知の確認用）を作る
 */
const FAST_MOVING_INDEXES = new Set([2, 10, 23, 32, 40, 44]);

function buildPartners(): SeedPartner[] {
  const partners: SeedPartner[] = [];
  const add = (
    code: string,
    name: string,
    kind: PartnerKind,
    mailDomain: string,
  ) => {
    const id = partners.length + 1;
    const serial = String(id).padStart(4, "0");
    partners.push({
      id,
      code,
      name,
      kind,
      postalCode: `000${serial}`,
      address: `デモ県サンプル市中央${(id % 9) + 1}丁目${id}-${(id % 5) + 1}`,
      phone: `000-0000-${serial}`,
      email: `${code.toLowerCase().replace("-", "")}@${mailDomain}`,
    });
  };
  CUSTOMER_NAMES.forEach((name, i) =>
    add(`C-${String(i + 1).padStart(4, "0")}`, name, "customer", "example.jp"),
  );
  SUPPLIER_NAMES.forEach((name, i) =>
    add(`S-${String(i + 1).padStart(4, "0")}`, name, "supplier", "example.com"),
  );
  return partners;
}

// ---------------------------------------------------------------------------
// 生成本体
// ---------------------------------------------------------------------------

/** 発注・受注を作る日（基準日から何日前か）を、古い順に count 件 */
function orderDaysAgo(
  rng: ReturnType<typeof createRng>,
  count: number,
  recent: number[],
): number[] {
  const days = recent.slice();
  while (days.length < count) days.push(rng.int(1, PERIOD_DAYS - 2));
  return days.sort((a, b) => b - a);
}

function sumLines(lines: SeedLine[]) {
  const subtotal = lines.reduce(
    (sum, line) => sum + line.quantity * line.unitPrice,
    0,
  );
  const tax = calcTax(subtotal);
  return { subtotal, tax, total: subtotal + tax };
}

/**
 * デモ用シードデータを作る。
 * @param now 基準日時（通常は実行時刻）。日付はこの日（JST）から過去約 90 日に分布する
 */
export function buildSeedData(now: Date): SeedData {
  const rng = createRng(RANDOM_SEED);
  const today = toJstDateString(now);
  const dayOf = (daysAgo: number) => addDays(today, -daysAgo);

  const [admin, staff] = USERS;
  const partners = buildPartners();
  const customers = partners.filter((p) => p.kind === "customer");
  const suppliers = partners.filter((p) => p.kind === "supplier");

  // 商品
  const supplierIdOfProduct = new Map<number, number>();
  const products: SeedProduct[] = PRODUCT_SOURCE.map(
    ([name, category, unit, purchasePrice, supplierIndex], i) => {
      const id = i + 1;
      supplierIdOfProduct.set(id, suppliers[supplierIndex].id);
      // 売価は仕入単価の 1.3〜1.6 倍を 10 円単位に丸める
      const salesPrice =
        Math.round((purchasePrice * rng.int(130, 160)) / 100 / 10) * 10;
      return {
        id,
        code: `P-${String(id).padStart(4, "0")}`,
        name,
        category,
        unit,
        salesPrice,
        purchasePrice,
        reorderPoint: rng.int(2, 8) * 5,
      };
    },
  );
  const isFastMoving = (productId: number) =>
    FAST_MOVING_INDEXES.has(productId - 1);

  // 発注（40 件）。直近 6 件は入荷待ち（ordered／draft）になるよう最近の日付にする
  const poDays = orderDaysAgo(rng, 40, [0, 1, 2, 3, 5, 6]);
  const poCancelled = new Set([7, 19, 30]);
  interface PlannedPurchase {
    order: SeedPurchaseOrder;
    receivedAt: Date | null;
  }
  const plannedPurchases: PlannedPurchase[] = poDays.map((daysAgo, i) => {
    const supplierId = rng.pick(suppliers).id;
    const ymd = dayOf(daysAgo);
    const leadDays = rng.int(3, 7);
    let status: PurchaseOrderStatus;
    if (poCancelled.has(i)) status = "cancelled";
    else if (daysAgo - leadDays >= 1) status = "received";
    else if (daysAgo <= 1 && rng.chance(0.5)) status = "draft";
    else status = "ordered";

    // 仕入先の商品から 1〜4 品目。入荷済みの発注にはよく売れる商品を入れない（発注点割れを残すため）。
    // 入荷待ちの発注にはよく売れる商品を優先して入れる
    const candidates = products.filter(
      (p) => supplierIdOfProduct.get(p.id) === supplierId,
    );
    const pool =
      status === "received"
        ? candidates.filter((p) => !isFastMoving(p.id))
        : candidates;
    const picked = rng.sampleWeighted(
      pool,
      (p) => (status !== "received" && isFastMoving(p.id) ? 6 : 1),
      rng.int(1, Math.min(4, pool.length)),
    );
    const lines = picked
      .sort((a, b) => a.id - b.id)
      .map((p) => ({
        productId: p.id,
        quantity: rng.int(2, 6) * 10,
        unitPrice: p.purchasePrice,
      }));

    const createdAt = minDate(jstDateTime(ymd, 9, rng.int(0, 59)), now);
    const receivedAt =
      status === "received"
        ? jstDateTime(addDays(ymd, leadDays), 14, rng.int(0, 59))
        : null;
    return {
      order: {
        id: 0,
        number: "",
        supplierId,
        orderDate: dateOnly(ymd),
        expectedDate: dateOnly(addDays(ymd, leadDays)),
        status,
        note:
          status === "cancelled" ? "仕入先の在庫切れのため取消（デモ）" : null,
        ...sumLines(lines),
        createdAt,
        updatedAt: receivedAt ?? createdAt,
        lines,
      },
      receivedAt,
    };
  });

  // 受注（80 件）。今日の受注を 3 件入れ、月初でもダッシュボードの「今月」に出るようにする
  const soDays = orderDaysAgo(rng, 80, [0, 0, 0, 1, 2, 3]);
  const soCancelled = new Set([5, 18, 33, 47, 61, 72]);
  interface PlannedSale {
    order: SeedSalesOrder;
    shipAt: Date | null;
  }
  const plannedSales: PlannedSale[] = soDays.map((daysAgo, i) => {
    const customerId = rng.pick(customers).id;
    const ymd = dayOf(daysAgo);
    const shipDays = rng.int(1, 4);
    let status: SalesOrderStatus;
    if (soCancelled.has(i)) status = "cancelled";
    else if (daysAgo - shipDays >= 1) status = "shipped";
    else if (daysAgo === 0 && rng.chance(0.4)) status = "draft";
    else status = "confirmed";

    const picked = rng.sampleWeighted(
      products,
      (p) => (isFastMoving(p.id) ? 3 : 1),
      rng.int(1, 4),
    );
    const lines = picked
      .sort((a, b) => a.id - b.id)
      .map((p) => ({
        productId: p.id,
        quantity: isFastMoving(p.id) ? rng.int(3, 8) : rng.int(1, 8),
        unitPrice: p.salesPrice,
      }));

    const createdAt = minDate(jstDateTime(ymd, 10, rng.int(0, 59)), now);
    return {
      order: {
        id: 0,
        number: "",
        customerId,
        orderDate: dateOnly(ymd),
        dueDate: dateOnly(addDays(ymd, rng.int(3, 10))),
        status,
        note: status === "cancelled" ? "お客様都合により取消（デモ）" : null,
        ...sumLines(lines),
        createdAt,
        updatedAt: createdAt,
        lines,
      },
      shipAt:
        status === "shipped"
          ? jstDateTime(addDays(ymd, shipDays), 11, rng.int(0, 59))
          : null,
    };
  });

  // 伝票番号（日付ごとに 001 から）と ID（受注日順）を振る
  const sequences = new Map<string, number>();
  const assignNumber = (kind: "SO" | "PO", orderDate: Date): string => {
    const ymd = orderDate.toISOString().slice(0, 10);
    const key = `${kind}:${ymd}`;
    const n = (sequences.get(key) ?? 0) + 1;
    sequences.set(key, n);
    return `${kind}-${ymd.replaceAll("-", "")}-${String(n).padStart(3, "0")}`;
  };
  plannedPurchases.forEach((p, i) => {
    p.order.id = i + 1;
    p.order.number = assignNumber("PO", p.order.orderDate);
  });
  plannedSales.forEach((s, i) => {
    s.order.id = i + 1;
    s.order.number = assignNumber("SO", s.order.orderDate);
  });

  // 入出庫を時系列でシミュレーションする
  type StockEvent =
    | { at: Date; kind: "initial" }
    | { at: Date; kind: "receive"; plan: PlannedPurchase }
    | { at: Date; kind: "ship"; plan: PlannedSale }
    | { at: Date; kind: "stocktake"; productId: number; delta: number };

  const events: StockEvent[] = [
    { at: jstDateTime(dayOf(PERIOD_DAYS), 8, 0), kind: "initial" },
  ];
  for (const plan of plannedPurchases) {
    if (plan.receivedAt)
      events.push({ at: plan.receivedAt, kind: "receive", plan });
  }
  for (const plan of plannedSales) {
    if (plan.shipAt) events.push({ at: plan.shipAt, kind: "ship", plan });
  }
  // 棚卸差異（数件。よく売れる商品以外）
  const normalProducts = products.filter((p) => !isFastMoving(p.id));
  for (let i = 0; i < 8; i++) {
    const delta = rng.int(1, 3) * (rng.chance(0.5) ? 1 : -1);
    events.push({
      at: jstDateTime(dayOf(rng.int(5, PERIOD_DAYS - 10)), 17, rng.int(30, 59)),
      kind: "stocktake",
      productId: rng.pick(normalProducts).id,
      delta,
    });
  }
  events.sort((a, b) => a.at.getTime() - b.at.getTime());

  const stock = new Map<number, number>(products.map((p) => [p.id, 0]));
  const movements: SeedStockMovement[] = [];
  for (const event of events) {
    switch (event.kind) {
      case "initial":
        for (const p of products) {
          const quantity = isFastMoving(p.id)
            ? p.reorderPoint + rng.int(25, 40)
            : p.reorderPoint * 2 + rng.int(40, 100);
          stock.set(p.id, quantity);
          movements.push({
            productId: p.id,
            type: "adjust",
            quantity,
            reason: "期首在庫（棚卸）",
            refType: null,
            refId: null,
            userId: admin.id,
            createdAt: event.at,
          });
        }
        break;
      case "receive":
        for (const line of event.plan.order.lines) {
          stock.set(line.productId, stock.get(line.productId)! + line.quantity);
          movements.push({
            productId: line.productId,
            type: "in",
            quantity: line.quantity,
            reason: "発注の入荷",
            refType: "purchase_order",
            refId: event.plan.order.id,
            userId: staff.id,
            createdAt: event.at,
          });
        }
        break;
      case "ship": {
        const { order } = event.plan;
        // 1 行でも在庫が足りなければ出荷しない（spec §4 と同じ）。確定のまま残す
        if (
          order.lines.some((line) => stock.get(line.productId)! < line.quantity)
        ) {
          order.status = "confirmed";
          order.note = "在庫不足のため出荷待ち（デモ）";
          event.plan.shipAt = null;
          break;
        }
        for (const line of order.lines) {
          stock.set(line.productId, stock.get(line.productId)! - line.quantity);
          movements.push({
            productId: line.productId,
            type: "out",
            quantity: -line.quantity,
            reason: "受注の出荷",
            refType: "sales_order",
            refId: order.id,
            userId: staff.id,
            createdAt: event.at,
          });
        }
        order.updatedAt = event.at;
        break;
      }
      case "stocktake": {
        const current = stock.get(event.productId)!;
        const delta = current + event.delta < 0 ? -event.delta : event.delta;
        stock.set(event.productId, current + delta);
        movements.push({
          productId: event.productId,
          type: "adjust",
          quantity: delta,
          reason: "棚卸差異",
          refType: null,
          refId: null,
          userId: admin.id,
          createdAt: event.at,
        });
        break;
      }
    }
  }

  const documentSequences: SeedDocumentSequence[] = [
    ...sequences.entries(),
  ].map(([key, lastNumber]) => {
    const [kind, ymd] = key.split(":") as ["SO" | "PO", string];
    return { kind, date: dateOnly(ymd), lastNumber };
  });

  return {
    users: USERS,
    partners,
    products,
    salesOrders: plannedSales.map((s) => s.order),
    purchaseOrders: plannedPurchases.map((p) => p.order),
    stockMovements: movements,
    documentSequences,
  };
}
