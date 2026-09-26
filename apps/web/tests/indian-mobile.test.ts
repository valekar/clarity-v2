import assert from "node:assert/strict";
import test from "node:test";
import { formatIndianMobile, normalizeIndianMobile } from "../src/lib/indian-mobile.ts";

test("Indian mobile input normalizes local and country-code forms", () => {
  for (const value of ["90000 00001", "9000000001", "+91 90000 00001", "919000000001"]) {
    assert.equal(normalizeIndianMobile(value), "+919000000001");
  }
  assert.equal(formatIndianMobile("+919000000001"), "+91 90000 00001");
});

test("Indian mobile input rejects US, short and landline numbers", () => {
  for (const value of [
    "+14155550123",
    "1234567890",
    "900000001",
    "01123456789",
    "+91 50000 00001",
  ]) {
    assert.equal(normalizeIndianMobile(value), null);
  }
});
