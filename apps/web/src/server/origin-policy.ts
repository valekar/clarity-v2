export function mutationRequestAllowed(
  requestOrigin: string | null,
  contentType: string | null,
  expectedOrigin: string,
): boolean {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return requestOrigin === expectedOrigin && mediaType === "application/json";
}
