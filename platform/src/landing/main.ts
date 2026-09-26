import './reel.css';
import { Atlas, type Glyph, type Word } from './reel/atlas';
import { Overlay } from './reel/dom';
import { Frame, Renderer, type Build } from './reel/gl/renderer';
import { Navigator, Pull, bindInput } from './reel/nav';
import { WORDS, draw, layout, setCoverU, setQuality, setType } from './reel/scenes';
import { HOLDS } from './reel/time';

const root = document.documentElement;
const $ = <T extends Element = HTMLElement>(s: string, el: ParentNode = document) => el.querySelector<T>(s);
const $$ = <T extends Element = HTMLElement>(s: string, el: ParentNode = document) => Array.from(el.querySelectorAll<T>(s));
for (const el of $$('[data-year]')) el.textContent = String(new Date().getFullYear());

// ── details dossier ─────────────────────────────────────
const details = $('#details')!;
let lastFocus: HTMLElement | null = null;
const detailsOpen = () => root.classList.contains('details-open');
function openDetails(section?: string) {
  if (!root.classList.contains('reel')) {
    (section ? document.getElementById(section) : details)?.scrollIntoView({ behavior: 'smooth' });
    return;
  }
  lastFocus = document.activeElement as HTMLElement | null;
  root.classList.add('details-open');
  for (const el of $$('main')) el.setAttribute('inert', '');
  details.setAttribute('role', 'dialog');
  details.setAttribute('aria-modal', 'true');
  const panel = $('.details__panel', details)!;
  const target = section ? document.getElementById(section) : null;
  panel.scrollTop = target ? target.offsetTop - 90 : 0;
  requestAnimationFrame(() => $<HTMLElement>('.details__close', details)?.focus({ preventScroll: true }));
}
function closeDetails() {
  if (!detailsOpen()) return;
  root.classList.remove('details-open');
  for (const el of $$('main')) el.removeAttribute('inert');
  details.removeAttribute('role');
  details.removeAttribute('aria-modal');
  lastFocus?.focus({ preventScroll: true });
}
for (const b of $$('[data-open-details]'))
  b.addEventListener('click', (e) => {
    e.preventDefault();
    openDetails(b.dataset.openDetails || undefined);
  });
