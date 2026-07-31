import { describe, expect, it } from 'vitest';
import { parseStepsContent } from './steps.js';

describe('parseStepsContent', () => {
  it('preserves the canonical JSON array format', () => {
    const raw = JSON.stringify([
      { summary: 'Inspecting the repo', status: 'investigating' },
      { summary: 'Running tests', status: 'testing' },
    ]);

    expect(parseStepsContent(raw)).toEqual([
      { summary: 'Inspecting the repo', status: 'investigating' },
      { summary: 'Running tests', status: 'testing' },
    ]);
  });

  it('accepts a single step object before a second line is appended', () => {
    expect(parseStepsContent('{"summary":"Inspecting the repo","status":"investigating"}')).toEqual(
      [{ summary: 'Inspecting the repo', status: 'investigating' }],
    );
  });

  it('parses newline-delimited step objects written by append-oriented agents', () => {
    const raw = [
      '{"summary":"Inspecting the repo","status":"investigating"}',
      '{"summary":"Running tests","status":"testing","files_touched":[]}',
    ].join('\n');

    expect(parseStepsContent(raw)).toEqual([
      { summary: 'Inspecting the repo', status: 'investigating' },
      { summary: 'Running tests', status: 'testing', files_touched: [] },
    ]);
  });

  it('rejects malformed or non-object JSONL entries', () => {
    expect(
      parseStepsContent('{"summary":"Inspecting the repo","status":"investigating"}\nnot-json'),
    ).toBeNull();
    expect(
      parseStepsContent('{"summary":"Inspecting the repo","status":"investigating"}\n42'),
    ).toBeNull();
  });
});
