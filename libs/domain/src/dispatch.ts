import { validPhoneE164, type DoctorRecord } from "@clarity/domain/doctors";

export type DispatchRequest = Readonly<{
  expectedReportVersion: number;
  expectedManifestRevision: number;
  patientPhoneE164: string | null;
  doctorId: string | null;
  expectedDoctorVersion: number | null;
  sendToPatient: boolean;
  sendToDoctor: boolean;
}>;

export type DispatchFacts = Readonly<{
  reportState: "discovered" | "syncing" | "processing" | "ready" | "needs_attention";
  reportVersion: number;
  manifestRevision: number | null;
  selectedDoctor: DoctorRecord | null;
}>;

export type DispatchDecision =
  | Readonly<{ allowed: true; recipients: readonly ("patient" | "doctor")[] }>
  | Readonly<{
      allowed: false;
      reason:
        | "report_not_ready"
        | "report_changed"
        | "manifest_changed"
        | "recipient_required"
        | "patient_phone_required"
        | "doctor_required"
        | "doctor_changed";
    }>;

export function decideDispatch(facts: DispatchFacts, request: DispatchRequest): DispatchDecision {
  if (facts.reportState !== "ready") return { allowed: false, reason: "report_not_ready" };
  if (facts.reportVersion !== request.expectedReportVersion)
    return { allowed: false, reason: "report_changed" };
  if (
    facts.manifestRevision === null ||
    facts.manifestRevision !== request.expectedManifestRevision
  )
    return { allowed: false, reason: "manifest_changed" };
  if (!request.sendToPatient && !request.sendToDoctor)
    return { allowed: false, reason: "recipient_required" };
  if (
    request.sendToPatient &&
    (request.patientPhoneE164 === null || !validPhoneE164(request.patientPhoneE164))
  )
    return { allowed: false, reason: "patient_phone_required" };
  if (request.sendToDoctor) {
    if (
      request.doctorId === null ||
      facts.selectedDoctor === null ||
      facts.selectedDoctor.id !== request.doctorId ||
      !facts.selectedDoctor.active
    )
      return { allowed: false, reason: "doctor_required" };
    if (facts.selectedDoctor.version !== request.expectedDoctorVersion)
      return { allowed: false, reason: "doctor_changed" };
  }
  return {
    allowed: true,
    recipients: Object.freeze([
      ...(request.sendToPatient ? ["patient" as const] : []),
      ...(request.sendToDoctor ? ["doctor" as const] : []),
    ]),
  };
}
