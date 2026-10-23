import { PrismaClient } from "@prisma/client";

const raw = process.env.DAILY_SYNC_PHASE06_HARNESS_DATABASE_URL;
let url;
try { url = new URL(raw); } catch { throw new Error("06 harness URL is missing or invalid"); }
if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" ||
    url.port !== "55436" || url.pathname !== "/phase06_synthetic" ||
    url.username !== "phase06_harness" ||
    url.searchParams.get("schema") !== "phase06_harness" ||
    process.env.DAILY_SYNC_PHASE06_HARNESS_ACK !== "EMPTY_FULL_SCHEMA_SYNTHETIC_ONLY")
  throw new Error("06 harness target gate is closed");

const prisma = new PrismaClient({ datasourceUrl: raw });
try {
  const [identity] = await prisma.$queryRaw`
    SELECT current_database() AS db, current_schema() AS schema,
      current_user AS "role", host(inet_server_addr()) AS address,
      inet_server_port() AS port`;
  if (identity?.db !== "phase06_synthetic" ||
      identity.schema !== "phase06_harness" ||
      identity.role !== "phase06_harness" ||
      identity.address !== "127.0.0.1" || identity.port !== 55436)
    throw new Error("06 harness database identity mismatch");
  const tables = await prisma.$queryRaw`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'phase06_harness' AND table_type = 'BASE TABLE'`;
  if (tables.length !== 0)
    throw new Error("06 harness migration target is not an empty schema");
  process.stdout.write("PHASE06_EMPTY_DB_IDENTITY_VERIFIED\n");
} catch {
  process.stderr.write("PHASE06_PRECHECK_FAILED\n");
  process.exitCode = 1;
} finally { await prisma.$disconnect(); }
