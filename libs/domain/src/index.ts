export type ManifestMember = Readonly<{
  sopInstanceUid: string;
  sha256: string;
}>;

export type DeviceAdminIpcRequest =
  | Readonly<{ operation: "readSyncStatus" }>
  | Readonly<{ operation: "createPairing"; sourceId: string }>
  | Readonly<{ operation: "revokeDevice"; deviceId: string; expectedVersion: string }>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseDeviceAdminIpcRequest(value: unknown): DeviceAdminIpcRequest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const request = value as Record<string, unknown>;
  if (request.operation === "readSyncStatus") {
    return Object.keys(request).length === 1
      ? Object.freeze({ operation: "readSyncStatus" })
      : null;
  }
  if (
    request.operation === "createPairing" &&
    typeof request.sourceId === "string" &&
    UUID_PATTERN.test(request.sourceId) &&
    Object.keys(request).length === 2
  ) {
    return Object.freeze({
      operation: "createPairing",
      sourceId: request.sourceId.toLowerCase(),
    });
  }
  if (
    request.operation === "revokeDevice" &&
    typeof request.deviceId === "string" &&
    UUID_PATTERN.test(request.deviceId) &&
    typeof request.expectedVersion === "string" &&
    /^[1-9][0-9]{0,17}$/.test(request.expectedVersion) &&
    Object.keys(request).length === 3
  ) {
    return Object.freeze({
      operation: "revokeDevice",
      deviceId: request.deviceId.toLowerCase(),
      expectedVersion: request.expectedVersion,
    });
  }
  return null;
}

export function isTrustedDeviceIpcSender(
  frameUrl: string,
  dashboardOrigin: string,
  isMainFrame: boolean,
): boolean {
  if (!isMainFrame) return false;
  try {
    const frame = new URL(frameUrl);
    const expected = new URL(dashboardOrigin);
    return (
      frame.origin === expected.origin &&
      expected.protocol === "https:" &&
      expected.pathname === "/" &&
      expected.search === "" &&
      expected.hash === "" &&
      expected.username === "" &&
      expected.password === ""
    );
  } catch {
    return false;
  }
}

export type DeviceLeaseCheck = Readonly<{
  sourceId: string;
  deviceId: string;
  deviceSourceId: string;
  deviceStatus: "paired" | "revoked";
  sourceStatus: "active" | "disabled";
  leaseDeviceId: string | null;
  fencingToken: string;
  currentFencingToken: string;
  leaseExpiresAt: Date;
  now: Date;
}>;

export type DeviceLeaseDecision =
  | Readonly<{ allowed: true }>
  | Readonly<{
      allowed: false;
      reason:
        | "source-mismatch"
        | "device-revoked"
        | "source-disabled"
        | "lease-held-elsewhere"
        | "stale-fence"
        | "lease-expired";
    }>;

export function checkDeviceLease(input: DeviceLeaseCheck): DeviceLeaseDecision {
  if (input.deviceSourceId !== input.sourceId) return { allowed: false, reason: "source-mismatch" };
  if (input.deviceStatus !== "paired") return { allowed: false, reason: "device-revoked" };
  if (input.sourceStatus !== "active") return { allowed: false, reason: "source-disabled" };
  if (input.leaseDeviceId !== input.deviceId)
    return { allowed: false, reason: "lease-held-elsewhere" };
  if (input.fencingToken !== input.currentFencingToken)
    return { allowed: false, reason: "stale-fence" };
  if (input.leaseExpiresAt.getTime() <= input.now.getTime())
    return { allowed: false, reason: "lease-expired" };
  return { allowed: true };
}

export type DraftManifest = Readonly<{
  state: "draft";
  revision: number;
  expectedCurrentRevision: number | null;
  members: readonly ManifestMember[];
}>;

export type SealedManifest = Readonly<{
  state: "sealed";
  revision: number;
  members: readonly ManifestMember[];
  digest: string;
}>;

export type AddMemberDecision =
  | Readonly<{ kind: "added"; manifest: DraftManifest }>
  | Readonly<{ kind: "duplicate"; manifest: DraftManifest }>
  | Readonly<{ kind: "limit-reached"; maximumMembers: number }>
  | Readonly<{
      kind: "conflict";
      sopInstanceUid: string;
      existingSha256: string;
      incomingSha256: string;
    }>
  | Readonly<{ kind: "invalid"; reason: string }>;

export type SealDecision =
  | Readonly<{ kind: "sealed"; manifest: SealedManifest }>
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "source-not-stable" }>
  | Readonly<{ kind: "invalid-inventory"; reason: string }>
  | Readonly<{
      kind: "inventory-mismatch";
      missing: readonly string[];
      unexpected: readonly string[];
    }>
  | Readonly<{
      kind: "stale-revision";
      expectedCurrentRevision: number | null;
      actualCurrentRevision: number | null;
    }>;

