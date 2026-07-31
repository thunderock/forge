/**
 * Contrast audit for all built-in themes.
 * Parses styles.css, extracts CSS variable values per theme, and runs
 * checkThemeContrast() against each. Any warning fails the test so built-in
 * presets cannot regress below the supported contrast thresholds.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, it, expect } from 'vitest';
import { checkThemeContrast } from './custom-theme';
import type { CssVar } from './custom-theme';
import { CSS_VARS } from './custom-theme';

const CSS_VAR_SET = new Set<string>(CSS_VARS);
const VAR_RE = /^\s*(--[\w-]+)\s*:\s*(.+?)\s*;?\s*$/;

function parseVars(body: string): Partial<Record<CssVar, string>> {
  const vars: Partial<Record<CssVar, string>> = {};
  for (const line of body.split('\n')) {
    const match = VAR_RE.exec(line);
    if (match && CSS_VAR_SET.has(match[1])) {
      vars[match[1] as CssVar] = match[2].trim();
    }
  }
  return vars;
}

function parseThemesFromCss(css: string): Record<string, Partial<Record<CssVar, string>>> {
  const themes: Record<string, Partial<Record<CssVar, string>>> = {};
  const rootMatch = /:root\s*\{([^}]*)\}/.exec(css);
  const rootVars = rootMatch ? parseVars(rootMatch[1]) : {};

  // Match blocks like: html[data-look='name'] { ... } or html[data-look='a'], html[data-look='b'] { ... }
  const blockRe = /(html\[data-look='[^']+'\](?:\s*,\s*html\[data-look='[^']+'\])*)\s*\{([^}]*)\}/g;
  const nameRe = /data-look='([^']+)'/g;

  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = blockRe.exec(css)) !== null) {
    const selector = blockMatch[1];
    const body = blockMatch[2];

    // Extract all theme names from the selector (handles comma-separated groups)
    const names: string[] = [];
    nameRe.lastIndex = 0;
    let nameMatch: RegExpExecArray | null;
    while ((nameMatch = nameRe.exec(selector)) !== null) {
      names.push(nameMatch[1]);
    }

    // Parse CSS variable declarations from the block body
    const vars = parseVars(body);

    // Assign vars to each named theme (later blocks override earlier ones)
    for (const name of names) {
      themes[name] = { ...rootVars, ...(themes[name] ?? {}), ...vars };
    }
  }

  return themes;
}

const cssPath = resolve(__dirname, '../styles.css');
const css = readFileSync(cssPath, 'utf8');
const themes = parseThemesFromCss(css);

describe('built-in theme contrast audit', () => {
  it('parses at least 10 themes from styles.css', () => {
    expect(Object.keys(themes).length).toBeGreaterThanOrEqual(10);
  });

  it('applies root defaults to every parsed theme', () => {
    for (const vars of Object.values(themes)) {
      expect(CSS_VARS.every((name) => vars[name] !== undefined)).toBe(true);
    }
  });

  for (const [name, vars] of Object.entries(themes)) {
    it(`${name} — contrast check`, () => {
      const warnings = checkThemeContrast(vars);
      if (warnings.length > 0) {
        console.warn(`\n⚠  ${name}:`);
        for (const w of warnings) {
          console.warn(
            `   ${w.fgVar} on ${w.bgVar}: ${w.ratio.toFixed(2)}:1 (need ${w.required}:1)  fg=${w.fg} bg=${w.bg}`,
          );
        }
      }
      expect(warnings).toEqual([]);
    });
  }
});
