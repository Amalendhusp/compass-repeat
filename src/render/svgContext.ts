// Phase 5.3 items 14/16/17: SVG export by recording the SAME draw calls the canvas renderers make.
// The artwork renderers are written against CanvasRenderingContext2D; this implements just the
// subset they use when drawing artwork (paths, arcs, stroke/fill, alpha, dashes, caps, save/restore,
// a background rect) and turns each stroke/fill into an SVG element. Because the PNG and the SVG
// come from one code path, they can't disagree with each other or with the screen about
// composition, stroke grade or opacity. Opacity stays real SVG opacity (fill-opacity /
// stroke-opacity from the colour's own alpha × globalAlpha) — never baked against the background.

const TWO_PI = Math.PI * 2;

function n(v: number): string {
  return (Math.round(v * 100) / 100).toString();
}

/** '#rrggbb' / '#rrggbbaa' / '#rgb' → an rgb colour plus its own alpha. */
function parseColour(c: string): { rgb: string; alpha: number } {
  const hex = c.trim();
  if (/^#[0-9a-f]{8}$/i.test(hex)) return { rgb: hex.slice(0, 7), alpha: parseInt(hex.slice(7, 9), 16) / 255 };
  if (/^#[0-9a-f]{3}$|^#[0-9a-f]{6}$/i.test(hex)) return { rgb: hex, alpha: 1 };
  return { rgb: hex, alpha: 1 };
}

/** A path under construction, in SVG path syntax — also stands in for Path2D (see makePath). */
export class SvgPath {
  d: string[] = [];
  private hasPoint = false;

  moveTo(x: number, y: number): void {
    this.d.push(`M${n(x)} ${n(y)}`);
    this.hasPoint = true;
  }

  lineTo(x: number, y: number): void {
    this.d.push(`${this.hasPoint ? 'L' : 'M'}${n(x)} ${n(y)}`);
    this.hasPoint = true;
  }

  closePath(): void {
    this.d.push('Z');
  }

  /** Canvas arc() semantics exactly: joins from the current point with a line, sweeps clockwise
   * (increasing angle, y-down) unless `anticlockwise`, and draws a full circle once the requested
   * span reaches a whole turn. */
  arc(x: number, y: number, r: number, a0: number, a1: number, anticlockwise = false): void {
    const sx = x + r * Math.cos(a0);
    const sy = y + r * Math.sin(a0);
    this.lineTo(sx, sy);
    const full = anticlockwise ? a0 - a1 >= TWO_PI - 1e-9 : a1 - a0 >= TWO_PI - 1e-9;
    const sweepFlag = anticlockwise ? 0 : 1;
    if (full) {
      const mid = a0 + (anticlockwise ? -Math.PI : Math.PI);
      this.d.push(`A${n(r)} ${n(r)} 0 1 ${sweepFlag} ${n(x + r * Math.cos(mid))} ${n(y + r * Math.sin(mid))}`);
      this.d.push(`A${n(r)} ${n(r)} 0 1 ${sweepFlag} ${n(sx)} ${n(sy)}`);
      return;
    }
    const raw = anticlockwise ? a0 - a1 : a1 - a0;
    const delta = ((raw % TWO_PI) + TWO_PI) % TWO_PI;
    if (delta < 1e-9) return;
    this.d.push(`A${n(r)} ${n(r)} 0 ${delta > Math.PI ? 1 : 0} ${sweepFlag} ${n(x + r * Math.cos(a1))} ${n(y + r * Math.sin(a1))}`);
  }

  toString(): string {
    return this.d.join('');
  }
}

interface DrawState {
  strokeStyle: string;
  fillStyle: string;
  lineWidth: number;
  globalAlpha: number;
  lineCap: string;
  lineJoin: string;
  dash: number[];
}

export class SvgContext {
  private body: string[] = [];
  private path = new SvgPath();
  private state: DrawState = { strokeStyle: '#000000', fillStyle: '#000000', lineWidth: 1, globalAlpha: 1, lineCap: 'butt', lineJoin: 'miter', dash: [] };
  private stack: DrawState[] = [];

  readonly width: number;
  readonly height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  get strokeStyle(): string {
    return this.state.strokeStyle;
  }
  set strokeStyle(v: string) {
    this.state.strokeStyle = v;
  }
  get fillStyle(): string {
    return this.state.fillStyle;
  }
  set fillStyle(v: string) {
    this.state.fillStyle = v;
  }
  get lineWidth(): number {
    return this.state.lineWidth;
  }
  set lineWidth(v: number) {
    this.state.lineWidth = v;
  }
  get globalAlpha(): number {
    return this.state.globalAlpha;
  }
  set globalAlpha(v: number) {
    this.state.globalAlpha = v;
  }
  get lineCap(): string {
    return this.state.lineCap;
  }
  set lineCap(v: string) {
    this.state.lineCap = v;
  }
  get lineJoin(): string {
    return this.state.lineJoin;
  }
  set lineJoin(v: string) {
    this.state.lineJoin = v;
  }

  setLineDash(dash: number[]): void {
    this.state.dash = [...dash];
  }
  save(): void {
    this.stack.push({ ...this.state, dash: [...this.state.dash] });
  }
  restore(): void {
    const s = this.stack.pop();
    if (s) this.state = s;
  }

  beginPath(): void {
    this.path = new SvgPath();
  }
  moveTo(x: number, y: number): void {
    this.path.moveTo(x, y);
  }
  lineTo(x: number, y: number): void {
    this.path.lineTo(x, y);
  }
  closePath(): void {
    this.path.closePath();
  }
  arc(x: number, y: number, r: number, a0: number, a1: number, anticlockwise?: boolean): void {
    this.path.arc(x, y, r, a0, a1, anticlockwise);
  }

  clearRect(): void {
    // The export starts from nothing; a clear is a no-op.
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    const { rgb, alpha } = parseColour(this.state.fillStyle);
    this.body.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="${rgb}"${this.opacityAttr('fill', alpha)}/>`);
  }

  stroke(path?: SvgPath): void {
    const d = (path ?? this.path).toString();
    if (!d) return;
    const { rgb, alpha } = parseColour(this.state.strokeStyle);
    const s = this.state;
    const dash = s.dash.length ? ` stroke-dasharray="${s.dash.map(n).join(' ')}"` : '';
    const cap = s.lineCap !== 'butt' ? ` stroke-linecap="${s.lineCap}"` : '';
    const join = s.lineJoin !== 'miter' ? ` stroke-linejoin="${s.lineJoin}"` : '';
    this.body.push(`<path d="${d}" fill="none" stroke="${rgb}" stroke-width="${n(s.lineWidth)}"${this.opacityAttr('stroke', alpha)}${dash}${cap}${join}/>`);
  }

  fill(pathOrRule?: SvgPath | CanvasFillRule, rule?: CanvasFillRule): void {
    const path = pathOrRule instanceof SvgPath ? pathOrRule : this.path;
    const fillRule = (pathOrRule instanceof SvgPath ? rule : pathOrRule) ?? 'nonzero';
    const d = path.toString();
    if (!d) return;
    const { rgb, alpha } = parseColour(this.state.fillStyle);
    this.body.push(`<path d="${d}" fill="${rgb}"${this.opacityAttr('fill', alpha)}${fillRule === 'evenodd' ? ' fill-rule="evenodd"' : ''}/>`);
  }

  private opacityAttr(kind: 'fill' | 'stroke', colourAlpha: number): string {
    const a = Math.max(0, colourAlpha * this.state.globalAlpha);
    return a < 0.999 ? ` ${kind}-opacity="${Math.round(a * 1000) / 1000}"` : '';
  }

  toSvg(): string {
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${n(this.width)}" height="${n(this.height)}" viewBox="0 0 ${n(this.width)} ${n(this.height)}">`,
      ...this.body,
      '</svg>',
    ].join('\n');
  }
}

/** The renderers create their standalone paths through this, so the same drawing code builds a
 * real Path2D on a canvas and an SvgPath when recording an SVG. */
export function makePath(ctx: CanvasRenderingContext2D): Path2D {
  return (ctx as unknown) instanceof SvgContext ? (new SvgPath() as unknown as Path2D) : new Path2D();
}