export type MemberVerification = Readonly<{
  sopInstanceUid: string;
  sha256: string;
  verified: boolean;
  indexed: boolean;
}>;

export type ReadinessDecision = Readonly<{
  ready: boolean;
  reason:
    | "ready"
    | "unsealed-manifest"
    | "source-not-stable"
    | "unresolved-conflict"
    | "members-incomplete";
  missing: readonly string[];
  unverified: readonly string[];
  unindexed: readonly string[];
  conflicts: readonly string[];
  unexpected: readonly string[];
}>;

export type StableCompleteInventoryProof = Readonly<{
  sourceWasStableAtSeal: boolean;
  inventoryWasCompleteAtSeal: boolean;
}>;

export type CanonicalManifestHasher = (canonicalManifestJson: string) => string;

export type DispatchScope = Readonly<{
  revision: number;
  manifestDigest: string;
  members: readonly ManifestMember[];
}>;

export type LateInstanceDecision =
  | Readonly<{ kind: "unchanged"; manifest: SealedManifest }>
  | Readonly<{
      kind: "reopened";
      status: "syncing";
      manifest: SealedManifest;
      draft: DraftManifest;
    }>
  | Readonly<{
      kind: "conflict";
      status: "needs_attention";
      sopInstanceUid: string;
      existingSha256: string;
      incomingSha256: string;
    }>
  | Readonly<{ kind: "invalid"; reason: string }>;

const SHA256_HEX = /^[a-f0-9]{64}$/;
const DICOM_UID = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*$/;
export const MAX_MANIFEST_MEMBERS = 100_000;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeMember(value: unknown): ManifestMember | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (!isNonEmptyString(candidate.sopInstanceUid) || typeof candidate.sha256 !== "string")
    return undefined;
  const sopInstanceUid = candidate.sopInstanceUid.trim();
  const sha256 = candidate.sha256.toLowerCase();
  if (sopInstanceUid.length > 64 || !DICOM_UID.test(sopInstanceUid) || !SHA256_HEX.test(sha256))
    return undefined;
  return Object.freeze({ sopInstanceUid, sha256 });
}

function compareMembers(left: ManifestMember, right: ManifestMember): number {
  if (left.sopInstanceUid < right.sopInstanceUid) return -1;
  if (left.sopInstanceUid > right.sopInstanceUid) return 1;
  return left.sha256 < right.sha256 ? -1 : left.sha256 > right.sha256 ? 1 : 0;
}

function freezeMembers(members: readonly ManifestMember[]): readonly ManifestMember[] {
  return Object.freeze(members.map((member) => Object.freeze({ ...member })));
}

function currentRevisionIsValid(revision: number | null): boolean {
  return revision === null || (Number.isSafeInteger(revision) && revision >= 1);
}

export function createDraftManifest(expectedCurrentRevision: number | null): DraftManifest {
  if (!currentRevisionIsValid(expectedCurrentRevision)) {
    throw new TypeError("Current revision must be null or a positive safe integer.");
  }
  const revision = expectedCurrentRevision === null ? 1 : expectedCurrentRevision + 1;
  if (!Number.isSafeInteger(revision))
    throw new RangeError("Next revision exceeds the safe integer range.");
  return Object.freeze({
    state: "draft",
    revision,
    expectedCurrentRevision,
    members: Object.freeze([]),
  });
}

export function addManifestMember(draft: DraftManifest, input: unknown): AddMemberDecision {
  return addManifestMembers(draft, [input]);
}

export function addManifestMembers(draft: DraftManifest, input: unknown): AddMemberDecision {
  if (draft.state !== "draft")
    return { kind: "invalid", reason: "Members can only be added to a draft manifest." };
  if (!Array.isArray(input))
    return { kind: "invalid", reason: "Members must be provided as an array." };
  if (input.length > MAX_MANIFEST_MEMBERS) {
    return { kind: "limit-reached", maximumMembers: MAX_MANIFEST_MEMBERS };
  }
  const membersByUid = new Map(draft.members.map((member) => [member.sopInstanceUid, member]));
  let didAdd = false;
  for (const value of input as unknown[]) {
    const member = normalizeMember(value);
    if (!member)
      return {
        kind: "invalid",
        reason: "Member requires a non-empty SOP Instance UID and a SHA-256 digest.",
      };
    const existing = membersByUid.get(member.sopInstanceUid);
    if (existing?.sha256 === member.sha256) continue;
    if (existing) {
      return {
        kind: "conflict",
        sopInstanceUid: member.sopInstanceUid,
        existingSha256: existing.sha256,
        incomingSha256: member.sha256,
      };
    }
    if (membersByUid.size >= MAX_MANIFEST_MEMBERS) {
      return { kind: "limit-reached", maximumMembers: MAX_MANIFEST_MEMBERS };
    }
    membersByUid.set(member.sopInstanceUid, member);
    didAdd = true;
  }
  if (!didAdd) return { kind: "duplicate", manifest: draft };
  const members = freezeMembers([...membersByUid.values()].sort(compareMembers));
  return {
    kind: "added",
    manifest: Object.freeze({ ...draft, members }),
  };
}

