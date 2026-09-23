# Documentation tooling

Input: Markdown source, map frontmatter and map/CLAUDE.md. Output: deterministic
catalogs/twins and actionable integrity errors. No network, package install or
runtime services are required. Commands are defined in the root README.

Review: generation must only write its declared outputs; checking must be read-only.
Map parsing and output definitions live in map-files.ts. Future runtime checks
are separate implementation work. All authored script files must remain ≤700 lines.
