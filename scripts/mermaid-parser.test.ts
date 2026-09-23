import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeMermaidParser, validateMermaidDiagram } from "./mermaid-parser.ts";

after(() => closeMermaidParser());

test("Mermaid parser accepts supported documentation diagram types", async () => {
  await validateMermaidDiagram("flowchart TD\n  A --> B");
  await validateMermaidDiagram("sequenceDiagram\n  Alice->>Bob: hello");
  await validateMermaidDiagram("erDiagram\n  STUDY ||--o{ INSTANCE : contains");
});

test("Mermaid parser rejects malformed diagrams", async () => {
  await assert.rejects(validateMermaidDiagram("notADiagram\n  A --> B"));
  await assert.rejects(validateMermaidDiagram("flowchart TD\n  A --x-->"));
});
