import { HOLDS, SCENES, clamp, inDwell } from './time';

/** A viewer who keeps pushing hurries transitions, but only slightly; reading windows never speed up. */
const HURRY = 1.35;
/** Going back replays the transition in reverse, quicker than forwards; it is never gated. */
const BACK = 1.9;
/** An explicit chapter jump plays the scenes in between at this rate. */
const JUMP = 3.2;

/**
 * Scenes, not scroll. The film rests on each scene's key beat (its hold); a gesture can move past it only
 * after the beat has been on screen for the scene's reading time. Pushes that arrive earlier are
 * remembered — one step at most — and taken the moment the beat has been read, so frantic scrolling can
 * neither skip a scene nor cut its reading time.
 */
export class Navigator {
  T: number;
  K: number;
  rate = 1;
  /** One queued step at most. */
  pending = 0;
  /** The navigator's wall clock (s), advanced by update(). */
  clock = 0;
  /** Wall time the film came to rest on the current key beat; −1 while it moves. */
  restAt = -1;
  lastInput = -1e9;
  private jump = false;
  onTarget: (k: number) => void = () => {};
  /** A push arrived while the key beat is still being read. */
  onHeld: () => void = () => {};

  constructor(T: number, K: number, public reduced = false) {
    this.T = T;
    this.K = K;
  }

  get moving() {
    return Math.abs(HOLDS[this.K] - this.T) > 1e-6;
  }
  get last() {
    return this.K >= HOLDS.length - 1;
  }
  /** 0 → 1 while the key beat is read; 1 means the next gesture is taken. */
  get gate(): number {
    if (this.moving || this.restAt < 0) return 0;
    const r = SCENES[this.K].read;
    return r <= 0 ? 1 : clamp((this.clock - this.restAt) / r, 0, 1);
  }
  /** Seconds the open gate has waited without any input; −1 while closed. */
  get idle(): number {
    if (this.gate < 1 || this.last) return -1;
    const open = this.restAt + SCENES[this.K].read;
    return this.clock - Math.max(open, this.lastInput);
  }

  private setK(k: number) {
    k = clamp(k, 0, HOLDS.length - 1);
    if (k === this.K) return;
    this.K = k;
    this.restAt = -1;
    if (this.reduced) this.T = HOLDS[k];
    this.onTarget(k);
  }

  step(dir: 1 | -1) {
    this.lastInput = this.clock;
    if (dir < 0) {
      if (this.pending > 0) this.pending = 0;
      else {
        this.jump = false;
        this.setK(this.K - 1);
      }
      return;
    }
    if (this.moving && this.T > HOLDS[this.K]) {
      // playing backwards: a forward push turns it round
      this.setK(this.K + 1);
      return;
    }
    if (this.last) return;
    if (!this.moving && this.gate >= 1) {
      this.jump = false;
      this.setK(this.K + 1);
      return;
    }
    this.pending = 1;
    if (!this.moving) this.onHeld();
  }

  /** Chapter jump: an explicit choice, so the scenes in between play through quickly. */
  goTo(k: number) {
    this.lastInput = this.clock;
    this.pending = 0;
    this.jump = Math.abs(k - this.K) > 1 || this.moving;
    this.setK(k);
  }

  update(dt: number) {
    this.clock += dt;
    const target = HOLDS[this.K];
    const d = target - this.T;
    if (Math.abs(d) < 1e-6) {
      this.T = target;
      if (this.restAt < 0) this.restAt = this.clock;
      this.jump = false;
      this.rate += (1 - this.rate) * (1 - Math.exp(-dt * 6));
      if (this.pending > 0 && this.gate >= 1) {
        this.pending = 0;
        this.setK(this.K + 1);
      }
      return;
    }
    const dir = Math.sign(d);
    // a hold strictly between here and the target means a chapter jump
    let far = false;
    for (const h of HOLDS) if ((h - this.T) * dir > 1e-4 && (target - h) * dir > 1e-4) far = true;
    let want = dir < 0 ? BACK : this.jump || far ? JUMP : this.pending > 0 ? HURRY : 1;
    // ease back to 1× before a reading window starts, and never exceed it inside one
    const reading = dir > 0 && !this.jump && !far;
    if (reading && (inDwell(this.T) || inDwell(this.T + 0.4 * this.rate))) want = 1;
    this.rate += (want - this.rate) * (1 - Math.exp(-dt * 7));
    if (reading && inDwell(this.T)) this.rate = Math.min(this.rate, 1);
    const step = this.rate * dt;
    if (step >= Math.abs(d)) this.T = target;
    else this.T += step * dir;
  }
}

/**
 * Input tension as a spring: the stage leans towards the next scene while the viewer pushes (little while
 * the key beat is still being read, more once it may go on), a finger drags it directly, and after idle
 * time the film nudges itself once in a while. The DOM layer turns x into a lift and a peek of the next
 * scene's colour; the cue reads `press` for its squash and stretch.
 */
export class Pull {
  /** px, positive = towards the next scene */
  x = 0;
  private v = 0;
  /** decaying push pressure, −1…1 */
  press = 0;
  drag: number | null = null;
  private nudges = 0;
  private lastIdle = -1;
  /** Seconds into the current nudge; 0 when none plays. */
  private nudgeT = 0;
  /** A short-lived kick when the film refuses or takes a gesture. */
  private kick = 0;

  push(dir: number, mag: number) {
    this.press = clamp(this.press + dir * mag, -1, 1);
  }
  impulse(v: number) {
    this.v += v;
  }
  refuse() {
    this.kick = 1;
  }

