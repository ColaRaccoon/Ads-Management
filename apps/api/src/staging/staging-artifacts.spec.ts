import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.basename(process.cwd()).toLowerCase() === "api"
  ? path.resolve(process.cwd(), "../..")
  : process.cwd();
const file = (relative: string) => readFile(path.join(root, relative), "utf8");

describe("security step 8 staging artifacts", () => {
  it("pins the package toolchain and produces a non-root immutable release boundary", async () => {
    const [dockerfile, dockerignore, packageJson] = await Promise.all([
      file("deploy/Dockerfile"),
      file(".dockerignore"),
      file("package.json")
    ]);
    expect(packageJson).toContain('"packageManager": "npm@10.9.4"');
    expect(dockerfile).toContain("npm install --global npm@10.9.4");
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).toContain("API_PROXY_TARGET=http://127.0.0.1:4200/api");
    expect(await file("apps/api/tsconfig.build.json")).toContain('"src/**/*.cli.ts"');
    expect(await file("apps/api/tsconfig.build.json")).toContain('"sourceMap": false');
    expect(dockerfile).not.toContain("/srv/app/apps/api/prisma ./apps/api/prisma");
    expect(dockerignore).toMatch(/^\.env\.\*$/m);
    expect(dockerignore).toMatch(/^\*\*\/\.env$/m);
    expect(dockerignore).toMatch(/^\*\*\/\.env\.\*$/m);
    expect(dockerignore).toMatch(/^!\*\*\/\.env\.example$/m);
    expect(dockerfile).toContain("RUN node deploy/cloud/assert-build-context-clean.mjs");
    expect(dockerignore).toMatch(/^\.security-dev$/m);
    expect(dockerignore).toMatch(/^apps\/api\/storage\/\*\*$/m);
    expect(dockerignore).not.toMatch(/^(?:storage|\*\*\/storage)$/m);
    expect(dockerignore).not.toMatch(/^apps\/api\/src\/storage(?:\/\*\*)?$/m);
  });

  it("keeps the production API target release-local and outside environment promotion", async () => {
    const nextConfig = await file("apps/web/next.config.mjs");
    expect(nextConfig).toContain('process.env.NODE_ENV === "production"');
    expect(nextConfig).toContain('"http://127.0.0.1:4200/api"');
    expect(nextConfig).not.toContain("process.env.API_INTERNAL_PORT");
    expect(nextConfig).not.toContain("destination: `${process.env.API_PROXY_TARGET");
  });

  it("publishes only the independent edge on 3300 and hardens both services", async () => {
    const [compose, edgeDockerfile] = await Promise.all([
      file("deploy/compose.staging.yaml"),
      file("deploy/edge.Dockerfile")
    ]);
    expect(compose).toContain('"127.0.0.1:3300:8080"');
    expect(compose).not.toMatch(/(?:^|:)3100(?::|$)/m);
    expect(compose).not.toMatch(/(?:^|:)4100(?::|$)/m);
    expect(compose.match(/read_only: true/g)).toHaveLength(2);
    expect(compose.match(/no-new-privileges:true/g)).toHaveLength(2);
    expect(compose).toContain("internal: true");
    expect(compose).toMatch(/release:[\s\S]*networks:\s*\n\s*- private\s*\n\s*- egress/);
    expect(compose).toMatch(/edge:[\s\S]*networks:\s*\n\s*- private/);
    expect(compose).not.toContain("depends_on:");
    expect(compose).toContain("/backend-api/health/ready");
    expect(compose).toContain("process.env.INTERNAL_PROBE_TOKEN");
    expect(compose).toContain("maintenance_state:/run/maintenance");
    expect(compose).toContain("/tmp:size=128m");
    expect(edgeDockerfile).toContain("chown -R node:node /run/maintenance");
  });

  it("ships an independently switchable, cache-disabled maintenance response", async () => {
    const edge = await file("deploy/maintenance-edge.mjs");
    expect(edge).toContain('MAINTENANCE_MODE === "on"');
    expect(edge).toContain("existsSync(maintenanceFile)");
    expect(edge).toContain('"Cache-Control": "no-store"');
    expect(edge).toContain("response.writeHead(503");
    expect(edge).toContain('headers["x-forwarded-for"] = normalizedRemoteAddress');
    expect(edge).toContain("sanitizeHopByHop(upstreamResponse.headers)");
    expect(edge).toContain('responseHeaders["x-robots-tag"] = "noindex, nofollow, noarchive"');
  });

  it("retires the local PostgreSQL rehearsal after the Supabase DB-only decision", async () => {
    const script = await file("deploy/staging-rehearsal.ps1");
    expect(script).toContain('databaseProvider = "supabase_postgresql"');
    expect(script).toContain("localPostgreSqlUsed = $false");
    expect(script).toContain('restoreVerification = "deploy/windows/Restore-Verify.ps1"');
    expect(script).toContain('releaseCompatibility = "deploy/windows/Test-ReleaseCompatibility.ps1"');
    expect(script).toContain("EXPLICIT_APPROVAL_REQUIRED");
    expect(script).toContain("LEGACY_LOCAL_POSTGRES_REHEARSAL_RETIRED");
    expect(script).not.toContain("55432");
  });
});
