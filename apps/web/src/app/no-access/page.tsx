export default function NoAccessPage() {
  return (
    <main className="auth-shell">
      <section aria-labelledby="no-access-title">
        <p className="eyebrow">STAFF ACCESS</p>
        <h1 id="no-access-title">Access is not enabled</h1>
        <p className="page-description">
          This signed-in account does not have active staff access. Ask a workspace administrator
          for access.
        </p>
        <a className="auth-link" href="/sign-in">
          Return to sign in
        </a>
      </section>
    </main>
  );
}
