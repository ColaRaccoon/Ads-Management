import { validateSync } from "class-validator";
import { describe, expect, it, vi } from "vitest";
import { UpdateCoupangManualPurchaseVendorFeeDto } from "./dto/update-coupang-manual-purchase-vendor-fee.dto";
import { ProductsService } from "./products.service";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const SPOOFED_ACTOR_ID = "22222222-2222-4222-8222-222222222222";

describe("ProductsService setting actor attribution", () => {
  it("attributes dynamic and fixed-key settings to the authenticated actor", async () => {
    const upsert = vi.fn(async (args) => args);
    const tx = {
      appSetting: { findUnique: vi.fn(async () => null), upsert },
      securityAuditEvent: { create: vi.fn(async (args) => args) }
    };
    const service = new ProductsService({
      ...tx,
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx))
    } as never);

    await service.updateSetting(
      "global_setting",
      { valueJson: 1, description: "global", updatedBy: SPOOFED_ACTOR_ID } as never,
      ACTOR_ID
    );
    await service.updateCoupangManualPurchaseVendorFee({ valueJson: 5_000 }, ACTOR_ID);

    expect(upsert.mock.calls[0][0]).toMatchObject({
      where: { key: "global_setting" },
      update: { updatedBy: ACTOR_ID },
      create: { updatedBy: ACTOR_ID }
    });
    expect(upsert.mock.calls[1][0]).toMatchObject({
      where: { key: "coupang_manual_purchase_vendor_fee_per_unit_krw" },
      update: { valueJson: 5_000, updatedBy: ACTOR_ID },
      create: { valueJson: 5_000, updatedBy: ACTOR_ID }
    });
  });

  it("bounds the fixed vendor fee DTO to a positive DECIMAL(14,2) value", () => {
    expect(dtoErrors(0.01)).toHaveLength(0);
    expect(dtoErrors(999_999_999_999.99)).toHaveLength(0);
    expect(dtoErrors(0)).not.toHaveLength(0);
    expect(dtoErrors(1.001)).not.toHaveLength(0);
    expect(dtoErrors(1_000_000_000_000)).not.toHaveLength(0);
    expect(dtoErrors("5000" as never)).not.toHaveLength(0);
  });
});

function dtoErrors(valueJson: number) {
  const dto = new UpdateCoupangManualPurchaseVendorFeeDto();
  dto.valueJson = valueJson;
  return validateSync(dto);
}
