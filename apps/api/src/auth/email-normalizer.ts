const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NON_PRINTABLE_ASCII = /[^\x21-\x7e]/;

export function normalizeEmail(email: string) {
  const trimmed = email.replace(/^ +| +$/g, "");
  if (
    !trimmed ||
    trimmed.length > 320 ||
    NON_PRINTABLE_ASCII.test(trimmed) ||
    !EMAIL_PATTERN.test(trimmed)
  ) {
    throw new Error("INVALID_EMAIL");
  }
  return trimmed.toLowerCase();
}

export function normalizeEmailOrNull(email: string | null | undefined) {
  if (!email) return null;
  try {
    return normalizeEmail(email);
  } catch {
    return null;
  }
}
