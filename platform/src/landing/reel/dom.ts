/**
 * DOM overlay of the reel: the opening logo (CSS on first load, then driven by T), words placed from the
 * shared layout, the final panel, and the HUD — where you are, what is next, and the cue that teaches
 * the controls by moving. Only transform and opacity change per frame; each write is skipped when unchanged.
 */
import { D, HOLDS, M, SCENES, arrive, clamp01, expoIn, inOutCubic, leave, range, sceneAt, smooth, stag } from './time';
import { L, OUT, PEEK } from './scenes';
import type { Navigator, Pull } from './nav';

const H = HOLDS;
const IT = ['моточасы', 'масло', 'местоположение', 'пробег', 'в\u00a0одном кабинете'];
const DATA = [
  'от\u00a0трекера или с\u00a0панели по\u00a0фото счётчика',
  'уровень, давление и\u00a0температура\u00a0— если машина их передаёт',
  'по\u00a0трекеру или телефону в\u00a0кабине',
  'отсекаем дрожание сигнала на\u00a0стоянке',
  'владелец видит свои машины, дистрибьютор\u00a0— клиентов, FUCHS\u00a0— всю сеть',
];
/** Film windows in which each scene's DOM layer is on screen. */
const WIN: Array<[number, number]> = [
  [-1, 1.87],
  [2.6, H[1] + 0.2],
  [H[1] + 0.8, H[2] + 0.3],
  [H[2] + 0.9, H[3] + 0.3],
  [H[3] + 1.5, H[4] + 0.2],
  [H[4] + 0.3, H[5]],
  [H[5] + 1e-4, H[6]],
  [H[6] + 0.9, 99],
];
const hexCss = (c: readonly number[]) => `rgb(${Math.round(c[0] * 255)} ${Math.round(c[1] * 255)} ${Math.round(c[2] * 255)})`;

export class Overlay {
  private sc: HTMLElement[];
  private on: boolean[];
  private pin = new Map<string, HTMLElement>();
  private last = new Map<Element, string>();
  private lastO = new Map<Element, string>();
  private text = new Map<Element, string>();
  private mi = new Map<string, HTMLElement | null>();
  private s0: { root: HTMLElement; ring: HTMLElement; dot: SVGSVGElement; knock: SVGCircleElement; orbit: HTMLElement; spin: SVGSVGElement; thin: HTMLElement };
  private spin0 = 0;
  private spinAt = 0;
  private hud: { n: HTMLElement; title: HTMLElement; fill: HTMLElement; chapters: HTMLButtonElement[]; live: HTMLElement; cue: HTMLButtonElement; ticks: SVGElement[]; dot: SVGGElement; ring: SVGGElement };
  private lift: HTMLElement;
  private peek: HTMLElement;
  private rises: HTMLElement[];
  private s2note: HTMLElement | null;
  private s3a: HTMLElement | null;
  private s3b: HTMLElement | null;
  private s3data: HTMLElement | null;
  private s4list: HTMLElement | null;
  private s4w: HTMLElement[];
  private s5state: HTMLElement | null;
  private s5n: HTMLElement | null;
  private cur = -1;
  private dark = true;
  private lit = -1;
  private peekK = -1;
  private spin = 0;
  private tagW = 0;
  onChapter: (k: number) => void = () => {};
  onCue: () => void = () => {};

