import { describe, expect, it } from 'vitest';
import { Navigator, Pull } from '../src/landing/reel/nav';
import { HOLDS, SCENES, arrive, glide, inDwell, swing } from '../src/landing/reel/time';

const DT = 1 / 60;
function run(n: Navigator, seconds: number, each?: (n: Navigator) => void) {
  for (let t = 0; t < seconds; t += DT) {
    n.update(DT);
    each?.(n);
  }
}

describe('reel navigator: key beats cannot be skipped', () => {
  it('holds a push until the key beat has been read, then takes it', () => {
    const n = new Navigator(HOLDS[1], 1);
    n.update(DT); // arrive and start reading
    n.step(1);
    expect(n.K).toBe(1);
    expect(n.pending).toBe(1);
    run(n, SCENES[1].read - 0.2);
    expect(n.K).toBe(1);
    run(n, 0.4);
    expect(n.K).toBe(2);
    expect(n.pending).toBe(0);
  });

  it('frantic pushes queue one step at most and never skip a scene', () => {
    const n = new Navigator(HOLDS[1], 1);
    const seen: number[] = [];
    let last = n.K;
    run(n, 40, (m) => {
      m.step(1);
      if (m.K !== last) {
        expect(m.K - last).toBe(1);
        seen.push(m.K);
        last = m.K;
      }
    });
    expect(seen).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it('every key beat stays on screen for its reading time even under frantic input', () => {
    const n = new Navigator(HOLDS[1], 1);
    let restAt = -1, clock = 0;
    const held: number[] = [];
    let k = n.K;
    for (let t = 0; t < 40; t += DT) {
      n.step(1);
      n.update(DT);
      clock += DT;
      if (!n.moving && restAt < 0) restAt = clock;
      if (n.K !== k) {
        held.push(clock - restAt);
        expect(clock - restAt).toBeGreaterThanOrEqual(SCENES[k].read - 1e-6);
        k = n.K;
        restAt = -1;
      }
    }
    expect(held.length).toBe(6);
  });

  it('hurrying speeds transitions slightly but never reading windows', () => {
    const n = new Navigator(HOLDS[2], 2);
    n.update(DT);
    run(n, SCENES[2].read + 0.1);
    n.step(1); // go to 3
    n.step(1); // pending while scene 3 plays
    let maxRate = 0, maxInDwell = 0;
    run(n, 6, (m) => {
      maxRate = Math.max(maxRate, m.rate);
      if (inDwell(m.T)) maxInDwell = Math.max(maxInDwell, m.rate);
    });
    expect(maxRate).toBeGreaterThan(1.1);
    expect(maxRate).toBeLessThanOrEqual(1.35 + 1e-6);
    expect(maxInDwell).toBeLessThanOrEqual(1.08);
  });

  it('going back is immediate and cancels a queued step', () => {
    const n = new Navigator(HOLDS[3], 3);
    n.update(DT);
    n.step(1);
    expect(n.pending).toBe(1);
    n.step(-1);
    expect(n.pending).toBe(0);
    expect(n.K).toBe(3);
    n.step(-1);
    expect(n.K).toBe(2);
  });

  it('the idle film nudges itself once the key beat has been read', () => {
    const n = new Navigator(HOLDS[1], 1);
    const p = new Pull();
    let max = 0;
    run(n, 8, (m) => {
      p.update(DT, m, false);
      max = Math.max(max, p.x);
    });
    expect(max).toBeGreaterThan(5);
  });
});

describe('reel motion system', () => {
  const sample = (f: (x: number) => number) => Array.from({ length: 2001 }, (_, i) => f(i / 2000));
  it('the gesture anticipates, overshoots and settles exactly on 1, without jumps', () => {
    const v = sample((x) => swing(x));
    expect(v[0]).toBe(0);
    expect(v[2000]).toBe(1);
    expect(Math.min(...v)).toBeLessThan(-0.05);
    expect(Math.max(...v)).toBeGreaterThan(1.04);
    for (let i = 1; i < v.length; i++) expect(Math.abs(v[i] - v[i - 1])).toBeLessThan(0.006);
  });
  it('arrival never dips below its start; glide stays calm', () => {
    expect(Math.min(...sample((x) => arrive(x)))).toBeGreaterThanOrEqual(0);
    const g = sample((x) => glide(x));
    expect(Math.max(...g)).toBeLessThan(1.04);
    for (let i = 1; i < g.length; i++) expect(Math.abs(g[i] - g[i - 1])).toBeLessThan(0.004);
  });
});
