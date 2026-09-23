import { ClarityBrand } from "@clarity/ui";

const plannedCapabilities = [
  {
    name: "Study intake",
    description: "The local Orthanc connector will add studies automatically.",
  },
  {
    name: "Staff access",
    description: "Hanko sign-in and centre permissions are the next implementation step.",
  },
  {
    name: "Image viewing",
    description: "Verified cloud studies will open in the scoped viewer.",
  },
] as const;

export default function HomePage() {
  return (
    <main className="page-shell">
      <div className="workspace">
        <header className="site-header">
          <ClarityBrand />
          <span className="stage-badge">Foundation scaffold</span>
        </header>
        <section className="welcome" aria-labelledby="page-title">
          <p className="eyebrow">Clarity ScanLink V2</p>
          <h1 id="page-title">Staff workspace</h1>
          <p>
            The application structure is ready. Clinical records, staff sign-in and imaging
            connections have not been configured yet.
          </p>
        </section>
        <section aria-labelledby="capabilities-title">
          <h2 id="capabilities-title">Planned workflow</h2>
          <div className="capability-grid">
            {plannedCapabilities.map((capability) => (
              <article className="capability-card" key={capability.name}>
                <h3>{capability.name}</h3>
                <p>{capability.description}</p>
                <span>Pending integration</span>
              </article>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
