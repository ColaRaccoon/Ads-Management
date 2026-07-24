export class PercentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PercentInputError";
  }
}

export function rateToPercentInput(value: unknown) {
  if (value === null || value === undefined || String(value).trim() === "") return "";
  const rate = Number(value);
  if (!Number.isFinite(rate)) return "";
  return normalizeDecimal(rate * 100, 6);
}

export function percentInputToRate(value: string) {
  const text = value.trim();
  if (!text) return undefined;
  const percent = Number(text);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new PercentInputError("판매 수수료율은 0 이상 100 이하의 숫자여야 합니다.");
  }
  return Math.round((percent / 100) * 1_000_000) / 1_000_000;
}

export function normalizePercentInput(value: string) {
  const rate = percentInputToRate(value);
  return rate === undefined ? "" : rateToPercentInput(rate);
}

function normalizeDecimal(value: number, maximumFractionDigits: number) {
  return Number(value.toFixed(maximumFractionDigits)).toString();
}
