"use client";

import { Hanko } from "@teamhanko/hanko-elements";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function LogoutButton() {
  const router = useRouter();
  const [error, setError] = useState(false);
  async function logout() {
    const api = process.env.NEXT_PUBLIC_HANKO_API_URL;
    if (!api) {
      setError(true);
      return;
    }
    try {
      await new Hanko(api).logout();
      router.replace("/sign-in");
      router.refresh();
    } catch {
      setError(true);
    }
  }
  return (
    <div>
      <button className="secondary-button" onClick={() => void logout()} type="button">
        Sign out
      </button>
      {error && <p role="status">Sign out could not be completed. Please retry.</p>}
    </div>
  );
}
