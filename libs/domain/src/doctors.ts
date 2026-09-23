export type DoctorRecord = Readonly<{
  id: string;
  displayName: string;
  normalizedName: string;
  phoneE164: string;
  active: boolean;
  version: number;
}>;

export type DoctorCreationDecision =
  | Readonly<{ outcome: "create" }>
  | Readonly<{ outcome: "reuse"; doctor: DoctorRecord }>
  | Readonly<{ outcome: "inactive_exact_match"; doctor: DoctorRecord }>
  | Readonly<{ outcome: "confirm_shared_phone"; matches: readonly DoctorRecord[] }>;

export function normalizeDoctorName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

export function doctorIdentityName(value: string): string {
  return normalizeDoctorName(value).toLocaleLowerCase("en-US");
}

export function validPhoneE164(value: string): boolean {
  return /^\+[1-9][0-9]{7,14}$/.test(value);
}

export function decideDoctorCreation(
  input: Readonly<{
    normalizedName: string;
    phoneE164: string;
    confirmedSharedPhone: boolean;
    exactMatch: DoctorRecord | null;
    sharedPhoneMatches: readonly DoctorRecord[];
  }>,
): DoctorCreationDecision {
  if (input.exactMatch) {
    return input.exactMatch.active
      ? { outcome: "reuse", doctor: input.exactMatch }
      : { outcome: "inactive_exact_match", doctor: input.exactMatch };
  }
  const distinct = input.sharedPhoneMatches.filter(
    (doctor) => doctor.normalizedName !== input.normalizedName,
  );
  if (distinct.length && !input.confirmedSharedPhone) {
    return { outcome: "confirm_shared_phone", matches: distinct };
  }
  return { outcome: "create" };
}
