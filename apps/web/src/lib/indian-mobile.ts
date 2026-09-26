/** Staff-facing Indian mobile input; API and database retain canonical E.164. */
export function normalizeIndianMobile(value: string): string | null {
  const compact = value.replace(/[\s()-]/g, "");
  const national = compact.startsWith("+91")
    ? compact.slice(3)
    : compact.startsWith("91") && compact.length === 12
      ? compact.slice(2)
      : compact;
  return /^[6-9]\d{9}$/.test(national) ? `+91${national}` : null;
}

export function formatIndianMobile(value: string): string {
  const canonical = normalizeIndianMobile(value);
  return canonical ? `+91 ${canonical.slice(3, 8)} ${canonical.slice(8)}` : value;
}
