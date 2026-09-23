import assert from "node:assert/strict";
import test from "node:test";
import { boundaryViolations, physicalLineCount } from "./source-policy.ts";

test("physical line count handles empty files and final newlines", () => {
  assert.equal(physicalLineCount(""), 0);
  assert.equal(physicalLineCount("one\ntwo\n"), 2);
  assert.equal(physicalLineCount("one\r\ntwo"), 2);
});

test("workspace policy rejects app-to-app and deep relative imports", () => {
  const violations = boundaryViolations([
    {
      path: "/Users/valekar/Projects/clarity-v2/apps/web/src/page.tsx",
      text: 'import { run } from "@clarity/worker"; import x from "../../../worker/src/main";',
    },
  ]);
  assert.equal(violations.length, 2);
});

test("workspace policy rejects imports from the V1 checkout", () => {
  const violations = boundaryViolations([
    {
      path: "/Users/valekar/Projects/clarity-v2/apps/web/src/page.tsx",
      text: 'import client from "/Users/valekar/Projects/clarity/lib/client";',
    },
  ]);
  assert.equal(violations.length, 1);
  assert.match(violations[0] ?? "", /references V1/);
});

test("domain and contracts reject Node, UI, database, and provider dependencies", () => {
  const violations = boundaryViolations([
    {
      path: "/Users/valekar/Projects/clarity-v2/libs/domain/src/hash.ts",
      text: 'import { createHash } from "node:crypto";',
    },
    {
      path: "/Users/valekar/Projects/clarity-v2/libs/domain/src/page.ts",
      text: 'import Link from "next/link";',
    },
    {
      path: "/Users/valekar/Projects/clarity-v2/libs/contracts/src/native.ts",
      text: 'import { app } from "electron";',
    },
    {
      path: "/Users/valekar/Projects/clarity-v2/libs/contracts/src/query.ts",
      text: 'import Database from "better-sqlite3";',
    },
    {
      path: "/Users/valekar/Projects/clarity-v2/libs/domain/src/storage.ts",
      text: 'import { S3Client } from "@aws-sdk/client-s3";',
    },
    {
      path: "/Users/valekar/Projects/clarity-v2/libs/domain/src/pure.ts",
      text: 'import type { Report } from "@clarity/contracts";',
    },
  ]);
  assert.equal(violations.length, 5);
  assert.ok(violations.every((violation) => violation.includes("privileged dependency")));
});

test("domain and contracts reject bare Node builtins and provider SDK imports", () => {
  const violations = boundaryViolations([
    {
      path: "/Users/valekar/Projects/clarity-v2/libs/domain/src/fs.ts",
      text: 'import fs from "fs";',
    },
    {
      path: "/Users/valekar/Projects/clarity-v2/libs/contracts/src/mail.ts",
      text: 'import { Resend } from "resend";',
    },
  ]);
  assert.equal(violations.length, 2);
});
