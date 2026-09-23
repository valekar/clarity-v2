import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packages = ["apps/sync-service", "apps/worker"];
const scratch = mkdtempSync(join(tmpdir(), "clarity-v2-node-import-"));
const failures: string[] = [];

try {
  for (const packagePath of packages) {
    const entry = resolve(projectRoot, packagePath, "dist/main.js");
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(entry).href)});`],
      {
        cwd: scratch,
        encoding: "utf8",
        env:
          packagePath === "apps/sync-service" ? withoutSyncCredentials(process.env) : process.env,
      },
    );
    const expectedFailure =
      packagePath === "apps/worker"
        ? result.status === 78 && result.stderr.includes("could not start")
        : result.status === 78 && result.stderr.includes("configuration is missing or invalid");
    if (!expectedFailure) {
      failures.push(
        `${packagePath}: expected compiled module to load from ${scratch} and exit 78; ` +
          `got status ${String(result.status)} (${result.stderr.trim()})`,
      );
    }
  }

  const storageRoot = resolve(projectRoot, "libs/storage");
  const storageInstall = join(scratch, "node_modules", "@clarity", "storage");
  if (!existsSync(join(storageRoot, "dist", "intake-objects.js"))) {
    failures.push(
      "@clarity/storage: compiled intake-objects.js is missing; run pnpm run build first",
    );
  } else {
    mkdirSync(storageInstall, { recursive: true });
    copyFileSync(join(storageRoot, "package.json"), join(storageInstall, "package.json"));
    cpSync(join(storageRoot, "dist"), join(storageInstall, "dist"), { recursive: true });
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import { S3IntakeObjects } from "@clarity/storage/intake-objects"; let failed = false; try { new S3IntakeObjects({ endpoint: new URL("not-a-url"), bucket: "", region: "", accessKey: "", secretKey: "" }); } catch { failed = true; } if (!failed) process.exit(1); process.stdout.write("storage package export passed\\n");',
      ],
      { cwd: scratch, encoding: "utf8" },
    );
    if (result.status !== 0 || !result.stdout.includes("storage package export passed")) {
      failures.push(
        `@clarity/storage: package export failed from ${scratch}: ${result.stderr.trim()}`,
      );
    }
  }

  const imagingRoot = resolve(projectRoot, "libs/imaging");
  const imagingInstall = join(scratch, "node_modules", "@clarity", "imaging");
  if (!existsSync(join(imagingRoot, "dist", "index.js"))) {
    failures.push("@clarity/imaging: compiled dist/index.js is missing; run pnpm run build first");
  } else {
    mkdirSync(imagingInstall, { recursive: true });
    copyFileSync(join(imagingRoot, "package.json"), join(imagingInstall, "package.json"));
    cpSync(join(imagingRoot, "dist"), join(imagingInstall, "dist"), { recursive: true });
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import { readDicomIdentity } from "@clarity/imaging"; if (typeof readDicomIdentity !== "function") process.exit(1); process.stdout.write("imaging package export passed\\n");',
      ],
      { cwd: scratch, encoding: "utf8" },
    );
    if (result.status !== 0 || !result.stdout.includes("imaging package export passed")) {
      failures.push(
        `@clarity/imaging: package export failed from ${scratch}: ${result.stderr.trim()}`,
      );
    }
  }

  const domainRoot = resolve(projectRoot, "libs/domain");
  const domainInstall = join(scratch, "node_modules", "@clarity", "domain");
  if (!existsSync(join(domainRoot, "dist", "index.js"))) {
    failures.push("@clarity/domain: compiled dist/index.js is missing; run pnpm run build first");
  } else {
    mkdirSync(domainInstall, { recursive: true });
    copyFileSync(join(domainRoot, "package.json"), join(domainInstall, "package.json"));
    cpSync(join(domainRoot, "dist"), join(domainInstall, "dist"), { recursive: true });
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import { createDraftManifest } from "@clarity/domain"; const value = createDraftManifest(null); if (value.state !== "draft" || value.revision !== 1) process.exit(1); process.stdout.write("domain package export passed\\n");',
      ],
      { cwd: scratch, encoding: "utf8" },
    );
    if (result.status !== 0 || !result.stdout.includes("domain package export passed")) {
      failures.push(
        `@clarity/domain: package export failed from ${scratch}: ${result.stderr.trim()}`,
      );
    }
  }

  const serverRoot = resolve(projectRoot, "libs/server");
  const serverInstall = join(scratch, "node_modules", "@clarity", "server");
  if (!existsSync(join(serverRoot, "dist", "index.js"))) {
    failures.push("@clarity/server: compiled dist/index.js is missing; run pnpm run build first");
  } else {
    mkdirSync(serverInstall, { recursive: true });
    copyFileSync(join(serverRoot, "package.json"), join(serverInstall, "package.json"));
    cpSync(join(serverRoot, "dist"), join(serverInstall, "dist"), { recursive: true });
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import { createHankoSessionAdapter } from "@clarity/server"; const adapter = createHankoSessionAdapter({ apiOrigin: "https://auth.synthetic.invalid", issuer: "https://auth.synthetic.invalid", audience: "clarity-web" }); if (typeof adapter.validateCookie !== "function") process.exit(1); process.stdout.write("server package export passed\\n");',
      ],
      { cwd: scratch, encoding: "utf8" },
    );
    if (result.status !== 0 || !result.stdout.includes("server package export passed")) {
      failures.push(
        `@clarity/server: package export failed from ${scratch}: ${result.stderr.trim()}`,
      );
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

function withoutSyncCredentials(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const safe = { ...environment };
  for (const key of [
    "CLARITY_SYNC_SOURCE_KEY",
    "CLARITY_SYNC_STATE_DB",
    "CLARITY_SYNC_SPOOL_DIR",
    "CLARITY_ORTHANC_URL",
    "CLARITY_ORTHANC_AUTHORIZATION",
    "CLARITY_INGESTION_API_URL",
    "CLARITY_DEVICE_AUTHORIZATION",
  ]) {
    delete safe[key];
  }
  return safe;
}

if (failures.length > 0) {
  failures.forEach((failure) => process.stderr.write(`${failure}\n`));
  process.exitCode = 1;
} else {
  process.stdout.write(
    "Compiled service entries and @clarity/domain/@clarity/server/@clarity/storage/@clarity/imaging exports pass from a temporary external directory.\n",
  );
}
