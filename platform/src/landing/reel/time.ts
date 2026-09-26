/**
 * The film's one motion system and its scene table. Every scene takes its curves, durations and
 * stagger from here, so the whole film moves with one weight: a quick move prepared by anticipation,
 * travelling on an arc, finishing with overshoot and follow-through, then a hold long enough to read.
 * Every visual is a pure function of film time T, so a scene plays backwards as faithfully as forwards.
 */

/** Motion tokens, in seconds of film time. */
export const M = {
  /** pull back before a move */
  ant: 0.16,
  /** the move itself: fast */
  move: 0.36,
  /** overshoot and settle into the hold */
  settle: 0.5,
  /** a word or shape arriving (move + settle, no anticipation) */
  enter: 0.62,
  /** leaving: anticipation, then accelerate away */
  exit: 0.38,
  /** shape-to-shape transformation, deliberately slow */
  morph: 0.95,
  /** siblings: letters, rows, ticks */
  stagger: 0.045,
  /** groups: a heading, then its list */
  group: 0.1,
  /** no stagger chain may spread wider than this */
  staggerCap: 0.34,
  /** standard overshoot, share of travel */
  over: 0.07,
  /** standard anticipation depth, share of travel */
  pull: 0.08,
} as const;

export interface Scene {
  title: string;
  /** Film time of the scene's key beat, where it rests; the previous hold is where it starts. */
  hold: number;
  /** Wall seconds the key beat stays on screen before a gesture may move past it. */
  read: number;
  /** Reading windows (film time) inside the scene: they play at 1× even when the viewer hurries. */
  dwell?: ReadonlyArray<readonly [number, number]>;
}

// Scene boundaries. Scene 3 is long on purpose: five readings, each transformation slow, each word held.
const H0 = 1.41, H1 = 3.6, H2 = 7.3, H3 = 17.4, H4 = 20.0, H5 = 23.9, H6 = 26.8, H7 = 28.8;
/** Readings scene: morph start times; each morph lasts M.morph and is followed by a dwell. */
export const MORPH_AT = [H2 + 2.55, H2 + 4.6, H2 + 6.65, H2 + 8.7] as const;
const DW = 1.1;

export const SCENES: readonly Scene[] = [
  { title: 'Точка', hold: H0, read: 0.5 },
  { title: 'Отсчёт', hold: H1, read: 1.4 },
  { title: 'Четыре пути', hold: H2, read: 2.2, dwell: [[H1 + 2.3, H1 + 3.0]] },
  {
    title: 'Показания',
    hold: H3,
    read: 1.3,
    dwell: [[H2 + 1.45, H2 + 2.55], ...MORPH_AT.slice(0, 3).map((t) => [t + M.morph, t + M.morph + DW] as const)],
  },
  { title: 'Любая техника', hold: H4, read: 1.7 },
  { title: 'Без связи', hold: H5, read: 2.0, dwell: [[H4 + 0.9, H4 + 1.7]] },
  { title: 'На\u00a0связи', hold: H6, read: 1.0 },
  { title: 'Старт', hold: H7, read: 0 },
];
export const HOLDS = SCENES.map((s) => s.hold);
export const D = HOLDS[HOLDS.length - 1];

/** Index of the scene on screen: segment i is (hold[i-1], hold[i]]. */
export function sceneAt(T: number): number {
  let i = 0;
  while (i < HOLDS.length - 1 && T > HOLDS[i] + 1e-4) i++;
  return i;
}

/** True inside a reading window of any scene. */
export function inDwell(T: number): boolean {
  for (const s of SCENES) if (s.dwell) for (const [a, b] of s.dwell) if (T >= a && T < b) return true;
  return false;
}

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const range = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));
export const smooth = (t: number) => t * t * (3 - 2 * t);
/** Quintic smootherstep: zero velocity and acceleration at both ends — the calmest start and stop. */
export const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
export const inQuad = (t: number) => t * t;
export const inCubic = (t: number) => t * t * t;
export const outCubic = (t: number) => 1 - (1 - t) ** 3;
export const outQuart = (t: number) => 1 - (1 - t) ** 4;
export const inOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
export const inOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;
export const expoOut = (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t));
export const expoIn = (t: number) => (t <= 0 ? 0 : 2 ** (10 * t - 10));
export const expoInOut = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2);
/** Overshoots past 1 and settles back. */
export const backOut = (t: number, s = 1.70158) => {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const x = t - 1;
  return 1 + (s + 1) * x * x * x + s * x * x;
};
/** Pulls back first, then goes. */
export const backIn = (t: number, s = 1.70158) => (t <= 0 ? 0 : t >= 1 ? 1 : (s + 1) * t * t * t - s * t * t);

