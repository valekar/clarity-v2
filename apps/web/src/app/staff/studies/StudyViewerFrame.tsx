"use client";

import { useEffect, useRef, useState } from "react";
import dashboardStyles from "../study-dashboard.module.css";
import styles from "./viewer-compatibility.module.css";

const VIEWER_STARTUP_TIMEOUT_MS = 45_000;
const VIEWER_POLL_INTERVAL_MS = 500;

type ViewerState = "opening" | "ready" | "needs-retry";

function hasViewerCanvas(frame: HTMLIFrameElement): boolean {
  try {
    const document = frame.contentDocument;
    if (!document) return false;
    return Array.from(document.querySelectorAll("canvas")).some((canvas) => {
      const rect = canvas.getBoundingClientRect();
      return canvas.width >= 64 && canvas.height >= 64 && rect.width >= 64 && rect.height >= 64;
    });
  } catch {
    return false;
  }
}

export function StudyViewerFrame({ src }: { src: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ViewerState>("opening");

  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      if (frameRef.current && hasViewerCanvas(frameRef.current)) {
        setState("ready");
        window.clearInterval(timer);
      } else if (Date.now() - startedAt >= VIEWER_STARTUP_TIMEOUT_MS) {
        setState("needs-retry");
        window.clearInterval(timer);
      }
    }, VIEWER_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [attempt, src]);

  return (
    <section aria-label="Study image viewer">
      <p className={styles.viewerStatus} role="status" aria-live="polite">
        {state === "opening" && "Opening the verified cloud images…"}
        {state === "ready" &&
          "The viewer has an image canvas. Confirm the expected images are visible before review."}
        {state === "needs-retry" &&
          "The viewer has not shown an image canvas yet. The study may still be loading or may contain no renderable images. Do not treat a blank view as a negative finding; retry or use the approved source viewer."}
      </p>
      {state === "needs-retry" && (
        <button
          className={styles.retryViewer}
          type="button"
          onClick={() => {
            setState("opening");
            setAttempt((value) => value + 1);
          }}
        >
          Retry viewer
        </button>
      )}
      <iframe
        key={attempt}
        ref={frameRef}
        className={dashboardStyles.viewerFrame}
        src={src}
        title="DICOM study viewer"
        onError={() => setState("needs-retry")}
      />
    </section>
  );
}
