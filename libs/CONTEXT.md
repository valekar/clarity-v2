# Shared packages

Input: a real implementation need. Place browser-safe visual code in ui, pure
manifest/readiness/dispatch decisions in domain, versioned DTOs in contracts,
PostgreSQL adapters in database, cloud auth in server, scoped S3 in storage,
synthetic provider tests in messaging, and tool configuration in config.
The plan lists ownership for later imaging and real-provider work.
Output: explicit workspace exports and checks. Review the import graph so a UI
package never reaches Node, credentials, PostgreSQL or provider SDKs.

`@clarity/imaging` owns the bounded DICOM Part 10 identity reader shared by the
cloud worker and later imaging flows. It currently accepts implicit and explicit
little-endian headers only; it does not provide pixel decoding, CT/MR codecs or
clinical content validation. Its synthetic parser regressions remain exercised
through the worker tests and compiled package export check.
