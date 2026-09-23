export interface AnchoredInstancePageDecision {
  action: "accept" | "retry" | "complete";
  nextOffset: number;
  nextAnchor: string | null;
  acceptedIds: string[];
}

/** Interpret an offset page using the last durable ID as the correctness anchor. */
export function decideAnchoredInstancePage(
  offset: number,
  ids: readonly string[],
  lastAnchor: string | null,
  upperBound: string | null,
  pageSize: number,
): AnchoredInstancePageDecision {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("invalid page offset");
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error("invalid page size");
  assertOrdered(ids);

  if (ids.length === 0) {
    return offset === 0
      ? { action: "complete", nextOffset: 0, nextAnchor: lastAnchor, acceptedIds: [] }
      : {
          action: "retry",
          nextOffset: Math.max(0, offset - pageSize),
          nextAnchor: lastAnchor,
          acceptedIds: [],
        };
  }

  const first = ids[0]!;
  const last = ids.at(-1)!;
  if (lastAnchor !== null && offset > 0 && first > lastAnchor) {
    return {
      action: "retry",
      nextOffset: Math.max(0, offset - pageSize),
      nextAnchor: lastAnchor,
      acceptedIds: [],
    };
  }
  if (lastAnchor !== null && offset === 0 && upperBound !== null && first > upperBound) {
    return { action: "complete", nextOffset: 0, nextAnchor: lastAnchor, acceptedIds: [] };
  }

  const acceptedIds = ids.filter(
    (id) => upperBound !== null && (lastAnchor === null || id > lastAnchor) && id <= upperBound,
  );
  const nextAnchor = acceptedIds.at(-1) ?? lastAnchor;
  const reachedUpper = upperBound !== null && last >= upperBound;
  const reachedTail = ids.length < pageSize;
  const complete = reachedUpper || reachedTail || (upperBound === null && offset === 0);
  return {
    action: complete ? "complete" : "accept",
    nextOffset: Math.max(0, offset + ids.length - 1),
    nextAnchor,
    acceptedIds,
  };
}

function assertOrdered(ids: readonly string[]): void {
  for (let index = 1; index < ids.length; index += 1) {
    if (ids[index - 1]! >= ids[index]!) {
      throw new Error("Orthanc global instance IDs must be strictly increasing");
    }
  }
}