function normalizeInventory(
  input: unknown,
): Readonly<{ members: readonly ManifestMember[] }> | Readonly<{ reason: string }> {
  if (!Array.isArray(input)) return { reason: "Source inventory must be an array." };
  if (input.length > MAX_MANIFEST_MEMBERS)
    return { reason: `Source inventory exceeds ${MAX_MANIFEST_MEMBERS} members.` };
  const members: ManifestMember[] = [];
  const seen = new Map<string, string>();
  for (const item of input as unknown[]) {
    const member = normalizeMember(item);
    if (!member) return { reason: "Source inventory contains an invalid member." };
    const previousDigest = seen.get(member.sopInstanceUid);
    if (previousDigest !== undefined) {
      if (previousDigest !== member.sha256)
        return { reason: `Source inventory has conflicting bytes for ${member.sopInstanceUid}.` };
      return { reason: `Source inventory repeats ${member.sopInstanceUid}.` };
    }
    seen.set(member.sopInstanceUid, member.sha256);
    members.push(member);
  }
  return { members: freezeMembers(members.sort(compareMembers)) };
}

export function sealManifest(
  draft: DraftManifest,
  sourceInventory: unknown,
  actualCurrentRevision: number | null,
  proof: StableCompleteInventoryProof,
  hashCanonicalManifest: CanonicalManifestHasher,
): SealDecision {
  if (draft.state !== "draft")
    return { kind: "invalid-inventory", reason: "Only a draft manifest can be sealed." };
  if (!currentRevisionIsValid(actualCurrentRevision)) {
    return {
      kind: "invalid-inventory",
      reason: "Current revision must be null or a positive safe integer.",
    };
  }
  if (actualCurrentRevision !== draft.expectedCurrentRevision) {
    return {
      kind: "stale-revision",
      expectedCurrentRevision: draft.expectedCurrentRevision,
      actualCurrentRevision,
    };
  }
  if (proof?.sourceWasStableAtSeal !== true || proof.inventoryWasCompleteAtSeal !== true)
    return { kind: "source-not-stable" };
  if (draft.members.length === 0) return { kind: "empty" };
  const inventory = normalizeInventory(sourceInventory);
  if ("reason" in inventory) return { kind: "invalid-inventory", reason: inventory.reason };
  const draftByUid = new Map(draft.members.map((member) => [member.sopInstanceUid, member.sha256]));
  const sourceByUid = new Map(
    inventory.members.map((member) => [member.sopInstanceUid, member.sha256]),
  );
  const missing = [...draftByUid.keys()].filter((uid) => !sourceByUid.has(uid)).sort();
  const unexpected = [...sourceByUid.keys()].filter((uid) => !draftByUid.has(uid)).sort();
  const differing = [...draftByUid.keys()].filter((uid) => {
    const sourceDigest = sourceByUid.get(uid);
    return sourceDigest !== undefined && sourceDigest !== draftByUid.get(uid);
  });
  if (differing.length > 0)
    return {
      kind: "invalid-inventory",
      reason: `Source inventory bytes changed for ${differing.sort().join(", ")}.`,
    };
  if (missing.length > 0 || unexpected.length > 0) {
    return {
      kind: "inventory-mismatch",
      missing: Object.freeze(missing),
      unexpected: Object.freeze(unexpected),
    };
  }
  const members = freezeMembers(draft.members);
  const canonicalMembers = members.map(({ sopInstanceUid, sha256 }) => ({
    sopInstanceUid,
    sha256,
  }));
  const digest = hashCanonicalManifest(JSON.stringify(canonicalMembers));
  if (!SHA256_HEX.test(digest)) {
    return {
      kind: "invalid-inventory",
      reason: "Manifest hasher must return a lowercase SHA-256 hexadecimal digest.",
    };
  }
  return {
    kind: "sealed",
    manifest: Object.freeze({ state: "sealed", revision: draft.revision, members, digest }),
  };
}

