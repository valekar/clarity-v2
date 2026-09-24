import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getStaffServices } from "../../server/staff-services";
import { LogoutButton } from "../sign-in/LogoutButton";
import { SourceHealthPanel } from "./SourceHealthPanel";
import { StaffNavigation } from "./StaffNavigation";
import styles from "./study-dashboard.module.css";

export const dynamic = "force-dynamic";

type PageParameters = Promise<{ q?: string; cursor?: string }>;

function stateLabel(state: string, canView: boolean): string {
  switch (state) {
    case "ready":
      return canView ? "Ready" : "Verifying";
    case "syncing":
      return "Syncing";
    case "processing":
      return "Processing";
    case "needs_attention":
      return "Needs attention";
    default:
      return "Discovered";
  }
}

export default async function StaffHomePage({ searchParams }: { searchParams: PageParameters }) {
  let access;
  try {
    access = await getStaffServices().guard.requireStaffRead((await headers()).get("cookie"));
  } catch {
    return (
      <main className="auth-shell">
        <section aria-labelledby="unavailable-title">
          <h1 id="unavailable-title">Studies are unavailable</h1>
          <p className="page-description">The sign-in or study service could not be reached.</p>
          <Link className="auth-link" href="/staff">
            Try again
          </Link>
        </section>
      </main>
    );
  }
  if (!access.ok && access.status === 401) redirect("/sign-in");
  if (!access.ok && access.status === 403) redirect("/no-access");
  if (!access.ok) {
    return (
      <main className="auth-shell">
        <section aria-labelledby="unavailable-title">
          <h1 id="unavailable-title">Studies are unavailable</h1>
          <p className="page-description">The sign-in or study service could not be reached.</p>
        </section>
      </main>
    );
  }

  const params = await searchParams;
  const query = params.q?.trim() ?? "";
  let page;
  try {
    page = await getStaffServices().studyRepository.list({
      staffUserId: access.principal.staffUserId,
      search: query,
      ...(params.cursor ? { cursor: params.cursor } : {}),
      limit: 25,
    });
  } catch {
    return (
      <main className={styles.workspace}>
        <header className={styles.header}>
          <div>
            <p className="eyebrow">STAFF WORKSPACE</p>
            <h1>Studies</h1>
          </div>
          <LogoutButton />
        </header>
        <section className={styles.empty} aria-labelledby="study-error-title">
          <h2 id="study-error-title">Study list is temporarily unavailable</h2>
          <p className={styles.muted}>Your session is active. Try loading the list again.</p>
          <Link className={styles.retry} href="/staff">
            Try again
          </Link>
        </section>
      </main>
    );
  }

  const nextHref = page.nextCursor
    ? `/staff?${new URLSearchParams({ ...(query ? { q: query } : {}), cursor: page.nextCursor })}`
    : null;
  return (
    <main className={styles.workspace}>
      <header className={styles.header}>
        <div>
          <p className="eyebrow">CLARITY STAFF</p>
          <h1>Studies</h1>
        </div>
        <LogoutButton />
      </header>
      <StaffNavigation current="studies" />
      <SourceHealthPanel />
      <section className={styles.heading} aria-labelledby="queue-title">
        <h2 id="queue-title">Study queue</h2>
        <p className={styles.muted}>
          Search automatically admitted studies and open verified cloud images.
        </p>
      </section>
      <div className={styles.toolbar}>
        <form className={styles.search} action="/staff" method="get">
          <label htmlFor="study-search">
            Search by patient, study or accession
            <input id="study-search" name="q" maxLength={120} defaultValue={query} />
          </label>
          <button type="submit">Search</button>
        </form>
        <span className={styles.muted}>{page.items.length} studies on this page</span>
        <Link href="/staff/sharing" className={styles.retry}>
          Open sharing preview
        </Link>
      </div>
      <section className={styles.panel} aria-label="Studies">
        {page.items.length === 0 ? (
          <div className={styles.empty}>
            <h2>{query ? "No matching studies" : "No studies yet"}</h2>
            <p className={styles.muted}>
              {query
                ? "Try another patient, study or accession search."
                : "Studies appear after an authorized centre sends its inventory."}
            </p>
          </div>
        ) : (
          page.items.map((study) => (
            <article className={styles.studyRow} key={study.reportId}>
              <div className={styles.studyMain}>
                <h2>{study.patientName || "Patient name unavailable"}</h2>
                <div className={styles.studyMeta}>
                  <span>{study.studyDescription || "Study description unavailable"}</span>
                  {study.studyDate && <time dateTime={study.studyDate}>{study.studyDate}</time>}
                  {study.modalities.length > 0 && <span>{study.modalities.join(" · ")}</span>}
                  {study.accessionNumber && <span>Accession {study.accessionNumber}</span>}
                  <span>
                    {study.indexedCount} of {study.memberCount} images verified
                  </span>
                  {study.sourceStatus === "disabled" && (
                    <span>Source unavailable; cloud copy status shown</span>
                  )}
                </div>
              </div>
              <span
                className={`${styles.status} ${study.status === "ready" && study.canView ? styles.ready : study.status === "needs_attention" ? styles.needsAttention : ""}`}
              >
                {study.canView ? "Ready" : stateLabel(study.status, study.canView)}
              </span>
              {study.canView ? (
                <Link href={`/staff/studies/${study.reportId}`}>Open study</Link>
              ) : (
                <span className={styles.muted}>Viewer unavailable</span>
              )}
            </article>
          ))
        )}
      </section>
      <div className={styles.pagination}>
        {nextHref && (
          <Link href={nextHref} rel="next">
            Next page
          </Link>
        )}
      </div>
    </main>
  );
}
