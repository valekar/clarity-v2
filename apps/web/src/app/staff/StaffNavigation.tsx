import Link from "next/link";
import "./staff-navigation.css";

type StaffSection = "studies" | "doctors" | "settings";

export function StaffNavigation({ current }: { current?: StaffSection }) {
  return (
    <nav className="staff-side-navigation" aria-label="Staff sections">
      <span className="staff-side-navigation-title">CLARITY V2</span>
      <Link href="/staff" aria-current={current === "studies" ? "page" : undefined}>
        Studies
      </Link>
      <Link href="/staff/doctors" aria-current={current === "doctors" ? "page" : undefined}>
        Doctors
      </Link>
      <Link href="/staff/settings" aria-current={current === "settings" ? "page" : undefined}>
        Settings
      </Link>
    </nav>
  );
}