const springs = new Map<number, { zo: number; wd: number; k: number; end: number }>();
/** Damped oscillation released from 1 with zero velocity, forced to exactly 0 at u = 1. */
function ring(u: number, over: number): number {
  let p = springs.get(over);
  if (!p) {
    // damping ratio from the overshoot the curve is asked to show on its first swing
    const ln = Math.log(Math.max(1e-4, over));
    const zeta = -ln / Math.sqrt(Math.PI * Math.PI + ln * ln);
    // decay rate fixed at 6 per unit so a settle fills its share of the gesture instead of dying early
    const omega = 6 / Math.max(0.2, zeta);
    const wd = omega * Math.sqrt(Math.max(1e-6, 1 - zeta * zeta));
    const zo = zeta * omega;
    const raw = (x: number) => Math.exp(-zo * x) * (Math.cos(wd * x) + (zo / wd) * Math.sin(wd * x));
    p = { zo, wd, k: zo / wd, end: raw(1) };
    springs.set(over, p);
  }
  if (u >= 1) return 0;
  const v = Math.exp(-p.zo * u) * (Math.cos(p.wd * u) + p.k * Math.sin(p.wd * u));
  return v - p.end * u * u * u;
}

/**
 * The film's gesture, 0 → 1 over x ∈ [0, 1]: anticipation (dips to −pull), a fast move that
 * overshoots to 1 + over, then a spring settle onto 1. Velocity is continuous at every joint.
 * `a` and `b` are the shares of anticipation and move; the rest is the settle.
 */
export function swing(x: number, pull: number = M.pull, over: number = M.over, a = 0.24, b = 0.36): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (x < a) {
    const s = Math.sin((Math.PI / 2) * (x / a));
    return -pull * s * s;
  }
  if (x < a + b) {
    const u = (x - a) / b;
    return lerp(-pull, 1 + over, u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2);
  }
  return 1 + over * ring((x - a - b) / (1 - a - b), over);
}

/** Arrival: fast move, overshoot, settle. No anticipation — for things entering the frame. */
export const arrive = (x: number, over: number = M.over) => swing(x, 0, over, 0, 0.42);

/** Exit: a small pull back, then acceleration away; ends at full speed, so the cut carries it on. */
export function leave(x: number, pull: number = M.pull, a = 0.3): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (x < a) {
    const s = Math.sin((Math.PI / 2) * (x / a));
    return -pull * s * s;
  }
  const u = (x - a) / (1 - a);
  return lerp(-pull, 1, u * u);
}

/** Slow and pleasant: smootherstep with a whisper of overshoot for the readings' transformations. */
export function glide(x: number, over = 0.025): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const main = 0.78;
  if (x < main) return (1 + over) * smoother(x / main);
  return 1 + over * ring((x - main) / (1 - main), 0.2);
}

/** Start of item i of n in a stagger chain, never spreading wider than `cap`. */
export const stag = (i: number, n: number, step: number = M.stagger, cap: number = M.staggerCap) => i * (n > 1 ? Math.min(step, cap / (n - 1)) : step);

/**
 * Point on a quadratic arc from (x0, y0) to (x1, y1) at t; the control point sits off the chord's
 * midpoint by bend × chord length (positive bends to the left of the travel direction, i.e. up for
 * left-to-right travel on screen). Writes out[0], out[1].
 */
export function arc(x0: number, y0: number, x1: number, y1: number, bend: number, t: number, out: Float32Array | number[]) {
  const dx = x1 - x0, dy = y1 - y0;
  const cx = (x0 + x1) / 2 + dy * bend, cy = (y0 + y1) / 2 - dx * bend;
  const it = 1 - t;
  out[0] = it * it * x0 + 2 * it * t * cx + t * t * x1;
  out[1] = it * it * y0 + 2 * it * t * cy + t * t * y1;
}

/** Damped spring over a normalised duration: overshoots by `overshoot`, lands exactly on 1 at x = 1. */
export const settle = (x: number, overshoot = 0.08) => (x <= 0 ? 0 : x >= 1 ? 1 : 1 - ring(x, overshoot));

/** Value of a mass dropped from `height`: bounces `count` times, rests on 0 at x = 1. */
export function bounce(x: number, height = 1, count = 2): number {
  if (x <= 0 || x >= 1) return 0;
  let t = x, h = height, len = 0.55;
  for (let i = 0; i <= count; i++) {
    if (t < len) return h * 4 * (t / len) * (1 - t / len);
    t -= len;
    h *= 0.3;
    len *= 0.55;
  }
  return 0;
}

/** Rate of change of f at T (per second), for motion blur. */
export function speed(f: (T: number) => number, T: number): number {
  return (f(T + 1 / 240) - f(T - 1 / 240)) * 120;
}
