import { describe, expect, it } from "vitest";

import {
  emptyPartnerForm,
  formatPostalCode,
  hasPartnerRole,
  nextPartnerCode,
  normalizePostalCode,
  partnerFieldErrors,
  partnerInputSchema,
  partnerKindsFor,
  toPartnerFormValues,
  type PartnerFormValues,
} from "./schema";

const VALID: PartnerFormValues = {
  code: "C-0101",
  name: "デモ商店 テスト店",
  kind: "customer",
  postalCode: "000-0001",
  address: "デモ県サンプル市中央1丁目1-1",
  phone: "000-0000-0001",
  email: "demo@example.com",
};

function errorsOf(values: Partial<PartnerFormValues>) {
  const result = partnerInputSchema.safeParse({ ...VALID, ...values });
  if (result.success) throw new Error("検証が通ってしまいました");
  return partnerFieldErrors(result.error);
}

describe("partnerInputSchema", () => {
  it("正しい入力: 郵便番号はハイフンなしの 7 桁にし、前後の空白は除く", () => {
    expect(
      partnerInputSchema.parse({ ...VALID, name: "  デモ商店 テスト店 " }),
    ).toEqual({
      code: "C-0101",
      name: "デモ商店 テスト店",
      kind: "customer",
      postalCode: "0000001",
      address: "デモ県サンプル市中央1丁目1-1",
      phone: "000-0000-0001",
      email: "demo@example.com",
    });
  });

  it("郵便番号・住所・電話番号・メールアドレスは任意（空なら null）", () => {
    expect(
      partnerInputSchema.parse({
        ...VALID,
        postalCode: "",
        address: "  ",
        phone: "",
        email: "",
      }),
    ).toMatchObject({
      postalCode: null,
      address: null,
      phone: null,
      email: null,
    });
  });

  it("空の必須項目は日本語のエラー", () => {
    const result = partnerInputSchema.safeParse({
      ...emptyPartnerForm(),
      kind: "",
    });
    expect(result.success).toBe(false);
    expect(partnerFieldErrors(result.error!)).toEqual({
      code: ["取引先コードを入力してください"],
      name: ["取引先名を入力してください"],
      kind: ["種別を選択してください"],
    });
  });

  it("取引先コードは大文字に揃える", () => {
    expect(partnerInputSchema.parse({ ...VALID, code: "c-0101" }).code).toBe(
      "C-0101",
    );
  });

  it.each(["-C01", "C 01", "C/01", "Ｃ-01", "あ"])(
    "取引先コードの形式が違う（%j）とエラー",
    (code) => {
      expect(errorsOf({ code }).code?.[0]).toMatch(/^取引先コードは半角英数字/);
    },
  );

  it("文字数の上限", () => {
    expect(errorsOf({ code: "C".repeat(21) }).code).toEqual([
      "取引先コードは20文字以内で入力してください",
    ]);
    expect(errorsOf({ name: "あ".repeat(101) }).name).toEqual([
      "取引先名は100文字以内で入力してください",
    ]);
    expect(errorsOf({ address: "あ".repeat(201) }).address).toEqual([
      "住所は200文字以内で入力してください",
    ]);
  });

  it.each(["name", "address"] as const)(
    "%s に改行・タブなどの制御文字があるとエラー",
    (field) => {
      for (const value of ["一行目\n二行目", "a\tb", "a\u0000b", "a\u007fb"]) {
        expect(errorsOf({ [field]: value })[field]?.[0]).toMatch(
          /改行・タブなどの制御文字は使えません$/,
        );
      }
    },
  );

  it.each(["name", "address"] as const)(
    "%s に行区切り・表示方向の制御・BOM・C1 制御があるとエラー",
    (field) => {
      for (const char of [
        "\u2028",
        "\u2029",
        "\u200e",
        "\u200f",
        "\u202a",
        "\u202e",
        "\u2066",
        "\u2069",
        "\ufeff",
        "\u0085",
        "\u009f",
      ]) {
        expect(errorsOf({ [field]: `あ${char}い` })[field]?.[0]).toMatch(
          /改行・タブなどの制御文字は使えません$/,
        );
      }
    },
  );

  it("日本語・記号・絵文字は通る", () => {
    const parsed = partnerInputSchema.parse({
      ...VALID,
      name: "株式会社テスト（東京）😀",
      address: "東京都千代田区1-1-1　ビル２階",
    });
    expect(parsed.name).toBe("株式会社テスト（東京）😀");
    expect(parsed.address).toBe("東京都千代田区1-1-1　ビル２階");
  });

  it("種別は customer／supplier／both のどれか", () => {
    for (const kind of ["customer", "supplier", "both"]) {
      expect(partnerInputSchema.parse({ ...VALID, kind }).kind).toBe(kind);
    }
    // 画面の select・改ざんされた送信では型にない値も届きうる
    expect(
      errorsOf({ kind: "admin" as PartnerFormValues["kind"] }).kind,
    ).toEqual(["種別を選択してください"]);
  });

  describe("郵便番号（7 桁。ハイフン有無どちらも受け付け、保存はハイフンなし）", () => {
    it.each([
      ["1234567", "1234567"],
      ["123-4567", "1234567"],
      [" 123-4567 ", "1234567"],
      ["１２３－４５６７", "1234567"],
      ["１２３ー４５６７", "1234567"],
    ])("%j → %j", (input, expected) => {
      expect(
        partnerInputSchema.parse({ ...VALID, postalCode: input }).postalCode,
      ).toBe(expected);
    });

    it.each([
      "123456",
      "12345678",
      "1234-567",
      "123--4567",
      "123 4567",
      "〒1234567",
      "abc-defg",
    ])("形式が違う（%j）とエラー", (postalCode) => {
      expect(errorsOf({ postalCode }).postalCode).toEqual([
        "郵便番号は7桁の数字で入力してください（例 123-4567）",
      ]);
    });
  });

  describe("電話番号", () => {
    it.each([
      ["03-1234-5678", "03-1234-5678"],
      ["0312345678", "0312345678"],
      ["090-1234-5678", "090-1234-5678"],
      ["000-0000-0001", "000-0000-0001"], // シードの形式
      ["０３－１２３４－５６７８", "03-1234-5678"],
    ])("%j → %j", (input, expected) => {
      expect(partnerInputSchema.parse({ ...VALID, phone: input }).phone).toBe(
        expected,
      );
    });

    it.each([
      "3-1234-5678",
      "03-1234-567",
      "090-1234-56789",
      "03--1234-5678",
      "03-1234-5678-",
      "03-12-34-5678",
      "(03)1234-5678",
      "03-1234-abcd",
    ])("形式が違う（%j）とエラー", (phone) => {
      expect(errorsOf({ phone }).phone?.[0]).toMatch(/^電話番号は/);
    });
  });

  describe("メールアドレス", () => {
    it.each(["a@example", "example.com", "a b@example.com", "a@@example.com"])(
      "形式が違う（%j）とエラー",
      (email) => {
        expect(errorsOf({ email }).email).toEqual([
          "メールアドレスの形式が正しくありません（例 info@example.com）",
        ]);
      },
    );

    it("長すぎるとエラー", () => {
      expect(
        errorsOf({ email: `${"a".repeat(250)}@example.com` }).email?.[0],
      ).toBe("メールアドレスは254文字以内で入力してください");
    });
  });
});

