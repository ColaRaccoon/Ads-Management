import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateSupabaseDatabaseTarget } from "./supabase-database-target";

const ca=path.resolve("db-ca.crt");
const env={
  SUPABASE_DATABASE_PROJECT_REF:"abcdefghijklmnopqrst",
  SUPABASE_DATABASE_CONNECTION_MODE:"session_pooler",
  SUPABASE_DATABASE_HOST:"aws-0-ap-northeast-2.pooler.supabase.com",
  SUPABASE_DATABASE_RUNTIME_USER:"meta_runtime",
  SUPABASE_DATABASE_CA_CERT_PATH:ca,
  DATABASE_URL:`postgresql://meta_runtime.abcdefghijklmnopqrst:synthetic@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres?schema=public&sslmode=verify-full&sslrootcert=${encodeURIComponent(ca)}`
};

describe("Supabase database target boundary",()=>{
  it("accepts an exact persistent session-pooler target without returning credentials",()=>{
    const result=validateSupabaseDatabaseTarget(env);
    expect(result).toMatchObject({projectRef:"abcdefghijklmnopqrst",host:env.SUPABASE_DATABASE_HOST,port:"5432",runtimeUser:"meta_runtime"});
    expect(JSON.stringify(result)).not.toContain("synthetic@");
  });
  it("rejects host drift, transaction pooling, and weaker TLS",()=>{
    expect(()=>validateSupabaseDatabaseTarget({...env,SUPABASE_DATABASE_HOST:"evil.invalid"})).toThrow("exact Supabase database host");
    expect(()=>validateSupabaseDatabaseTarget({...env,DATABASE_URL:env.DATABASE_URL.replace(":5432/",":6543/")})).toThrow("host and port");
    expect(()=>validateSupabaseDatabaseTarget({...env,DATABASE_URL:env.DATABASE_URL.replace("verify-full","require")})).toThrow("verify-full");
  });
});
