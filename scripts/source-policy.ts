import { readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { projectRoot, readText } from "./map-files.ts";

export const MAX_AUTHORED_LINES = 700;

const authoredExtensions = new Set([
  ".ts",
  ".tsx",
  ".py",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".sql",
  ".json",
  ".yaml",
  ".yml",
  ".css",
  ".scss",
  ".html",
  ".sh",
  ".ps1",
  ".bat",
  ".cmd",
  ".toml",
]);

const ignoredDirectories = new Set([
  ".git",
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "coverage",
  "out",
]);
const applicationPackages = new Set(["web", "desktop", "sync-service", "worker"]);
const nodeBuiltins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const databasePackages = new Set([
  "@libsql/client",
  "@neondatabase/serverless",
  "@prisma/client",
  "better-sqlite3",
  "drizzle-orm",
  "knex",
  "kysely",
  "mongodb",
  "mongoose",
  "mysql2",
  "pg",
  "postgres",
  "prisma",
  "redis",
  "sequelize",
  "sqlite3",
  "typeorm",
]);
const providerPackages = new Set([
  "@aws-sdk",
  "@azure",
  "@clerk",
  "@firebase",
  "@google-cloud",
  "@hanko",
  "@resend",
  "@sendgrid",
  "@supabase",
  "@twilio",
  "aws-sdk",
  "firebase-admin",
  "nodemailer",
  "resend",
  "stripe",
  "twilio",
]);
const pureLibraries = new Set(["domain", "contracts"]);

export function physicalLineCount(source: string): number {
  if (source.length === 0) return 0;
  const lines = source.split(/\r\n|\n|\r/);
  return source.endsWith("\n") || source.endsWith("\r") ? lines.length - 1 : lines.length;
}

function listAuthoredFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory())
      return ignoredDirectories.has(entry.name) ? [] : listAuthoredFiles(path);
    if (!entry.isFile() || entry.name === "pnpm-lock.yaml") return [];
    return authoredExtensions.has(extname(entry.name)) ? [path] : [];
  });
}

export function lineLimitViolations(files: readonly string[]): string[] {
  return files.flatMap((path) => {
    const lines = physicalLineCount(readText(path));
    return lines > MAX_AUTHORED_LINES
      ? [`${relative(projectRoot, path)}: ${lines} lines exceeds ${MAX_AUTHORED_LINES}`]
      : [];
  });
}

export function authoredSourceFiles(): string[] {
  return listAuthoredFiles(projectRoot);
}

type BoundaryFile = Readonly<{ path: string; text: string }>;

function packageRoot(path: string): string | undefined {
  const rel = relative(projectRoot, resolve(path));
  const parts = rel.split(sep);
  return parts.length >= 3 && (parts[0] === "apps" || parts[0] === "libs")
    ? resolve(projectRoot, parts[0]!, parts[1]!)
    : undefined;
}

function imports(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"\n]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) if (match[1]) specifiers.push(match[1]);
  }
  return specifiers;
}

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

function packageMatches(name: string, restricted: ReadonlySet<string>): boolean {
  if (restricted.has(name)) return true;
  for (const root of restricted) {
    if (root.startsWith("@") && name.startsWith(`${root}/`)) return true;
  }
  return false;
}

function pureLibraryViolation(owner: string, filePath: string, specifier: string): boolean {
  if (!owner.startsWith(resolve(projectRoot, "libs") + sep)) return false;
  const library = relative(resolve(projectRoot, "libs"), owner).split(sep)[0];
  if (!pureLibraries.has(library ?? "")) return false;
  const sourceDirectory = resolve(owner, "src") + sep;
  if (!resolve(filePath).startsWith(sourceDirectory)) return false;
  const name = packageName(specifier);
  return (
    nodeBuiltins.has(specifier) ||
    name === "next" ||
    name === "electron" ||
    packageMatches(name, databasePackages) ||
    packageMatches(name, providerPackages)
  );
}

export function boundaryViolations(files: readonly BoundaryFile[]): string[] {
  const failures: string[] = [];
  for (const file of files) {
    const owner = packageRoot(file.path);
    if (!owner) continue;
    for (const specifier of imports(file.text)) {
      if (pureLibraryViolation(owner, file.path, specifier)) {
        failures.push(
          `${relative(projectRoot, file.path)}: pure domain/contracts package imports privileged dependency (${specifier})`,
        );
        continue;
      }
      if (
        specifier.includes("/Projects/clarity/") ||
        specifier.startsWith("file:///Users/valekar/Projects/clarity/")
      ) {
        failures.push(
          `${relative(projectRoot, file.path)}: runtime import references V1 (${specifier})`,
        );
        continue;
      }
      if (!specifier.startsWith(".")) {
        const appAlias = specifier.match(/^@clarity\/([^/]+)/)?.[1];
        const ownerIsApp = owner.startsWith(resolve(projectRoot, "apps") + sep);
        const appName = ownerIsApp
          ? relative(resolve(projectRoot, "apps"), owner).split(sep)[0]
          : undefined;
        if (ownerIsApp && appAlias && applicationPackages.has(appAlias) && appAlias !== appName) {
          failures.push(
            `${relative(projectRoot, file.path)}: app-to-app import @clarity/${appAlias}`,
          );
        }
        continue;
      }
      const target = resolve(file.path, "..", specifier);
      if (isAbsolute(target) && packageRoot(target) !== owner) {
        failures.push(
          `${relative(projectRoot, file.path)}: deep relative import crosses package boundary (${specifier})`,
        );
      }
    }
  }
  return failures;
}

export function sourcePolicyViolations(): string[] {
  const files = authoredSourceFiles();
  const sourceFiles = files.map((path) => ({ path, text: readText(path) }));
  return [...lineLimitViolations(files), ...boundaryViolations(sourceFiles)];
}
