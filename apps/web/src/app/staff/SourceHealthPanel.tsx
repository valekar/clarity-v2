"use client";

import { useEffect, useState } from "react";
import styles from "./source-health.module.css";
import {
  formatCapacity,
  requestSourceHealth,
  sourceHealthMessage,
  type SourceHealthResponse,
} from "./source-health";

type PanelState = "loading" | "ready" | "unavailable";

function displayTime(value: string | null): string {
  if (!value) return "Not reported";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : "Not reported";
}

export function SourceHealthPanel() {
  const [refreshNumber, setRefreshNumber] = useState(0);
  const [state, setState] = useState<PanelState>("loading");
  const [result, setResult] = useState<SourceHealthResponse | null>(null);

  useEffect(() => {
    let active = true;
    let refreshing = false;
    const controller = new AbortController();
    async function refresh() {
      if (refreshing) return;
      refreshing = true;
      try {
        const parsed = await requestSourceHealth(fetch, controller.signal);
        if (active) {
          setResult(parsed);
          setState("ready");
        }
      } catch {
        if (active) setState("unavailable");
      } finally {
        refreshing = false;
      }
    }
    void refresh();
    const interval = window.setInterval(() => void refresh(), 60_000);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(interval);
    };
  }, [refreshNumber]);

  return (
    <section
      className={styles.panel}
      aria-labelledby="source-health-title"
      aria-busy={state === "loading"}
    >
      <div className={styles.header}>
        <div>
          <h2 id="source-health-title">Centre sync status</h2>
          <p>Operational status only. Study details stay in the study queue.</p>
        </div>
        <button type="button" onClick={() => setRefreshNumber((value) => value + 1)}>
          Refresh status
        </button>
      </div>
      {state === "loading" && <p role="status">Checking source status…</p>}
      {state === "unavailable" && (
        <div className={styles.unavailable} role="status">
          <p>Source status is unavailable. Current source and cloud health is unknown.</p>
          <button type="button" onClick={() => setRefreshNumber((value) => value + 1)}>
            Try again
          </button>
        </div>
      )}
      {state === "ready" && result?.items.length === 0 && (
        <p role="status">No source status is available for this staff account.</p>
      )}
      {state === "ready" && result && result.items.length > 0 && (
        <ul className={styles.sources}>
          {result.items.map((item, index) => (
            <li className={styles.source} key={item.sourceId}>
              <div className={styles.sourceHeading}>
                <h3>{item.sourceName.trim() || `Source ${index + 1}`}</h3>
                <span className={`${styles.badge} ${styles[item.status]}`}>{item.status}</span>
              </div>
              <p>{sourceHealthMessage(item)}</p>
              <dl>
                <div>
                  <dt>Last report</dt>
                  <dd>{displayTime(item.observedAt)}</dd>
                </div>
                <div>
                  <dt>Last successful sync</dt>
                  <dd>{displayTime(item.lastSuccessfulSyncAt)}</dd>
                </div>
                <div>
                  <dt>Waiting to sync</dt>
                  <dd>
                    {item.queuedStudies} studies, {item.queuedUploads} uploads
                  </dd>
                </div>
                <div>
                  <dt>Local space free</dt>
                  <dd>
                    {item.spoolFreeBytes === null
                      ? "Not reported"
                      : formatCapacity(item.spoolFreeBytes)}
                  </dd>
                </div>
                <div>
                  <dt>Cloud connection</dt>
                  <dd>
                    {item.cloudReachable === null
                      ? "Unknown"
                      : item.cloudReachable
                        ? "Reachable at last report"
                        : "Unavailable at last report"}
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
