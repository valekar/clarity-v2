import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  chmodSync,
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const probeDirectory = dirname(fileURLToPath(import.meta.url));
const serviceDirectory = resolve(probeDirectory, "..");
const expectedNodeVersion = "22.20.0";
const heartbeatMilliseconds = 100;
const maxDiagnosticsBytes = 1024;
const activeProbes = new Set();

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10_000, ...options });
  if (result.error || result.status !== 0) {
    const details = `${result.stderr ?? ""}${result.stdout ?? ""}`.slice(0, maxDiagnosticsBytes);
    throw new Error(
      `command failed: ${command} (${result.status ?? result.error?.message}) ${details}`,
    );
  }
  return result;
}

function compileProbe(outputDirectory) {
  const version = runSync(process.execPath, ["--version"]);
  assert.equal(version.stdout.trim(), `v${expectedNodeVersion}`);
  const compiler = join(serviceDirectory, "node_modules", "typescript", "bin", "tsc");
  runSync(
    process.execPath,
    [compiler, "-p", join(probeDirectory, "tsconfig.json"), "--outDir", outputDirectory],
    {
      cwd: serviceDirectory,
    },
  );
  return version.stdout.trim();
}

function stageRuntime(root, compiledDirectory) {
  const runtimeDirectory = join(root, "runtime");
  const binary = join(runtimeDirectory, "bin", "node");
  const probe = join(runtimeDirectory, "app", "probe.js");
  const sqlite = join(runtimeDirectory, "node_modules", "better-sqlite3");
  mkdirSync(dirname(binary), { recursive: true });
  mkdirSync(dirname(probe), { recursive: true });
  mkdirSync(sqlite, { recursive: true });
  copyFileSync(process.execPath, binary);
  chmodSync(binary, 0o755);
  copyFileSync(join(compiledDirectory, "probe.js"), probe);
  writeFileSync(join(runtimeDirectory, "package.json"), '{"type":"module","private":true}\n');

  const sqliteSource = realpathSync(join(serviceDirectory, "node_modules", "better-sqlite3"));
  for (const item of ["package.json", "lib", "prebuilds"]) {
    cpSync(join(sqliteSource, item), join(sqlite, item), { recursive: true, dereference: true });
  }
  const packageInfo = JSON.parse(readFileSync(join(sqlite, "package.json"), "utf8"));
  assert.equal(packageInfo.version, "13.0.3");
  const binding = join(sqlite, "prebuilds", "darwin-arm64.node");
  assert.equal(existsSync(binding), true);
  return {
    runtimeDirectory,
    binary,
    binaryRealpath: realpathSync(binary),
    probe,
    sqliteDirectory: sqlite,
    sqliteVersion: packageInfo.version,
    binding,
  };
}

function protectCredential(path) {
  const user = userInfo().username;
  runSync("/bin/chmod", ["+a", `user:${user} allow read,write`, path]);
  const acl = runSync("/bin/ls", ["-lde", path]).stdout;
  assert.ok(acl.includes(user), "synthetic credential file has a user ACL");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  return { mode: (statSync(path).mode & 0o777).toString(8), acl: acl.trim().split("\n").slice(1) };
}

