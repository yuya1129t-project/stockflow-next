/** URL の [id] を受注 ID にする（正の整数でなければ null） */
export function parseSalesOrderId(value: string): number | null {
  if (!/^\d{1,9}$/.test(value)) return null;
  const id = Number(value);
  return id >= 1 ? id : null;
}
