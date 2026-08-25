import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from "@nestjs/common";

const DANGEROUS_JSON_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;

@Injectable()
export class DangerousJsonKeysPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata) {
    if (metadata.type === "body") assertSafeJsonKeys(value);
    return value;
  }
}

export function assertSafeJsonKeys(value: unknown) {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let visited = 0;
  while (pending.length > 0) {
    const entry = pending.pop();
    if (!entry) continue;
    const { value: current, depth } = entry;
    if (!current || typeof current !== "object") continue;
    if (depth > MAX_JSON_DEPTH) throw invalidJsonStructure();
    if (seen.has(current)) continue;
    seen.add(current);
    visited += 1;
    if (visited > MAX_JSON_NODES) throw invalidJsonStructure();
    for (const key of Object.keys(current)) {
      if (DANGEROUS_JSON_KEYS.has(key) || key.length > 256 || CONTROL_CHARACTER_PATTERN.test(key)) {
        throw invalidJsonKey();
      }
      pending.push({
        value: (current as Record<string, unknown>)[key],
        depth: depth + 1
      });
    }
  }
}

function invalidJsonKey() {
  return new BadRequestException({
    code: "INVALID_JSON_KEY",
    message: "Request JSON contains an invalid object key."
  });
}

function invalidJsonStructure() {
  return new BadRequestException({
    code: "INVALID_JSON_STRUCTURE",
    message: "Request JSON exceeds the allowed depth or node count."
  });
}
