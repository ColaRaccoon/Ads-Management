import qs from "qs";
import { describe, expect, it } from "vitest";

// Synthetic dependency regressions, not evidence of a reachable application route.
describe("query-string dependency security regressions", () => {
  it.each([{ plainObjects: true }, { allowPrototypes: true }])(
    "serializes an untrusted constructor.isBuffer property safely with %j (CVE-2026-82417)",
    (options) => {
      const query = "filter%5Bconstructor%5D%5BisBuffer%5D=value";
      const parsed = qs.parse(query, options);

      expect(qs.stringify(parsed)).toBe(query);
    }
  );

  it.each(["values=1,2,3,4", "values[]=1,2,3,4"])(
    "rejects comma arrays over the configured bound: %s (CVE-2026-82562)",
    (query) => {
      expect(() => qs.parse(query, {
        comma: true,
        arrayLimit: 3,
        throwOnLimitExceeded: true
      })).toThrow(RangeError);
    }
  );

  it("keeps flat and bracket comma arrays at the configured bound", () => {
    const options = { comma: true, arrayLimit: 3, throwOnLimitExceeded: true };

    expect(qs.parse("values=1,2,3", options)).toEqual({ values: ["1", "2", "3"] });
    expect(qs.parse("values[]=1,2,3", options)).toEqual({ values: [["1", "2", "3"]] });
  });

  it("preserves ordinary nested filters and indexed arrays through a round trip", () => {
    const input = { filter: { channel: "Meta Ads" }, page: "2", ids: ["one", "two"] };
    const query = qs.stringify(input);

    expect(query).toBe("filter%5Bchannel%5D=Meta%20Ads&page=2&ids%5B0%5D=one&ids%5B1%5D=two");
    expect(qs.parse(query)).toEqual(input);
  });

  it("continues to serialize real Buffer values as query-string text", () => {
    expect(qs.stringify({ value: Buffer.from("synthetic value") })).toBe("value=synthetic%20value");
  });
});
