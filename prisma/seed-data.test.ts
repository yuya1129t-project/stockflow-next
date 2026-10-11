import { describe, expect, it } from "vitest";

import { buildSeedData, toJstDateString } from "./seed-data";

describe("buildSeedData", () => {
  const now = new Date("2026-10-11T12:00:00+09:00");

  it("同じ基準日時なら毎回同じデータになる（固定シード）", () => {
    expect(buildSeedData(now)).toEqual(buildSeedData(now));
  });

  it("基準日が変わっても、日付がずれるだけで中身は同じ", () => {
    const later = buildSeedData(new Date("2026-11-01T00:30:00+09:00"));
    const base = buildSeedData(now);
    const shape = (data: typeof base) =>
      data.salesOrders.map((o) => [o.status, o.customerId, o.total, o.lines]);
    expect(shape(later)).toEqual(shape(base));
  });

  it("受注・発注の日付は基準日から過去約 90 日以内", () => {
    const data = buildSeedData(now);
    const today = toJstDateString(now);
    const from = toJstDateString(
      new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000),
    );
    for (const order of [...data.salesOrders, ...data.purchaseOrders]) {
      const ymd = order.orderDate.toISOString().slice(0, 10);
      expect(ymd >= from && ymd <= today, `${order.number}: ${ymd}`).toBe(true);
    }
  });

  it("月初（1 日の早朝）に実行しても今月の受注がある", () => {
    const monthStart = new Date("2026-11-01T00:30:00+09:00");
    const data = buildSeedData(monthStart);
    const thisMonth = toJstDateString(monthStart).slice(0, 7);
    expect(
      data.salesOrders.some(
        (o) =>
          o.status === "confirmed" &&
          o.orderDate.toISOString().startsWith(thisMonth),
      ),
    ).toBe(true);
    for (const order of data.salesOrders) {
      expect(order.createdAt.getTime()).toBeLessThanOrEqual(
        monthStart.getTime(),
      );
    }
  });
});
