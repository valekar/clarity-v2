"use client";

import { useCallback, useEffect, useState } from "react";
import { formatIndianMobile, normalizeIndianMobile } from "../../../lib/indian-mobile";
import styles from "./DoctorsDirectory.module.css";

type DoctorRecord = Readonly<{
  id: string;
  displayName: string;
  phoneE164: string;
  active: boolean;
}>;
type DoctorResponse = Readonly<{ doctors: readonly DoctorRecord[] }>;
type CreateResponse =
  | Readonly<{ outcome: "created" | "reused"; doctor: DoctorRecord }>
  | Readonly<{ outcome: "inactive_exact_match"; doctor: DoctorRecord }>
  | Readonly<{ outcome: "confirm_shared_phone"; matches: readonly DoctorRecord[] }>;

export function DoctorsDirectory() {
  const [query, setQuery] = useState("");
  const [doctors, setDoctors] = useState<readonly DoctorRecord[]>([]);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [confirmSharedPhone, setConfirmSharedPhone] = useState(false);
  const [sharedMatches, setSharedMatches] = useState<readonly DoctorRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async (value: string) => {
    setLoading(true);
    setLoadError("");
    try {
      const response = await fetch(`/api/doctors?q=${encodeURIComponent(value)}&limit=20`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Directory unavailable");
      const result = (await response.json()) as DoctorResponse;
      setDoctors(result.doctors);
    } catch {
      setDoctors([]);
      setLoadError("Doctor directory is unavailable. Check your staff connection and retry.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(query.trim()), 180);
    return () => window.clearTimeout(timer);
  }, [load, query]);

  function updateDetails(field: "name" | "phone", value: string) {
    if (field === "name") setName(value);
    else setPhone(value);
    setSharedMatches([]);
    setConfirmSharedPhone(false);
    setNotice("");
  }

  async function addDoctor(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const phoneE164 = normalizeIndianMobile(phone);
    if (!phoneE164 || !name.trim() || saving) return;
    setSaving(true);
    setNotice("");
    try {
      const response = await fetch("/api/doctors", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: name.trim(),
          phoneE164,
          confirmedSharedPhone: confirmSharedPhone,
        }),
      });
      if (response.status === 403)
        throw new Error("Your staff access no longer permits this action.");
      if (!response.ok)
        throw new Error("The doctor could not be added. Check the details and retry.");
      const result = (await response.json()) as CreateResponse;
      if (result.outcome === "confirm_shared_phone") {
        setSharedMatches(result.matches);
        setNotice("This mobile number is already listed. Confirm sharing only after verification.");
        return;
      }
      if (result.outcome === "inactive_exact_match") {
        setNotice("This matching doctor is inactive. Ask an administrator to review the entry.");
        return;
      }
      setName("");
      setPhone("");
      setConfirmSharedPhone(false);
      setSharedMatches([]);
      setQuery("");
      await load("");
      setNotice(
        result.outcome === "created"
          ? `${result.doctor.displayName} added to the directory.`
          : `${result.doctor.displayName} is already in the directory.`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Doctor directory unavailable.");
    } finally {
      setSaving(false);
    }
  }

  const validPhone = normalizeIndianMobile(phone) !== null;
  const canSubmit =
    Boolean(name.trim()) &&
    validPhone &&
    !saving &&
    (sharedMatches.length === 0 || confirmSharedPhone);

  return (
    <div className={styles.layout}>
      <section className={styles.panel} aria-labelledby="doctor-directory-title">
        <div className={styles.heading}>
          <div>
            <p className="eyebrow">SHARING CONTACTS</p>
            <h2 id="doctor-directory-title">Doctor directory</h2>
            <p className={styles.intro}>Find a doctor before preparing a share.</p>
          </div>
          <span className={styles.count}>{loading ? "…" : doctors.length} shown</span>
        </div>
        <label className={styles.field}>
          <span>Search doctors</span>
          <input
            type="search"
            placeholder="Name or mobile number"
            value={query}
            maxLength={80}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className={styles.listHeading}>
          <span>Directory</span>
          <button
            className={styles.textButton}
            onClick={() => void load(query.trim())}
            type="button"
          >
            Refresh
          </button>
        </div>
        {loadError ? (
          <p className={styles.error} role="alert">
            {loadError}
          </p>
        ) : loading ? (
          <p className={styles.empty} role="status">
            Loading doctors…
          </p>
        ) : doctors.length === 0 ? (
          <div className={styles.empty}>
            <strong>{query.trim() ? "No matching doctors" : "No doctors added yet"}</strong>
            <p>
              {query.trim()
                ? "Try another name or mobile number."
                : "Use Add a doctor to create the first entry."}
            </p>
          </div>
        ) : (
          <ul className={styles.list} aria-label="Doctor directory results">
            {doctors.map((doctor) => (
              <li className={styles.row} key={doctor.id}>
                <span className={styles.avatar} aria-hidden="true">
                  {doctor.displayName.trim().charAt(0).toUpperCase()}
                </span>
                <span className={styles.doctorDetails}>
                  <strong>{doctor.displayName}</strong>
                  <small>{formatIndianMobile(doctor.phoneE164)}</small>
                </span>
                <span className={doctor.active ? styles.active : styles.inactive}>
                  {doctor.active ? "Active" : "Inactive"}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className={styles.footnote}>Showing up to 20 doctors. Search to narrow the list.</p>
      </section>

      <section className={styles.panel} aria-labelledby="add-doctor-title">
        <p className="eyebrow">DIRECTORY UPDATE</p>
        <h2 id="add-doctor-title">Add a doctor</h2>
        <p className={styles.intro}>Use a verified contact number for this doctor.</p>
        <form className={styles.form} onSubmit={(event) => void addDoctor(event)}>
          <label className={styles.field}>
            <span>Doctor name</span>
            <input
              required
              maxLength={160}
              placeholder="Dr. Sample Rao"
              value={name}
              onChange={(event) => updateDetails("name", event.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span>Mobile number</span>
            <span className={styles.phoneInput}>
              <span className={styles.countryCode} aria-hidden="true">
                +91
              </span>
              <input
                required
                type="tel"
                inputMode="numeric"
                autoComplete="off"
                placeholder="90000 00001"
                value={phone}
                aria-describedby="doctor-phone-help"
                aria-invalid={phone.length > 0 && !validPhone}
                onChange={(event) =>
                  updateDetails("phone", event.target.value.replace(/^\+91[\s-]?/, ""))
                }
              />
            </span>
          </label>
          <p id="doctor-phone-help" className={styles.help}>
            Enter a 10-digit Indian mobile number. +91 is added automatically.
          </p>
          {sharedMatches.length > 0 && (
            <fieldset className={styles.confirmation}>
              <legend>Shared mobile number</legend>
              <p>
                This number already belongs to{" "}
                {sharedMatches.map((doctor) => doctor.displayName).join(", ")}.
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={confirmSharedPhone}
                  onChange={(event) => setConfirmSharedPhone(event.target.checked)}
                />
                I verified that this doctor shares the number
              </label>
            </fieldset>
          )}
          <button className={styles.submit} disabled={!canSubmit} type="submit">
            {saving ? "Saving doctor…" : "Add doctor"}
          </button>
          <p className={styles.notice} aria-live="polite">
            {notice}
          </p>
        </form>
      </section>
    </div>
  );
}
