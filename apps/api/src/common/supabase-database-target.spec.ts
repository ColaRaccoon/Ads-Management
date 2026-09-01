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
  it("uses system trust without a private CA path in cloud containers",()=>{
    const { SUPABASE_DATABASE_CA_CERT_PATH: _removed, ...cloud } = env;
    const databaseUrl = cloud.DATABASE_URL.replace(/&sslrootcert=[^&]+/, "");
    expect(validateSupabaseDatabaseTarget(cloud, databaseUrl, { tlsTrust: "system" }))
      .toMatchObject({ projectRef: env.SUPABASE_DATABASE_PROJECT_REF, caCertificatePath: null });
    expect(() => validateSupabaseDatabaseTarget(env, databaseUrl, { tlsTrust: "system" }))
      .toThrow("system TLS trust");
  });
  it("accepts numeric characters in a real Supabase project ref",()=>{
    const projectRef = "abc123def456ghi789jk";
    const numeric = {
      ...env,
      SUPABASE_DATABASE_PROJECT_REF: projectRef,
      SUPABASE_DATABASE_HOST: "db.abc123def456ghi789jk.supabase.co",
      SUPABASE_DATABASE_CONNECTION_MODE: "direct",
      SUPABASE_DATABASE_RUNTIME_USER: "meta_runtime",
      DATABASE_URL: `postgresql://meta_runtime:synthetic@db.${projectRef}.supabase.co:5432/postgres?schema=public&sslmode=verify-full&sslrootcert=${encodeURIComponent(ca)}`
    };
    expect(validateSupabaseDatabaseTarget(numeric)).toMatchObject({ projectRef });
  });
});
