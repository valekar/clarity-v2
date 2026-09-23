import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { LogoutButton } from "../../sign-in/LogoutButton";
import { getStaffServices } from "../../../server/staff-services";
import { StaffAccessPanel } from "./StaffAccessPanel";
import { StaffNavigation } from "../StaffNavigation";

export const dynamic = "force-dynamic";

export default async function StaffSettingsPage() {
  let access;
  try {
    access = await getStaffServices().guard.requireStaffAdmin((await headers()).get("cookie"));
  } catch {
    return (
      <main className="auth-shell">
        <h1>Staff access is unavailable</h1>
      </main>
    );
  }
  if (!access.ok && access.status === 401) redirect("/sign-in");
  if (!access.ok && access.status === 403) redirect("/no-access");
  if (!access.ok)
    return (
      <main className="auth-shell">
        <h1>Staff access is unavailable</h1>
      </main>
    );

  return (
    <main className="settings-shell">
      <header className="settings-header">
        <div>
          <a className="auth-back-inline" href="/staff">
            Staff workspace
          </a>
          <h1>Settings</h1>
        </div>
        <LogoutButton />
      </header>
      <StaffNavigation current="settings" />
      <StaffAccessPanel />
      <p className="page-footer">
        Access changes take effect on the next request. Disabling the last administrator is
        rejected.
      </p>
    </main>
  );
}
