import { createHmac, hkdfSync } from "node:crypto";
import { Prisma } from "@prisma/client";
import { ProviderFailure } from "./bounded-request";
import { credentialKey } from "./credential-vault";

/** Keep the observation key version fixed across credential rotations. A deliberate
 * observation-key rotation requires a new baseline, never an implicit rehash. */
export function cafe24ObservationKey(env: NodeJS.ProcessEnv = process.env) {
  // A compromised historical HMAC key cannot become a new secret by renaming
  // it. Keep its rows as quarantined evidence until a deliberate new baseline.
  if (env.DAILY_SYNC_CAFE24_OBSERVATION_REBASELINE_REQUIRED === "true")
    throw new ProviderFailure("FIELD_UNSUPPORTED", false);
  const rawVersion = env.DAILY_SYNC_CAFE24_OBSERVATION_KEY_VERSION ?? "1";
  if (!/^[1-9]\d?$/.test(rawVersion)) throw new ProviderFailure("FIELD_UNSUPPORTED", false);
  const version = Number(rawVersion);
  const independent = env.DAILY_SYNC_CAFE24_OBSERVATION_KEY_B64;
  if (independent !== undefined) {
    const key = Buffer.from(independent, "base64");
    if (version < 2 || key.length !== 32 || key.toString("base64") !== independent ||
        Object.entries(env).some(([name, value]) =>
          (/^DAILY_SYNC_CREDENTIAL_KEY_V\d+$/.test(name) || name === "DAILY_SYNC_CHECKPOINT_KEY_B64") && value === independent)) {
      key.fill(0); throw new ProviderFailure("FIELD_UNSUPPORTED", false);
    }
    return { version, key };
  }
  const credential = credentialKey(version, env);
  try {
    return { version, key: Buffer.from(hkdfSync("sha256", credential,
      Buffer.from("cafe24-observation-v1"), Buffer.from("order-revision"), 32)) };
  } finally { credential.fill(0); }
}

export function cafe24ObservationHmac(key: Buffer, domain: string, value: string) {
  return createHmac("sha256", key).update(domain).update("\0").update(value).digest("hex");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProviderFailure("FIELD_UNSUPPORTED", false);
  return value as Record<string, unknown>;
}

function identifier(value: unknown) {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))
    throw new ProviderFailure("FIELD_UNSUPPORTED", false);
  if ((typeof value !== "string" && typeof value !== "number") ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(String(value)))
    throw new ProviderFailure("FIELD_UNSUPPORTED", false);
  return String(value);
}

function text(value: unknown, max: number) {
  if (typeof value !== "string" || !value.trim() || value.length > max ||
      /[\u0000-\u001f\u007f]/.test(value))
    throw new ProviderFailure("FIELD_UNSUPPORTED", false);
  return value.trim();
}

function amount(value: unknown, precision = 18, scale = 2) {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))
    throw new ProviderFailure("FIELD_UNSUPPORTED", false);
  if ((typeof value !== "string" && typeof value !== "number") ||
      !new RegExp(`^(?:0|[1-9]\\d{0,${precision - scale - 1}})(?:\\.\\d{1,${scale}})?$`)
        .test(String(value)))
    throw new ProviderFailure("FIELD_UNSUPPORTED", false);
  return new Prisma.Decimal(String(value)).toFixed(scale);
}

function optionalText(value: unknown, max: number) {
  return value == null ? null : text(value, max);
}

/** An observed content fingerprint is not a provider revision or freshness proof. */
export function cafe24ObservedRevision(rawOrder: unknown, rawItems: unknown,
  sellerDropdownVerified: boolean, observationKey: Buffer) {
  if (!Buffer.isBuffer(observationKey) || observationKey.length !== 32)
    throw new ProviderFailure("FIELD_UNSUPPORTED", false);
  const order = record(rawOrder);
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length >= 100)
    throw new ProviderFailure("PARTIAL_PAGE", false);
  const orderId = identifier(order.order_id);
  if (order.currency !== "KRW") throw new ProviderFailure("CURRENCY_MISMATCH", false);
  const methods = order.payment_method;
  if (methods != null && (!Array.isArray(methods) || methods.length > 16 ||
      !methods.every((value) => typeof value === "string" && value.length <= 64 &&
        !/[\u0000-\u001f\u007f]/.test(value))))
    throw new ProviderFailure("FIELD_UNSUPPORTED", false);
  const itemKeys = new Set<string>();
  const items = rawItems.map((raw) => {
    const item = record(raw);
    const key = identifier(item.order_item_code);
    if (itemKeys.has(key)) throw new ProviderFailure("RECONCILIATION_FAILED", false);
    itemKeys.add(key);
    if (!Object.prototype.hasOwnProperty.call(item, "option_value") ||
        item.option_value == null || !sellerDropdownVerified)
      throw new ProviderFailure("FIELD_UNSUPPORTED", false);
    const option = text(item.option_value, 256);
    return [key, identifier(item.product_no), text(item.product_name, 256), option,
      amount(item.quantity, 14, 4), amount(item.product_price),
      optionalText(item.order_status, 64)];
  }).sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  const projection = [orderId, String(order.shop_no), text(order.order_date, 64),
    optionalText(order.place_date, 64), amount(order.payment_amount),
    order.order_price_amount == null ? null : amount(order.order_price_amount),
    methods ?? null, optionalText(order.order_status, 64), items];
  return { orderId, itemCount: items.length,
    contentHash: cafe24ObservationHmac(observationKey, "CONTENT_V1", JSON.stringify(projection)) };
}
