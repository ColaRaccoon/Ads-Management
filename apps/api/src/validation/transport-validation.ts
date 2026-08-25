import { Transform } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  registerDecorator,
  ValidateIf,
  ValidationArguments,
  ValidationOptions
} from "class-validator";

export const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INVALID_BOUNDED_JSON = Symbol("invalidBoundedJson");

export abstract class TransportDto {
  [key: string]: unknown;
}

export function IsOptionalUndefined(): PropertyDecorator {
  return ValidateIf((_object, value) => value !== undefined);
}

export function IsDateOnly(validationOptions?: ValidationOptions): PropertyDecorator {
  return (target, propertyKey) => {
    registerDecorator({
      name: "isDateOnly",
      target: target.constructor,
      propertyName: propertyKey.toString(),
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (typeof value !== "string" || !DATE_ONLY_PATTERN.test(value)) return false;
          const parsed = new Date(`${value}T00:00:00.000Z`);
          return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a valid YYYY-MM-DD date`;
        }
      }
    });
  };
}

export function IsOnOrAfter(property: string, validationOptions?: ValidationOptions): PropertyDecorator {
  return (target, propertyKey) => {
    registerDecorator({
      name: "isOnOrAfter",
      target: target.constructor,
      propertyName: propertyKey.toString(),
      constraints: [property],
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const start = (args.object as Record<string, unknown>)[args.constraints[0]];
          return value === undefined || value === null || start === undefined || start === null
            || (typeof value === "string" && typeof start === "string" && value >= start);
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be on or after ${args.constraints[0]}`;
        }
      }
    });
  };
}

export function IsBoundedJson(
  options: { maxDepth?: number; maxNodes?: number; maxBytes?: number } = {},
  validationOptions?: ValidationOptions
): PropertyDecorator {
  const maxDepth = options.maxDepth ?? 6;
  const maxNodes = options.maxNodes ?? 500;
  const maxBytes = options.maxBytes ?? 32_768;
  return (target, propertyKey) => {
    Transform(({ value, obj, key }) => boundedJson(obj?.[key], maxDepth, maxNodes, maxBytes)
      ? value
      : INVALID_BOUNDED_JSON)(target, propertyKey);
    registerDecorator({
      name: "isBoundedJson",
      target: target.constructor,
      propertyName: propertyKey.toString(),
      constraints: [maxDepth, maxNodes, maxBytes],
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          return boundedJson(value, maxDepth, maxNodes, maxBytes);
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} exceeds JSON depth, node, or size limits`;
        }
      }
    });
  };
}

export function IsPlainRecord(validationOptions?: ValidationOptions): PropertyDecorator {
  return (target, propertyKey) => {
    registerDecorator({
      name: "isPlainRecord",
      target: target.constructor,
      propertyName: propertyKey.toString(),
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          return value !== null && typeof value === "object" && !Array.isArray(value)
            && Object.getPrototypeOf(value) === Object.prototype;
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a JSON object`;
        }
      }
    });
  };
}

export function IsFiniteNumeric(
  options: { min?: number; max?: number; maxDecimalPlaces?: number; integer?: boolean } = {},
  validationOptions?: ValidationOptions
): PropertyDecorator {
  return (target, propertyKey) => {
    registerDecorator({
      name: "isFiniteNumeric",
      target: target.constructor,
      propertyName: propertyKey.toString(),
      constraints: [options],
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          const text = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
          if (!/^-?\d+(?:\.\d+)?$/.test(text)) return false;
          const parsed = Number(text);
          if (!Number.isFinite(parsed)) return false;
          if (options.integer && !Number.isInteger(parsed)) return false;
          if (options.min !== undefined && parsed < options.min) return false;
          if (options.max !== undefined && parsed > options.max) return false;
          const decimals = text.includes(".") ? text.length - text.indexOf(".") - 1 : 0;
          return options.maxDecimalPlaces === undefined || decimals <= options.maxDecimalPlaces;
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a bounded finite numeric value`;
        }
      }
    });
  };
}

export function StrictPositiveInteger(max: number): PropertyDecorator {
  return (target, propertyKey) => {
    Transform(({ value }) => strictInteger(value))(target, propertyKey);
    IsInt()(target, propertyKey);
    Min(1)(target, propertyKey);
    Max(max)(target, propertyKey);
  };
}

export class DateRangeQueryDto extends TransportDto {
  @IsOptionalUndefined()
  @IsDateOnly()
  from?: string;

  @IsOptionalUndefined()
  @IsDateOnly()
  @IsOnOrAfter("from")
  to?: string;
}

export class RequiredDateRangeDto extends TransportDto {
  @IsDateOnly()
  from!: string;

  @IsDateOnly()
  @IsOnOrAfter("from")
  to!: string;
}

export class DateQueryDto extends TransportDto {
  @IsOptionalUndefined()
  @IsDateOnly()
  date?: string;
}

export class IncludeInactiveQueryDto extends TransportDto {
  @IsOptionalUndefined()
  @IsIn(["true", "false"])
  includeInactive?: string;
}

export class TakeQueryDto extends TransportDto {
  @IsOptionalUndefined()
  @StrictPositiveInteger(500)
  take?: number;
}

export class DateRangeTakeQueryDto extends DateRangeQueryDto {
  @IsOptionalUndefined()
  @StrictPositiveInteger(5_000)
  take?: number;
}

export class UuidParamDto extends TransportDto {
  @IsUuidV4()
  id!: string;
}

export class ProductIdQueryDto extends TransportDto {
  @IsOptionalUndefined()
  @IsUuidV4()
  productId?: string;
}

export function IsUuidV4(validationOptions?: ValidationOptions): PropertyDecorator {
  return (target, propertyKey) => {
    registerDecorator({
      name: "isUuidV4",
      target: target.constructor,
      propertyName: propertyKey.toString(),
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          return typeof value === "string" && UUID_V4_PATTERN.test(value);
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a UUID v4`;
        }
      }
    });
  };
}

export class SearchQueryDto extends TransportDto {
  @IsOptionalUndefined()
  @IsString()
  @MaxLength(200)
  q?: string;
}

function strictInteger(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return Number(value);
  return value;
}

function boundedJson(value: unknown, maxDepth: number, maxNodes: number, maxBytes: number) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > maxBytes) return false;
  } catch {
    return false;
  }
  let nodes = 0;
  let bytes = 0;
  const encoder = new TextEncoder();
  const dangerousKeys = new Set(["__proto__", "prototype", "constructor"]);
  const visit = (current: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > maxNodes || depth > maxDepth) return false;
    if (current === null || typeof current === "boolean") return true;
    if (typeof current === "number") return Number.isFinite(current);
    if (typeof current === "string") {
      bytes += encoder.encode(current).byteLength;
      return bytes <= maxBytes;
    }
    if (Array.isArray(current)) {
      return current.length <= maxNodes && current.every((item) => visit(item, depth + 1));
    }
    if (!current || typeof current !== "object" || Object.getPrototypeOf(current) !== Object.prototype) return false;
    const entries = Object.entries(current as Record<string, unknown>);
    if (entries.length > maxNodes) return false;
    for (const [key, child] of entries) {
      if (dangerousKeys.has(key) || key.length > 256 || /[\u0000-\u001f\u007f]/.test(key)) return false;
      bytes += encoder.encode(key).byteLength;
      if (bytes > maxBytes || !visit(child, depth + 1)) return false;
    }
    return true;
  };
  return visit(value, 0);
}
