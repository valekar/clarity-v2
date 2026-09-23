"use client";

import { useEffect, useMemo, useState } from "react";
import styles from "../StaffTools.module.css";

type Doctor = Readonly<{
  id: string;
  displayName: string;
  normalizedName: string;
  phoneE164: string;
  active: boolean;
  version: number;
}>;
type DoctorSearch = Readonly<{ doctors: readonly Doctor[] }>;
type DoctorCreate =
  | Readonly<{ outcome: "created" | "reused"; doctor: Doctor }>
  | Readonly<{ outcome: "inactive_exact_match"; doctor: Doctor }>
  | Readonly<{ outcome: "confirm_shared_phone"; matches: readonly Doctor[] }>;
const e164 = /^\+[1-9][0-9]{7,14}$/;

export function SharingPreview() {
  const [patientPhone, setPatientPhone] = useState("");
  const [includePatient, setIncludePatient] = useState(false);
  const [includeDoctor, setIncludeDoctor] = useState(false);
  const [doctorQuery, setDoctorQuery] = useState("");
  const [doctors, setDoctors] = useState<readonly Doctor[]>([]);
  const [selectedDoctorId, setSelectedDoctorId] = useState("");
  const [newDoctorName, setNewDoctorName] = useState("");
  const [newDoctorPhone, setNewDoctorPhone] = useState("");
  const [confirmSharedPhone, setConfirmSharedPhone] = useState(false);
  const [sharedMatches, setSharedMatches] = useState<readonly Doctor[]>([]);
  const [status, setStatus] = useState("Choose a recipient to prepare a local preview.");
  const [copyStatus, setCopyStatus] = useState("");

  const selectedDoctor = doctors.find((doctor) => doctor.id === selectedDoctorId) ?? null;
  const message = useMemo(
    () =>
      "Clarity: A report is ready for you. Secure sharing is not available yet. This is a preview only; no link or message has been sent.",
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void fetch(`/api/doctors?q=${encodeURIComponent(doctorQuery)}&limit=20`, {
        cache: "no-store",
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error("Search unavailable");
          const result = (await response.json()) as DoctorSearch;
          setDoctors(result.doctors);
          if (
            selectedDoctorId &&
            !result.doctors.some((doctor) => doctor.id === selectedDoctorId)
          ) {
            setSelectedDoctorId("");
          }
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setStatus("Doctor search is unavailable. Check staff access and retry.");
        });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [doctorQuery, selectedDoctorId]);

  async function addDoctor(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("Checking doctor directory…");
    try {
      const response = await fetch("/api/doctors", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: newDoctorName,
          phoneE164: newDoctorPhone,
          confirmedSharedPhone: confirmSharedPhone,
        }),
      });
      if (response.status === 403)
        throw new Error("Staff access is required to update the directory.");
      if (!response.ok) throw new Error("Doctor details could not be saved.");
      const result = (await response.json()) as DoctorCreate;
      if (result.outcome === "confirm_shared_phone") {
        setSharedMatches(result.matches);
        setStatus("Review the matching doctor and confirm the shared number only when verified.");
        return;
      }
      if (result.outcome === "inactive_exact_match") {
        setStatus("This exact doctor entry is inactive. Ask an administrator to review it.");
        return;
      }
      setSelectedDoctorId(result.doctor.id);
      setDoctors((current) => [
        result.doctor,
        ...current.filter((doctor) => doctor.id !== result.doctor.id),
      ]);
      setDoctorQuery(result.doctor.displayName);
      setIncludeDoctor(true);
      setNewDoctorName("");
      setNewDoctorPhone("");
      setConfirmSharedPhone(false);
      setSharedMatches([]);
      setStatus(
        result.outcome === "created" ? "Doctor added and selected." : "Existing doctor selected.",
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Doctor directory unavailable.");
    }
  }

  async function copyPreview() {
    try {
      await navigator.clipboard.writeText(message);
      setCopyStatus("Preview text copied. No sharing link was created.");
    } catch {
      setCopyStatus("Clipboard access is unavailable in this browser.");
    }
  }

  return (
    <div className={styles.content}>
      <section className={styles.panel} aria-labelledby="recipient-title">
        <p className="eyebrow">SYNTHETIC SHARING PREVIEW</p>
        <h2 id="recipient-title">Recipients</h2>
        <p className={styles.muted}>
          Enter test details only. The form does not contact recipients or create a report link.
        </p>
        <label className={styles.field}>
          Patient mobile (international format)
          <input
            type="tel"
            inputMode="tel"
            autoComplete="off"
            placeholder="+14155550123"
            value={patientPhone}
            aria-describedby="patient-mobile-help"
            onChange={(event) => setPatientPhone(event.target.value)}
          />
        </label>
        <p id="patient-mobile-help" className={`${styles.muted} ${styles.mobileHint}`}>
          Use a synthetic number. No patient data is loaded on this page.
        </p>
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={includePatient}
            onChange={(event) => setIncludePatient(event.target.checked)}
          />
          Include patient in the preview
        </label>
        <label className={styles.field}>
          Search and select a doctor
          <input
            value={doctorQuery}
            maxLength={80}
            onChange={(event) => setDoctorQuery(event.target.value)}
          />
        </label>
        <label className={styles.field}>
          Doctor
          <select
            value={selectedDoctorId}
            onChange={(event) => {
              setSelectedDoctorId(event.target.value);
              setIncludeDoctor(Boolean(event.target.value));
            }}
          >
            <option value="">Choose a doctor</option>
            {doctors.map((doctor) => (
              <option disabled={!doctor.active} key={doctor.id} value={doctor.id}>
                {doctor.displayName} · {doctor.phoneE164}
                {doctor.active ? "" : " · inactive"}
              </option>
            ))}
          </select>
        </label>
        <ul id="doctor-results" className={styles.list} aria-label="Doctor search results">
          {doctors.slice(0, 5).map((doctor) => (
            <li key={doctor.id}>
              <span className={styles.doctorName}>
                <strong>{doctor.displayName}</strong>
                <small>{doctor.phoneE164}</small>
              </span>
              <button
                className={styles.buttonSecondary}
                disabled={!doctor.active}
                type="button"
                onClick={() => {
                  setSelectedDoctorId(doctor.id);
                  setDoctorQuery(doctor.displayName);
                  setIncludeDoctor(true);
                  setStatus("Doctor selected; directory phone is filled into the preview context.");
                }}
              >
                {doctor.active ? "Select" : "Inactive"}
              </button>
            </li>
          ))}
        </ul>
        {selectedDoctor && (
          <p className={styles.muted}>Selected phone: {selectedDoctor.phoneE164}</p>
        )}
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={includeDoctor}
            disabled={!selectedDoctor?.active}
            onChange={(event) => setIncludeDoctor(event.target.checked)}
          />
          Include selected doctor in the preview
        </label>
        <p className={styles.feedback} aria-live="polite">
          {status}
        </p>
      </section>

      <section className={styles.panel} aria-labelledby="preview-title">
        <p className="eyebrow">NO DISPATCH</p>
        <h2 id="preview-title">Message preview</h2>
        <div className={styles.preview} aria-live="polite">
          {message}
        </div>
        <p className={styles.feedback} aria-live="polite">
          {includePatient &&
            (!e164.test(patientPhone)
              ? "Enter a valid E.164 patient mobile to include it in the preview. "
              : "Patient recipient selected. ")}
          {includeDoctor &&
            (!selectedDoctor?.active
              ? "Select an active doctor. "
              : `Doctor recipient selected: ${selectedDoctor.displayName}. `)}
          {!includePatient && !includeDoctor
            ? "Select at least one recipient to preview the sharing intent."
            : ""}
        </p>
        <div className={styles.actions}>
          <button
            className={styles.buttonSecondary}
            type="button"
            onClick={() => void copyPreview()}
          >
            Copy preview text
          </button>
          <button
            className={styles.buttonSecondary}
            type="button"
            disabled
            aria-describedby="qr-unavailable"
          >
            QR unavailable
          </button>
        </div>
        <p id="qr-unavailable" className={styles.unavailable}>
          A QR code needs a verified, expiring report link. That sharing service is not enabled.
        </p>
        <p className={styles.feedback} aria-live="polite">
          {copyStatus}
        </p>
        <button
          className={styles.button}
          type="button"
          disabled
          aria-describedby="send-unavailable"
        >
          Send unavailable
        </button>
        <p id="send-unavailable" className={styles.unavailable}>
          Sending is disabled until the recipient-verification policy and dispatch backend are
          ready.
        </p>
      </section>

      <section
        className={`${styles.panel} ${styles.sharePanel}`}
        aria-labelledby="add-doctor-title"
      >
        <p className="eyebrow">DIRECTORY</p>
        <h2 id="add-doctor-title">Add or select a doctor</h2>
        <form className={styles.inlineForm} onSubmit={(event) => void addDoctor(event)}>
          <label className={styles.field}>
            Doctor name
            <input
              required
              maxLength={160}
              value={newDoctorName}
              onChange={(event) => setNewDoctorName(event.target.value)}
            />
          </label>
          <label className={styles.field}>
            Doctor phone (E.164)
            <input
              required
              type="tel"
              inputMode="tel"
              placeholder="+14155550123"
              value={newDoctorPhone}
              onChange={(event) => setNewDoctorPhone(event.target.value)}
            />
          </label>
          <button
            className={styles.buttonSecondary}
            disabled={
              !newDoctorName.trim() ||
              !e164.test(newDoctorPhone) ||
              (sharedMatches.length > 0 && !confirmSharedPhone)
            }
            type="submit"
          >
            Add or select
          </button>
        </form>
        {sharedMatches.length > 0 && (
          <fieldset className={styles.confirmation}>
            <legend>Shared phone review</legend>
            <p className={styles.muted}>This number matches:</p>
            <ul>
              {sharedMatches.map((doctor) => (
                <li key={doctor.id}>{doctor.displayName}</li>
              ))}
            </ul>
            <label>
              <input
                type="checkbox"
                checked={confirmSharedPhone}
                onChange={(event) => setConfirmSharedPhone(event.target.checked)}
              />
              I verified that this new doctor shares this number
            </label>
          </fieldset>
        )}
      </section>
    </div>
  );
}
