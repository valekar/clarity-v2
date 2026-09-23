import assert from "node:assert/strict";
import { test } from "node:test";
import { decideAnchoredInstancePage } from "../src/discovery/anchored-instance-page.js";

test("a deleted anchor and predecessors cause bounded backtracking without skipping later IDs", () => {
  const first = decideAnchoredInstancePage(0, ["a", "b"], null, "e", 2);
  assert.deepEqual(first.acceptedIds, ["a", "b"]);
  assert.equal(first.nextOffset, 1);
  const overshot = decideAnchoredInstancePage(1, ["d", "e"], "b", "e", 2);
  assert.equal(overshot.action, "retry");
  assert.equal(overshot.nextOffset, 0);
  const repaired = decideAnchoredInstancePage(0, ["c", "d"], "b", "e", 2);
  assert.deepEqual(repaired.acceptedIds, ["c", "d"]);
  assert.equal(repaired.nextOffset, 1);
  const tail = decideAnchoredInstancePage(1, ["d", "e"], "d", "e", 2);
  assert.deepEqual(tail.acceptedIds, ["e"]);
  assert.equal(tail.action, "complete");
});

test("insertions before the anchor are overlapped and cannot shift out the next ID", () => {
  const initial = decideAnchoredInstancePage(0, ["a", "b"], null, "z", 2);
  const shifted = decideAnchoredInstancePage(1, ["aa", "b"], "b", "z", 2);
  assert.equal(shifted.action, "accept");
  assert.deepEqual(shifted.acceptedIds, []);
  assert.equal(shifted.nextOffset, 2);
  const next = decideAnchoredInstancePage(2, ["b", "c"], "b", "z", 2);
  assert.deepEqual(next.acceptedIds, ["c"]);
  assert.ok(next.nextOffset > initial.nextOffset);
});

test("empty overshoot backs up and tail deletion ends on a verified short page", () => {
  const empty = decideAnchoredInstancePage(8, [], "d", "z", 2);
  assert.equal(empty.action, "retry");
  assert.equal(empty.nextOffset, 6);
  const overlap = decideAnchoredInstancePage(6, ["d", "e"], "d", "z", 2);
  assert.equal(overlap.nextOffset, 7);
  const tail = decideAnchoredInstancePage(7, ["e"], "e", "z", 2);
  assert.deepEqual(tail.acceptedIds, []);
  assert.equal(tail.action, "complete");
});

test("a finite upper ID completes despite IDs arriving beyond the bound", () => {
  const first = decideAnchoredInstancePage(0, ["a", "b"], null, "d", 2);
  const second = decideAnchoredInstancePage(first.nextOffset, ["b", "c"], "b", "d", 2);
  const finish = decideAnchoredInstancePage(second.nextOffset, ["c", "d"], "c", "d", 2);
  assert.equal(finish.action, "complete");
  assert.deepEqual(finish.acceptedIds, ["d"]);
});

test("non-ordered or duplicate Orthanc pages are rejected", () => {
  assert.throws(
    () => decideAnchoredInstancePage(0, ["b", "a"], null, "z", 2),
    /strictly increasing/,
  );
  assert.throws(
    () => decideAnchoredInstancePage(0, ["a", "a"], null, "z", 2),
    /strictly increasing/,
  );
});
