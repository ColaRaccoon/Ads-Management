import "reflect-metadata";
import { readFileSync,writeFileSync,unlinkSync } from "node:fs";
import {createHash} from "node:crypto";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {PrismaService} from "../apps/api/src/common/prisma.service";

/** Same approved target and CA as the operating service; no credential output. */
export function productionCafe24Db() {
  if(process.env.SUPABASE_DATABASE_PROJECT_REF!=="iygjmosbelbosfxidqxv" || process.env.SUPABASE_DATABASE_SCHEMA!=="meta_ads")
    throw Error("PRODUCTION_TARGET_MISMATCH");
  let caPath:string|undefined;
  if(process.platform==="win32" && process.env.DATABASE_URL) {
    const ca=Buffer.from(readFileSync(new URL("../deploy/cloud/certs/supabase-prod-ca-2021.crt",import.meta.url),"utf8").replace(/\r\n/g,"\n"));
    if(createHash("sha256").update(ca).digest("hex")!=="700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7")throw Error("CA_FINGERPRINT_MISMATCH");
    caPath=join(tmpdir(),`cafe24-option-public-ca-${process.pid}.pem`);writeFileSync(caPath,ca);
    const url=new URL(process.env.DATABASE_URL);
    if(url.searchParams.get("schema")!=="meta_ads" || !url.hostname.endsWith("supabase.com"))throw Error("DATABASE_TARGET_MISMATCH");
    url.searchParams.set("sslrootcert",caPath);url.searchParams.set("sslcert",caPath);
    url.searchParams.set("sslmode","verify-full");url.searchParams.set("sslaccept","strict");
    process.env.DATABASE_URL=url.toString();
  }
  const db=new PrismaService();
  return {db,close:async()=>{await db.$disconnect();if(caPath)unlinkSync(caPath);}};
}
