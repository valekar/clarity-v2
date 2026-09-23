# Imaging package context

`@clarity/imaging` provides a bounded DICOM Part 10 identity reader for the V2
worker. It parses only the file meta header and the Study, Series and SOP UIDs
needed for intake validation. The current envelope accepts implicit and
explicit little endian transfer syntaxes and fails closed on unsupported
compressed syntax, malformed headers and oversized values. It does not decode
pixels or establish clinical suitability. Synthetic CT, MR and SR fixtures test
identity parsing only.

The package is imported by the worker; keep stream limits and identity checks
in this package when adding later imaging flows. See
[`docs/evidence/26-connected-ingestion.md`](../../docs/evidence/26-connected-ingestion.md)
for connected worker evidence and its limits.
