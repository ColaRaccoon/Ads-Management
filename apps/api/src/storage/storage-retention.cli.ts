import { ConfigService } from "@nestjs/config";
import { PrismaClient } from "@prisma/client";
import { validateSupabaseDatabaseTarget } from "../common/supabase-database-target";
import { StorageTombstoneService } from "./storage-tombstone.service";

async function main() {
  const target=validateSupabaseDatabaseTarget(process.env);
  const execute = process.argv.includes("--execute");
  if(execute){requireArgument("approved","true");requireArgument("maintenance-confirmed","true");requireArgument("confirm-project-ref",target.projectRef);requireArgument("confirm-db-host",target.host);requireArgument("confirm-db-name",target.database);requireArgument("confirm-db-schema",target.schema);}
  const limit = parseLimit(process.argv.find((value) => value.startsWith("--limit=")));
  const prisma = new PrismaClient();
  try {
    const service = new StorageTombstoneService(
      prisma as never,
      new ConfigService(process.env)
    );
    const result = await service.purgeExpired({ execute, limit });
    process.stdout.write(`${JSON.stringify({ result: "PASS", ...result })}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

function requireArgument(name:string,expected:string){const prefix=`--${name}=`;const value=process.argv.find((item)=>item.startsWith(prefix))?.slice(prefix.length);if(value!==expected)throw new Error(`--${name} confirmation is required.`);}

function parseLimit(value: string | undefined) {
  if (!value) return 100;
  const normalized = value.slice("--limit=".length);
  if (!/^\d+$/.test(normalized)) throw new Error("--limit must be an integer.");
  const limit = Number(normalized);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("--limit must be between 1 and 500.");
  }
  return limit;
}

main().catch(() => {
  process.stderr.write("Storage retention maintenance failed with a protected error.\n");
  process.exitCode = 1;
});
