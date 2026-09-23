export interface StudyObservation {
  orthancStudyId: string;
  studyInstanceUid: string;
  patientId: string | null;
  patientIssuerOfPatientId: string | null;
  patientName: string | null;
  patientBirthDate: string | null;
  patientSex: string | null;
  studyDate: string | null;
  studyTime: string | null;
  studyDescription: string | null;
  accessionNumber: string | null;
  modalities: string | null;
}

export interface InstanceObservation {
  orthancInstanceId: string;
  orthancStudyId: string;
  studyInstanceUid: string;
  seriesInstanceUid: string | null;
  sopInstanceUid: string;
}

export interface InventoryRun {
  id: string;
  sourceKey: string;
  kind: "initial" | "periodic";
  generation: number;
  cursorAtStart: number;
  feedHorizon: number | null;
  feedDoneAtHorizon: boolean | null;
  status:
    "scanning-studies" | "scanning-instances" | "revalidating" | "awaiting-replay" | "complete";
  nextStudyOffset: number;
  nextInstanceOffset: number;
  lastInstanceId: string | null;
  upperInstanceId: string | null;
  upperBoundCaptured: boolean;
  revalidationAfterSopUid: string | null;
  revalidationUpperSopUid: string | null;
  reconcileJobId: number | null;
  completedAt: string | null;
}

export interface LogicalReport {
  sourceKey: string;
  studyInstanceUid: string;
  orthancStudyId: string;
  patientId: string | null;
  patientIssuerOfPatientId: string | null;
  patientName: string | null;
  patientBirthDate: string | null;
  patientSex: string | null;
  studyDate: string | null;
  studyTime: string | null;
  studyDescription: string | null;
  accessionNumber: string | null;
  modalities: string | null;
  sourceMissing: boolean;
}

export interface DiscoveredInstance extends InstanceObservation {
  sourceKey: string;
  sourceMissing: boolean;
}

export interface InstanceStudyPair {
  study: StudyObservation;
  instance: InstanceObservation;
}
