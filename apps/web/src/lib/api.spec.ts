import { describe, expect, it } from "vitest";
import { parseApiErrorPayload } from "./api";

describe("API error payload parsing", () => {
  it("prefers a validated domain code from the exception details envelope", () => {
    expect(parseApiErrorPayload(JSON.stringify({
      code: "ConflictException",
      message: "The category changed after it was loaded.",
      details: {
        code: "COUPANG_DAILY_CATEGORY_CHANGED",
        message: "The category changed after it was loaded."
      }
    }))).toEqual({
      code: "COUPANG_DAILY_CATEGORY_CHANGED",
      message: "The category changed after it was loaded."
    });
  });

  it("rejects untrusted codes and control-heavy or oversized messages", () => {
    expect(parseApiErrorPayload(JSON.stringify({
      code: "<script>alert(1)</script>",
      message: "x".repeat(501),
      details: { code: "__proto__.polluted" }
    }))).toEqual({ code: null, message: null });
  });

  it("returns a safe empty result for non-JSON and non-object payloads", () => {
    expect(parseApiErrorPayload("<html>proxy error</html>"))
      .toEqual({ code: null, message: null });
    expect(parseApiErrorPayload(JSON.stringify(["unexpected"])))
      .toEqual({ code: null, message: null });
  });
});
