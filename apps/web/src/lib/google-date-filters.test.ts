import test from "node:test";
import assert from "node:assert/strict";
import { googleDateFilterError, googleFilterQuery, readGoogleDateFilters } from "./google-date-filters";

test("Google bare URL starts at yesterday across Korea midnight, month and year boundaries", () => {
  for (const [instant, expected] of [
    ["2026-10-25T14:59:59Z", "2026-10-24"],
    ["2026-10-25T15:00:00Z", "2026-10-25"],
    ["2026-10-31T15:00:00Z", "2026-10-31"],
    ["2025-12-31T15:00:00Z", "2025-12-31"],
    ["2024-02-29T15:00:00Z", "2024-02-29"]
  ]) {
    const filters = readGoogleDateFilters("", new Date(instant));
    assert.equal(filters.from, expected);
    assert.equal(filters.to, expected);
    assert.equal(googleDateFilterError(filters), null);
    assert.equal(googleFilterQuery(filters, "api"), `from=${expected}&to=${expected}`);
  }
});

test("Google filter-only URL retains filters and sends yesterday on the first report query", () => {
  const filters = readGoogleDateFilters("productId=p&connectionId=g&cafe24ConnectionId=c", new Date("2026-10-26T04:00:00Z"));
  assert.equal(googleFilterQuery(filters, "api"), "from=2026-10-25&to=2026-10-25&connectionId=g&cafe24ConnectionId=c&productId=p");
});

test("explicit dates survive refresh and Google menu navigation even after midnight", () => {
  const filters = readGoogleDateFilters("from=2026-10-23&to=2026-10-25&productId=p&range=complete");
  assert.equal(filters.range, "");
  assert.equal(filters.from, "2026-10-23");
  assert.equal(filters.to, "2026-10-25");
  assert.deepEqual(readGoogleDateFilters(googleFilterQuery(filters), new Date("2026-11-01T00:00:00Z")), filters);
});

test("common completion period remains an explicit URL choice and is not sent as an API parameter", () => {
  const filters = readGoogleDateFilters("range=complete&productId=p");
  assert.equal(filters.from, "");
  assert.equal(filters.to, "");
  assert.equal(googleDateFilterError(filters), null);
  assert.equal(googleFilterQuery(filters, "api"), "productId=p");
  assert.deepEqual(readGoogleDateFilters(googleFilterQuery(filters)), filters);
});

test("partial, impossible, reversed or manually cleared dates cannot silently select completion mode", () => {
  for (const search of ["from=2026-10-23", "to=2026-10-25&range=complete", "from=2026-02-30&to=2026-03-01", "from=2026-10-25&to=2026-10-23"]) {
    const filters = readGoogleDateFilters(search);
    assert.ok(googleDateFilterError(filters));
    assert.equal(filters.range, "");
  }
  const filters = readGoogleDateFilters("");
  assert.ok(googleDateFilterError({ ...filters, from: "", to: "" }));
});
