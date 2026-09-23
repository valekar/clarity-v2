import Link from "next/link";
import styles from "./study-dashboard.module.css";

type StaffSection = "studies" | "doctors" | "settings";

export function StaffNavigation({ current }: { current?: StaffSection }) {
  return (
    <nav className={styles.nav} aria-label="Staff sections">
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
