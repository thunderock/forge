import { describe, expect, it } from 'vitest';
import { abbreviateHomePath } from './path';

describe('abbreviateHomePath', () => {
  it('shortens macOS home paths', () => {
    expect(abbreviateHomePath('/Users/liang/projects/app')).toBe('~/projects/app');
  });

  it('shortens Linux home paths', () => {
    expect(abbreviateHomePath('/home/liang/projects/app')).toBe('~/projects/app');
  });

  it('shortens the home directory itself', () => {
    expect(abbreviateHomePath('/Users/liang')).toBe('~');
  });

  it('leaves non-home paths unchanged', () => {
    expect(abbreviateHomePath('/var/tmp/app')).toBe('/var/tmp/app');
  });
});