export function evaluateReadiness(
  manifest: SealedManifest | DraftManifest,
  verificationInput: unknown,
  sourceWasStableAtSeal: boolean,
  hasUnresolvedConflict: boolean,
): ReadinessDecision {
  if (manifest.state !== "sealed") {
    return {
      ready: false,
      reason: "unsealed-manifest",
      missing: [],
      unverified: [],
      unindexed: [],
      conflicts: [],
      unexpected: [],
    };
  }
  if (!sourceWasStableAtSeal) {
    return {
      ready: false,
      reason: "source-not-stable",
      missing: [],
      unverified: [],
      unindexed: [],
      conflicts: [],
      unexpected: [],
    };
  }
  if (hasUnresolvedConflict) {
    return {
      ready: false,
      reason: "unresolved-conflict",
      missing: [],
      unverified: [],
      unindexed: [],
      conflicts: [],
      unexpected: [],
    };
  }
  if (!Array.isArray(verificationInput)) {
    return {
      ready: false,
      reason: "members-incomplete",
      missing: manifest.members.map(({ sopInstanceUid }) => sopInstanceUid),
      unverified: [],
      unindexed: [],
      conflicts: [],
      unexpected: [],
    };
  }
  if (verificationInput.length > MAX_MANIFEST_MEMBERS) {
    return {
      ready: false,
      reason: "members-incomplete",
      missing: manifest.members.map(({ sopInstanceUid }) => sopInstanceUid),
      unverified: [],
      unindexed: [],
      conflicts: [],
      unexpected: [],
    };
  }
  const observations = new Map<string, MemberVerification>();
  const malformed: string[] = [];
  for (const value of verificationInput as unknown[]) {
    if (typeof value !== "object" || value === null) {
      malformed.push("invalid verification entry");
      continue;
    }
    const entry = value as Record<string, unknown>;
    const member = normalizeMember(entry);
    if (!member || typeof entry.verified !== "boolean" || typeof entry.indexed !== "boolean") {
      malformed.push(
        isNonEmptyString(entry.sopInstanceUid)
          ? entry.sopInstanceUid
          : "invalid verification entry",
      );
      continue;
    }
    const previous = observations.get(member.sopInstanceUid);
    if (previous) {
      malformed.push(member.sopInstanceUid);
      continue;
    }
    observations.set(member.sopInstanceUid, {
      ...member,
      verified: entry.verified,
      indexed: entry.indexed,
    });
  }
  const expected = new Map(
    manifest.members.map((member) => [member.sopInstanceUid, member.sha256]),
  );
  const missing: string[] = [];
  const unverified: string[] = [];
  const unindexed: string[] = [];
  const conflicts: string[] = [...malformed];
  for (const [uid, digest] of expected) {
    const observation = observations.get(uid);
    if (!observation) {
      missing.push(uid);
      continue;
    }
    if (observation.sha256 !== digest) {
      conflicts.push(uid);
      continue;
    }
    if (!observation.verified) unverified.push(uid);
    if (!observation.indexed) unindexed.push(uid);
  }
  const unexpected = [...observations.keys()].filter((uid) => !expected.has(uid)).sort();
  const isReady =
    missing.length === 0 &&
    unverified.length === 0 &&
    unindexed.length === 0 &&
    conflicts.length === 0 &&
    unexpected.length === 0;
  return {
    ready: isReady,
    reason: isReady ? "ready" : "members-incomplete",
    missing: Object.freeze(missing.sort()),
    unverified: Object.freeze(unverified.sort()),
    unindexed: Object.freeze(unindexed.sort()),
    conflicts: Object.freeze([...new Set(conflicts)].sort()),
    unexpected: Object.freeze(unexpected),
  };
}

export function createDispatchScope(manifest: SealedManifest): DispatchScope {
  if (manifest.state !== "sealed")
    throw new TypeError("Dispatch scope requires a sealed manifest.");
  return Object.freeze({
    revision: manifest.revision,
    manifestDigest: manifest.digest,
    members: freezeMembers(manifest.members),
  });
}

export function handleLateInstance(manifest: SealedManifest, input: unknown): LateInstanceDecision {
  const member = normalizeMember(input);
  if (!member)
    return {
      kind: "invalid",
      reason: "Late instance requires a non-empty SOP Instance UID and a SHA-256 digest.",
    };
  const existing = manifest.members.find(
    (candidate) => candidate.sopInstanceUid === member.sopInstanceUid,
  );
  if (existing?.sha256 === member.sha256) return { kind: "unchanged", manifest };
  if (existing) {
    return {
      kind: "conflict",
      status: "needs_attention",
      sopInstanceUid: member.sopInstanceUid,
      existingSha256: existing.sha256,
      incomingSha256: member.sha256,
    };
  }
  const addResult = addManifestMembers(createDraftManifest(manifest.revision), [
    ...manifest.members,
    member,
  ]);
  if (addResult.kind !== "added")
    return { kind: "invalid", reason: "Could not add the late instance to the next revision." };
  return { kind: "reopened", status: "syncing", manifest, draft: addResult.manifest };
}
