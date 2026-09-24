import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectViewerCompatibility,
  tagString,
  viewerCompatibilityMessage,
} from "../src/app/staff/studies/viewer-compatibility.ts";

test("classifies synthetic MR as unverified and gives an explicit verification fallback", () => {
  const result = inspectViewerCompatibility([
    {
      modality: "MR",
      sopClassUid: "1.2.840.10008.5.1.4.1.1.4",
      transferSyntaxUid: "1.2.840.10008.1.2.1",
    },
  ]);
  assert.equal(result.hasMr, true);
  assert.match(viewerCompatibilityMessage(result)[0] ?? "", /MR rendering has not been verified/);
});

test("classifies synthetic structured reports as non-image objects, not blank images", () => {
  const result = inspectViewerCompatibility([
    {
      modality: "SR",
      sopClassUid: "1.2.840.10008.5.1.4.1.1.88.33",
      transferSyntaxUid: "1.2.840.10008.1.2.1",
    },
  ]);
  assert.equal(result.nonImageCount, 1);
  assert.match(viewerCompatibilityMessage(result)[0] ?? "", /will not appear as image slices/);
  assert.match(
    viewerCompatibilityMessage(result)[0] ?? "",
    /Do not treat an empty viewport as a negative finding/,
  );
});

test("treats non-native and absent transfer syntax as unverified instead of claiming decode support", () => {
  const result = inspectViewerCompatibility([
    {
      modality: "CT",
      sopClassUid: "1.2.840.10008.5.1.4.1.1.2",
      transferSyntaxUid: "1.2.840.10008.1.2.4.80",
    },
    { modality: "CT", sopClassUid: "1.2.840.10008.5.1.4.1.1.2", transferSyntaxUid: null },
  ]);
  assert.equal(result.alternativeTransferSyntaxCount, 1);
  assert.equal(result.unknownTransferSyntaxCount, 1);
  assert.match(
    viewerCompatibilityMessage(result).join(" "),
    /Browser codec support is not verified/,
  );
  assert.match(
    viewerCompatibilityMessage(result).join(" "),
    /Transfer syntax could not be confirmed/,
  );
});

test("reads only a valid string value from DICOM JSON", () => {
  assert.equal(tagString({ "00080060": { Value: ["MR"] } }, "00080060"), "MR");
  assert.equal(tagString({ "00080060": { Value: [3] } }, "00080060"), null);
});

test("marks an empty or bounded inspection as incomplete with a safe fallback", () => {
  const result = inspectViewerCompatibility([], false, true);
  assert.equal(result.incomplete, true);
  assert.match(
    viewerCompatibilityMessage(result).join(" "),
    /Do not treat a blank viewport as a negative finding/,
  );
});
