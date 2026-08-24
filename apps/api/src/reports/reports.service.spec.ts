import { describe, expect, it, vi } from "vitest";
import { ReportsService } from "./reports.service";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const SPOOFED_ACTOR_ID = "22222222-2222-4222-8222-222222222222";

describe("ReportsService actor attribution", () => {
  it("uses the authenticated actor when creating an export record", async () => {
    const create = vi.fn(async (_args: { data: Record<string, unknown> }) => {
      throw new Error("stop after attribution write");
    });
    const service = new ReportsService(
      { reportExport: { create } } as never,
      {} as never,
      {} as never
    );

    await expect(
      service.export(
        {
          reportType: "DAILY_HTML",
          from: "2026-08-24",
          to: "2026-08-24",
          parameters: { createdBy: SPOOFED_ACTOR_ID }
        },
        ACTOR_ID
      )
    ).rejects.toThrow("stop after attribution write");

    expect(create.mock.calls[0][0].data.createdBy).toBe(ACTOR_ID);
  });
});
