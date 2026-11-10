import "reflect-metadata";
import { HttpException } from "@nestjs/common";
import { AppRole, PrismaClient } from "@prisma/client";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { permissionsForRole } from "../auth/role-permissions";
import { REQUIRED_PERMISSIONS } from "../auth/route-decorators";
import type { PrismaService } from "../common/prisma.service";
import { InfluencerRecordsService } from "./influencer-records.service";
import { InfluencerController } from "./influencer.controller";
import { InfluencerCollaborationInput, UpdateInfluencerNumberingInput } from "./influencer.dto";

const input = {
  nickname: "혜민",
  managerName: "담당자",
  productId: randomUUID(),
  feeKrw: 150_000,
  startDate: "2026-11-01",
  note: null
};

test("staff can maintain collaborations and read-only users can view their saved metrics", () => {
  for (const action of ["list", "creatives", "daily"] as const) {
    assert.deepEqual(Reflect.getMetadata(REQUIRED_PERMISSIONS, InfluencerController.prototype[action]), ["data.read"]);
  }
  for (const action of ["create", "update"] as const) {
    assert.deepEqual(Reflect.getMetadata(REQUIRED_PERMISSIONS, InfluencerController.prototype[action]), ["influencers.manage"]);
  }
  for (const role of [AppRole.USER, AppRole.ADMIN, AppRole.SUPER_ADMIN]) {
    assert.ok(permissionsForRole(role).includes("influencers.manage"));
  }
  assert.deepEqual(Reflect.getMetadata(REQUIRED_PERMISSIONS, InfluencerController.prototype.numbering), ["influencers.numbering"]);
  assert.ok(!permissionsForRole(AppRole.USER).includes("influencers.numbering"));
  assert.ok(permissionsForRole(AppRole.ADMIN).includes("influencers.numbering"));
  assert.ok(permissionsForRole(AppRole.SUPER_ADMIN).includes("influencers.numbering"));
  assert.deepEqual(permissionsForRole(AppRole.GUEST), ["data.read"]);
});

test("transport accepts an open period and validates integer KRW amounts and required fields", async () => {
  const errors = (data: object) => validate(plainToInstance(InfluencerCollaborationInput, data), {
    whitelist: true,
    forbidNonWhitelisted: true
  });
  assert.deepEqual(await errors({ ...input, feeKrw: 0 }), []);
  for (const feeKrw of [-1, 1.5, "150000", 1_000_000_000_000]) {
    assert.ok((await errors({ ...input, feeKrw })).some(error => error.property === "feeKrw"));
  }
  assert.ok((await errors({ ...input, endDate: "2026-11-05" })).some(error => error.property === "endDate"));
  assert.ok((await errors({ ...input, productId: undefined })).some(error => error.property === "productId"));
  assert.ok((await errors({ ...input, note: undefined })).some(error => error.property === "note"));
});

test("numbering accepts digit strings with leading zeros and rejects numeric values", async () => {
  const version = randomUUID();
  assert.deepEqual(await validate(plainToInstance(UpdateInfluencerNumberingInput, { version, numbers: ["0015"] })), []);
  assert.ok((await validate(plainToInstance(UpdateInfluencerNumberingInput, { version, numbers: [15] }))).length);
});

const fixtureUrl = process.env.INFLUENCER_FIXTURE_DATABASE_URL;

test("PostgreSQL keeps same-nickname collaborations separate and preserves saved performance during fee edits", { skip: !fixtureUrl }, async () => {
  const url = new URL(fixtureUrl!);
  assert.equal(url.protocol, "postgresql:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.username, "fixture_owner");
  assert.equal(url.pathname, "/influencer_fixture");
  assert.equal(url.searchParams.get("schema"), "meta_ads");
  url.searchParams.set("connection_limit", "3");
  const owner = new PrismaClient({ datasourceUrl: url.toString() });
  url.username = "meta_ads_prod_runtime";
  const runtime = new PrismaClient({ datasourceUrl: url.toString() });
  const service = new InfluencerRecordsService(runtime as PrismaService);
  const definition = { ...input, nickname: `혜민 ${randomUUID()}`, productId: randomUUID() };
  try {
    await owner.product.create({ data: { id: definition.productId, name: "Fixture", displayName: "Fixture", code: randomUUID() } });
    const first = await service.create(definition);
    const next = await service.create(definition);
    assert.equal(first.netPerformanceKrw, -150_000);
    assert.equal(first.aggregatedAt, null);
    assert.equal(first.managerName, definition.managerName);
    assert.equal(first.productName, "Fixture");
    assert.notEqual(next.id, first.id);

    assert.throws(() => service.create({ ...definition, startDate: "2026-11-31" }), hasStatus(400));
    await assert.rejects(() => service.numbering(first.id, { version: first.version, numbers: ["0015", "15"] }), hasStatus(400));
    const reserved = await service.numbering(first.id, { version: first.version, numbers: ["0015"] });
    assert.deepEqual(reserved.numbers, ["0015"]);
    await assert.rejects(() => service.numbering(next.id, { version: next.version, numbers: ["15"] }), hasStatus(409));
    const version = reserved.version;
    const id = first.id;
    const creativeTotals = [{ creativeName: "두줄보호대_인플(혜민)0015", adSpendKrw: 150_000, adMarginKrw: 130_000, dataThrough: "2026-11-05" }];
    await owner.influencerCollaboration.update({ where: { id }, data: {
      adSpendKrw: 150_000, adMarginKrw: 130_000, netPerformanceKrw: -20_000, creativeCount: 1, creativeTotals,
      aggregatedAt: new Date("2026-11-06T00:00:00Z"), dataThrough: new Date("2026-11-05T00:00:00Z"), needsBackfill: false
    } });
    assert.deepEqual(await service.creatives(id), { items: creativeTotals });
    const saved = await service.update(id, { ...definition, version, feeKrw: 140_000 });
    assert.equal(saved.netPerformanceKrw, -10_000);
    assert.equal(saved.adSpendKrw, 150_000);
    assert.equal(saved.creativeCount, 1);
    assert.equal(saved.dataThrough, "2026-11-05");
    assert.equal((await owner.influencerCollaboration.findUniqueOrThrow({ where: { id } })).needsBackfill, false);
    assert.notEqual(saved.version, version);
    await assert.rejects(() => service.update(id, { ...definition, version }), hasStatus(409));
    const rescheduled = await service.update(id, { ...definition, version: saved.version, startDate: "2026-11-02" });
    assert.equal(rescheduled.netPerformanceKrw, -150_000);
    assert.equal(rescheduled.aggregatedAt, null);
    assert.equal(rescheduled.dataThrough, null);
    assert.deepEqual(await service.creatives(id), { items: [] });
    assert.equal((await owner.influencerCollaboration.findUniqueOrThrow({ where: { id } })).needsBackfill, true);
    assert.ok((await service.list(1)).items.some(row => row.id === id));
  } finally {
    try {
      await owner.influencerCollaboration.deleteMany({ where: { productId: definition.productId } });
      await owner.product.deleteMany({ where: { id: definition.productId } });
    }
    finally { await Promise.all([owner.$disconnect(), runtime.$disconnect()]); }
  }
});

function hasStatus(status: number) {
  return (error: unknown) => error instanceof HttpException && error.getStatus() === status;
}
