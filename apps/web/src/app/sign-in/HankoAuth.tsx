"use client";

import { register } from "@teamhanko/hanko-elements";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

export function HankoAuth() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const api = process.env.NEXT_PUBLIC_HANKO_API_URL ?? "";

  useEffect(() => {
    if (!api) return;
    let active = true;
    void register(api)
      .then(({ hanko }) => {
        hanko.onSessionCreated(() => {
          router.replace("/staff");
          router.refresh();
        });
        if (active) setReady(true);
      })
      .catch(() => {
        if (active) setReady(false);
      });
    return () => {
      active = false;
    };
  }, [api, router]);

  if (!api)
    return <p className="auth-unavailable">Sign-in is unavailable until Hanko is configured.</p>;
  return (
    <div className="auth-panel">
      {!ready && (
        <p className="auth-status" role="status">
          Connecting to the configured sign-in service…
        </p>
      )}
      <hanko-login />
    </div>
  );
}
