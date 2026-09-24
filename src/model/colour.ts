// Phase 5.2 item 26: a fill's opacity travels inside its stored colour (#rrggbbaa), so every
// renderer that already draws `doc.fills` (Construct and Repeat) honours it with no extra state.

export function withAlpha(colour: string, alpha: number): string {
  const rgb = colourRgb(colour);
  if (alpha >= 0.995) return rgb;
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${rgb}${a}`;
}

/** The #rrggbb part — for comparing against palette swatches regardless of opacity. */
export function colourRgb(colour: string): string {
  return /^#[0-9a-f]{8}$/i.test(colour) ? colour.slice(0, 7) : colour;
}

export function colourAlpha(colour: string): number {
  return /^#[0-9a-f]{8}$/i.test(colour) ? parseInt(colour.slice(7, 9), 16) / 255 : 1;
}
