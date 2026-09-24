export type DicomJson = Record<string, { Value?: unknown }>;

export type ViewerInstanceSummary = Readonly<{
  modality: string | null;
  sopClassUid: string | null;
  transferSyntaxUid: string | null;
}>;

export type ViewerCompatibility = Readonly<{
  hasMr: boolean;
  nonImageCount: number;
  alternativeTransferSyntaxCount: number;
  unknownTransferSyntaxCount: number;
  inspectedCount: number;
  truncated: boolean;
  incomplete: boolean;
}>;

const NATIVE_TRANSFER_SYNTAXES = new Set(["1.2.840.10008.1.2", "1.2.840.10008.1.2.1"]);

const NON_IMAGE_MODALITIES = new Set([
  "SR",
  "PR",
  "KO",
  "DOC",
  "RTSTRUCT",
  "RTPLAN",
  "RTDOSE",
  "REG",
]);

function firstString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

export function tagString(item: DicomJson, tag: string): string | null {
  return firstString(item[tag]?.Value);
}

export function inspectViewerCompatibility(
  instances: readonly ViewerInstanceSummary[],
  truncated = false,
  incomplete = false,
): ViewerCompatibility {
  return {
    hasMr: instances.some((item) => item.modality?.toUpperCase() === "MR"),
    nonImageCount: instances.filter((item) => {
      const modality = item.modality?.toUpperCase();
      const sop = item.sopClassUid ?? "";
      return (
        (modality !== undefined && NON_IMAGE_MODALITIES.has(modality)) ||
        sop.startsWith("1.2.840.10008.5.1.4.1.1.88.") ||
        sop === "1.2.840.10008.5.1.4.1.1.104.1" ||
        sop === "1.2.840.10008.5.1.4.1.1.104.2"
      );
    }).length,
    alternativeTransferSyntaxCount: instances.filter(
      (item) =>
        item.transferSyntaxUid !== null && !NATIVE_TRANSFER_SYNTAXES.has(item.transferSyntaxUid),
    ).length,
    unknownTransferSyntaxCount: instances.filter((item) => item.transferSyntaxUid === null).length,
    inspectedCount: instances.length,
    truncated,
    incomplete: incomplete || instances.length === 0,
  };
}

export function viewerCompatibilityMessage(result: ViewerCompatibility): string[] {
  const messages: string[] = [];
  if (result.hasMr) {
    messages.push(
      "MR images are present. MR rendering has not been verified in this build; check each image against an approved source viewer before clinical use.",
    );
  }
  if (result.nonImageCount > 0) {
    messages.push(
      `${result.nonImageCount} non-image DICOM object(s) are present. They will not appear as image slices here. Do not treat an empty viewport as a negative finding; check the approved source viewer or contact imaging support.`,
    );
  }
  if (result.alternativeTransferSyntaxCount > 0) {
    messages.push(
      `${result.alternativeTransferSyntaxCount} object(s) use a non-native transfer syntax. Browser codec support is not verified; if an image is blank or reports a decode error, use the approved source viewer or contact imaging support.`,
    );
  }
  if (result.unknownTransferSyntaxCount > 0) {
    messages.push(
      `Transfer syntax could not be confirmed for ${result.unknownTransferSyntaxCount} object(s). Image codec support is unverified; confirm image completeness in an approved source viewer.`,
    );
  }
  if (result.truncated) {
    messages.push(
      "Compatibility inspection reached its safety limit. Some objects may not be represented in this summary.",
    );
  }
  if (result.incomplete) {
    messages.push(
      "Compatibility inspection was incomplete. Do not treat a blank viewport as a negative finding; verify the study in an approved source viewer or contact imaging support.",
    );
  }
  return messages;
}
