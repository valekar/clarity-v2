"use client";

import { useCallback, useEffect, useState } from "react";

type DoctorRecord = Readonly<{
  id: string;
  displayName: string;
  normalizedName: string;
  phoneE164: string;
  active: boolean;
  version: number;
}>;
const validPhoneE164 = (value: string) => /^\+[1-9][0-9]{7,14}$/.test(value);

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
  const [status, setStatus] = useState("Loading doctor directory…");

  const load = useCallback(async (value: string) => {
    setStatus("Loading doctor directory…");
    try {
      const response = await fetch(`/api/doctors?q=${encodeURIComponent(value)}&limit=20`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Directory unavailable");
      const result = (await response.json()) as DoctorResponse;
      setDoctors(result.doctors);
      setStatus(`${result.doctors.length} doctors shown (maximum 20).`);
    } catch {
      setDoctors([]);
      setStatus("Doctor directory unavailable. Retry when staff services are available.");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(query), 0);
    return () => window.clearTimeout(timer);
  }, [load, query]);

  async function addDoctor(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("Checking doctor details…");
    try {
      const response = await fetch("/api/doctors", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: name,
          phoneE164: phone,
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
        setStatus(
          "This number is already used by another doctor. Confirm the shared number only if verified.",
        );
        return;
      }
      if (result.outcome === "inactive_exact_match") {
        setStatus(
          "An exact matching doctor is inactive. Ask an administrator to review the directory entry.",
        );
        return;
      }
      setName("");
      setPhone("");
      setConfirmSharedPhone(false);
      setSharedMatches([]);
      setStatus(result.outcome === "created" ? "Doctor added." : "Existing doctor selected.");
      await load(query);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Doctor directory unavailable.");
    }
  }

  return (
    <div className="staff-panels">
      <section className="staff-panel" aria-labelledby="doctor-directory-title">
        <div className="staff-panel-heading">
          <div>
            <p className="eyebrow">SHARING CONTACTS</p>
            <h2 id="doctor-directory-title">Doctor directory</h2>
          </div>
          <button className="secondary-button" onClick={() => void load(query)} type="button">
            Refresh
          </button>
        </div>
        <p className="staff-feedback" aria-live="polite">
          {status}
        </p>
        <label className="staff-field">
          Search by name or phone
          <input value={query} maxLength={80} onChange={(event) => setQuery(event.target.value)} />
        </label>
        {doctors.length === 0 ? (
          <p className="staff-muted">No matching doctors on this page.</p>
        ) : (
          <ul className="doctor-list">
            {doctors.map((doctor) => (
              <li key={doctor.id}>
                <span>
                  <strong>{doctor.displayName}</strong>
                  <small>{doctor.phoneE164}</small>
                </span>
                <span className={doctor.active ? "doctor-active" : "doctor-inactive"}>
                  {doctor.active ? "Active" : "Inactive"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="staff-panel" aria-labelledby="add-doctor-title">
        <p className="eyebrow">DIRECTORY UPDATE</p>
        <h2 id="add-doctor-title">Add a doctor</h2>
        <form className="staff-form" onSubmit={(event) => void addDoctor(event)}>
          <label className="staff-field">
            Doctor name
            <input
              required
              maxLength={160}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="staff-field">
            Phone number (international format)
            <input
              required
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="+14155550123"
              value={phone}
              aria-describedby="doctor-phone-help"
              onChange={(event) => setPhone(event.target.value)}
            />
          </label>
          <p id="doctor-phone-help" className="staff-muted">
            Use E.164 format, for example +14155550123.
          </p>
          {sharedMatches.length > 0 && (
            <fieldset className="staff-confirmation">
              <legend>Confirm this shared number</legend>
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
                I verified that this doctor shares the number above
              </label>
            </fieldset>
          )}
          <button
            className="secondary-button"
            disabled={
              !name.trim() ||
              !validPhoneE164(phone) ||
              (sharedMatches.length > 0 && !confirmSharedPhone)
            }
            type="submit"
          >
            Add or select doctor
          </button>
        </form>
      </section>
    </div>
  );
}
