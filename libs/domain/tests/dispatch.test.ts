import assert from "node:assert/strict";
import test from "node:test";
import { decideDispatch } from "../src/dispatch.ts";

const doctor = {
  id: "20000000-0000-4000-8000-000000000001",
  displayName: "Synthetic doctor",
  normalizedName: "synthetic doctor",
  phoneE164: "+919876543210",
  active: true,
  version: 3,
} as const;
const facts = {
  reportState: "ready",
  reportVersion: 9,
  manifestRevision: 2,
  selectedDoctor: doctor,
} as const;
const request = {
  expectedReportVersion: 9,
  expectedManifestRevision: 2,
  patientPhoneE164: "+919876543211",
  doctorId: doctor.id,
  expectedDoctorVersion: 3,
  sendToPatient: true,
  sendToDoctor: true,
} as const;

test("dispatch requires a current Ready package and exact selected contacts", () => {
  assert.deepEqual(decideDispatch(facts, request), {
    allowed: true,
    recipients: ["patient", "doctor"],
  });
  assert.equal(decideDispatch({ ...facts, reportState: "syncing" }, request).allowed, false);
  assert.deepEqual(decideDispatch({ ...facts, manifestRevision: 3 }, request), {
    allowed: false,
    reason: "manifest_changed",
  });
  assert.deepEqual(decideDispatch(facts, { ...request, patientPhoneE164: null }), {
    allowed: false,
    reason: "patient_phone_required",
  });
  assert.deepEqual(decideDispatch(facts, { ...request, expectedDoctorVersion: 2 }), {
    allowed: false,
    reason: "doctor_changed",
  });
  assert.deepEqual(
    decideDispatch(facts, { ...request, sendToPatient: false, sendToDoctor: false }),
    {
      allowed: false,
      reason: "recipient_required",
    },
  );
});
