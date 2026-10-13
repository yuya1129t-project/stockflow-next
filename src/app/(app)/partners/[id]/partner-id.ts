/** URL の [id] を取引先 ID にする（正の整数でなければ null） */
export function parsePartnerId(value: string): number | null {
  if (!/^\d{1,9}$/.test(value)) return null;
  const id = Number(value);
  return id >= 1 ? id : null;
}
