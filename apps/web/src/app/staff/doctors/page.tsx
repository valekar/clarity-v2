import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getStaffServices } from "../../../server/staff-services";
import { LogoutButton } from "../../sign-in/LogoutButton";
import { StaffNavigation } from "../StaffNavigation";
import { DoctorsDirectory } from "./DoctorsDirectory";
import styles from "../StaffTools.module.css";

export const dynamic = "force-dynamic";

export default async function DoctorsPage() {
  let access;
  try {
    access = await getStaffServices().guard.requireStaffRead((await headers()).get("cookie"));
  } catch {
    return (
      <main className={styles.workspace}>
        <h1>Doctors are unavailable</h1>
        <p>Staff services could not be reached.</p>
      </main>
    );
  }
  if (!access.ok && access.status === 401) redirect("/sign-in");
  if (!access.ok && access.status === 403) redirect("/no-access");
  if (!access.ok)
    return (
      <main className={styles.workspace}>
        <h1>Doctors are unavailable</h1>
        <p>Try again when staff services are available.</p>
      </main>
    );

  return (
    <main className={styles.workspace}>
      <header className={styles.header}>
        <div>
          <p className="eyebrow">CLARITY STAFF</p>
          <h1>Doctors</h1>
        </div>
        <LogoutButton />
      </header>
      <StaffNavigation current="doctors" />
      <DoctorsDirectory />
    </main>
  );
}
