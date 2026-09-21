let seq = 0;

/** Short, sortable-enough unique id. Not persisted-format-sensitive in v1 (no server sync). */
export function genId(prefix: string): string {
  seq += 1;
  return `${prefix}_${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
