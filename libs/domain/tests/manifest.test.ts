import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  addManifestMembers,
  addManifestMember,
  createDispatchScope,
  createDraftManifest,
  evaluateReadiness,
  handleLateInstance,
  sealManifest,
  type ManifestMember,
  type SealedManifest,
} from "../src/index.ts";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);
const memberA: ManifestMember = { sopInstanceUid: "1.2.3", sha256: hashA };
const memberB: ManifestMember = { sopInstanceUid: "1.2.4", sha256: hashB };
const memberC: ManifestMember = { sopInstanceUid: "1.2.5", sha256: hashC };
const stableInventoryProof = {
  sourceWasStableAtSeal: true,
  inventoryWasCompleteAtSeal: true,
} as const;
const hashCanonicalManifest = (canonicalJson: string) =>
  createHash("sha256").update(canonicalJson, "utf8").digest("hex");

function draftWith(members: readonly ManifestMember[], currentRevision: number | null = null) {
  const result = addManifestMembers(createDraftManifest(currentRevision), members);
  assert.equal(result.kind, "added");
  if (result.kind !== "added") throw new Error("Expected members to be added.");
  return result.manifest;
}

function seal(
  members: readonly ManifestMember[],
  currentRevision: number | null = null,
): SealedManifest {
  const draft = draftWith(members, currentRevision);
  const result = sealManifest(
    draft,
    members,
    currentRevision,
    stableInventoryProof,
    hashCanonicalManifest,
  );
  assert.equal(result.kind, "sealed");
  if (result.kind !== "sealed") throw new Error("Expected manifest to seal.");
  return result.manifest;
}

test("manifest member add is immutable and distinguishes duplicate from conflicting bytes", () => {
  const draft = createDraftManifest(null);
  const added = addManifestMember(draft, memberA);
  assert.equal(added.kind, "added");
  if (added.kind !== "added") return;
  assert.equal(draft.members.length, 0);
  assert.equal(addManifestMember(added.manifest, memberA).kind, "duplicate");
  const conflict = addManifestMember(added.manifest, { ...memberA, sha256: hashB });
  assert.equal(conflict.kind, "conflict");
  assert.equal(
    addManifestMember(added.manifest, { sopInstanceUid: "  ", sha256: hashA }).kind,
    "invalid",
  );
  assert.equal(
    addManifestMember(added.manifest, { sopInstanceUid: "1.2.9", sha256: "nope" }).kind,
    "invalid",
  );
});

test("sealing requires a non-empty exact inventory and produces an order-independent digest", () => {
  const empty = sealManifest(
    createDraftManifest(null),
    [],
    null,
    stableInventoryProof,
    hashCanonicalManifest,
  );
  assert.equal(empty.kind, "empty");
  const draft = draftWith([memberB, memberA]);
  assert.equal(
    sealManifest(draft, [memberA], null, stableInventoryProof, hashCanonicalManifest).kind,
    "inventory-mismatch",
  );
  assert.equal(
    sealManifest(
      draft,
      [memberA, memberB, memberC],
      null,
      stableInventoryProof,
      hashCanonicalManifest,
    ).kind,
    "inventory-mismatch",
  );
  assert.equal(
    sealManifest(
      draft,
      [{ ...memberA, sha256: hashC }, memberB],
      null,
      stableInventoryProof,
      hashCanonicalManifest,
    ).kind,
    "invalid-inventory",
  );
  assert.equal(
    sealManifest(
      draft,
      [memberA, memberA, memberB],
      null,
      stableInventoryProof,
      hashCanonicalManifest,
    ).kind,
    "invalid-inventory",
  );
  assert.equal(
    sealManifest(
      draft,
      [memberA, { ...memberA, sha256: hashC }, memberB],
      null,
      stableInventoryProof,
      hashCanonicalManifest,
    ).kind,
    "invalid-inventory",
  );
  assert.equal(
    sealManifest(
      draft,
      [memberA, memberB],
      null,
      {
        sourceWasStableAtSeal: false,
        inventoryWasCompleteAtSeal: true,
      },
      hashCanonicalManifest,
    ).kind,
    "source-not-stable",
  );
  assert.equal(
    sealManifest(
      draft,
      [memberA, memberB],
      null,
      {
        sourceWasStableAtSeal: true,
        inventoryWasCompleteAtSeal: false,
      },
      hashCanonicalManifest,
    ).kind,
    "source-not-stable",
  );
  const first = seal([memberA, memberB]);
  const reversed = seal([memberB, memberA]);
  assert.equal(first.digest, reversed.digest);
  assert.equal(first.members.map(({ sopInstanceUid }) => sopInstanceUid).join(","), "1.2.3,1.2.4");
  assert.equal(Object.isFrozen(first.members), true);
  assert.equal(Object.isFrozen(first), true);
});

