import "reflect-metadata";
import { PrismaService } from "../common/prisma.service";
import { loadAuthConfig } from "./auth.config";
import { BootstrapSuperAdminService, describeDatabaseTarget } from "./bootstrap-super-admin";
import { SupabaseAuthAdapter } from "./supabase-auth.adapter";

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const authUserId = requiredArgument(args, "auth-user-id");
  const email = requiredArgument(args, "email");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const target = describeDatabaseTarget(databaseUrl);
  const apply = args.has("apply");

  console.info("Super-admin bootstrap target", {
    databaseHost: target.host,
    databasePort: target.port,
    databaseName: target.database,
    databaseSchema: target.schema,
    authUserId,
    email,
    mode: apply ? "apply" : "dry-run"
  });

  if (apply) {
    requireConfirmation(args, "confirm-db-host", target.host);
    requireConfirmation(args, "confirm-db-name", target.database);
    requireConfirmation(args, "confirm-db-schema", target.schema);
    requireConfirmation(args, "confirm-auth-user-id", authUserId);
    requireConfirmation(args, "confirm-email", email);
  }

  const config = loadAuthConfig();
  const prisma = new PrismaService();
  const provider = new SupabaseAuthAdapter(config);
  await prisma.$connect();
  try {
    const result = await new BootstrapSuperAdminService(prisma, provider).run({
      authUserId,
      email,
      dryRun: !apply
    });
    console.info("Super-admin bootstrap completed", result);
  } finally {
    await prisma.$disconnect();
  }
}

function parseArguments(argv: string[]) {
  const parsed = new Map<string, string>();
  for (const argument of argv) {
    if (!argument.startsWith("--")) throw new Error("Arguments must use --name=value format.");
    const separator = argument.indexOf("=");
    if (separator === -1) parsed.set(argument.slice(2), "true");
    else parsed.set(argument.slice(2, separator), argument.slice(separator + 1));
  }
  return parsed;
}

function requiredArgument(args: Map<string, string>, name: string) {
  const value = args.get(name)?.trim();
  if (!value) throw new Error(`--${name}=... is required.`);
  return value;
}

function requireConfirmation(args: Map<string, string>, name: string, expected: string) {
  if (args.get(name) !== expected) throw new Error(`--${name} does not match the inspected target.`);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown bootstrap error";
    console.error("Super-admin bootstrap failed", { message });
    process.exitCode = 1;
  });
}
