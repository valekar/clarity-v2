"use client";

import { useCallback, useEffect, useState } from "react";
import { pendingRoleFor, setPendingRole, type PendingRoleSelections } from "./pending-role";

type StaffEntry = Readonly<{
  staffUserId: string;
  displayName: string;
  active: boolean;
  membership: Readonly<{
    role: "admin" | "staff";
    status: "active" | "disabled";
    version: string;
  }> | null;
}>;
type StaffPage = Readonly<{ entries: readonly StaffEntry[]; nextCursor: string | null }>;

export function StaffAccessPanel() {
  const [page, setPage] = useState<StaffPage>({ entries: [], nextCursor: null });
  const [cursor, setCursor] = useState<string | null>(null);
  const [roles, setRoles] = useState<PendingRoleSelections>({});
  const [status, setStatus] = useState("Loading staff accounts…");
  const [busyUser, setBusyUser] = useState<string | null>(null);

  const load = useCallback(async (after: string | null) => {
    setStatus("Loading staff accounts…");
    try {
      const query = new URLSearchParams({ limit: "50" });
      if (after) query.set("after", after);
      const response = await fetch(`/api/staff?${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Staff accounts could not be loaded.");
      const value = (await response.json()) as StaffPage;
      setPage(value);
      setCursor(after);
      setStatus(`${value.entries.length} staff accounts loaded.`);
    } catch {
      setStatus("Staff accounts could not be loaded. Retry to check access and service status.");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(null), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function update(entry: StaffEntry, action: "grant" | "disable") {
    setBusyUser(entry.staffUserId);
    setStatus(action === "grant" ? "Updating staff access…" : "Disabling staff access…");
    try {
      const response =
        action === "grant"
          ? await fetch("/api/staff", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                targetUserId: entry.staffUserId,
                role: pendingRoleFor(roles, entry.staffUserId),
              }),
            })
          : await fetch(`/api/staff/${entry.staffUserId}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ expectedVersion: entry.membership?.version }),
            });
      if (response.status === 409) {
        setStatus(
          "Access changed since this page loaded, or the change would remove the last administrator. Refresh the list and review again.",
        );
      } else if (response.status === 403) {
        setStatus("This account no longer has administrator access. Refresh the page.");
      } else if (!response.ok) {
        setStatus("The access change could not be completed. Refresh and try again.");
      } else {
        setStatus(action === "grant" ? "Staff access granted." : "Staff access disabled.");
        await load(cursor);
      }
    } catch {
      setStatus("The access service is unavailable. Retry after checking the connection.");
    } finally {
      setBusyUser(null);
    }
  }

  return (
    <section className="panel staff-access-panel" aria-labelledby="staff-access-title">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">SETTINGS</p>
          <h2 id="staff-access-title">Staff access</h2>
        </div>
        <button className="secondary-button" onClick={() => void load(cursor)} type="button">
          Refresh
        </button>
      </div>
      <p className="form-intro">
        Staff accounts are created by an administrator. Confirm the person before granting access.
        Signing in does not grant a staff role automatically.
      </p>
      <p className="access-feedback" aria-live="polite">
        {status}
      </p>
      {page.entries.length === 0 ? (
        <p className="directory-empty">No staff accounts are on this page.</p>
      ) : (
        <ul className="staff-list">
          {page.entries.map((entry) => {
            const pending = !entry.membership;
            const active = entry.active && entry.membership?.status === "active";
            return (
              <li className="staff-row" key={entry.staffUserId}>
                <div className="staff-account">
                  <strong>{entry.displayName}</strong>
                  <span>
                    {pending
                      ? "Pending review"
                      : `${entry.membership?.role} · ${entry.membership?.status}`}
                  </span>
                </div>
                {pending ? (
                  <div className="staff-actions">
                    <label>
                      <span className="visually-hidden">Access role for {entry.displayName}</span>
                      <select
                        aria-label={`Access role for ${entry.displayName}`}
                        onChange={(event) =>
                          setRoles((current) =>
                            setPendingRole(
                              current,
                              entry.staffUserId,
                              event.target.value as "admin" | "staff",
                            ),
                          )
                        }
                        value={pendingRoleFor(roles, entry.staffUserId)}
                      >
                        <option value="staff">Staff</option>
                        <option value="admin">Administrator</option>
                      </select>
                    </label>
                    <button
                      className="secondary-button"
                      disabled={busyUser !== null || !entry.active}
                      onClick={() => void update(entry, "grant")}
                      type="button"
                    >
                      {busyUser === entry.staffUserId ? "Saving…" : "Grant access"}
                    </button>
                  </div>
                ) : active ? (
                  <button
                    className="secondary-button"
                    disabled={busyUser !== null}
                    onClick={() => void update(entry, "disable")}
                    type="button"
                  >
                    {busyUser === entry.staffUserId ? "Saving…" : "Disable access"}
                  </button>
                ) : (
                  <span className="state-label">ACCESS DISABLED</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="directory-pagination">
        <button
          className="secondary-button"
          disabled={!cursor || busyUser !== null}
          onClick={() => void load(null)}
          type="button"
        >
          First page
        </button>
        <button
          className="secondary-button"
          disabled={!page.nextCursor || busyUser !== null}
          onClick={() => page.nextCursor && void load(page.nextCursor)}
          type="button"
        >
          Next page
        </button>
      </div>
    </section>
  );
}