test("compare-and-swap rejects a draft based on a stale current revision", () => {
  const staleDraft = draftWith([memberA], 2);
  const result = sealManifest(
    staleDraft,
    [memberA],
    3,
    stableInventoryProof,
    hashCanonicalManifest,
  );
  assert.deepEqual(result, {
    kind: "stale-revision",
    expectedCurrentRevision: 2,
    actualCurrentRevision: 3,
  });
  assert.equal(createDraftManifest(null).revision, 1);
  assert.equal(createDraftManifest(3).revision, 4);
});

test("readiness requires stable source and every exact member verified and indexed", () => {
  const manifest = seal([memberA, memberB]);
  const complete = [
    { ...memberA, verified: true, indexed: true },
    { ...memberB, verified: true, indexed: true },
  ];
  assert.deepEqual(evaluateReadiness(manifest, complete, true, false), {
    ready: true,
    reason: "ready",
    missing: [],
    unverified: [],
    unindexed: [],
    conflicts: [],
    unexpected: [],
  });
  // Source stability is seal-time evidence. Orthanc can be offline now while
  // the verified cloud copy remains Ready.
  const sourceReachableNow = false;
  const readyAfterSourceDisconnect = evaluateReadiness(manifest, complete, true, false);
  assert.equal(sourceReachableNow, false);
  assert.equal(readyAfterSourceDisconnect.ready, true);
  assert.equal(evaluateReadiness(manifest, complete, false, false).reason, "source-not-stable");
  assert.equal(evaluateReadiness(manifest, complete, true, true).reason, "unresolved-conflict");
  const partial = evaluateReadiness(
    manifest,
    [{ ...memberA, verified: true, indexed: false }],
    true,
    false,
  );
  assert.deepEqual(partial.missing, [memberB.sopInstanceUid]);
  assert.deepEqual(partial.unindexed, [memberA.sopInstanceUid]);
  const tampered = evaluateReadiness(
    manifest,
    [
      { ...memberA, sha256: hashC, verified: true, indexed: true },
      { ...memberB, verified: false, indexed: true },
    ],
    true,
    false,
  );
  assert.deepEqual(tampered.conflicts, [memberA.sopInstanceUid]);
  assert.deepEqual(tampered.unverified, [memberB.sopInstanceUid]);
  const extra = evaluateReadiness(
    manifest,
    [...complete, { ...memberC, verified: true, indexed: true }],
    true,
    false,
  );
  assert.equal(extra.ready, false);
  assert.deepEqual(extra.unexpected, [memberC.sopInstanceUid]);
  assert.equal(
    evaluateReadiness(createDraftManifest(null), [], true, false).reason,
    "unsealed-manifest",
  );
});

test("late instances reopen to a new syncing revision without changing frozen dispatch scope", () => {
  const manifest = seal([memberA, memberB]);
  const frozen = createDispatchScope(manifest);
  const decision = handleLateInstance(manifest, memberC);
  assert.equal(decision.kind, "reopened");
  if (decision.kind !== "reopened") return;
  assert.equal(decision.status, "syncing");
  assert.equal(decision.draft.revision, manifest.revision + 1);
  assert.equal(decision.draft.expectedCurrentRevision, manifest.revision);
  assert.deepEqual(decision.draft.members, [memberA, memberB, memberC]);
  assert.deepEqual(frozen.members, [memberA, memberB]);
  assert.equal(
    frozen.members.some(({ sopInstanceUid }) => sopInstanceUid === memberC.sopInstanceUid),
    false,
  );
  assert.equal(Object.isFrozen(frozen.members), true);
  const duplicate = handleLateInstance(manifest, memberA);
  assert.deepEqual(duplicate, { kind: "unchanged", manifest });
  assert.equal("status" in duplicate, false);
  const conflict = handleLateInstance(manifest, { ...memberA, sha256: hashC });
  assert.equal(conflict.kind, "conflict");
  if (conflict.kind === "conflict") assert.equal(conflict.status, "needs_attention");
});
