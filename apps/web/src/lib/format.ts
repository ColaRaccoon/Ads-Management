export function formatNumber(value: unknown, digits = 0): string {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "-";
  }
  return number.toLocaleString("ko-KR", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function formatKrw(value: unknown): string {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "-";
  }
  return `${Math.round(number).toLocaleString("ko-KR")}원`;
}

export function formatUsd(value: unknown): string {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "-";
  }
  return `$${number.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

export function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

export function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
