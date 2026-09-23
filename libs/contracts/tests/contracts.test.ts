import assert from "node:assert/strict";
import test from "node:test";
import {
  isDeviceLeaseResponse,
  isStudyAdmissionRequest,
  isStudyAdmissionResponse,
  isUploadAdmissionResponse,
  isUploadStatusResponse,
  isManifestBeginRequest,
  isManifestBeginResponse,
  isManifestPageRequest,
  isManifestSealRequest,
  isManifestSealResponse,
} from "../src/index.ts";

test("lease and study contracts validate bounded cloud DTOs", () => {
  assert.equal(
    isDeviceLeaseResponse({
      sourceGeneration: 1,
      fencingToken: "12",
      leaseExpiresAt: "2026-09-23T12:00:00.000Z",
    }),
    true,
  );
  const study = {
    admissionKey: "123e4567-e89b-42d3-a456-426614174000",
    sourceGeneration: 1,
    fencingToken: "12",
    studyInstanceUid: "1.2.3",
    orthancStudyId: "source-study-locator",
    patientId: "patient-7",
    patientIssuerOfPatientId: "hospital-a",
    patientName: "Synthetic^Patient",
  };
  assert.equal(isStudyAdmissionRequest(study), true);
  assert.equal(
    isStudyAdmissionRequest({ ...study, patientIssuerOfPatientId: "x".repeat(65) }),
    false,
  );
  assert.equal(
    isStudyAdmissionResponse({
      reportId: "123e4567-e89b-42d3-a456-426614174000",
      studyInstanceUid: "1.2.3",
      version: 1,
      currentManifestRevision: null,
      currentManifestDigest: null,
      currentManifestGeneration: null,
    }),
    true,
  );
  assert.equal(
    isStudyAdmissionResponse({
      reportId: "123e4567-e89b-42d3-a456-426614174000",
      studyInstanceUid: "1.2.3",
      version: 2,
      currentManifestRevision: 3,
      currentManifestDigest: "a".repeat(64),
      currentManifestGeneration: 1,
    }),
    true,
  );
  assert.equal(
    isStudyAdmissionResponse({
      reportId: "123e4567-e89b-42d3-a456-426614174000",
      studyInstanceUid: "1.2.3",
      version: 2,
      currentManifestRevision: 3,
      currentManifestDigest: null,
      currentManifestGeneration: 1,
    }),
    false,
  );
  assert.equal(
    isUploadAdmissionResponse({
      uploadId: "123e4567-e89b-42d3-a456-426614174000",
      status: "received",
    }),
    true,
  );
  assert.equal(
    isUploadAdmissionResponse({
      uploadId: "123e4567-e89b-42d3-a456-426614174000",
      expiresAt: "2026-09-23T12:00:00.000Z",
      mode: "put",
      put: {
        url: "https://objects.example.invalid/file",
        headers: { "content-type": "application/dicom" },
      },
    }),
    true,
  );
  assert.equal(
    isUploadAdmissionResponse({
      uploadId: "123e4567-e89b-42d3-a456-426614174000",
      status: "uploading",
    }),
    false,
  );
  assert.equal(isUploadStatusResponse({ status: "completed" }), true);
});

test("manifest contracts bound attempts, revisions, pages, and digests", () => {
  const begin = {
    sourceGeneration: 1,
    fencingToken: "12",
    inventoryAttemptId: "123e4567-e89b-42d3-a456-426614174000",
    expectedCurrentRevision: null,
    expectedReportVersion: 2,
  };
  assert.equal(isManifestBeginRequest(begin), true);
  assert.equal(isManifestBeginResponse({ revision: 1 }), true);
  assert.equal(isManifestBeginResponse({ revision: 0 }), false);
  assert.equal(
    isManifestPageRequest({
      ...begin,
      revision: 1,
      members: [{ sopInstanceUid: "1.2.3", sha256: "a".repeat(64) }],
    }),
    true,
  );
  assert.equal(
    isManifestPageRequest({
      ...begin,
      revision: 1,
      members: Array.from({ length: 501 }, (_, index) => ({
        sopInstanceUid: `1.2.${index + 1}`,
        sha256: "a".repeat(64),
      })),
    }),
    false,
  );
  assert.equal(
    isManifestSealRequest({
      ...begin,
      revision: 1,
      sourceObservedAt: "2026-09-23T12:00:00.000Z",
      sourceStable: true,
      inventoryComplete: true,
      observedManifestDigest: "b".repeat(64),
    }),
    true,
  );
  assert.equal(isManifestSealResponse({ sealed: false }), true);
});
