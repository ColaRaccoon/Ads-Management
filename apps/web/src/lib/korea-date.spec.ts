import { describe, expect, it } from "vitest";
import { koreaTodayDateInput, koreaYesterdayDateInput } from "./korea-date";

describe("Korea date inputs", () => {
  it("uses the Asia/Seoul calendar date", () => {
    expect(koreaTodayDateInput(new Date("2026-07-27T14:59:59.000Z"))).toBe("2026-07-27");
    expect(koreaTodayDateInput(new Date("2026-07-27T15:00:00.000Z"))).toBe("2026-07-28");
  });

  it("selects exactly 24 hours before now as yesterday in Korea", () => {
    expect(koreaYesterdayDateInput(new Date("2026-07-27T14:59:59.000Z"))).toBe("2026-07-26");
    expect(koreaYesterdayDateInput(new Date("2026-07-27T15:00:00.000Z"))).toBe("2026-07-27");
    expect(koreaYesterdayDateInput(new Date("2026-01-01T00:00:00.000Z"))).toBe("2025-12-31");
  });
});
