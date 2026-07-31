export type HarborReleaseValidationOptions = {
  inspectLocal?: boolean;
  imageRevision?: (reference: string) => string | undefined;
  rejectUnexpected?: boolean;
};

export function harborReleaseValidationErrors(
  values: Readonly<Record<string, string | undefined>>,
  options?: HarborReleaseValidationOptions,
): string[];
