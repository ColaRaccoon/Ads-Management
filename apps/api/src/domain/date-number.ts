export type ParseIssue = {
  columnName: string;
  errorCode: string;
  message: string;
  rawValue?: string;
};

export function toDateOnly(value: string | null | undefined): Date | null {
  const normalized = parseDateString(value);
  if (!normalized) {
    return null;
  }
  return new Date(`${normalized}T00:00:00.000Z`);
}

export function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function parseDateString(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const input = value.trim();
  const compact = input.match(/^(\d{4})(\d{2})(\d{2})$/);
  const dash = input.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const slash = input.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  const dot = input.match(/^(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?$/);
  const match = compact ?? dash ?? slash ?? dot;

  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }

  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day
    .toString()
    .padStart(2, "0")}`;
}

export function parseNumberValue(
  value: string | number | null | undefined,
  options: { emptyAs: 0 | null }
): number | null {
  if (value === null || value === undefined) {
    return options.emptyAs;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : options.emptyAs;
  }

  const input = value.trim();
  if (!input || input === "-") {
    return options.emptyAs;
  }

  const cleaned = input.replace(/[,%\s$₩￦원]/g, "");
  if (!cleaned) {
    return options.emptyAs;
  }

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

export function safeDivide(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }
  return numerator / denominator;
}

export function dateRangeDays(from: string, to: string): number {
  const start = toDateOnly(from);
  const end = toDateOnly(to);
  if (!start || !end || end < start) {
    return 0;
  }
  return Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
}