  update(dt: number, nav: Navigator | null, reduced: boolean) {
    const open = nav ? nav.gate >= 1 && !nav.moving : false;
    const reach = nav?.last ? 4 : open ? 30 : 10;
    let target = this.press * reach;
    if (this.drag !== null) {
      // rubber band: follows the finger, stiffer the further it goes
      const dd = this.drag;
      target = Math.sign(dd) * Math.min(72, 72 * (1 - Math.exp(-Math.abs(dd) / (open ? 110 : 220))));
    }
    if (nav && !reduced) {
      const idle = nav.idle;
      // any input restarts the idle clock and the nudge count
      if (idle < 0 || idle < this.lastIdle) this.nudges = 0;
      this.lastIdle = idle;
      if (idle > 3.4 + this.nudges * 6.5 && this.nudges < 4 && this.drag === null && Math.abs(this.press) < 0.02) {
        this.nudges++;
        // a small dip first (anticipation), then the lift that shows the next scene underneath
        this.nudgeT = 1e-3;
        this.v -= 90;
      }
    }
    if (this.nudgeT > 0) {
      const before = this.nudgeT;
      this.nudgeT += dt;
      if (before < 0.14 && this.nudgeT >= 0.14) this.v += 460;
      if (this.nudgeT > 0.2) this.nudgeT = 0;
    }
    this.kick = Math.max(0, this.kick - dt * 3.2);
    // stiff enough to feel like a hand on the stage, damped so it settles with one small overshoot
    const k = this.drag !== null ? 900 : 170, c = this.drag !== null ? 60 : 17;
    this.v += (k * (target - this.x) - c * this.v) * dt;
    this.x += this.v * dt;
    if (reduced) this.x = 0;
    this.press *= Math.exp(-dt * 5.5);
  }
  /** 0 → 1 refusal flash for the cue. */
  get refused() {
    return this.kick;
  }
}

export interface InputHooks {
  go: (dir: 1 | -1) => void;
  push: (dir: 1 | -1, mag: number) => void;
  drag: (dy: number | null) => void;
  blocked: () => boolean;
}

/**
 * Wheel, trackpad, touch and keys → one step per gesture. Trailing inertia is ignored; a fresh push
 * inside the inertia tail, or scrolling that keeps going without decaying, counts as a new request.
 * Every raw event also feeds the pull spring, so the stage answers the hand before a scene changes.
 */
export function bindInput(root: HTMLElement, h: InputHooks) {
  let last = -1e9, fireAt = -1e9, fired = false, acc = 0, burstDir = 0;
  const recent: number[] = [];
  addEventListener(
    'wheel',
    (e) => {
      if (h.blocked()) return;
      let dy = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (e.deltaMode === 1) dy *= 16;
      else if (e.deltaMode === 2) dy *= innerHeight;
      const a = Math.abs(dy);
      if (a < 0.5) return;
      const t = e.timeStamp;
      const dir = dy > 0 ? 1 : -1;
      h.push(dir, Math.min(0.35, a / 260));
      if (t - last > 200 || dir !== burstDir) {
        fired = false;
        acc = 0;
        recent.length = 0;
        burstDir = dir;
      }
      last = t;
      let peak = 0;
      for (const r of recent) peak = Math.max(peak, r);
      recent.push(a);
      if (recent.length > 6) recent.shift();
      acc += a;
      if (!fired) {
        if (acc >= 12) {
          fired = true;
          fireAt = t;
          h.go(dir);
        }
        return;
      }
      const fresh = a > peak * 1.6 + 6 && t - fireAt > 260;
      // inertia tails decay to a trickle of 1–2 px; real continued scrolling keeps its magnitude
      const sustained = t - fireAt > 650 && recent.length >= 6 && a >= 10 && a >= 0.8 * (recent[0] + recent[1]) * 0.5;
      if (fresh || sustained) {
        fireAt = t;
        h.go(dir);
      }
    },
    { passive: true },
  );

  let y0 = 0, x0 = 0, touchFired = false, vertical = false;
  root.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1) return;
      y0 = e.touches[0].clientY;
      x0 = e.touches[0].clientX;
      touchFired = false;
      vertical = false;
    },
    { passive: true },
  );
  root.addEventListener(
    'touchmove',
    (e) => {
      if (h.blocked() || e.touches.length !== 1) return;
      const dy = y0 - e.touches[0].clientY, dx = x0 - e.touches[0].clientX;
      if (!vertical && Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx) * 1.2) vertical = true;
      if (!vertical) return;
      h.drag(dy);
      if (!touchFired && Math.abs(dy) > 46) {
        touchFired = true;
        h.go(dy > 0 ? 1 : -1);
      }
    },
    { passive: true },
  );
  const end = () => h.drag(null);
  root.addEventListener('touchend', end, { passive: true });
  root.addEventListener('touchcancel', end, { passive: true });

  addEventListener('keydown', (e) => {
    if (h.blocked() || e.altKey || e.ctrlKey || e.metaKey) return;
    const el = e.target instanceof Element ? e.target : null;
    if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
    const onControl = !!el?.closest('a, button, summary');
    if (e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === 'ArrowRight' || (e.key === ' ' && !onControl)) {
      e.preventDefault();
      h.push(1, 0.3);
      h.go(1);
    } else if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      h.push(-1, 0.3);
      h.go(-1);
    }
  });
}