  constructor(private reduced: boolean) {
    const q = <T extends Element>(s: string) => document.querySelector<T>(s)!;
    const qa = <T extends Element>(s: string, el: ParentNode = document) => Array.from(el.querySelectorAll<T>(s));
    this.sc = qa<HTMLElement>('.sc');
    this.on = this.sc.map(() => false);
    for (const el of qa<HTMLElement>('[data-p]')) this.pin.set(el.dataset.p!, el);
    for (const [k, el] of this.pin) this.mi.set(k, el.querySelector<HTMLElement>('.mi'));
    const r = q<HTMLElement>('.s0');
    this.s0 = {
      root: r,
      ring: r.querySelector('.s0-ring')!,
      dot: r.querySelector('.s0-dot')!,
      knock: r.querySelector('.s0-knock')!,
      orbit: r.querySelector('.s0-orbit')!,
      spin: r.querySelector('.s0-orbit svg')!,
      thin: r.querySelector('.s0-thin')!,
    };
    const chapters = q<HTMLElement>('[data-hud-chapters]');
    const cue = q<HTMLButtonElement>('[data-cue]');
    this.hud = {
      n: q('[data-hud-n]'),
      title: q('[data-hud-title]'),
      fill: q('[data-hud-fill]'),
      chapters: SCENES.map((s, i) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('aria-label', `Сцена ${i + 1} из\u00a0${SCENES.length}: ${s.title}`);
        b.addEventListener('click', () => this.onChapter(i));
        li.append(b);
        chapters.append(li);
        return b;
      }),
      live: q('[data-live]'),
      cue,
      ticks: qa<SVGElement>('.cue__t', cue),
      dot: cue.querySelector<SVGGElement>('.cue__dot')!,
      ring: cue.querySelector<SVGGElement>('.cue__ring')!,
    };
    cue.addEventListener('click', () => this.onCue());
    this.lift = q('.lift');
    this.peek = q('.peek');
    this.rises = qa<HTMLElement>('.s7 [data-rise]');
    this.s2note = document.querySelector<HTMLElement>('.s2-note');
    this.s3a = this.pin.get('s3word')?.querySelector('[data-w="a"]') ?? null;
    this.s3b = this.pin.get('s3word')?.querySelector('[data-w="b"]') ?? null;
    this.s3data = this.pin.get('s3word')?.querySelector<HTMLElement>('.s3-data') ?? null;
    this.s4list = document.querySelector<HTMLElement>('[data-s4-list]');
    this.s4w = qa<HTMLElement>('.s4-w');
    this.s5state = this.pin.get('s5tag')?.querySelector('[data-s5-state]') ?? null;
    this.s5n = this.pin.get('s5tag')?.querySelector('[data-s5-n]') ?? null;
    markDevice();
  }

  private tf(el: Element, v: string) {
    if (this.last.get(el) !== v) {
      this.last.set(el, v);
      (el as HTMLElement).style.transform = v;
    }
  }
  private op(el: Element, a: number) {
    const v = a >= 0.999 ? '1' : a <= 0.001 ? '0' : a.toFixed(3);
    if (this.lastO.get(el) !== v) {
      this.lastO.set(el, v);
      (el as HTMLElement).style.opacity = v;
    }
  }
  private txt(el: Element, v: string): boolean {
    if (this.text.get(el) !== v) {
      this.text.set(el, v);
      el.textContent = v;
      return true;
    }
    return false;
  }
  /** Pins an element at (x, y) with an alignment offset in % of its own box. */
  private at(key: string, x: number, y: number, ax = 0, ay = 0, a = 1) {
    const el = this.pin.get(key);
    if (!el) return;
    this.tf(el, `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) translate(${ax}%,${ay}%)`);
    this.op(el, a);
  }
  /** Masked rise of the .mi inside an element: p 0 → hidden below, 1 → in place, >1 overshoot; out > 0 leaves upwards. */
  private rise(key: string, p: number, out = 0) {
    const el = this.mi.get(key);
    if (el) this.tf(el, `translate3d(0,${((1 - p) * 110 - out * 115).toFixed(2)}%,0)`);
  }

  /** First load: the CSS intro has played; from here the logo is driven by film time. */
  takeover(nowS: number) {
    const a = this.s0.spin.getAnimations()[0];
    if (a && typeof a.currentTime === 'number') this.spin0 = ((a.currentTime - 900) / 18000) * 360;
    this.spinAt = nowS;
    this.s0.root.classList.remove('is-css');
  }

  announce(k: number) {
    this.hud.live.textContent = `Сцена ${k + 1} из\u00a0${SCENES.length}: ${SCENES[k].title}`;
  }

  update(T: number, now: number, nav: Navigator | null, pull: Pull | null) {
    const K = nav ? nav.K : 0;
    for (let i = 0; i < this.sc.length; i++) {
      const [a, b] = WIN[i];
      const show = (T >= a && T <= b) || (i === K && Math.abs(T - H[K]) < 1e-4);
      if (show !== this.on[i]) {
        this.on[i] = show;
        this.sc[i].classList.toggle('on', show);
      }
    }
    if (this.on[0]) this.scene0(T, now);
    if (this.on[1]) this.scene1(T);
    if (this.on[2]) this.scene2(T);
    if (this.on[3]) this.scene3(T);
    if (this.on[4]) this.scene4(T);
    if (this.on[5]) this.scene5(T);
    if (this.on[7]) this.scene7(T);
    this.hudUpdate(T, now, nav, pull);
  }

  private scene0(T: number, now: number) {
    const s = this.s0;
    const a = range(T, H[0], 1.64), c = range(T, 1.64, 1.86);
    // anticipation: the ring breathes out before it collapses into the dot
    this.tf(s.ring, `scale(${((1 + 0.07 * smooth(a)) * (1 - expoIn(c))).toFixed(4)})`);
    const e = inOutCubic(c);
    this.tf(s.dot, `translate(${(-13.125 * e).toFixed(3)}%,${(22.73 * e).toFixed(3)}%)`);
    s.knock.setAttribute('r', (8.8 - 2.4 * c).toFixed(2));
    this.op(s.orbit, 1 - range(T, H[0], 1.62));
    this.tf(s.orbit, `translate(-50%,-50%) scale(${(1 + 0.25 * a).toFixed(4)})`);
    const ang = this.reduced ? 0 : this.spin0 + (now - this.spinAt) * 20;
    this.tf(s.spin, `rotate(${ang.toFixed(2)}deg)`);
    this.op(s.thin, 0.3 * (1 - range(T, 1.5, 1.8)));
    this.tf(s.thin, `translate(-50%,-50%) scale(${(1 + 0.12 * a).toFixed(4)})`);
  }

  private scene1(T: number) {
    const u = OUT.wmU, fade = 1 - range(T, H[1], H[1] + 0.12);
    const lab = arrive(range(T, 2.78, 3.2), 0.1);
    this.at('s1l', OUT.wmX0, OUT.ruleY - 12 + (1 - lab) * 10, 0, -100, Math.min(1, lab) * fade);
    // on a phone only one caption fits over the rule: centre it
    this.at('s1r', L.portrait ? L.cx : OUT.wmX1, OUT.ruleY - 12 + (1 - lab) * 10, L.portrait ? -50 : -100, -100, Math.min(1, lab) * fade);
    this.at('s1u', L.cx, OUT.wmBase + (L.portrait ? 26 : 34) * u + 8, -50, 0, 1);
    this.rise('s1u', arrive(range(T, 2.86, 2.86 + M.enter), 0.12), leave(range(T, H[1], H[1] + 0.2), 0.1));
    const sub = this.pin.get('s1u')?.querySelector('.mono');
    if (sub) this.op(sub, range(T, 3.06, 3.36) * fade);
  }

  private scene2(T: number) {
    const out = range(T, H[2], H[2] + 0.16);
    const fade = 1 - out;
    const P = L.portrait, W = L.W, Hh = L.H;
    const x0 = P ? W * 0.08 : W * 0.06;
    this.at('s2h', x0, Hh * (P ? 0.12 : 0.13), 0, 0, fade);
    this.rise('s2h', arrive(range(T, H[1] + 0.95, H[1] + 0.95 + M.enter), 0.1), leave(out, 0.1));
    if (this.s2note) this.op(this.s2note, range(T, H[1] + 1.2, H[1] + 1.5));
    const s = OUT.icon;
    for (let i = 0; i < 4; i++) {
      const t0 = H[1] + 1.0 + stag(i, 4, 0.08);
      const p = arrive(range(T, t0, t0 + M.enter), 0.1);
      const y = OUT.srcY[i] + (1 - p) * 12;
      if (P) this.at(`src${i}`, OUT.srcX[i], y + s + 12, -50, 0, Math.min(1, p) * fade);
      else this.at(`src${i}`, OUT.srcX[i] + s * 1.5, y, 0, -50, Math.min(1, p) * fade);
    }
    const cab = arrive(range(T, H[1] + 1.3, H[1] + 1.3 + M.enter), 0.1);
    const cabFade = 1 - range(T, H[2], H[2] + 0.1);
    this.at('s2cab', OUT.cabX - OUT.cabW / 2 + Math.max(8, OUT.cabW * 0.04), OUT.cabY - OUT.cabH / 2 + Math.max(22, OUT.cabH * 0.14) / 2, 0, -50, Math.min(1, cab) * cabFade);
    const off = this.pin.get('s2off');
    if (off) {
      const ox = P ? OUT.srcX[2] : OUT.srcX[2] + s * 1.5;
      const oy = P ? OUT.srcY[2] - s - 10 : OUT.srcY[2] - s * 1.35;
      this.at('s2off', ox, oy, P ? -50 : 0, -100, OUT.phoneOff * fade);
    }
  }

  private scene3(T: number) {
    const vis = range(T, H[2] + 0.95, H[2] + 1.25) * (1 - range(T, H[3], H[3] + 0.15));
    const { s3x: x, s3y: y, s3R: R } = OUT;
    const j = Math.max(0, Math.min(4, OUT.reading));
    this.at('s3word', x, y + R * (L.portrait ? 2.2 : 2.25), -50, 0, vis);
    // the reading's source slides under the word each time it changes
    const dt = OUT.readingT;
    const dIn = arrive(range(dt, 0.35, 1), 0.1);
    if (this.s3data) {
      this.txt(this.s3data, DATA[j]);
      this.tf(this.s3data, `translate3d(0,${((1 - dIn) * 10).toFixed(2)}px,0)`);
      this.op(this.s3data, Math.min(1, j === 0 && OUT.reading === 0 ? range(T, H[2] + 1.1, H[2] + 1.4) : dIn));
    }
    const a = this.s3a, b = this.s3b;
    if (a && b) {
      const prev = OUT.reading > 0 ? OUT.readingPrev : 0;
      this.txt(a, IT[prev]);
      this.txt(b, IT[j]);
      // the old word leaves upwards with a small pull, the new one rises and settles; they never overlap
      const eo = leave(range(dt, 0, 0.45), 0.06), ei = arrive(range(dt, 0.3, 1), 0.1);
      this.tf(a, `translate3d(0,${(-120 * eo).toFixed(2)}%,0)`);
      this.tf(b, `translate3d(0,${(j === prev ? 0 : (1 - ei) * 110).toFixed(2)}%,0)`);
      this.op(a, j === prev ? 0 : 1 - range(dt, 0.2, 0.45));
      if (OUT.reading === 0) this.tf(b, `translate3d(0,${((1 - arrive(range(T, H[2] + 0.95, H[2] + 0.95 + M.enter), 0.1)) * 110).toFixed(2)}%,0)`);
    }
  }

  private scene4(T: number) {
    const fade = 1 - range(T, H[4], H[4] + 0.14);
    const P = L.portrait;
    const x0 = P ? L.W * 0.08 : L.W * 0.06;
    this.at('s4h', x0, L.H * (P ? 0.115 : 0.14), 0, 0, fade);
    this.rise('s4h', arrive(range(T, H[3] + 1.6, H[3] + 1.6 + M.enter), 0.1), leave(range(T, H[4], H[4] + 0.2), 0.1));
    if (this.s4list) this.op(this.s4list, fade);
    for (let i = 0; i < this.s4w.length; i++) {
      const t0 = H[3] + 1.78 + stag(i, 4, 0.09);
      const p = arrive(range(T, t0, t0 + M.enter), 0.12);
      this.tf(this.s4w[i], `translate3d(0,${((1 - p) * 110).toFixed(2)}%,0)`);
    }
  }

  private scene5(T: number) {
    const P = L.portrait;
    const x0 = P ? L.W * 0.08 : L.W * 0.06;
    this.at('s5big', x0, L.H * (P ? 0.115 : 0.14), 0, 0, 1);
    this.rise('s5big', arrive(range(T, H[4] + 0.45, H[4] + 0.45 + M.enter), 0.1));
    const sub = this.pin.get('s5big')?.querySelectorAll<HTMLElement>('.s5-sub');
    if (sub) for (let i = 0; i < sub.length; i++) this.op(sub[i], range(T, H[4] + 0.75 + i * 0.35, H[4] + 1.05 + i * 0.35));
    const tag = this.pin.get('s5tag');
    let tw = this.tagW;
    if (tag && this.s5state && this.s5n) {
      const n = OUT.stored, sent = OUT.sent;
      const done = OUT.inCover && n === 0 && sent > 0;
      const a = this.txt(this.s5state, !OUT.inCover ? 'нет сети · точки в\u00a0памяти' : n > 0 ? 'сеть есть · досылаем' : 'точки в\u00a0кабинете');
      const b = this.txt(this.s5n, done ? `${sent} из\u00a0${sent}` : String(n));
      tag.classList.toggle('is-off', !OUT.inCover);
      tag.classList.toggle('is-done', done);
      // measured only when the words change, so the frame loop never forces layout
      if (a || b || tw <= 0) tw = this.tagW = tag.offsetWidth;
    }
    // beside the beacon, on whichever side fits, never past the screen edge
    const edge = 12;
    let tx = OUT.tagX + 14;
    if (tx + tw > L.W - edge) tx = OUT.tagX - 14 - tw;
    tx = Math.max(edge, Math.min(L.W - edge - tw, tx));
    this.at('s5tag', tx, OUT.tagY - 14, 0, -100, OUT.tagOn * range(T, H[4] + 0.95, H[4] + 1.15));
  }

  private scene7(T: number) {
    const sc = this.sc[7];
    sc.style.setProperty('--lock-bottom', `${OUT.lockBottom.toFixed(1)}px`);
    this.at('s7it', L.cx, OUT.lockBottom + 6, -50, 0, 1);
    this.rise('s7it', arrive(range(T, H[6] + 1.15, H[6] + 1.15 + M.enter), 0.12));
    for (let i = 0; i < this.rises.length; i++) {
      const t0 = H[6] + 1.3 + stag(i, this.rises.length, 0.08);
      const p = arrive(range(T, t0, t0 + M.enter), 0.1);
      this.tf(this.rises[i], `translate3d(0,${((1 - p) * 28).toFixed(2)}px,0)`);
      this.op(this.rises[i], Math.min(1, p * 1.4));
    }
    sc.classList.toggle('is-live', T >= H[7] - 0.6);
  }

  private hudUpdate(T: number, now: number, nav: Navigator | null, pull: Pull | null) {
    const i = sceneAt(T);
    if (i !== this.cur) {
      this.cur = i;
      this.txt(this.hud.n, String(i + 1).padStart(2, '0'));
      this.txt(this.hud.title, SCENES[i].title);
      for (let k = 0; k < this.hud.chapters.length; k++) this.hud.chapters[k].setAttribute('aria-current', String(k === i));
      document.documentElement.classList.toggle('reel-end', i === SCENES.length - 1);
    }
    this.tf(this.hud.fill, `scaleX(${(T / D).toFixed(4)})`);
    // the stage leans towards the next scene; the next scene's colour shows underneath
    const lift = pull ? pull.x : 0;
    this.tf(this.lift, lift ? `translate3d(0,${(-lift).toFixed(2)}px,0)` : 'none');
    const K = nav ? nav.K : 0;
    const pk = !nav || nav.moving ? -1 : K;
    if (pk !== this.peekK && pk >= 0) {
      this.peekK = pk;
      this.peek.style.setProperty('--peek', hexCss(PEEK[pk]));
    }
    this.tf(this.peek, `scaleY(${clamp01(lift / 96).toFixed(4)})`);
    // the cue: twelve ticks count the reading time down, the dot answers every push
    const gate = nav ? nav.gate : 0;
    const moving = !nav || nav.moving;
    const lit = moving ? 0 : Math.round(gate * 12);
    if (lit !== this.lit) {
      this.lit = lit;
      for (let k = 0; k < 12; k++) this.hud.ticks[k].classList.toggle('on', k < lit);
      this.hud.cue.classList.toggle('is-ready', lit >= 12);
    }
    if (!this.reduced) this.spin = moving ? (this.spin + (nav ? nav.rate : 1) * 2.4) % 360 : this.spin * 0.86;
    this.tf(this.hud.ring, `rotate(${this.spin.toFixed(2)}deg)`);
    const press = pull ? pull.press : 0;
    const refused = pull ? pull.refused : 0;
    const st = Math.min(0.6, Math.abs(press) * 1.4);
    const dy = press * 7 + (lift > 0 ? Math.min(9, lift * 0.25) : 0);
    this.tf(this.hud.dot, `translate(0px,${dy.toFixed(2)}px) scale(${(1 - st * 0.35).toFixed(3)},${(1 + st).toFixed(3)})`);
    this.op(this.hud.ring, 1 - 0.55 * refused * (0.5 + 0.5 * Math.cos(now * 30)));
  }

  /** HUD ink follows the background: dark type on bone, yellow and сурик; bone on ink and синь. */
  setHudDark(bgLum: number) {
    const dark = bgLum < 0.3;
    if (dark !== this.dark) {
      this.dark = dark;
      document.documentElement.classList.toggle('hud-ink', !dark);
    }
  }
}

/** The download tile for the visitor's own device is the obvious next step. */
function markDevice() {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const kind = /Android/i.test(ua) ? 'android' : ios ? 'ios' : /Windows/i.test(ua) ? 'windows' : '';
  if (!kind) return;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-dl]'))) el.toggleAttribute('data-mine', el.dataset.dl === kind);
  document.documentElement.dataset.device = kind;
}
