#!/usr/bin/env node

// This runs in a short-lived helper container sharing Hanko's network namespace.
// The Hanko Admin API is loopback-only; public signup stays disabled.

import { stdin, stdout, stderr } from "node:process";

const [username] = process.argv.slice(2);
if (!username || !/^[A-Za-z0-9_]{3,32}$/.test(username)) {
  stderr.write("A 3–32 character username is required.\n");
  process.exit(2);
}

let password = "";
for await (const chunk of stdin) password += chunk;
password = password.replace(/\r?\n$/, "");
if (password.length < 12 || password.length > 256) {
  stderr.write("Password must contain 12–256 characters.\n");
  process.exit(2);
}

const origin = "http://127.0.0.1:8001";
async function api(path, method = "GET", body) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { /* status-only error below */ }
  if (!response.ok) throw new Error(`Hanko Admin API returned HTTP ${response.status}.`);
  return data;
}

try {
  const found = await api(`/users?username=${encodeURIComponent(username)}&per_page=2`);
  if (!Array.isArray(found) || found.length > 1) throw new Error("Hanko username lookup was ambiguous.");
  let user = found[0];
  let created = false;
  if (!user) {
    user = await api("/users", "POST", { username });
    created = true;
  }
  const userId = user?.id;
  if (typeof userId !== "string" || !/^[0-9a-f-]{36}$/i.test(userId)) {
    throw new Error("Hanko did not return a valid user ID.");
  }
  let passwordSet = false;
  try {
    await api(`/users/${encodeURIComponent(userId)}/password`);
  } catch (error) {
    if (!String(error.message).includes("HTTP 404")) throw error;
    await api(`/users/${encodeURIComponent(userId)}/password`, "POST", {
      user_id: userId,
      password,
    });
    passwordSet = true;
  }
  stdout.write(`${JSON.stringify({ id: userId, username, created, passwordSet })}\n`);
} catch (error) {
  stderr.write(`${error instanceof Error ? error.message : "Hanko provisioning failed."}\n`);
  process.exitCode = 1;
} finally {
  password = "";
}
