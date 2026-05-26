export function hasUserPromptDraftText(text: string, stagedText?: string): boolean {
  const value = text.trim();
  if (!value) return false;
  return value !== stagedText?.trim();
}
