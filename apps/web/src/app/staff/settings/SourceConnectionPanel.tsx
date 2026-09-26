"use client";

import { useState, useSyncExternalStore } from "react";
import "./source-connection.css";

type SourceReply = Readonly<{ ok: boolean; error?: string }>;
type SourceBridge = Readonly<{ open(): Promise<SourceReply> }>;

function bridge(): SourceBridge | null {
  if (typeof window === "undefined") return null;
  return (
    (window as Window & { claritySourceSettings?: SourceBridge }).claritySourceSettings ?? null
  );
}

export function SourceConnectionPanel() {
  const available = useSyncExternalStore(
    () => () => {},
    () => Boolean(bridge()),
    () => false,
  );
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");

  async function openLocalSettings() {
    const local = bridge();
    if (!local) return;
    setBusy(true);
    setFeedback("");
    try {
      const reply = await local.open();
      if (!reply.ok) {
        setFeedback(`Could not show connection settings: ${reply.error ?? "unavailable"}.`);
      }
    } catch {
      setFeedback("Could not show connection settings.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="source-connection-panel" aria-labelledby="source-connection-title">
      <div className="source-connection-heading">
        <div>
          <p className="eyebrow">THIS COMPUTER</p>
          <h2 id="source-connection-title">Orthanc connection</h2>
        </div>
      </div>
      <p className="source-connection-intro">
        Connect this computer to the private Orthanc REST API. In the desktop app, the connection
        form stays in Settings. New studies are checked on the schedule you save.
      </p>
      {!available ? (
        <p role="status" className="source-connection-feedback">
          Open Settings in the installed Clarity desktop app to configure this computer.
        </p>
      ) : (
        <>
          <button
            className="source-connection-open"
            type="button"
            onClick={() => void openLocalSettings()}
            disabled={busy}
          >
            Configure Orthanc connection
          </button>
          <p role="status" className="source-connection-feedback">
            {feedback}
          </p>
        </>
      )}
    </section>
  );
}