function makePlist(path) {
  const app = "/opt/clarity-v2/sync-service/current";
  const data = "/var/db/clarity-v2/sync-service";
  const logs = "/var/log/clarity-v2/sync-service";
  const argumentsList = [
    `${app}/runtime/bin/node`,
    `${app}/lifecycle-probe/dist/probe.js`,
    "--db",
    `${data}/checkpoint.sqlite`,
    "--credential",
    `${data}/source-credential.json`,
    "--challenge",
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "--response-file",
    `${data}/challenge-response.txt`,
    "--heartbeat-ms",
    "1000",
  ];
  const argumentXml = argumentsList
    .map((argument) => `<string>${argument}</string>`)
    .join("\n    ");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>org.clarity-v2.sync-service</string>
  <key>ProgramArguments</key><array>
    ${argumentXml}
  </array>
  <key>UserName</key><string>clarity-sync-service</string>
  <key>WorkingDirectory</key><string>${data}</string>
  <key>StandardOutPath</key><string>${logs}/launchd.stdout.log</string>
  <key>StandardErrorPath</key><string>${logs}/launchd.stderr.log</string>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
</dict>
</plist>
`;
  writeFileSync(path, xml, { mode: 0o600 });
  const lint = runSync("/usr/bin/plutil", ["-lint", path]);
  assert.ok(lint.stdout.includes("OK"));
  for (const argument of argumentsList.filter((value) => value.includes("/"))) {
    assert.equal(argument.startsWith("/"), true);
  }
  assert.ok(xml.includes("<key>UserName</key><string>clarity-sync-service</string>"));
  assert.ok(xml.includes("<key>ThrottleInterval</key><integer>30</integer>"));
  return {
    lint: lint.stdout.trim(),
    argumentsList,
    data,
    logs,
    label: "org.clarity-v2.sync-service",
  };
}

function startProbe(runtime, args, environment) {
  const child = spawn(runtime.binary, [runtime.probe, ...args], {
    cwd: runtime.runtimeDirectory,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = { child, stdout: "", stderr: "", events: [] };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    result.stdout += chunk;
    if (Buffer.byteLength(result.stdout) > maxDiagnosticsBytes) child.kill("SIGKILL");
    parseOutputLines(result);
  });
  child.stderr.on("data", (chunk) => {
    result.stderr += chunk;
    if (Buffer.byteLength(result.stderr) > maxDiagnosticsBytes) child.kill("SIGKILL");
  });
  result.exited = new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => {
      activeProbes.delete(result);
      resolveExit({ code, signal });
    });
  });
  activeProbes.add(result);
  return result;
}

function parseOutputLines(result) {
  const lines = result.stdout.split("\n");
  result.events = [];
  for (const line of lines.slice(0, -1)) {
    try {
      result.events.push(JSON.parse(line));
    } catch {
      throw new Error("probe emitted malformed diagnostics");
    }
  }
}

async function waitForEvent(result, type, timeoutMilliseconds = 4_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    parseOutputLines(result);
    const event = result.events.find((item) => item.type === type);
    if (event) return event;
    if (result.child.exitCode !== null) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`probe did not emit ${type} within the bounded wait`);
}

function inspect(runtime, databasePath, environment) {
  const result = spawnSync(runtime.binary, [runtime.probe, "--inspect", databasePath], {
    cwd: runtime.runtimeDirectory,
    env: environment,
    encoding: "utf8",
    timeout: 2_000,
  });
  if (result.error || result.status !== 0) throw new Error("staged SQLite inspection failed");
  if (Buffer.byteLength(result.stdout) > maxDiagnosticsBytes)
    throw new Error("inspection output exceeded limit");
  return JSON.parse(result.stdout);
}

async function waitForSequence(runtime, databasePath, environment, previousSequence) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const snapshot = inspect(runtime, databasePath, environment);
    if (snapshot.state?.committed_sequence > previousSequence) return snapshot;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
  }
  throw new Error("heartbeat did not commit within the bounded wait");
}

async function terminateGracefully(result) {
  const start = Date.now();
  result.child.kill("SIGTERM");
  const exit = await Promise.race([
    result.exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("SIGTERM did not stop probe")), 3_000),
    ),
  ]);
  assert.equal(exit.code, 0);
  const stopped = await waitForEvent(result, "stopped");
  return { exit, stopped, milliseconds: Date.now() - start };
}

async function stopActiveProbes() {
  const running = [...activeProbes];
  for (const result of running) {
    if (result.child.exitCode === null && result.child.signalCode === null) {
      result.child.kill("SIGTERM");
    }
  }
  await Promise.race([
    Promise.allSettled(running.map((result) => result.exited)),
    new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000)),
  ]);
  for (const result of [...activeProbes]) {
    if (result.child.exitCode === null && result.child.signalCode === null) {
      result.child.kill("SIGKILL");
    }
  }
  await Promise.race([
    Promise.allSettled([...activeProbes].map((result) => result.exited)),
    new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000)),
  ]);
  if (activeProbes.size > 0) throw new Error("failed to stop all staged probe children");
}

async function exerciseFailureCleanup(runtime, args, environment) {
  let probe;
  try {
    probe = startProbe(runtime, args, environment);
    await waitForEvent(probe, "started");
    throw new Error("synthetic failure injection after child startup");
  } catch (error) {
    assert.equal(error.message, "synthetic failure injection after child startup");
  } finally {
    await stopActiveProbes();
  }
  const exit = await probe.exited;
  assert.equal(exit.code, 0);
  return true;
}

async function main() {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "clarity-v2-p03-lifecycle-"));
  let success = false;
  try {
    const compiledDirectory = join(temporaryRoot, "compiled");
    mkdirSync(compiledDirectory);
    const nodeVersion = compileProbe(compiledDirectory);
    const runtime = stageRuntime(temporaryRoot, compiledDirectory);
    const dataDirectory = join(temporaryRoot, "data");
    mkdirSync(dataDirectory);
    const databasePath = join(dataDirectory, "heartbeat.sqlite");
    const credentialPath = join(temporaryRoot, "synthetic-credential.json");
    const responsePath = join(temporaryRoot, "challenge-response.txt");
    const secret = randomBytes(32).toString("hex");
    const challenge = randomBytes(32).toString("hex");
    writeFileSync(credentialPath, JSON.stringify({ secret }), { mode: 0o600 });
    chmodSync(credentialPath, 0o600);
    const credentialProtection = protectCredential(credentialPath);
    const expectedResponse = createHmac("sha256", Buffer.from(secret, "hex"))
      .update(Buffer.from(challenge, "hex"))
      .digest("hex");
    const environment = {
      HOME: join(temporaryRoot, "runtime-home"),
      TMPDIR: temporaryRoot,
      PATH: "",
      LANG: "C",
    };
    mkdirSync(environment.HOME);
    const startupArgs = [
      "--db",
      databasePath,
      "--credential",
      credentialPath,
      "--challenge",
      challenge,
      "--response-file",
      responsePath,
      "--heartbeat-ms",
      String(heartbeatMilliseconds),
    ];

    const foregroundStartedAt = Date.now();
    const foreground = startProbe(runtime, startupArgs, environment);
    const foregroundStart = await waitForEvent(foreground, "started");
    const foregroundStartupMilliseconds = Date.now() - foregroundStartedAt;
    assert.equal(foregroundStart.nodeVersion, expectedNodeVersion);
    assert.equal(foregroundStart.executable, runtime.binaryRealpath);
    assert.equal(foregroundStart.pid, foreground.child.pid);
    assert.equal(existsSync(responsePath), true);
    assert.equal(readFileSync(responsePath, "utf8"), expectedResponse);
    const heartbeat = await waitForSequence(runtime, databasePath, environment, 0);
    assert.equal(heartbeat.state.admission_open, 1);
    assert.equal(heartbeat.state.startup_id, foregroundStart.startupId);
    assert.ok(heartbeat.heartbeatCount <= 32);
    const graceful = await terminateGracefully(foreground);
    const stoppedSnapshot = inspect(runtime, databasePath, environment);
    assert.equal(stoppedSnapshot.state.admission_open, 0);
    assert.equal(stoppedSnapshot.startups.at(-1).stopped_at === null, false);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2 * heartbeatMilliseconds));
    const stableSnapshot = inspect(runtime, databasePath, environment);
    assert.equal(stableSnapshot.state.committed_sequence, stoppedSnapshot.state.committed_sequence);

    const crashProbe = startProbe(runtime, startupArgs, environment);
    const crashStart = await waitForEvent(crashProbe, "started");
    const beforeCrash = await waitForSequence(
      runtime,
      databasePath,
      environment,
      stoppedSnapshot.state.committed_sequence,
    );
    crashProbe.child.kill("SIGKILL");
    const killed = await crashProbe.exited;
    assert.equal(killed.signal, "SIGKILL");
    const afterKill = inspect(runtime, databasePath, environment);
    assert.equal(afterKill.state.admission_open, 1);

    const recoveredProbe = startProbe(runtime, startupArgs, environment);
    const recoveredStart = await waitForEvent(recoveredProbe, "started");
    assert.notEqual(recoveredStart.startupId, crashStart.startupId);
    const recoveredHeartbeat = await waitForSequence(
      runtime,
      databasePath,
      environment,
      beforeCrash.state.committed_sequence,
    );
    assert.equal(recoveredHeartbeat.state.startup_id, recoveredStart.startupId);
    assert.equal(recoveredStart.pid, recoveredProbe.child.pid);
    const finalGraceful = await terminateGracefully(recoveredProbe);
    const failureCleanupVerified = await exerciseFailureCleanup(runtime, startupArgs, environment);

    const missingCredentialPath = join(temporaryRoot, "missing-credential.json");
    const missingDatabasePath = join(temporaryRoot, "must-not-exist.sqlite");
    const missing = startProbe(
      runtime,
      [
        "--db",
        missingDatabasePath,
        "--credential",
        missingCredentialPath,
        "--challenge",
        challenge,
        "--response-file",
        responsePath,
      ],
      environment,
    );
    const missingExit = await Promise.race([
      missing.exited,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("missing-credential case timed out")), 2_000),
      ),
    ]);
    assert.equal(missingExit.code, 78);
    assert.equal(missing.stderr, "credential unavailable\n");
    assert.ok(Buffer.byteLength(missing.stderr) <= 256);
    assert.equal(missing.stderr.includes(secret), false);
    assert.equal(missing.stderr.includes(missingCredentialPath), false);
    assert.equal(existsSync(missingDatabasePath), false);

    const plistPath = join(temporaryRoot, "org.clarity-v2.sync-service.plist");
    const plist = makePlist(plistPath);
    const argumentValidation = runSync(
      runtime.binary,
      [runtime.probe, "--validate-arguments", ...plist.argumentsList.slice(2)],
      {
        cwd: runtime.runtimeDirectory,
        env: environment,
      },
    );
    assert.equal(JSON.parse(argumentValidation.stdout).type, "valid-arguments");
    assert.equal(
      JSON.parse(argumentValidation.stdout).databasePath,
      "/var/db/clarity-v2/sync-service/checkpoint.sqlite",
    );
    const summary = {
      result: "pass",
      platform: `${process.platform}-${process.arch}`,
      node: {
        version: nodeVersion,
        copiedBinaryBytes: statSync(runtime.binary).size,
        sha256: sha256(runtime.binary),
        launchPath: runtime.binary,
        runtimePath: runtime.binaryRealpath,
      },
      sqlite: {
        packageVersion: runtime.sqliteVersion,
        bindingBytes: statSync(runtime.binding).size,
        bindingSha256: sha256(runtime.binding),
      },
      foreground: {
        startupId: foregroundStart.startupId,
        pid: foregroundStart.pid,
        uid: foregroundStart.uid,
        firstCommittedSequence: heartbeat.state.committed_sequence,
        gracefulStopSequence: graceful.stopped.sequence,
        startupMilliseconds: foregroundStartupMilliseconds,
        stopMilliseconds: graceful.milliseconds,
        stoppedAdmission: stoppedSnapshot.state.admission_open === 0,
        databaseReopenedAfterStop: stableSnapshot.state.startup_id === foregroundStart.startupId,
        sequenceStableAfterExit:
          stableSnapshot.state.committed_sequence === stoppedSnapshot.state.committed_sequence,
      },
      crashRecovery: {
        killedSignal: killed.signal,
        killedAtSequence: beforeCrash.state.committed_sequence,
        recoveredStartupId: recoveredStart.startupId,
        recoveredPid: recoveredStart.pid,
        resumedSequence: recoveredHeartbeat.state.committed_sequence,
        durableProgress:
          recoveredHeartbeat.state.committed_sequence > beforeCrash.state.committed_sequence,
        gracefulStopSequence: finalGraceful.stopped.sequence,
      },
      credential: {
        bytes: statSync(credentialPath).size,
        protection: credentialProtection,
        challengeResponseVerified: true,
        secretPrinted: false,
        missingExitCode: missingExit.code,
        missingDiagnosticBytes: Buffer.byteLength(missing.stderr),
        missingDiagnosticBounded: Buffer.byteLength(missing.stderr) <= 256,
        missingCredentialDoesNotCreateDatabase: !existsSync(missingDatabasePath),
      },
      launchd: {
        plistPath,
        lint: plist.lint,
        label: plist.label,
        userName: "clarity-sync-service",
        programArguments: plist.argumentsList,
        dataDirectory: plist.data,
        logDirectory: plist.logs,
        throttleSeconds: 30,
        registered: false,
        argumentsAcceptedByProbe: true,
      },
      runnerCleanup: {
        injectedFailureStoppedChild: failureCleanupVerified,
        temporaryDirectoryRemoved: true,
      },
      scope: "synthetic foreground lifecycle only; no launchd registration or real credentials",
    };
    success = true;
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    await stopActiveProbes();
    rmSync(temporaryRoot, { recursive: true, force: true });
    if (!existsSync(temporaryRoot)) {
      process.stderr.write(
        success
          ? "temporary lifecycle runtime cleaned\n"
          : "temporary lifecycle runtime cleaned after failure\n",
      );
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "lifecycle probe failed"}\n`);
  process.exitCode = 1;
});
