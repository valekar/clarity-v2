import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseServerConfig, readServerConfig, saveServerConfig } from "../src/server-config.ts";

test("server setup accepts only credential-free trusted origins", () => {
  assert.deepEqual(
    parseServerConfig({
      dashboardOrigin: "https://staff.example.test/",
      hankoOrigin: "https://auth.example.test/",
    }),
    { dashboardOrigin: "https://staff.example.test", hankoOrigin: "https://auth.example.test" },
  );
  assert.throws(
    () =>
      parseServerConfig({
        dashboardOrigin: "http://staff.example.test",
        hankoOrigin: "https://auth.example.test",
      }),
    TypeError,
  );
  assert.throws(
    () =>
      parseServerConfig({
        dashboardOrigin: "https://user:secret@staff.example.test",
        hankoOrigin: "https://auth.example.test",
      }),
    TypeError,
  );
});

test("loopback setup persists privately and can be read on the next launch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clarity-desktop-config-"));
  try {
    const input = {
      dashboardOrigin: "http://127.0.0.1:3111/",
      hankoOrigin: "http://127.0.0.1:8000/",
    };
    await saveServerConfig(directory, input, true);
    assert.deepEqual(await readServerConfig(directory, true), {
      dashboardOrigin: "http://127.0.0.1:3111",
      hankoOrigin: "http://127.0.0.1:8000",
    });
    const info = await stat(join(directory, "server.json"));
    assert.equal(info.mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(join(directory, "server.json"), "utf8")), {
      dashboardOrigin: "http://127.0.0.1:3111",
      hankoOrigin: "http://127.0.0.1:8000",
    });
    await assert.rejects(readServerConfig(directory), /invalid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
