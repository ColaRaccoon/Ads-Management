import { spawnSync } from "node:child_process";

process.env.DATABASE_URL ??= "postgresql://meta_ads_app:example@localhost:5432/meta_ads_performance?schema=public";
process.env.SHADOW_DATABASE_URL ??=
  "postgresql://meta_ads_shadow:example@localhost:5432/meta_ads_performance_shadow?schema=public";

const command = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(command, ["prisma", "validate", "--schema", "apps/api/prisma/schema.prisma"], {
  stdio: "inherit",
  env: process.env,
  shell: process.platform === "win32"
});

process.exit(result.status ?? 1);
