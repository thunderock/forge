import * as monaco from 'monaco-editor';
import type { LookPreset } from './look';

interface PresetColors {
  bgElevated: string;
  fg: string;
  fgMuted: string;
  fgSubtle: string;
  border: string;
  accent: string;
  base?: 'vs' | 'vs-dark';
}

// Colors are generally derived from the CSS variables in src/styles.css for each look preset,
// but may intentionally diverge (e.g. midnight uses #000 editor background for OLED).
// Diff highlight colors use the GitHub Dark palette (shared across all presets).
const graphiteColors: PresetColors = {
  bgElevated: '#1c2630',
  fg: '#d7e4f0',
  fgMuted: '#9bb0c3',
  fgSubtle: '#678197',
  border: '#2e3e50',
  accent: '#ff6a2c',
};

const presetColors: Record<LookPreset, PresetColors> = {
  classic: {
    bgElevated: '#2d2e32',
    fg: '#cccdd2',
    fgMuted: '#8b8d93',
    fgSubtle: '#6d7076',
    border: '#393b3f',
    accent: '#4267ff',
  },
  graphite: graphiteColors,
  midnight: {
    ...graphiteColors,
    bgElevated: '#000000',
  },
  indigo: {
    bgElevated: '#1c2038',
    fg: '#deddff',
    fgMuted: '#b1b2de',
    fgSubtle: '#8286b6',
    border: '#384270',
    accent: '#7a78ff',
  },
  ember: {
    bgElevated: '#211918',
    fg: '#f2ddd1',
    fgMuted: '#d5ab94',
    fgSubtle: '#9f7561',
    border: '#4e3831',
    accent: '#ff944d',
  },
  glacier: {
    bgElevated: '#232e3a',
    fg: '#e5eff5',
    fgMuted: '#bed2dc',
    fgSubtle: '#92aebb',
    border: '#3b5363',
    accent: '#50e2d3',
  },
  minimal: {
    bgElevated: '#252520',
    fg: '#e8e8e8',
    fgMuted: '#b8b8b8',
    fgSubtle: '#909090',
    border: '#2a2925',
    accent: '#c8bfa0',
  },
  zenburnesque: {
    bgElevated: '#2e2d2a',
    fg: '#dcdccc',
    fgMuted: '#a0a090',
    fgSubtle: '#7f8f7f',
    border: '#484640',
    accent: '#cc9393',
  },
  'catppuccin-mocha': {
    bgElevated: '#1e1e2e',
    fg: '#cdd6f4',
    fgMuted: '#a6adc8',
    fgSubtle: '#7f849c',
    border: '#45475a',
    accent: '#cba6f7',
  },
  'islands-dark': {
    bgElevated: '#181a1d',
    fg: '#bcbec4',
    fgMuted: '#9a9da4',
    fgSubtle: '#7a7e85',
    border: '#2c2f34',
    accent: '#286cf5',
  },
  'islands-light': {
    bgElevated: '#ffffff',
    fg: '#1f2329',
    fgMuted: '#5e6066',
    fgSubtle: '#8d9199',
    border: '#d3d5db',
    accent: '#2c6def',
    base: 'vs',
  },
  workbench: {
    bgElevated: '#1f1f1f',
    fg: '#cccccc',
    fgMuted: '#969696',
    fgSubtle: '#6c6c6c',
    border: '#2b2b2b',
    accent: '#0078d4',
  },
};

function buildThemeData(c: PresetColors): monaco.editor.IStandaloneThemeData {
  const isLight = c.base === 'vs';
  return {
    base: c.base ?? 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: c.fgSubtle.slice(1) },
      { token: 'keyword', foreground: c.accent.slice(1) },
    ],
    colors: {
      'editor.background': c.bgElevated,
      'editor.foreground': c.fg,
      'editor.lineHighlightBackground': isLight ? '#00000008' : '#ffffff06',
      'editorLineNumber.foreground': c.fgSubtle,
      'editorLineNumber.activeForeground': c.fgMuted,
      'editor.selectionBackground': c.accent + '33',
      'editorWidget.background': c.bgElevated,
      'editorWidget.border': c.border,
      // GitHub-inspired diff palette
      'diffEditor.insertedLineBackground': isLight ? '#2ea04322' : '#2ea04315',
      'diffEditor.removedLineBackground': isLight ? '#f8514922' : '#f8514915',
      'diffEditor.insertedTextBackground': '#2ea04340',
      'diffEditor.removedTextBackground': '#f8514940',
      'diffEditorGutter.insertedLineBackground': '#2ea04326',
      'diffEditorGutter.removedLineBackground': '#f8514926',
      'diffEditor.unchangedRegionBackground': c.border,
      'diffEditor.unchangedRegionForeground': c.fgMuted,
      'diffEditor.unchangedRegionShadow': '#00000000',
      'scrollbarSlider.background': c.fgSubtle + '40',
      'scrollbarSlider.hoverBackground': c.fgSubtle + '60',
    },
  };
}

export function monacoThemeName(preset: LookPreset): string {
  return `parallel-${preset}`;
}

export function registerMonacoThemes(): void {
  for (const [preset, colors] of Object.entries(presetColors)) {
    monaco.editor.defineTheme(monacoThemeName(preset as LookPreset), buildThemeData(colors));
  }
}
