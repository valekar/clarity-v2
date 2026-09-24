import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getStaffServices } from "../../../../server/staff-services";
import { LogoutButton } from "../../../sign-in/LogoutButton";
import { StaffNavigation } from "../../StaffNavigation";
import styles from "../../study-dashboard.module.css";
import { StudyViewerFrame } from "../StudyViewerFrame";
import { ViewerCompatibilityNotice } from "../ViewerCompatibilityNotice";

export const dynamic = "force-dynamic";

export default async function StudyViewerPage({
  params,
}: {
  params: Promise<{ reportId: string }>;
}) {
  let access;
  try {
    access = await getStaffServices().guard.requireStaffRead((await headers()).get("cookie"));
  } catch {
    return (
      <main className={styles.workspace}>
        <h1>Viewer unavailable</h1>
        <p>The sign-in or Report service could not be reached.</p>
      </main>
    );
  }
  if (!access.ok && access.status === 401) redirect("/sign-in");
  if (!access.ok && access.status === 403) redirect("/no-access");
  if (!access.ok) {
    return (
      <main className={styles.workspace}>
        <h1>Viewer unavailable</h1>
        <p>Try again when staff access is available.</p>
      </main>
    );
  }

  const { reportId } = await params;
  let study;
  try {
    study = await getStaffServices().studyRepository.findViewableReport(
      access.principal.staffUserId,
      reportId,
    );
  } catch {
    return (
      <main className={styles.workspace}>
        <h1>Viewer unavailable</h1>
        <p>Study access could not be checked.</p>
      </main>
    );
  }
  if (!study) {
    return (
      <main className={styles.workspace}>
        <header className={styles.header}>
          <h1>Study is not ready to view</h1>
          <LogoutButton />
        </header>
        <p className={styles.muted}>
          The Report may still be syncing, or its verified cloud files are unavailable.
        </p>
        <Link href="/staff">Return to studies</Link>
      </main>
    );
  }

  const viewerUrl = `/ohif/viewer?StudyInstanceUIDs=${encodeURIComponent(study.studyInstanceUid)}`;
  return (
    <main className={styles.workspace}>
      <header className={styles.header}>
        <div>
          <p className="eyebrow">VERIFIED CLOUD STUDY</p>
          <h1>{study.patientName || "Patient"}</h1>
          <p className={styles.muted}>
            {[study.studyDescription, study.studyDate, study.modalities.join(" · ")]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div>
          <Link href="/staff">Back to studies</Link>
          <LogoutButton />
        </div>
      </header>
      <StaffNavigation current="studies" />
      <p className={styles.muted}>The viewer reads the verified cloud copy.</p>
      <ViewerCompatibilityNotice studyUid={study.studyInstanceUid} />
      <StudyViewerFrame src={viewerUrl} />
    </main>
  );
}