describe("normalizePostalCode・formatPostalCode", () => {
  it("正規化と表示用の整形", () => {
    expect(normalizePostalCode("123-4567")).toBe("1234567");
    expect(normalizePostalCode("12-34567")).toBeNull();
    expect(formatPostalCode("1234567")).toBe("123-4567");
    expect(formatPostalCode(null)).toBe("");
  });
});

describe("toPartnerFormValues", () => {
  it("保存済みの値をフォームの値にし、そのまま検証を通る（編集画面の初期値）", () => {
    const saved = partnerInputSchema.parse(VALID);
    const values = toPartnerFormValues(saved);
    expect(values.postalCode).toBe("000-0001");
    expect(partnerInputSchema.parse(values)).toEqual(saved);

    const empty = partnerInputSchema.parse({
      ...VALID,
      postalCode: "",
      address: "",
      phone: "",
      email: "",
    });
    expect(toPartnerFormValues(empty)).toMatchObject({
      postalCode: "",
      address: "",
      phone: "",
      email: "",
    });
  });
});

describe("nextPartnerCode（登録画面で提案するコード）", () => {
  const codes = ["C-0001", "C-0012", "S-0008", "C-0003", "C-X1", "ZC-0099"];

  it("種別ごとの接頭辞で、最大の番号＋1 を 4 桁で返す", () => {
    expect(nextPartnerCode("customer", codes)).toBe("C-0013");
    expect(nextPartnerCode("supplier", codes)).toBe("S-0009");
    expect(nextPartnerCode("both", codes)).toBe("B-0001");
  });

  it("9999 を超えたら桁を増やす", () => {
    expect(nextPartnerCode("customer", ["C-9999"])).toBe("C-10000");
  });
});

describe("partnerKindsFor・hasPartnerRole（spec §3: 顧客は customer か both、仕入先は supplier か both）", () => {
  it("役割ごとの種別", () => {
    expect(partnerKindsFor("customer")).toEqual(["customer", "both"]);
    expect(partnerKindsFor("supplier")).toEqual(["supplier", "both"]);
    expect(hasPartnerRole("both", "customer")).toBe(true);
    expect(hasPartnerRole("both", "supplier")).toBe(true);
    expect(hasPartnerRole("customer", "supplier")).toBe(false);
    expect(hasPartnerRole("supplier", "customer")).toBe(false);
  });
});
