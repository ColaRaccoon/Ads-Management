import { timingSafeEqual } from "node:crypto";
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Request } from "express";
import { enabledSync } from "../daily-sync/sync-contract";
import { AUTH_ROUTE_ACCESS, MACHINE_SYNC_ROUTE } from "./route-decorators";

export const MACHINE_SYNC_AUTHORIZED = Symbol("MACHINE_SYNC_AUTHORIZED");
export type MachineSyncRequest = Request & { [MACHINE_SYNC_AUTHORIZED]?: true };

@Injectable()
export class MachineSyncGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext) {
    if (this.reflector.get<string>(AUTH_ROUTE_ACCESS, context.getHandler()) !== MACHINE_SYNC_ROUTE) return true;
    const request = context.switchToHttp().getRequest<MachineSyncRequest>();
    const secrets = machineSecrets(process.env);
    const target = process.env.RUNTIME_API_TARGET_ID;
    const candidate = request.get("x-daily-sync-token");
    const currentMatches = secrets ? constantTimeToken(candidate, secrets.current) : false;
    const previousMatches = secrets ? constantTimeToken(candidate, secrets.previous ?? secrets.current) : false;
    const accepted = currentMatches || previousMatches;
    if (!enabledSync() || !accepted ||
        !target || request.get("x-daily-sync-target") !== target ||
        !candidate) {
      throw new ForbiddenException({ code: "MACHINE_SYNC_FORBIDDEN", message: "Machine sync is not authorized." });
    }
    request[MACHINE_SYNC_AUTHORIZED] = true;
    return true;
  }
}

export function machineSecrets(env: NodeJS.ProcessEnv, now = Date.now()) {
  const current = env.DAILY_SYNC_MACHINE_TOKEN;
  if (!strongMachineSecret(current)) return null;
  const otherKeys = [
    "INTERNAL_PROBE_TOKEN", "AUTH_SESSION_HANDLE_SECRET", "AUTH_SESSION_HANDLE_PREVIOUS_SECRET",
    "AUTH_AUTHORIZATION_VERSION_SECRET", "AUTH_CSRF_SECRET", "AUTH_CSRF_PREVIOUS_SECRET",
    "AUTH_LOCAL_SESSION_TOKEN_SECRET", "AUTH_LOCAL_SETUP_TOKEN_SECRET", "AUTH_LOCAL_RATE_LIMIT_SECRET",
    "SUPABASE_SECRET_KEY", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_STORAGE_ACCESS_TOKEN"
  ];
  const otherValues = otherKeys.map((key) => env[key]).filter(Boolean);
  if (otherValues.includes(current)) return null;
  const configuredPrevious = env.DAILY_SYNC_MACHINE_TOKEN_PREVIOUS;
  const expiresAt = Date.parse(env.DAILY_SYNC_MACHINE_PREVIOUS_EXPIRES_AT ?? "");
  const previous = configuredPrevious && configuredPrevious !== current &&
    strongMachineSecret(configuredPrevious) && !otherValues.includes(configuredPrevious) &&
    Number.isFinite(expiresAt) && expiresAt > now && expiresAt <= now + 86_400_000
    ? configuredPrevious : null;
  return { current, previous };
}

function strongMachineSecret(value: string | undefined): value is string {
  if (!value || Buffer.byteLength(value, "utf8") < 32 || value.length > 512) return false;
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  const entropy = [...counts.values()].reduce((sum, count) => {
    const probability = count / value.length;
    return sum - count * Math.log2(probability);
  }, 0);
  return counts.size >= 12 && entropy >= 160;
}

function constantTimeToken(candidate: string | undefined, expected: string) {
  if (!candidate || candidate.length > 512) return false;
  const left = Buffer.from(candidate, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}
