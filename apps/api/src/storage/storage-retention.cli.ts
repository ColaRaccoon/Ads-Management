import { ConfigService } from "@nestjs/config";
import { PrismaClient } from "@prisma/client";
import { StorageTombstoneService } from "./storage-tombstone.service";

async function main() {
  assertLocalDatabase(process.env.DATABASE_URL);
  const execute = process.argv.includes("--execute");
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

function assertLocalDatabase(value: string | undefined) {
  if (!value) throw new Error("DATABASE_URL is required.");
  const url = new URL(value);
  if (url.hostname !== "127.0.0.1" || url.port !== "55432") {
    throw new Error("Storage retention maintenance is restricted to the loopback development database.");
  }
}

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
