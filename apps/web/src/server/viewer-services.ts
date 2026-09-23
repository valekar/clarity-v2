import "server-only";
import {
  createScopedDicomwebGateway,
  createScopedOhifProxy,
} from "@clarity/server/viewer/scoped-dicomweb";
import { getStaffServices } from "./staff-services";

let dicomweb: ReturnType<typeof createScopedDicomwebGateway> | undefined;
let ohif: ReturnType<typeof createScopedOhifProxy> | undefined;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing server configuration: ${name}`);
  return value;
}

export function getScopedDicomwebGateway() {
  if (dicomweb) return dicomweb;
  dicomweb = createScopedDicomwebGateway({
    orthancDicomwebUrl: requiredEnvironment("CLOUD_ORTHANC_DICOMWEB_URL"),
    username: requiredEnvironment("CLOUD_ORTHANC_USERNAME"),
    password: requiredEnvironment("CLOUD_ORTHANC_PASSWORD"),
    staff: getStaffServices().guard,
    studies: getStaffServices().studyRepository,
  });
  return dicomweb;
}

export function getScopedOhifProxy() {
  if (ohif) return ohif;
  ohif = createScopedOhifProxy({
    orthancOrigin: requiredEnvironment("CLOUD_ORTHANC_URL"),
    username: requiredEnvironment("CLOUD_ORTHANC_USERNAME"),
    password: requiredEnvironment("CLOUD_ORTHANC_PASSWORD"),
    staff: getStaffServices().guard,
    studies: getStaffServices().studyRepository,
  });
  return ohif;
}
