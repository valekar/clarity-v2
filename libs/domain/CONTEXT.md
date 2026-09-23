# Pure ingestion decisions

Input: observed source members, verified member status and explicit revision values.
Output: deterministic manifest sealing, readiness, late-instance reopening and
immutable dispatch-scope decisions. This package performs no persistence, network
access or clinical byte handling. Before sealing, callers must fetch a fresh full
source inventory and establish source stability, then pass the explicit
`sourceWasStableAtSeal` and `inventoryWasCompleteAtSeal` proof. Digest creation is
injected through a synchronous canonical-manifest hasher so this package has no
Node-only imports; callers must hash the supplied UTF-8 canonical JSON with
SHA-256 and return lowercase hexadecimal. The caller must perform compare-and-swap when persisting the sealed
revision; it also owns bounded paging, transaction durability and source inventory
semantics. The manifest digest is SHA-256 over UTF-8 canonical JSON for the
lexically sorted list of `{sopInstanceUid, sha256}` objects. Readiness takes exactly
the sealed member set; its stability input is seal-time evidence, not current source
reachability, so a later Orthanc disconnect does not regress a verified cloud
Report. Duplicate late observations return unchanged without asserting a Report
status; the caller preserves the current Report state. Extra UIDs are reported and
prevent Ready. See plan sections 3.4–3.6.
