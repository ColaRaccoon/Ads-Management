export const MAX_KRW_INTEGER = 999_999_999_999;

export type KrwParseResult =
  | { kind: "empty" }
  | { kind: "valid"; value: number }
  | { kind: "invalid"; message: string };

export function parseKrwIntegerInput(raw: string): KrwParseResult {
  const text = raw.trim();
  if (!text) return { kind: "empty" };
  if (!/^\d{1,3}(?:,\d{3})*$|^\d+$/.test(text)) {
    return { kind: "invalid", message: "0 이상의 원화 정수만 입력하세요. 천 단위 쉼표는 사용할 수 있습니다." };
  }
  const value = Number(text.replaceAll(",", ""));
  if (!Number.isSafeInteger(value) || value > MAX_KRW_INTEGER) {
    return { kind: "invalid", message: `금액은 ${MAX_KRW_INTEGER.toLocaleString("ko-KR")}원 이하여야 합니다.` };
  }
  return { kind: "valid", value };
}

export function formatKrwInputValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined || String(value).trim() === "") return "";
  const parsed = parseKrwIntegerInput(String(value));
  return parsed.kind === "valid" ? parsed.value.toLocaleString("ko-KR") : String(value);
}

export function krwInputToOptionalNumber(raw: string): number | undefined {
  const parsed = parseKrwIntegerInput(raw);
  if (parsed.kind === "invalid") throw new Error(parsed.message);
  return parsed.kind === "valid" ? parsed.value : undefined;
}
