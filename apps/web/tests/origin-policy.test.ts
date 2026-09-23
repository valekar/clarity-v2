import assert from "node:assert/strict";
import test from "node:test";
import { mutationRequestAllowed } from "../src/server/origin-policy.ts";
import { pendingRoleFor, setPendingRole } from "../src/app/staff/settings/pending-role.ts";

const origin = "https://staff.clarity.example";

test("accepts only same-origin JSON mutations", () => {
  assert.equal(mutationRequestAllowed(origin, "application/json", origin), true);
  assert.equal(mutationRequestAllowed(origin, "application/json; charset=utf-8", origin), true);
  for (const requestOrigin of [
    null,
    "https://attacker.example",
    "https://staff.clarity.example.evil.invalid",
    "http://staff.clarity.example",
    "https://staff.clarity.example:444",
  ]) {
    assert.equal(mutationRequestAllowed(requestOrigin, "application/json", origin), false);
  }
  assert.equal(mutationRequestAllowed(origin, "text/plain", origin), false);
  assert.equal(mutationRequestAllowed(origin, null, origin), false);
});

test("staff role selection is isolated per pending identity", () => {
  const selections = setPendingRole({}, "pending-one", "admin");
  assert.equal(pendingRoleFor(selections, "pending-one"), "admin");
  assert.equal(pendingRoleFor(selections, "pending-two"), "staff");
});
