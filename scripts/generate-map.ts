import { writeFileSync } from "node:fs";
import { relative } from "node:path";
import { createMapOutputs, projectRoot } from "./map-files.ts";

for (const [path, contents] of createMapOutputs()) {
  writeFileSync(path, contents, "utf8");
  process.stdout.write(`Generated ${relative(projectRoot, path)}\n`);
}
