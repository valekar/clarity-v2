import assert from "node:assert/strict";
import test from "node:test";
import {
  dashboardSignInUrl,
  isHostedSettingsUrl,
  isTrustedUrl,
  sourceSectionUrl,
  trustedOrigin,
} from "../src/navigation-policy.ts";

test("requires credential-free HTTPS origins for dashboard and Hanko", () => {
  assert.equal(trustedOrigin("https://staff.example.test"), "https://staff.example.test");
  assert.throws(() => trustedOrigin("https://staff.example.test/path"), TypeError);
  assert.throws(() => trustedOrigin("https://user:secret@staff.example.test"), TypeError);
  assert.throws(() => trustedOrigin("http://staff.example.test", true), TypeError);
});

test("allows explicit loopback HTTP only for disposable development", () => {
  assert.equal(trustedOrigin("http://127.0.0.1:3000", true), "http://127.0.0.1:3000");
  assert.throws(() => trustedOrigin("http://127.0.0.1:3000"), TypeError);
  assert.throws(() => trustedOrigin("http://10.0.0.4:3000", true), TypeError);
});

test("blocks untrusted origins, malformed URLs and non-web schemes", () => {
  const origins = new Set(["https://staff.example.test", "https://auth.example.test"]);
  assert.equal(isTrustedUrl("https://auth.example.test/sessions/validate", origins), true);
  assert.equal(isTrustedUrl("https://attacker.example.test/", origins), false);
  assert.equal(isTrustedUrl("javascript:alert(1)", origins), false);
  assert.equal(isTrustedUrl("not a URL", origins), false);
});

test("starts the hosted dashboard at its staff sign-in route", () => {
  assert.equal(
    dashboardSignInUrl("https://staff.example.test"),
    "https://staff.example.test/sign-in",
  );
});

test("only hosted Settings can request the in-window private form", () => {
  const origin = "https://staff.example.test";
  assert.equal(isHostedSettingsUrl(`${origin}/staff/settings`, origin), true);
  assert.equal(isHostedSettingsUrl(`${origin}/staff`, origin), false);
  assert.equal(isHostedSettingsUrl("https://other.example.test/staff/settings", origin), false);
  assert.equal(isHostedSettingsUrl("file:///staff/settings", origin), false);
});

test("local Settings navigation accepts only fixed staff destinations", () => {
  const origin = "https://staff.example.test";
  assert.equal(sourceSectionUrl(origin, "studies"), `${origin}/staff`);
  assert.equal(sourceSectionUrl(origin, "doctors"), `${origin}/staff/doctors`);
  assert.equal(sourceSectionUrl(origin, "settings"), `${origin}/staff/settings`);
  assert.equal(sourceSectionUrl(origin, "https://other.example.test"), null);
  assert.equal(sourceSectionUrl(origin, "../api/device-admin/authorize"), null);
});
