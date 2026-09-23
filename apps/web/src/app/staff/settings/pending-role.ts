export type PendingRole = "admin" | "staff";
export type PendingRoleSelections = Readonly<Record<string, PendingRole>>;

export function setPendingRole(
  current: PendingRoleSelections,
  staffUserId: string,
  role: PendingRole,
): PendingRoleSelections {
  return Object.freeze({ ...current, [staffUserId]: role });
}

export function pendingRoleFor(current: PendingRoleSelections, staffUserId: string): PendingRole {
  return current[staffUserId] ?? "staff";
}
