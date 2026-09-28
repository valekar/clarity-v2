import Link from "next/link";
import { HankoAuth } from "./HankoAuth";

export const dynamic = "force-dynamic";

export default function SignInPage() {
  return (
    <main className="auth-shell">
      <Link className="auth-back" href="/">
        Clarity V2
      </Link>
      <section aria-labelledby="sign-in-title">
        <p className="eyebrow">STAFF ACCESS</p>
        <h1 id="sign-in-title">Sign in</h1>
        <p className="page-description">
          Use the staff username and password given to you by your administrator.
        </p>
        <HankoAuth />
      </section>
    </main>
  );
}
