import { existsSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { createMapOutputs, listFiles, projectRoot, readMapCards, readText } from "./map-files.ts";
import { validateMermaidDiagram } from "./mermaid-parser.ts";

const failures: string[] = [];
let checkedLinks = 0;
let checkedDiagrams = 0;
const files = listFiles(projectRoot);
const markdownFiles = files.filter((path) => path.endsWith(".md"));

function assertCondition(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

function outsideCode(text: string): string {
  return text.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, "");
}

function headingAnchors(text: string): Set<string> {
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  for (const match of outsideCode(text).matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const heading = match[1];
    if (!heading) continue;
    const base = heading
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replaceAll(" ", "-");
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

for (const path of markdownFiles) {
  const text = readText(path);
  const label = relative(projectRoot, path);
  const fences = text.match(/^(`{3,}|~{3,})/gm) ?? [];
  assertCondition(fences.length % 2 === 0, `${label}: unbalanced code fences`);
  for (const match of outsideCode(text).matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
    const raw = match[1];
    if (!raw) continue;
    const target = raw.replace(/^<|>$/g, "");
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const hashIndex = target.indexOf("#");
    const localPath = hashIndex < 0 ? target : target.slice(0, hashIndex);
    const anchor = hashIndex < 0 ? "" : decodeURIComponent(target.slice(hashIndex + 1));
    const absolute = localPath
      ? resolve(dirname(path), decodeURIComponent(localPath).replace(/:\d+$/, ""))
      : path;
    checkedLinks++;
    if (!existsSync(absolute)) {
      failures.push(`${label}: missing local link ${target}`);
      continue;
    }
    if (anchor && absolute.endsWith(".md") && statSync(absolute).isFile()) {
      assertCondition(
        headingAnchors(readText(absolute)).has(anchor),
        `${label}: missing anchor ${target}`,
      );
    }
  }
  for (const match of text.matchAll(/```mermaid\n([\s\S]*?)\n```/g)) {
    const source = match[1] ?? "";
    checkedDiagrams += 1;
    const line = text.slice(0, match.index).split("\n").length;
    try {
      await validateMermaidDiagram(source);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${label}:${line}: invalid Mermaid syntax: ${message}`);
    }
  }
}

const seenIds = new Set<string>();
for (const card of readMapCards()) {
  const label = relative(projectRoot, card.path);
  assertCondition(
    !seenIds.has(card.id) && /^[a-z0-9-]+$/.test(card.id),
    `${label}: duplicate/invalid id`,
  );
  seenIds.add(card.id);
  assertCondition(
    ["object", "process", "decision", "session"].includes(card.type),
    `${label}: invalid type`,
  );
  const expectedShelf = card.type === "process" ? "processes" : `${card.type}s`;
  assertCondition(
    relative(join(projectRoot, "map"), card.path).split(sep)[0] === expectedShelf,
    `${label}: type does not match shelf`,
  );
  assertCondition(
    ["live", "leftover", "ghost"].includes(card.universe),
    `${label}: invalid universe`,
  );
  assertCondition(["verified", "stale", "stub"].includes(card.status), `${label}: invalid status`);
  assertCondition(
    card.universe !== "ghost" || card.status === "stub",
    `${label}: a ghost must remain stub`,
  );
  assertCondition(/^\d{4}-\d{2}-\d{2}$/.test(card.updated), `${label}: invalid date`);
  assertCondition(card.revision.length > 0, `${label}: missing revision`);
  assertCondition(
    /\[[^\]]+\]\([^)]+\)/.test(readText(card.path)),
    `${label}: card needs source links`,
  );
}

for (const [path, expected] of createMapOutputs()) {
  assertCondition(
    existsSync(path) && readText(path) === expected,
    `${relative(projectRoot, path)}: stale generated output; run generate-map.ts`,
  );
}

const sourceExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".sql",
  ".json",
  ".yaml",
  ".yml",
  ".css",
  ".html",
]);
for (const path of files.filter((file) => sourceExtensions.has(extname(file)))) {
  if (path.endsWith("pnpm-lock.yaml")) continue;
  const text = readText(path);
  const count = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  assertCondition(count <= 700, `${relative(projectRoot, path)}: ${count} lines exceeds 700`);
}
assertCondition(
  readText(join(projectRoot, "AGENTS.md")).split("\n").length <= 60,
  "Root AGENTS.md is no longer a small router (60 lines)",
);

const plan = readText(join(projectRoot, "docs", "01-final-clarity-v2-plan.md"));
const requirementsSection = plan.split("## 1. Requirements")[1]?.split("## 2. Diagnosis")[0] ?? "";
const traceabilitySection =
  plan.split("## 5. Traceability and verification")[1]?.split("## 6. Delivery")[0] ?? "";
const requirements = new Set(requirementsSection.match(/\b(?:BR|TR)-\d{2}\b/g) ?? []);
assertCondition(requirements.size > 0, "Plan requirements are missing");
for (const requirement of requirements) {
  assertCondition(
    traceabilitySection.includes(requirement),
    `Plan requirement ${requirement} has no traceability row`,
  );
}

if (failures.length > 0) {
  failures.forEach((failure) => process.stderr.write(`${failure}\n`));
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Checked ${markdownFiles.length} Markdown files, ${checkedLinks} local links, ` +
      `${seenIds.size} map cards and ${requirements.size} requirements.\n`,
  );
  process.stdout.write("Map outputs are current; source line limits pass.\n");
  process.stdout.write(
    `Parsed ${checkedDiagrams} Mermaid diagrams with mermaid@12.0.0; diagrams were not rendered.\n`,
  );
}
