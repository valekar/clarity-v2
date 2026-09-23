"use client";

import { useState } from "react";
import { ClarityBrand } from "@clarity/ui";

const navigation = ["Studies", "Doctors", "Settings"] as const;
type Section = (typeof navigation)[number];

const sampleDoctors = [
  {
    id: "sample-one",
    name: "Dr. Sample One",
    specialty: "Sample specialty",
    email: "doctor.one@example.invalid",
    mobile: "+91 90000 00001",
  },
  {
    id: "sample-two",
    name: "Dr. Sample Two",
    specialty: "Sample specialty",
    email: "doctor.two@example.invalid",
    mobile: "+91 90000 00002",
  },
] as const;

export default function HomePage() {
  const [section, setSection] = useState<Section>("Studies");
  const [patientMobile, setPatientMobile] = useState("");
  const [doctorId, setDoctorId] = useState("");

  const selectedDoctor = sampleDoctors.find((doctor) => doctor.id === doctorId);
  const invalidMobile = patientMobile.length > 0 && !/^\+?[\d\s()-]{7,20}$/.test(patientMobile);

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Workspace">
        <div className="brand-lockup">
          <ClarityBrand />
          <span className="workspace-label">STAFF WORKSPACE</span>
        </div>
        <nav className="primary-nav" aria-label="Main navigation">
          {navigation.map((item, index) => (
            <button
              aria-current={section === item ? "page" : undefined}
              className={`nav-item${section === item ? " nav-item-active" : ""}`}
              key={item}
              onClick={() => setSection(item)}
              type="button"
            >
              <span className="nav-index">0{index + 1}</span>
              {item}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="status-dot" aria-hidden="true" />
          <span>Setup incomplete</span>
        </div>
      </aside>

      <div className="main-column">
        <header className="topbar">
          <p>
            Clarity Diagnostics <span>/</span> {section}
          </p>
          <span className="stage-badge">INACTIVE PREVIEW</span>
        </header>

        <div className="content-wrap">
          <section className="page-heading" aria-labelledby="page-title">
            <div>
              <p className="eyebrow">STAFF WORKSPACE</p>
              <h1 id="page-title">{section}</h1>
              <p className="page-description">
                A preview of the staff workflow. Sign-in and centre data are not connected.
              </p>
            </div>
            <span className="connection-chip">
              <span className="status-dot" aria-hidden="true" /> Not connected
            </span>
          </section>

          {section === "Studies" && (
            <div className="dashboard-grid">
              <section className="panel studies-panel" aria-labelledby="studies-title">
                <div className="panel-heading">
                  <div>
                    <p className="eyebrow">WORK QUEUE</p>
                    <h2 id="studies-title">Recent studies</h2>
                  </div>
                  <span className="count-pill">0 studies</span>
                </div>
                <div className="empty-state">
                  <span className="empty-mark" aria-hidden="true">
                    —
                  </span>
                  <h3>No studies available</h3>
                  <p>Studies will appear here after a centre connection is configured.</p>
                  <span className="quiet-label">STUDY INTAKE UNAVAILABLE</span>
                </div>
              </section>

              <section className="panel share-panel" aria-labelledby="share-title">
                <div className="panel-heading share-heading">
                  <div>
                    <p className="eyebrow">SHARING PREVIEW</p>
                    <h2 id="share-title">Prepare a share</h2>
                  </div>
                  <span className="lock-mark" aria-label="Sending unavailable">
                    ⊘
                  </span>
                </div>
                <p className="form-intro">
                  Enter contact details to preview the form. No study is selected.
                </p>

                <form onSubmit={(event) => event.preventDefault()}>
                  <div className="field-group">
                    <label htmlFor="patient-mobile">Patient mobile</label>
                    <input
                      autoComplete="tel"
                      aria-describedby={invalidMobile ? "mobile-hint mobile-error" : "mobile-hint"}
                      aria-invalid={invalidMobile}
                      id="patient-mobile"
                      inputMode="tel"
                      maxLength={20}
                      onChange={(event) => setPatientMobile(event.target.value)}
                      placeholder="Enter mobile number"
                      type="tel"
                      value={patientMobile}
                    />
                    <span className="field-hint" id="mobile-hint">
                      Include country code when known.
                    </span>
                    {invalidMobile && (
                      <span className="field-error" id="mobile-error">
                        Enter a valid mobile number.
                      </span>
                    )}
                  </div>

                  <div className="field-group">
                    <label htmlFor="doctor-select">Referring doctor</label>
                    <select
                      id="doctor-select"
                      onChange={(event) => setDoctorId(event.target.value)}
                      value={doctorId}
                    >
                      <option value="">Select a doctor</option>
                      {sampleDoctors.map((doctor) => (
                        <option key={doctor.id} value={doctor.id}>
                          {doctor.name} · {doctor.specialty}
                        </option>
                      ))}
                    </select>
                    <span className="field-hint">Sample entries demonstrate doctor selection.</span>
                  </div>

                  <div className="autofill-box" aria-live="polite">
                    <div className="autofill-title">
                      <span>Doctor contact</span>
                      <span>{selectedDoctor ? "AUTO-FILLED" : "SELECT A DOCTOR"}</span>
                    </div>
                    <div className="autofill-row">
                      <span>Email</span>
                      <span>{selectedDoctor?.email ?? "—"}</span>
                    </div>
                    <div className="autofill-row">
                      <span>Mobile</span>
                      <span>{selectedDoctor?.mobile ?? "—"}</span>
                    </div>
                  </div>

                  <button
                    aria-describedby="send-unavailable"
                    className="send-button"
                    disabled
                    type="button"
                  >
                    Generate and send <span aria-hidden="true">↗</span>
                  </button>
                  <p className="unavailable-note" id="send-unavailable">
                    Sending is unavailable until sign-in, study data and delivery are configured.
                  </p>
                </form>
              </section>
            </div>
          )}

          {section === "Doctors" && (
            <section className="panel directory-panel" aria-labelledby="doctors-title">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">CONTACT DIRECTORY</p>
                  <h2 id="doctors-title">Doctors</h2>
                </div>
                <button className="secondary-button" disabled type="button">
                  Add doctor
                </button>
              </div>
              <div className="directory-empty">
                <h3>Doctor directory unavailable</h3>
                <p>
                  Doctor records will be managed here when staff access and centre data are
                  connected.
                </p>
                <span className="quiet-label">NO DIRECTORY DATA LOADED</span>
              </div>
            </section>
          )}

          {section === "Settings" && (
            <section className="panel settings-panel" aria-labelledby="settings-title">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">WORKSPACE</p>
                  <h2 id="settings-title">Settings</h2>
                </div>
              </div>
              <div className="settings-row">
                <div>
                  <h3>Staff access</h3>
                  <p>Staff sign-in and permissions have not been configured.</p>
                </div>
                <span className="state-label">UNAVAILABLE</span>
              </div>
              <div className="settings-row">
                <div>
                  <h3>Centre connection</h3>
                  <p>Study intake and connection status are not available in this preview.</p>
                </div>
                <span className="state-label">NOT CONNECTED</span>
              </div>
            </section>
          )}

          <footer className="page-footer">
            Clarity V2 <span>·</span> Foundation scaffold <span>·</span> No clinical data connected
          </footer>
        </div>
      </div>
    </main>
  );
}
