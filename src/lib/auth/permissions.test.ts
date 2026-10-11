import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ACTIONS,
  can,
  isRole,
  PERMISSIONS,
  ROLES,
  type Action,
  type Role,
} from "./permissions";

/**
 * 期待する権限表（docs/spec.md §2 をそのまま書き写したもの）。
 * ○ = true、× = false。列は admin / staff / viewer の順
 */
const EXPECTED: Record<
  Action,
  [admin: boolean, staff: boolean, viewer: boolean]
> = {
  view: [true, true, true],
  "master:edit": [true, true, false],
  "master:deactivate": [true, false, false],
  "order:edit": [true, true, false],
  "stock:adjust": [true, true, false],
  "csv:export": [true, true, true],
  "csv:import": [true, true, false],
  "user:manage": [true, false, false],
  "audit:view": [true, false, false],
};

describe("can（ロール × 操作の全組み合わせ）", () => {
  const cases = ACTIONS.flatMap((action) =>
    ROLES.map((role, i) => ({ action, role, expected: EXPECTED[action][i] })),
  );

  it("操作 9 種 × ロール 3 種 = 27 通りを網羅している", () => {
    expect(ACTIONS).toHaveLength(9);
    expect(cases).toHaveLength(27);
  });

  it.each(cases)(
    "$role は $action を実行できる: $expected",
    ({ role, action, expected }) => {
      expect(can(role, action)).toBe(expected);
    },
  );
});

describe("docs/spec.md §2 の表との一致", () => {
  /** spec の §2 の表を「機能 → [admin, staff, viewer]」に読み取る */
  function readSpecTable(): Map<string, Record<Role, boolean>> {
    const specPath = fileURLToPath(
      new URL("../../../docs/spec.md", import.meta.url),
    );
    const spec = readFileSync(specPath, "utf8");
    const section = spec
      .split(/^## /m)
      .find((s) => s.startsWith("2. ロールと権限"));
    if (!section)
      throw new Error("spec.md に「## 2. ロールと権限」が見つかりません");

    const rows = section
      .split("\n")
      .filter((line) => line.startsWith("|"))
      .map((line) =>
        line
          .split("|")
          .slice(1, -1)
          .map((cell) => cell.trim()),
      );
    const [header, , ...body] = rows;
    expect(header).toEqual(["機能", "admin", "staff", "viewer"]);

    const table = new Map<string, Record<Role, boolean>>();
    for (const [label, ...marks] of body) {
      for (const mark of marks) expect(["○", "×"]).toContain(mark);
      table.set(label, {
        admin: marks[0] === "○",
        staff: marks[1] === "○",
        viewer: marks[2] === "○",
      });
    }
    return table;
  }

  const specTable = readSpecTable();

  it("spec の表の行と権限定義の操作が 1 対 1 に対応する", () => {
    const labels = ACTIONS.map((action) => PERMISSIONS[action].label);
    expect([...labels].sort()).toEqual([...specTable.keys()].sort());
  });

  it.each(ACTIONS)("%s の許可ロールが spec の表と一致する", (action) => {
    const row = specTable.get(PERMISSIONS[action].label);
    expect(row).toBeDefined();
    for (const role of ROLES) {
      expect(can(role, action), `${role} × ${action}`).toBe(row![role]);
    }
  });
});

describe("isRole", () => {
  it("admin / staff / viewer だけを受け付ける", () => {
    expect(ROLES.every(isRole)).toBe(true);
    expect(isRole("user")).toBe(false);
    expect(isRole("")).toBe(false);
    expect(isRole(undefined)).toBe(false);
  });
});
