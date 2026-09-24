"use client";

import { useEffect, useState } from "react";
import styles from "./viewer-compatibility.module.css";
import {
  inspectViewerCompatibility,
  tagString,
  viewerCompatibilityMessage,
  type DicomJson,
} from "./viewer-compatibility";

const MAX_SERIES = 32;
const MAX_INSTANCES_PER_SERIES = 256;

async function qido(path: string, signal: AbortSignal): Promise<DicomJson[]> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { Accept: "application/dicom+json" },
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error("metadata-unavailable");
  const result: unknown = await response.json();
  if (
    !Array.isArray(result) ||
    result.some((item) => !item || typeof item !== "object" || Array.isArray(item))
  ) {
    throw new Error("invalid-metadata");
  }
  return result as DicomJson[];
}

export function ViewerCompatibilityNotice({ studyUid }: { studyUid: string }) {
  const [state, setState] = useState<"checking" | "ready" | "unavailable">("checking");
  const [messages, setMessages] = useState<string[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    async function inspect() {
      try {
        const fields = "00080060,0020000E";
        const series = await qido(
          `/dicom-web/studies/${encodeURIComponent(studyUid)}/series?includefield=${fields}`,
          signal,
        );
        const truncated = series.length > MAX_SERIES;
        const selectedSeries = series.slice(0, MAX_SERIES);
        const inspected = [] as Array<{
          modality: string | null;
          sopClassUid: string | null;
          transferSyntaxUid: string | null;
        }>;
        let instanceTruncated = false;
        let incomplete = false;

        for (const item of selectedSeries) {
          if (controller.signal.aborted) return;
          if (signal.aborted) throw new Error("metadata-timeout");
          const uid = tagString(item, "0020000E");
          if (!uid || !/^\d+(?:\.\d+)*$/.test(uid)) {
            incomplete = true;
            continue;
          }
          const query = new URLSearchParams({
            limit: String(MAX_INSTANCES_PER_SERIES + 1),
            includefield: "00080016,00080018,00080060",
          });
          const instances = await qido(
            `/dicom-web/studies/${encodeURIComponent(studyUid)}/series/${encodeURIComponent(uid)}/instances?${query}`,
            signal,
          );
          if (instances.length === 0) incomplete = true;
          if (instances.length > MAX_INSTANCES_PER_SERIES) instanceTruncated = true;
          for (const instance of instances.slice(0, MAX_INSTANCES_PER_SERIES)) {
            inspected.push({
              modality: tagString(instance, "00080060") ?? tagString(item, "00080060"),
              sopClassUid: tagString(instance, "00080016"),
              transferSyntaxUid: tagString(instance, "00020010"),
            });
          }
        }
        if (controller.signal.aborted) return;
        if (signal.aborted) throw new Error("metadata-timeout");
        const summary = inspectViewerCompatibility(
          inspected,
          truncated || instanceTruncated,
          incomplete,
        );
        setMessages(viewerCompatibilityMessage(summary));
        setState("ready");
      } catch {
        if (!controller.signal.aborted) setState("unavailable");
      }
    }
    void inspect();
    return () => controller.abort();
  }, [studyUid]);

  if (state === "checking") {
    return (
      <p className={styles.notice} role="status">
        Checking verified study image compatibility…
      </p>
    );
  }
  if (state === "unavailable") {
    return (
      <p className={styles.notice} role="status">
        Image compatibility could not be checked. Do not interpret a blank viewport as a negative
        finding; verify the study in an approved source viewer or contact imaging support.
      </p>
    );
  }
  if (messages.length === 0) {
    return (
      <p className={styles.notice} role="status">
        Compatibility metadata was checked for the verified study.
      </p>
    );
  }
  return (
    <section className={styles.notice} role="status" aria-label="Viewer compatibility">
      <h2>Viewer compatibility</h2>
      <ul>
        {messages.map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
    </section>
  );
}
