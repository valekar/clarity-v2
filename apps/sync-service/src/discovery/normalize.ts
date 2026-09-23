import type { InstanceObservation, StudyObservation } from "./model.js";

export function normalizeDicomUid(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a DICOM UID string`);
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 64 ||
    !/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*$/.test(normalized)
  ) {
    throw new Error(`${label} is not a valid normalized DICOM UID`);
  }
  return normalized;
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 2048) {
    throw new Error(`${label} must be a string no longer than 2048 characters`);
  }
  const normalized = value.trim();
  return normalized.length ? normalized : null;
}

export function normalizeStudyObservation(
  orthancStudyId: string,
  value: unknown,
): StudyObservation {
  const response = jsonObject(value, "Orthanc study");
  const tags = jsonObject(response.MainDicomTags, "Orthanc study MainDicomTags");
  const patientTags =
    response.PatientMainDicomTags === undefined
      ? {}
      : jsonObject(response.PatientMainDicomTags, "Orthanc study PatientMainDicomTags");
  const studyInstanceUid = normalizeDicomUid(tags.StudyInstanceUID, "StudyInstanceUID");
  return {
    orthancStudyId,
    studyInstanceUid,
    patientId: optionalString(patientTags.PatientID, "PatientID"),
    patientIssuerOfPatientId: optionalString(patientTags.IssuerOfPatientID, "IssuerOfPatientID"),
    patientName: optionalString(patientTags.PatientName, "PatientName"),
    patientBirthDate: optionalString(patientTags.PatientBirthDate, "PatientBirthDate"),
    patientSex: optionalString(patientTags.PatientSex, "PatientSex"),
    studyDate: optionalString(tags.StudyDate, "StudyDate"),
    studyTime: optionalString(tags.StudyTime, "StudyTime"),
    studyDescription: optionalString(tags.StudyDescription, "StudyDescription"),
    accessionNumber: optionalString(tags.AccessionNumber, "AccessionNumber"),
    modalities: optionalString(tags.ModalitiesInStudy, "ModalitiesInStudy"),
  };
}

export function normalizeInstanceObservation(
  source: { orthancInstanceId: string; orthancStudyId: string },
  study: StudyObservation,
  seriesInstanceUid: unknown,
  value: unknown,
): InstanceObservation {
  const response = jsonObject(value, "Orthanc instance");
  const tags = jsonObject(response.MainDicomTags, "Orthanc instance MainDicomTags");
  const normalizedSeriesUid =
    seriesInstanceUid === undefined || seriesInstanceUid === null
      ? null
      : normalizeDicomUid(seriesInstanceUid, "SeriesInstanceUID");
  return {
    orthancInstanceId: source.orthancInstanceId,
    orthancStudyId: source.orthancStudyId,
    studyInstanceUid: study.studyInstanceUid,
    seriesInstanceUid: normalizedSeriesUid,
    sopInstanceUid: normalizeDicomUid(tags.SOPInstanceUID, "SOPInstanceUID"),
  };
}
