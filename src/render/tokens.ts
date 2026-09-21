// Design tokens, spec §11 — verified against the approved visual design artifact.

export const color = {
  plaster: '#F3EFE7',
  paper: '#FBF9F5',
  well: '#E8E2D6',
  hairline: '#DCD5C8',
  ink: '#1E2A36',
  muted: '#56606B',
  construction: '#8E98A3',
  brass: '#8C5E1C',
  brassLight: '#EADBBE',
  signal: '#2F5BEA',
  signalLight: '#DCE4FC',
  pointStroke: '#9AA3AD',
} as const;

export const stroke = {
  construction: 0.9,
  extensionDash: [4, 4] as [number, number],
  previewDash: [5, 4] as [number, number],
  fairDefault: 2.5,
};

export const radii = {
  dock: 20,
  sheet: 24,
  contextBar: 16,
  chip: 12,
  minTouchTarget: 44,
};

export const font = {
  title: `'Newsreader', Georgia, serif`,
  ui: `'Bricolage Grotesque', 'Helvetica Neue', system-ui, sans-serif`,
  mono: `'JetBrains Mono', ui-monospace, monospace`,
};

/** Phase 3I: representative swatches for the approved palette names — a minimal stroke colour
 * selector, not the full ≤8-colour palette editor (deferred with Fill/Repeat). "Mine" is a
 * custom colour input, not a fixed swatch, so it isn't listed here. */
export const fairPalette: { name: string; colour: string }[] = [
  { name: 'Lapis & Zellige', colour: '#1E3A6E' },
  { name: 'Terracotta', colour: '#B5502E' },
  { name: 'Monsoon', colour: '#3F6B5E' },
  { name: 'Sindoor', colour: '#C6402C' },
  { name: 'Athangudi', colour: '#C98A2C' },
  { name: 'Channapatna', colour: '#8B3A62' },
];