for (const b of $$('[data-close-details]')) b.addEventListener('click', closeDetails);
addEventListener('keydown', (e) => {
  if (!detailsOpen()) return;
  if (e.key === 'Escape') closeDetails();
  if (e.key === 'Tab') {
    const items = $$<HTMLElement>('a[href], button, summary', details).filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
    else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
  }
});
if (/^#(download|details)$/.test(location.hash)) requestAnimationFrame(() => openDetails(location.hash === '#download' ? 'downloads' : undefined));

function toDocument() {
  root.classList.remove('reel', 'reel--still', 'reel--live', 'reel--gl');
}

if (root.classList.contains('reel')) start();

function start() {
  // tells the watchdog in <head> that the film is booting
  root.classList.add('reel--live');
  const reduced = root.classList.contains('reel--still');
  const debug = new URLSearchParams(location.search).has('debug');
  const canvas = $<HTMLCanvasElement>('canvas.stage')!;
  let R: Renderer;
  try {
    R = new Renderer(canvas);
  } catch (e) {
    console.warn('reel disabled', e);
    return toDocument();
  }
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    toDocument();
  });

  const low = innerWidth / innerHeight < 0.8 || (navigator.hardwareConcurrency ?? 8) <= 4;
  let build: Build | null = null;
  const worker = new Worker(new URL('./reel/worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<Build>) => {
    build = e.data;
    worker.terminate();
  };
  worker.postMessage({ count: low ? 1800 : 3200, torusScale: 1.9, grid: low ? [70, 58] : [104, 86] });

  // glyphs are rasterised a few per frame once the fonts are in, so the intro never hitches
  const atlas = new Atlas();
  const type = { wm: [] as Glyph[], wmScale: 1.3, words: {} as Record<string, Word> };
  // one glyph per job; the frame loop runs jobs in 5 ms slices
  const jobs: Array<() => void> = [];
  for (let i = 0; i < 6; i++) jobs.push(() => (type.wm[i] = atlas.wordmarkLetter(type.wmScale, i)));
  for (const w of WORDS) {
    // one instrument voice for the kinetic type: Martian Mono at its widest, condensed only for the longest word
    const font = "800 128px 'Martian Mono'", stretch: CanvasFontStretch = w.cond ? 'condensed' : 'semi-expanded';
    for (const ch of new Set(Array.from(w.word.replace(/\s/g, '')))) jobs.push(() => atlas.char(font, ch, stretch));
    jobs.push(() => (type.words[w.word] = atlas.word(font, w.word, stretch)));
  }
  let fontsIn = false;
  Promise.all([
    document.fonts.load("800 128px 'Martian Mono'", 'МОТОЧАСЫ МЕСТОПОЛОЖЕНИЕ'),
    document.fonts.load("800 32px 'Onest'", 'Четыре пути'),
    document.fonts.load("500 12px 'Martian Mono'"),
  ])
    .catch(() => undefined)
    .finally(() => (fontsIn = true));

  const F = new Frame();
  const dom = new Overlay(reduced);
  const pull = new Pull();
  const s0 = $('.s0')!;
  let atlasUp = false, buildUp = false, warmed = false, film = false;
  let nav: Navigator | null = null;
  let manual: { T: number; now: number } | null = null;
  let last = performance.now();
  const pr = Math.min(devicePixelRatio || 1, 1.5);
  let res = 1, q = 1, win = 0, winN = 0, good = 0;
  const frames: number[] = [];
  const cpu: number[] = [];
  const marks: Record<string, number> = {};
  const mark = (k: string) => (marks[k] ??= Math.round(performance.now()));
  const longtasks: Array<{ at: number; ms: number }> = [];
  if (debug && 'PerformanceObserver' in window)
    try {
      new PerformanceObserver((l) => l.getEntries().forEach((e) => longtasks.push({ at: Math.round(e.startTime), ms: Math.round(e.duration) }))).observe({ type: 'longtask', buffered: true });
    } catch {
      /* not supported */
    }

  const introDone = () => reduced || s0.getAnimations({ subtree: true }).every((a) => a.playState === 'finished' || a.effect?.getTiming().iterations === Infinity);

  const slow: Array<{ T: number; draw: number; gl: number; dom: number }> = [];
  const render = (T: number, now: number, dt: number) => {
    const W = innerWidth, H = innerHeight;
    const t0 = debug ? performance.now() : 0;
    R.resize(W, H, pr * res);
    layout(W, H);
    F.reset();
    draw(F, T, now);
    const t1 = debug ? performance.now() : 0;
    R.render(F);
    const t2 = debug ? performance.now() : 0;
    dom.setHudDark(0.2126 * F.base[0] + 0.7152 * F.base[1] + 0.0722 * F.base[2]);
    dom.update(T, now, nav, pull);
    if (debug) {
      const t3 = performance.now();
      if (t3 - t0 > 8) slow.push({ T: +T.toFixed(3), draw: +(t1 - t0).toFixed(1), gl: +(t2 - t1).toFixed(1), dom: +(t3 - t2).toFixed(1) });
    }
  };

  const go = (dir: 1 | -1) => {
    if (!nav) return;
    const n = nav;
    const vt = (document as Document & { startViewTransition?: (cb: () => void) => unknown }).startViewTransition;
    // reduced motion: calm cross-fades between the scenes' resting frames
    if (reduced && vt) vt.call(document, () => (n.step(dir), render(n.T, 0, 0)));
    else n.step(dir);
  };

  const loop = (nowMs: number) => {
    requestAnimationFrame(loop);
    const dt = Math.min(0.1, Math.max(0, (nowMs - last) / 1000));
    last = nowMs;
    if (document.hidden) return;
    const now = reduced ? 0 : nowMs / 1000;
    if (!film) {
      try {
        R.poll();
      } catch (e) {
        console.warn(e);
        return toDocument();
      }
      if (R.linked) mark('shadersLinked');
      if (fontsIn) mark('fontsIn');
      if (fontsIn && jobs.length) {
        const t0 = performance.now();
        // the intro runs on the compositor, so the main thread can spend most of each frame here
        while (jobs.length && performance.now() - t0 < 10) jobs.shift()!();
        if (!jobs.length) {
          setType(type);
          R.setAtlas(atlas);
          atlasUp = true;
          mark('atlasUp');
        }
      }
      if (build && !buildUp) {
        R.setBuild(build);
        setCoverU(build.coverU);
        const facets = $('[data-facets]');
        if (facets) facets.textContent = build.count.toLocaleString('ru-RU').replace(/\u202f/g, '\u00a0');
        buildUp = true;
        mark('buildUp');
      }
      if (R.linked && atlasUp && buildUp && !warmed) {
        layout(innerWidth, innerHeight);
        R.resize(innerWidth, innerHeight, pr);
        // real frames from every scene, so each pipeline state is built before it first appears
        const H = HOLDS;
        for (const T of [2.05, H[1] + 1.9, H[2] + 3.0, H[3] + 1.3, H[4] + 1.8, H[5] + 0.5, H[5] + 1.9, H[6] + 1.2]) {
          F.reset();
          draw(F, T, now);
          R.warm(F);
        }
        warmed = true;
        mark('warmed');
      }
      if (R.linked && warmed) {
        R.resize(innerWidth, innerHeight, pr);
        layout(innerWidth, innerHeight);
        F.reset();
        draw(F, 0, now);
        R.render(F);
        root.classList.add('reel--gl');
      }
      if (warmed && introDone()) {
        film = true;
        mark('filmStart');
        dom.takeover(now);
        nav = new Navigator(HOLDS[0], 0, reduced);
        nav.onTarget = (k) => dom.announce(k);
        nav.onHeld = () => pull.refuse();
        dom.onChapter = (k) => nav!.goTo(k);
        dom.onCue = () => {
          pull.push(1, 0.4);
          go(1);
        };
        bindInput($('#reel')!, {
          go,
          push: (d, m) => pull.push(d, m),
          drag: (dy) => (pull.drag = dy),
          blocked: () => detailsOpen() || !!manual,
        });
        $('[data-restart]')?.addEventListener('click', (e) => {
          e.preventDefault();
          nav!.goTo(1);
        });
        // the intro flows straight into the first scene
        if (reduced) go(1);
        else nav.step(1);
      }
      return;
    }
    const n = nav!;
    let T: number;
    if (manual) T = manual.T;
    else {
      n.update(dt);
      T = n.T;
    }
    pull.update(dt, manual ? null : n, reduced);
    render(T, manual ? manual.now : now, dt);
    if (debug) {
      cpu.push(performance.now() - nowMs);
      if (cpu.length > 1200) cpu.shift();
      frames.push(dt * 1000);
      if (frames.length > 1200) frames.shift();
    }
    // adaptive quality: drop resolution first, then facet count; recover slowly
    if (!manual && !reduced) {
      win += dt;
      winN++;
      if (winN >= 45) {
        const avg = win / winN;
        if (avg > 0.0195 && (res > 0.62 || q > 0.45)) {
          if (res > 0.62) res = Math.max(0.62, res - 0.1);
          else q = Math.max(0.45, q - 0.15);
          setQuality(q);
          good = 0;
        } else if (avg < 0.0152 && ++good >= 4 && (res < 1 || q < 1)) {
          if (q < 1) q = Math.min(1, q + 0.1);
          else res = Math.min(1, res + 0.05);
          setQuality(q);
          good = 0;
        }
        win = 0;
        winN = 0;
      }
    }
  };
  requestAnimationFrame(loop);

  if (debug)
    Object.assign(window, {
      __reel: {
        seek: (T: number, now = 1) => {
          manual = { T, now };
          render(T, now, 0);
        },
        free: () => (manual = null),
        state: () => ({ film, T: nav?.T, K: nav?.K, rate: nav?.rate, gate: nav?.gate, pending: nav?.pending, lift: pull.x, res, q, linked: R.linked, atlasUp, buildUp }),
        holds: () => HOLDS.slice(),
        frames: () => {
          const s = frames.slice().sort((a, b) => a - b);
          const c = cpu.slice().sort((a, b) => a - b);
          const p = (x: number) => s[Math.min(s.length - 1, Math.floor(s.length * x))] ?? 0;
          const pc = (x: number) => +(c[Math.min(c.length - 1, Math.floor(c.length * x))] ?? 0).toFixed(2);
          return { n: s.length, p50: p(0.5), p95: p(0.95), max: s[s.length - 1] ?? 0, over20: s.filter((x) => x > 20).length, over33: s.filter((x) => x > 33).length, cpuP50: pc(0.5), cpuP95: pc(0.95), cpuMax: pc(1), marks, longtasks };
        },
        resetFrames: () => ((frames.length = 0), (cpu.length = 0), (longtasks.length = 0)),
        step: (d: 1 | -1) => go(d),
        renderer: R,
        slow: () => slow,
      },
    });
}
