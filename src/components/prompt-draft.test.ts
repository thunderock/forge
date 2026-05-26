import { describe, expect, it } from 'vitest';
import { hasUserPromptDraftText } from './prompt-draft';

describe('hasUserPromptDraftText', () => {
  it('does not treat an empty prompt as a user draft', () => {
    expect(hasUserPromptDraftText('', 'queued automation')).toBe(false);
    expect(hasUserPromptDraftText('   ', 'queued automation')).toBe(false);
  });

  it('does not treat the staged automation text as a user draft', () => {
    expect(hasUserPromptDraftText('queued automation', 'queued automation')).toBe(false);
  });

  it('treats half-written user text as a draft even when automation is staged', () => {
    expect(hasUserPromptDraftText('I am typing a reply', 'queued automation')).toBe(true);
  });

  it('treats user text as a draft when no automation text exists', () => {
    expect(hasUserPromptDraftText('manual note')).toBe(true);
  });
});
