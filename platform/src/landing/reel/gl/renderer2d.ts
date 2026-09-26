import { SDF, type Atlas } from '../atlas';
import type { Build, Col, Frame } from './renderer';

const PF = 16;
const GF = 20;
const TAU = Math.PI * 2;
const MORPH_POINTS = 256;
const SDF_GRID = 144;
const SDF_EXTENT = 1.7;
const PART_DEPTH_BANDS = 8;
const PART_HUES = 30;
const PART_BUCKETS = PART_DEPTH_BANDS * PART_HUES;
const POINT_COLOR_BANDS = 9;
const POINT_ALPHA_BANDS = 16;
const POINT_BUCKETS = POINT_COLOR_BANDS * POINT_ALPHA_BANDS;
const PART_PALETTE: readonly (readonly [number, number, number])[] = [
  [0.96, 0.79, 0.48],
  [0.83, 0.58, 0.29],
  [0.65, 0.39, 0.28],
  [0.54, 0.42, 0.66],
  [0.41, 0.58, 0.74],
  [0.98, 0.92, 0.79],
];
const PART_LEVELS = [0.36, 0.5, 0.65, 0.82, 1];

/** Structural surface shared by the WebGL and Canvas renderers. */
export interface FilmRenderer {
  linked: boolean;
  devW: number;
  devH: number;
  cssW: number;
  cssH: number;
  scale: number;
  poll(): boolean;
  setAtlas(atlas: Atlas): void;
  setBuild(build: Build): void;
  resize(cssW: number, cssH: number, pr: number): void;
  warm(frame: Frame): void;
  render(frame: Frame, warm?: boolean): void;
}

interface ColorStyle {
  key: number;
  r: number;
  g: number;
  b: number;
  rgb: string;
  alpha: string[] | null;
}

interface TintedAtlas {
  fill: HTMLCanvasElement;
  outline: HTMLCanvasElement;
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(a: number, b: number, x: number) {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

function fract(x: number) {
  return x - Math.floor(x);
}

function hash12(x: number, y: number) {
  return fract(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453);
}

function hash13(x: number, y: number, z: number) {
  let px = fract(x * 0.1031), py = fract(y * 0.1031), pz = fract(z * 0.1031);
  const dot = px * (pz + 31.32) + py * (py + 31.32) + pz * (px + 31.32);
  px += dot;
  py += dot;
  pz += dot;
  return fract((px + py) * pz);
}

function valueNoise(x: number, y: number, z: number) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const n000 = hash13(ix, iy, iz), n100 = hash13(ix + 1, iy, iz), n010 = hash13(ix, iy + 1, iz), n110 = hash13(ix + 1, iy + 1, iz);
  const n001 = hash13(ix, iy, iz + 1), n101 = hash13(ix + 1, iy, iz + 1), n011 = hash13(ix, iy + 1, iz + 1), n111 = hash13(ix + 1, iy + 1, iz + 1);
  const x00 = n000 + (n100 - n000) * ux, x10 = n010 + (n110 - n010) * ux;
  const x01 = n001 + (n101 - n001) * ux, x11 = n011 + (n111 - n011) * ux;
  return (x00 + (x10 - x00) * uy) + ((x01 + (x11 - x01) * uy) - (x00 + (x10 - x00) * uy)) * uz;
}

function toneMap(v: number) {
  v *= 1.1;
  return Math.pow(clamp01((v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14)), 1 / 2.2);
}

function sdUneven(x: number, y: number, r1: number, r2: number, h: number) {
  const px = Math.abs(x), b = (r1 - r2) / h, a = Math.sqrt(1 - b * b), k = px * -b + y * a;
  if (k < 0) return Math.hypot(px, y) - r1;
  if (k > a * h) return Math.hypot(px, y - h) - r2;
  return px * a + y * b - r1;
}

function sdRoundBox(x: number, y: number, bx: number, by: number, r: number) {
  const qx = Math.abs(x) - bx + r, qy = Math.abs(y) - by + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function shapeDistance(id: number, x: number, y: number) {
  if (id === 0) return Math.hypot(x, y) - 1;
  if (id === 1) return sdUneven(x, -y + 0.35, 0.68, 0.05, 1.3);
  if (id === 2) return Math.max(sdUneven(x, y + 0.35, 0.64, 0.04, 1.28), -(Math.hypot(x, y + 0.35) - 0.27));
  if (id === 3) return sdRoundBox(x, y, 0.84, 0.62, 0.16);
  const ring = Math.abs(Math.hypot(x, y) - 1) - 0.2143;
  return Math.max(ring, -(Math.hypot(x - 0.5, y + 0.8660254) - 0.5238));
}

function contourArea(points: number[]) {
  let area = 0;
  const n = points.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) area += points[j * 2] * points[i * 2 + 1] - points[i * 2] * points[j * 2 + 1];
  return area * 0.5;
}

function resampleContour(points: number[], count: number) {
  if (contourArea(points) < 0) {
    for (let i = 0, j = (points.length >> 1) - 1; i < j; i++, j--) {
      const ax = points[i * 2], ay = points[i * 2 + 1];
      points[i * 2] = points[j * 2];
      points[i * 2 + 1] = points[j * 2 + 1];
      points[j * 2] = ax;
      points[j * 2 + 1] = ay;
    }
  }
  const n = points.length >> 1;
  let start = 0;
  for (let i = 1; i < n; i++) {
    const dy = points[i * 2 + 1] - points[start * 2 + 1];
    if (dy < -1e-5 || (Math.abs(dy) < 1e-5 && Math.abs(points[i * 2]) < Math.abs(points[start * 2]))) start = i;
  }
  const ordered = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const j = (start + i) % n;
    ordered[i * 2] = points[j * 2];
    ordered[i * 2 + 1] = points[j * 2 + 1];
  }
  const lengths = new Float32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    lengths[i + 1] = lengths[i] + Math.hypot(ordered[j * 2] - ordered[i * 2], ordered[j * 2 + 1] - ordered[i * 2 + 1]);
  }
  const out = new Float32Array(count * 2), total = lengths[n];
  let edge = 0;
  for (let i = 0; i < count; i++) {
    const d = (total * i) / count;
    while (edge < n - 1 && lengths[edge + 1] < d) edge++;
    const j = (edge + 1) % n, span = lengths[edge + 1] - lengths[edge], t = span > 1e-6 ? (d - lengths[edge]) / span : 0;
    out[i * 2] = ordered[edge * 2] + (ordered[j * 2] - ordered[edge * 2]) * t;
    out[i * 2 + 1] = ordered[edge * 2 + 1] + (ordered[j * 2 + 1] - ordered[edge * 2 + 1]) * t;
  }
  return out;
}

export class Renderer2D implements FilmRenderer {
  linked = true;
  devW = 1;
  devH = 1;
  cssW = 1;
  cssH = 1;
  scale = 1;

  private readonly mainCtx: CanvasRenderingContext2D;
  private readonly scratch: HTMLCanvasElement;
  private readonly scratchCtx: CanvasRenderingContext2D;
  private readonly partLayer: HTMLCanvasElement;
  private readonly partLayerCtx: CanvasRenderingContext2D;
  private readonly mapLayer: HTMLCanvasElement;
  private readonly mapLayerCtx: CanvasRenderingContext2D;
  private targetCtx: CanvasRenderingContext2D;
  private activeFill: string | CanvasGradient | null = null;
  private activeStroke: string | null = null;
  private activeAlpha = -1;
  private dashPattern = [0, 0];
  private solidDash: number[] = [];
  private colors = new Map<number, ColorStyle>();
  private atlas: Atlas | null = null;
  private mask: HTMLCanvasElement | null = null;
  private outlineMask: HTMLCanvasElement | null = null;
  private tinted = new Map<number, TintedAtlas>();
  private white!: ColorStyle;
  private outerShapes: Float32Array[] = [];
  private innerShapes: Float32Array[] = [];
  private partPalette: ColorStyle[] = [];
  private partEdgePalette: ColorStyle[] = [];
  private pointPalette: ColorStyle[] = [];
  private clipX = 0;
  private clipY = 0;
  private clipR = 0;

  private partCount = 0;
  private partSize = 0;
  private partA = new Float32Array(0);
  private partNA = new Float32Array(0);
  private partB = new Float32Array(0);
  private partNB = new Float32Array(0);
  private partSeed = new Float32Array(0);
  private partOrder = new Float32Array(0);
  private partBias = new Float32Array(0);
  private partNoise = new Float32Array(0);
  private partDither = new Float32Array(0);
  private partScreen = new Float32Array(0);
  private partBucket = new Uint16Array(0);
  private partIndices = new Uint32Array(0);
  private partBucketCount = new Uint32Array(PART_BUCKETS);
  private partBucketStart = new Uint32Array(PART_BUCKETS);
  private partBucketCursor = new Uint32Array(PART_BUCKETS);
  private partCacheValid = false;
  private partCacheT = -1;
  private partCacheTime = -1;
  private partCacheCount = -1;
  private partCacheScale = -1;
  private partCacheW = -1;
  private partCacheH = -1;
  private partLeft = 0;
  private partTop = 0;
  private partRight = 0;
  private partBottom = 0;

  private mapPoints: Build['points'] = new Float32Array(0);
  private mapPointCount = 0;
  private pointScreen = new Float32Array(0);
  private pointBucket = new Uint16Array(0);
  private pointIndices = new Uint32Array(0);
  private pointBucketCount = new Uint32Array(POINT_BUCKETS);
  private pointBucketStart = new Uint32Array(POINT_BUCKETS);
  private pointBucketCursor = new Uint32Array(POINT_BUCKETS);
  private mapCacheValid = false;
  private mapCacheTime = -1;
  private mapCacheKey = new Float64Array(33);
  private projected = new Float32Array(3);
  private projectedB = new Float32Array(3);
  private projectedC = new Float32Array(3);

  private get ctx() {
    return this.targetCtx;
  }

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!ctx) throw new Error('canvas2d');
    this.mainCtx = ctx;
    this.targetCtx = ctx;
    this.scratch = document.createElement('canvas');
    const scratchCtx = this.scratch.getContext('2d');
    if (!scratchCtx) throw new Error('canvas2d scratch');
    this.scratchCtx = scratchCtx;
    this.partLayer = document.createElement('canvas');
    const partLayerCtx = this.partLayer.getContext('2d');
    if (!partLayerCtx) throw new Error('canvas2d part layer');
    this.partLayerCtx = partLayerCtx;
    this.mapLayer = document.createElement('canvas');
    const mapLayerCtx = this.mapLayer.getContext('2d');
    if (!mapLayerCtx) throw new Error('canvas2d map layer');
    this.mapLayerCtx = mapLayerCtx;
    this.white = this.color(1, 1, 1);
    this.makeContours();
    for (let h = 0; h < PART_PALETTE.length; h++)
      for (let s = 0; s < PART_LEVELS.length; s++) {
        const hue = PART_PALETTE[h], level = PART_LEVELS[s];
        this.partPalette.push(this.color(hue[0] * level, hue[1] * level, hue[2] * level));
      }
    for (let i = 0; i < this.partPalette.length; i++) {
      const c = this.partPalette[i];
      this.partEdgePalette.push(this.color(c.r / 255 * 0.58 + 0.949 * 0.42, c.g / 255 * 0.58 + 0.922 * 0.42, c.b / 255 * 0.58 + 0.867 * 0.42));
    }
    for (let i = 0; i < POINT_COLOR_BANDS; i++) {
      const t = i / (POINT_COLOR_BANDS - 1);
      this.pointPalette.push(this.color(0.949 + (1 - 0.949) * t, 0.922 + (0.29 - 0.922) * t, 0.867 + (0.078 - 0.867) * t));
    }
  }

  poll() {
    return true;
  }

  private color(r: number, g: number, b: number) {
    const cr = Math.round(Math.round(clamp01(r) * 63) * (255 / 63));
    const cg = Math.round(Math.round(clamp01(g) * 63) * (255 / 63));
    const cb = Math.round(Math.round(clamp01(b) * 63) * (255 / 63));
    const key = (cr << 16) | (cg << 8) | cb;
    let entry = this.colors.get(key);
    if (entry) return entry;
    entry = { key, r: cr, g: cg, b: cb, rgb: `rgb(${cr},${cg},${cb})`, alpha: null };
    this.colors.set(key, entry);
    return entry;
  }

  private colorAt(data: Float32Array, o: number) {
    return this.color(data[o], data[o + 1], data[o + 2]);
  }

  private alphaColor(color: ColorStyle, alpha: number) {
    if (!color.alpha) {
      color.alpha = new Array<string>(256);
      for (let i = 0; i < 256; i++) color.alpha[i] = `rgba(${color.r},${color.g},${color.b},${i / 255})`;
    }
    return color.alpha[clamp(Math.round(alpha * 255), 0, 255)];
  }

  private makeContours() {
    const n = SDF_GRID, edgeCount = 2 * n * (n - 1), horizontalCount = n * (n - 1);
    const values = new Float32Array(n * n), edgeX = new Float32Array(edgeCount), edgeY = new Float32Array(edgeCount);
    const active = new Uint8Array(edgeCount), adjA = new Int32Array(edgeCount), adjB = new Int32Array(edgeCount), visited = new Uint8Array(edgeCount);
    const step = (SDF_EXTENT * 2) / (n - 1);
    for (let id = 0; id < 5; id++) {
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) values[y * n + x] = shapeDistance(id, -SDF_EXTENT + x * step, -SDF_EXTENT + y * step);
      active.fill(0);
      adjA.fill(-1);
      adjB.fill(-1);
      visited.fill(0);
      const crossing = (edge: number, v0: number, v1: number) => {
        if (active[edge]) return;
        const t = v0 / (v0 - v1);
        if (edge < horizontalCount) {
          const ey = Math.floor(edge / (n - 1)), ex = edge - ey * (n - 1);
          edgeX[edge] = -SDF_EXTENT + (ex + t) * step;
          edgeY[edge] = -SDF_EXTENT + ey * step;
        } else {
          const v = edge - horizontalCount, ey = Math.floor(v / n), ex = v - ey * n;
          edgeX[edge] = -SDF_EXTENT + ex * step;
          edgeY[edge] = -SDF_EXTENT + (ey + t) * step;
        }
        active[edge] = 1;
      };
      const link = (a: number, b: number) => {
        if (adjA[a] < 0) adjA[a] = b;
        else adjB[a] = b;
        if (adjA[b] < 0) adjA[b] = a;
        else adjB[b] = a;
      };
      for (let y = 0; y < n - 1; y++)
        for (let x = 0; x < n - 1; x++) {
          const tl = values[y * n + x], tr = values[y * n + x + 1], br = values[(y + 1) * n + x + 1], bl = values[(y + 1) * n + x];
          const code = (tl < 0 ? 1 : 0) | (tr < 0 ? 2 : 0) | (br < 0 ? 4 : 0) | (bl < 0 ? 8 : 0);
          if (code === 0 || code === 15) continue;
          const top = y * (n - 1) + x, right = horizontalCount + y * n + x + 1;
          const bottom = (y + 1) * (n - 1) + x, left = horizontalCount + y * n + x;
          if ((tl < 0) !== (tr < 0)) crossing(top, tl, tr);
          if ((tr < 0) !== (br < 0)) crossing(right, tr, br);
          if ((bl < 0) !== (br < 0)) crossing(bottom, bl, br);
          if ((tl < 0) !== (bl < 0)) crossing(left, tl, bl);
          switch (code) {
            case 1: link(top, left); break;
            case 2: link(top, right); break;
            case 3: link(left, right); break;
            case 4: link(right, bottom); break;
            case 5:
              if (shapeDistance(id, -SDF_EXTENT + (x + 0.5) * step, -SDF_EXTENT + (y + 0.5) * step) < 0) { link(top, right); link(bottom, left); }
              else { link(top, left); link(right, bottom); }
              break;
            case 6: link(top, bottom); break;
            case 7: link(left, bottom); break;
            case 8: link(bottom, left); break;
            case 9: link(top, bottom); break;
            case 10:
              if (shapeDistance(id, -SDF_EXTENT + (x + 0.5) * step, -SDF_EXTENT + (y + 0.5) * step) < 0) { link(top, left); link(right, bottom); }
              else { link(top, right); link(bottom, left); }
              break;
            case 11: link(right, bottom); break;
            case 12: link(left, right); break;
            case 13: link(top, right); break;
            case 14: link(top, left); break;
          }
        }
      const loops: number[][] = [];
      for (let start = 0; start < edgeCount; start++) {
        if (!active[start] || visited[start] || adjA[start] < 0) continue;
        const points: number[] = [];
        let current = start, previous = -1, guard = 0;
        while (current >= 0 && guard++ <= edgeCount) {
          if (visited[current] && current !== start) break;
          visited[current] = 1;
          points.push(edgeX[current], edgeY[current]);
          const a = adjA[current], b = adjB[current], next = a !== previous ? a : b;
          previous = current;
          current = next;
          if (current === start) break;
        }
        if (points.length >= 6) loops.push(points);
      }
      loops.sort((a, b) => Math.abs(contourArea(b)) - Math.abs(contourArea(a)));
      if (!loops.length) {
        const circle: number[] = [];
        for (let i = 0; i < MORPH_POINTS; i++) circle.push(Math.cos((i / MORPH_POINTS) * TAU), Math.sin((i / MORPH_POINTS) * TAU));
        loops.push(circle);
      }
      this.outerShapes[id] = resampleContour(loops[0], MORPH_POINTS);
      this.innerShapes[id] = new Float32Array(MORPH_POINTS * 2);
      if (id === 2 && loops.length > 1) this.innerShapes[id] = resampleContour(loops[1], MORPH_POINTS);
    }
  }

  setAtlas(atlas: Atlas) {
    if (this.atlas === atlas) return;
    this.atlas = atlas;
    this.tinted.clear();
    const makeMask = (outline: boolean) => {
      const canvas = document.createElement('canvas');
      canvas.width = atlas.w;
      canvas.height = atlas.h;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('canvas2d atlas');
      const image = ctx.createImageData(atlas.w, atlas.h), pixels = image.data, source = atlas.data;
      for (let i = 0; i < source.length; i++) {
        const d0 = (1 - source[i] / 255 - SDF.cutoff) * SDF.radius, d = outline ? Math.abs(d0 + 2.6) - 2.6 : d0;
        const a = Math.round(clamp01(0.5 - d) * 255), p = i * 4;
        pixels[p] = 255; pixels[p + 1] = 255; pixels[p + 2] = 255; pixels[p + 3] = a;
      }
      ctx.putImageData(image, 0, 0);
      return canvas;
    };
    this.mask = makeMask(false);
    this.outlineMask = makeMask(true);
  }

  private tint(source: HTMLCanvasElement, color: ColorStyle) {
    const canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas2d tint');
    ctx.drawImage(source, 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = color.rgb;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'source-over';
    return canvas;
  }

  private tintedAtlas(color: ColorStyle) {
    let atlas = this.tinted.get(color.key);
    if (atlas) return atlas;
    if (!this.mask || !this.outlineMask) throw new Error('atlas not set');
    atlas = { fill: this.tint(this.mask, color), outline: this.tint(this.outlineMask, color) };
    this.tinted.set(color.key, atlas);
    return atlas;
  }

  setBuild(build: Build) {
    this.partCacheValid = false;
    this.mapCacheValid = false;
    this.partCount = build.count;
    this.partSize = build.size;
    this.mapPoints = build.points;
    this.mapPointCount = build.pointCount;
    this.partA = new Float32Array(build.count * 3);
    this.partNA = new Float32Array(build.count * 3);
    this.partB = new Float32Array(build.count * 3);
    this.partNB = new Float32Array(build.count * 3);
    this.partSeed = new Float32Array(build.count * 4);
    this.partOrder = new Float32Array(build.count);
    this.partBias = new Float32Array(build.count);
    this.partNoise = new Float32Array(build.count);
    this.partDither = new Float32Array(build.count);
    this.partScreen = new Float32Array(build.count * 6);
    this.partBucket = new Uint16Array(build.count);
    this.partIndices = new Uint32Array(build.count);
    const data = build.instances;
    for (let i = 0; i < build.count; i++) {
      const o = i * 19, p = i * 3, s = i * 4;
      this.partA[p] = data[o]; this.partA[p + 1] = data[o + 1]; this.partA[p + 2] = data[o + 2];
      this.partNA[p] = data[o + 3]; this.partNA[p + 1] = data[o + 4]; this.partNA[p + 2] = data[o + 5];
      this.partB[p] = data[o + 6]; this.partB[p + 1] = data[o + 7]; this.partB[p + 2] = data[o + 8];
      this.partNB[p] = data[o + 9]; this.partNB[p + 1] = data[o + 10]; this.partNB[p + 2] = data[o + 11];
      this.partSeed[s] = data[o + 12]; this.partSeed[s + 1] = data[o + 13];
      this.partSeed[s + 2] = data[o + 14]; this.partSeed[s + 3] = data[o + 15];
      this.partOrder[i] = data[o + 16];
      this.partBias[i] = data[o + 18];
      const x = data[o], y = data[o + 1], z = data[o + 2];
      this.partNoise[i] = 0.62 * valueNoise(x * 5.4 + 3.1, y * 5.4 + 3.1, z * 5.4 + 3.1) + 0.38 * valueNoise(x * 12.6 - 1.7, y * 12.6 - 1.7, z * 12.6 - 1.7);
      this.partDither[i] = hash12(i * 1.17 + data[o + 15] * 97, data[o + 12] * 31 + data[o + 13] * 7);
    }
    this.pointScreen = new Float32Array(build.pointCount * 3);
    this.pointBucket = new Uint16Array(build.pointCount);
    this.pointIndices = new Uint32Array(build.pointCount);
  }

  resize(cssW: number, cssH: number, pr: number) {
    const w = Math.max(2, Math.round(cssW * pr)), h = Math.max(2, Math.round(cssH * pr));
    if (w !== this.canvas.width || h !== this.canvas.height) { this.canvas.width = w; this.canvas.height = h; }
    if (w !== this.scratch.width || h !== this.scratch.height) { this.scratch.width = w; this.scratch.height = h; }
    if (w !== this.partLayer.width || h !== this.partLayer.height) { this.partLayer.width = w; this.partLayer.height = h; this.partCacheValid = false; }
    if (w !== this.mapLayer.width || h !== this.mapLayer.height) { this.mapLayer.width = w; this.mapLayer.height = h; this.mapCacheValid = false; }
    this.devW = w;
    this.devH = h;
    this.cssW = cssW;
    this.cssH = cssH;
    this.scale = w / cssW;
    this.targetCtx = this.mainCtx;
    this.mainCtx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    this.scratchCtx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    this.partLayerCtx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    this.mapLayerCtx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    this.activeFill = null;
    this.activeStroke = null;
    this.activeAlpha = -1;
  }

  warm(frame: Frame) {
    const part = frame.part.on, pts = frame.pts.on;
    frame.part.on = this.partCount > 0;
    frame.pts.on = this.mapPointCount > 0;
    this.render(frame, true);
    frame.part.on = part;
    frame.pts.on = pts;
  }

  private setFill(style: string | CanvasGradient) {
    if (this.activeFill !== style) { this.ctx.fillStyle = style; this.activeFill = style; }
  }

  private setStroke(style: string) {
    if (this.activeStroke !== style) { this.ctx.strokeStyle = style; this.activeStroke = style; }
  }

  private setAlpha(alpha: number) {
    if (this.activeAlpha !== alpha) { this.ctx.globalAlpha = alpha; this.activeAlpha = alpha; }
  }

  private addWipeStop(gradient: CanvasGradient, color: ColorStyle, t: number, distance: number, off: number, soft: number) {
    if (t < 0 || t > 1) return;
    gradient.addColorStop(t, this.alphaColor(color, 1 - smoothstep(-soft, soft, distance - off)));
  }

  private drawLinearWipe(frame: Frame) {
    const nx = frame.wipe[0], ny = frame.wipe[1], off = frame.wipe[2], soft = frame.wipe[3];
    const minDot = Math.min(0, nx * this.cssW) + Math.min(0, ny * this.cssH);
    const maxDot = Math.max(0, nx * this.cssW) + Math.max(0, ny * this.cssH);
    const span = Math.max(1e-5, maxDot - minDot), gradient = this.ctx.createLinearGradient(nx * minDot, ny * minDot, nx * maxDot, ny * maxDot);
    const color = this.colorAt(frame.wipeCol, 0);
    this.addWipeStop(gradient, color, 0, minDot, off, soft);
    for (let i = 0; i <= 32; i++) {
      const distance = off - soft + (2 * soft * i) / 32;
      this.addWipeStop(gradient, color, (distance - minDot) / span, distance, off, soft);
    }
    this.addWipeStop(gradient, color, 1, maxDot, off, soft);
    this.setFill(gradient);
    this.ctx.fillRect(0, 0, this.cssW, this.cssH);
    this.activeFill = null;
  }

  private drawDiscWipe(x: number, y: number, radius: number, soft: number, color: ColorStyle) {
    soft = Math.max(soft, 0.7);
    const inner = Math.max(0, radius - soft), outer = Math.max(0.001, radius + soft);
    const gradient = this.ctx.createRadialGradient(x, y, inner, x, y, outer);
    for (let i = 0; i <= 32; i++) {
      const t = i / 32, d = inner + (outer - inner) * t - radius;
      gradient.addColorStop(t, this.alphaColor(color, 1 - smoothstep(-soft, soft, d)));
    }
    this.setFill(gradient);
    this.ctx.fillRect(0, 0, this.cssW, this.cssH);
    this.activeFill = null;
  }

  private drawBackground(frame: Frame) {
    this.setAlpha(1);
    this.ctx.globalCompositeOperation = 'source-over';
    this.setFill(this.colorAt(frame.base, 0).rgb);
    this.ctx.fillRect(0, 0, this.cssW, this.cssH);
    if (frame.wipe[3] > 0) this.drawLinearWipe(frame);
    for (let i = 0; i < frame.discN; i++) {
      const o = i * 4, c = i * 3;
      this.drawDiscWipe(frame.disc[o], frame.disc[o + 1], frame.disc[o + 2], frame.disc[o + 3], this.colorAt(frame.discCol, c));
    }
  }

  private partColor(r: number, g: number, b: number) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < this.partPalette.length; i++) {
      const p = this.partPalette[i], dr = r * 255 - p.r, dg = g * 255 - p.g, db = b * 255 - p.b;
      const d = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  private drawFacets(frame: Frame) {
    const n = Math.min(this.partCount, Math.max(0, Math.floor(frame.part.count)));
    if (!n) return;
    this.partLeft = this.cssW;
    this.partTop = this.cssH;
    this.partRight = 0;
    this.partBottom = 0;
    this.partBucketCount.fill(0);
    this.partBucket.fill(0xffff, 0, n);
    const ring = frame.part.ring, exc = frame.part.exc, cam = frame.cam;
    const tFilm = frame.part.T, now = frame.time;
    for (let i = 0; i < n; i++) {
      const p = i * 3, s = i * 4;
      const ax0 = this.partA[p], ay0 = this.partA[p + 1], az0 = this.partA[p + 2];
      const nax0 = this.partNA[p], nay0 = this.partNA[p + 1], naz0 = this.partNA[p + 2];
      const ax = ring[0] * ax0 + ring[4] * ay0 + ring[8] * az0 + ring[12];
      const ay = ring[1] * ax0 + ring[5] * ay0 + ring[9] * az0 + ring[13];
      const az = ring[2] * ax0 + ring[6] * ay0 + ring[10] * az0 + ring[14];
      let nax = ring[0] * nax0 + ring[4] * nay0 + ring[8] * naz0;
      let nay = ring[1] * nax0 + ring[5] * nay0 + ring[9] * naz0;
      let naz = ring[2] * nax0 + ring[6] * nay0 + ring[10] * naz0;
      let nl = 1 / (Math.hypot(nax, nay, naz) || 1);
      nax *= nl; nay *= nl; naz *= nl;
      const bx0 = this.partB[p], by0 = this.partB[p + 1], bz0 = this.partB[p + 2];
      const nbx0 = this.partNB[p], nby0 = this.partNB[p + 1], nbz0 = this.partNB[p + 2];
      const bx = exc[0] * bx0 + exc[4] * by0 + exc[8] * bz0 + exc[12];
      const by = exc[1] * bx0 + exc[5] * by0 + exc[9] * bz0 + exc[13];
      const bz = exc[2] * bx0 + exc[6] * by0 + exc[10] * bz0 + exc[14];
      let nbx = exc[0] * nbx0 + exc[4] * nby0 + exc[8] * nbz0;
      let nby = exc[1] * nbx0 + exc[5] * nby0 + exc[9] * nbz0;
      let nbz = exc[2] * nbx0 + exc[6] * nby0 + exc[10] * nbz0;
      nl = 1 / (Math.hypot(nbx, nby, nbz) || 1);
      nbx *= nl; nby *= nl; nbz *= nl;
      const fs = frame.part.fly0 + this.partOrder[i] * frame.part.spread;
      const f = clamp01((tFilm - fs) / (frame.part.dur * (0.84 + 0.32 * this.partSeed[s + 3])));
      const fe = f < 0.5 ? 4 * f * f * f : 1 - Math.pow(-2 * f + 2, 3) * 0.5;
      const seedX = this.partSeed[s], seedY = this.partSeed[s + 1], seedZ = this.partSeed[s + 2], seedW = this.partSeed[s + 3];
      const p1x = ax + nax * 0.42 + seedX * 0.5, p1y = ay + nay * 0.42 + 0.75 + seedY * 0.5, p1z = az + naz * 0.42 + seedZ * 0.5;
      const p2x = bx + nbx * 0.55 + seedZ * 0.38, p2y = by + nby * 0.55 + 0.6 + seedX * 0.38, p2z = bz + nbz * 0.55 + seedY * 0.38;
      const it = 1 - fe, it2 = it * it, fe2 = fe * fe;
      let px = it2 * it * ax + 3 * it2 * fe * p1x + 3 * it * fe2 * p2x + fe2 * fe * bx;
      let py = it2 * it * ay + 3 * it2 * fe * p1y + 3 * it * fe2 * p2y + fe2 * fe * by;
      let pz = it2 * it * az + 3 * it2 * fe * p1z + 3 * it * fe2 * p2z + fe2 * fe * bz;
      if (f <= 0) {
        const anticipation = Math.sin(Math.PI * clamp01((tFilm - fs + 0.18) / 0.18));
        px -= nax * 0.04 * anticipation; py -= nay * 0.04 * anticipation; pz -= naz * 0.04 * anticipation;
      }
      const k = clamp01((f - 0.78) / 0.22);
      if (f > 0.001) {
        const dx = bx - p2x, dy = by - p2y, dz = bz - p2z, il = 1 / (Math.hypot(dx, dy, dz) || 1);
        const follow = 0.06 * Math.sin(Math.PI * k) * (1 - k * 0.4);
        px += dx * il * follow; py += dy * il * follow; pz += dz * il * follow;
      }
      if (f >= 0.999) {
        const bob = 0.006 * Math.sin(now * 1.3 + seedW * 23);
        px += nbx * bob; py += nby * bob; pz += nbz * bob;
      }
      const gone = smoothstep(seedW * 0.55, seedW * 0.55 + 0.45, frame.part.gone), gone2 = gone * gone;
      px += (frame.part.goneTo[0] - px) * gone2;
      py += (frame.part.goneTo[1] - py) * gone2;
      pz += (frame.part.goneTo[2] - pz) * gone2;
      const appear = smoothstep(this.partNoise[i] - 0.02, this.partNoise[i] + 0.12, frame.part.appear), fade = appear * (1 - gone);
      if (fade < this.partDither[i]) continue;
      const size = this.partSize * appear * (1 + 0.22 * Math.sin(Math.PI * f)) * (1 - gone);
      if (size < 0.00015) continue;
      let nx = nax * (1 - fe) + nbx * fe, ny = nay * (1 - fe) + nby * fe, nz = naz * (1 - fe) + nbz * fe;
      nl = 1 / (Math.hypot(nx, ny, nz) || 1);
      nx *= nl; ny *= nl; nz *= nl;
      const surfaceX = nx, surfaceY = ny, surfaceZ = nz;
      let ux = 0, uy = 1, uz = 0;
      if (Math.abs(ny) >= 0.9) { ux = 1; uy = 0; }
      let tx = uy * nz - uz * ny, ty = uz * nx - ux * nz, tz = ux * ny - uy * nx;
      const tl = 1 / (Math.hypot(tx, ty, tz) || 1);
      tx *= tl; ty *= tl; tz *= tl;
      let qx = ny * tz - nz * ty, qy = nz * tx - nx * tz, qz = nx * ty - ny * tx;
      nx += tx * seedX * 0.38 + qx * seedY * 0.38;
      ny += ty * seedX * 0.38 + qy * seedY * 0.38;
      nz += tz * seedX * 0.38 + qz * seedY * 0.38;
      nl = 1 / (Math.hypot(nx, ny, nz) || 1);
      nx *= nl; ny *= nl; nz *= nl;
      ux = 0; uy = 1; uz = 0;
      if (Math.abs(ny) >= 0.9) { ux = 1; uy = 0; }
      tx = uy * nz - uz * ny; ty = uz * nx - ux * nz; tz = ux * ny - uy * nx;
      const tiltedT = 1 / (Math.hypot(tx, ty, tz) || 1);
      tx *= tiltedT; ty *= tiltedT; tz *= tiltedT;
      qx = ny * tz - nz * ty; qy = nz * tx - nx * tz; qz = nx * ty - ny * tx;
      const spin = seedX * Math.PI + TAU * (1 + Math.floor(seedW * 2)) * (f * f * f * (f * (f * 6 - 15) + 10)) + 0.45 * Math.sin(Math.PI * k) * (1 - k);
      const cs = Math.cos(spin), sn = Math.sin(spin);
      const rx = tx * cs + qx * sn, ry = ty * cs + qy * sn, rz = tz * cs + qz * sn;
      const sx = -tx * sn + qx * cs, sy = -ty * sn + qy * cs, sz = -tz * sn + qz * cs;
      const u0 = cs, v0 = sn, u1 = -0.5 * cs - 0.8660254 * sn, v1 = 0.8660254 * cs - 0.5 * sn;
      const u2 = -0.5 * cs + 0.8660254 * sn, v2 = -0.8660254 * cs - 0.5 * sn;
      const x0 = px + (rx * u0 + sx * v0) * size, y0 = py + (ry * u0 + sy * v0) * size, z0 = pz + (rz * u0 + sz * v0) * size;
      const x1 = px + (rx * u1 + sx * v1) * size, y1 = py + (ry * u1 + sy * v1) * size, z1 = pz + (rz * u1 + sz * v1) * size;
      const x2 = px + (rx * u2 + sx * v2) * size, y2 = py + (ry * u2 + sy * v2) * size, z2 = pz + (rz * u2 + sz * v2) * size;
      cam.project(x0, y0, z0, this.projected);
      cam.project(x1, y1, z1, this.projectedB);
      cam.project(x2, y2, z2, this.projectedC);
      const w0 = this.projected[2], w1 = this.projectedB[2], w2 = this.projectedC[2];
      if (w0 <= 0.05 || w1 <= 0.05 || w2 <= 0.05) continue;
      const minX = Math.min(this.projected[0], this.projectedB[0], this.projectedC[0]);
      const maxX = Math.max(this.projected[0], this.projectedB[0], this.projectedC[0]);
      const minY = Math.min(this.projected[1], this.projectedB[1], this.projectedC[1]);
      const maxY = Math.max(this.projected[1], this.projectedB[1], this.projectedC[1]);
      if (maxX < -4 || minX > this.cssW + 4 || maxY < -4 || minY > this.cssH + 4) continue;
      if (minX < this.partLeft) this.partLeft = minX;
      if (minY < this.partTop) this.partTop = minY;
      if (maxX > this.partRight) this.partRight = maxX;
      if (maxY > this.partBottom) this.partBottom = maxY;
      const o = i * 6;
      this.partScreen[o] = this.projected[0]; this.partScreen[o + 1] = this.projected[1];
      this.partScreen[o + 2] = this.projectedB[0]; this.partScreen[o + 3] = this.projectedB[1];
      this.partScreen[o + 4] = this.projectedC[0]; this.partScreen[o + 5] = this.projectedC[1];
      const depth = (w0 + w1 + w2) / 3, layer = clamp(Math.floor(depth / 3), 0, PART_DEPTH_BANDS - 1);
      const vx = cam.eye[0] - px, vy = cam.eye[1] - py, vz = cam.eye[2] - pz;
      const vl = 1 / (Math.hypot(vx, vy, vz) || 1), viewX = vx * vl, viewY = vy * vl, viewZ = vz * vl;
      const shellFacing = surfaceX * viewX + surfaceY * viewY + surfaceZ * viewZ;
      if (shellFacing < 0) { nx = -nx; ny = -ny; nz = -nz; }
      const cosT = clamp01(nx * viewX + ny * viewY + nz * viewZ), keyX = 0.5, keyY = 0.74, keyZ = 0.45;
      const diff = Math.max(0, nx * keyX + ny * keyY + nz * keyZ);
      let hx = keyX + viewX, hy = keyY + viewY, hz = keyZ + viewZ;
      const hl = 1 / (Math.hypot(hx, hy, hz) || 1);
      hx *= hl; hy *= hl; hz *= hl;
      const spec = Math.pow(Math.max(0, nx * hx + ny * hy + nz * hz), 64);
      const fres = 0.06 + 0.94 * Math.pow(1 - cosT, 4), shell = 0.26 + 0.74 * smoothstep(-0.35, 0.3, shellFacing);
      const filmThickness = 192 + 62 * Math.sin((px * 0.8 + py * 0.45 - pz * 0.4) * 0.95 - now * 0.2) +
        30 * (valueNoise(px * 1.2, py * 1.2 + now * 0.04, pz * 1.2) - 0.5) + seedW * 12 + this.partBias[i] * fe;
      const sinT2 = (1 - cosT * cosT) / (1.46 * 1.46), opd = 2 * 1.46 * filmThickness * Math.sqrt(Math.max(0, 1 - sinT2));
      const fR = 0.5 - 0.5 * Math.cos(TAU * opd / 650), fG = 0.5 - 0.5 * Math.cos(TAU * opd / 540), fB = 0.5 - 0.5 * Math.cos(TAU * opd / 460);
      const mean = (fR + fG + fB) / 3, filmR = mean + (fR - mean) * 0.95, filmG = mean + (fG - mean) * 0.95, filmB = mean + (fB - mean) * 0.95;
      const specScale = spec * (1.4 + 0.9 * Math.sin(Math.PI * f)) * shell, light = (0.1 + 0.7 * diff + 1.05 * fres) * shell;
      const linearR = 0.012 + filmR * light + specScale * (0.5 + filmR * 0.75);
      const linearG = 0.011 + filmG * light + specScale * (0.5 + filmG * 0.75);
      const linearB = 0.009 + filmB * light + specScale * (0.5 + filmB * 0.75);
      const hue = this.partColor(toneMap(linearR), toneMap(linearG), toneMap(linearB));
      const bucket = layer * PART_HUES + hue;
      this.partBucket[i] = bucket;
      this.partBucketCount[bucket]++;
    }
    let total = 0;
    for (let b = 0; b < PART_BUCKETS; b++) {
      this.partBucketStart[b] = total;
      this.partBucketCursor[b] = total;
      total += this.partBucketCount[b];
    }
    for (let i = 0; i < n; i++) {
      const b = this.partBucket[i];
      if (b !== 0xffff) this.partIndices[this.partBucketCursor[b]++] = i;
    }
    this.setAlpha(1);
    for (let layer = PART_DEPTH_BANDS - 1; layer >= 0; layer--)
      for (let hue = 0; hue < PART_HUES; hue++) {
        const b = layer * PART_HUES + hue, count = this.partBucketCount[b];
        if (!count) continue;
        this.setFill(this.partPalette[hue].rgb);
        this.ctx.beginPath();
        const end = this.partBucketStart[b] + count;
        for (let j = this.partBucketStart[b]; j < end; j++) {
          const o = this.partIndices[j] * 6;
          this.ctx.moveTo(this.partScreen[o], this.partScreen[o + 1]);
          this.ctx.lineTo(this.partScreen[o + 2], this.partScreen[o + 3]);
          this.ctx.lineTo(this.partScreen[o + 4], this.partScreen[o + 5]);
          this.ctx.closePath();
        }
        this.ctx.fill();
        this.setStroke(this.partEdgePalette[hue].rgb);
        this.setAlpha(0.56);
        this.ctx.lineWidth = 0.36;
        this.ctx.stroke();
        this.setAlpha(1);
      }
  }

  private drawMapPoints(frame: Frame) {
    const pts = frame.pts, cam = frame.cam;
    this.pointBucketCount.fill(0);
    this.pointBucket.fill(0xffff);
    const tstep = Math.floor(frame.time * 12);
    for (let i = 0; i < this.mapPointCount; i++) {
      const o = i * 4, x = this.mapPoints[o], y = this.mapPoints[o + 1], z = this.mapPoints[o + 2], route = this.mapPoints[o + 3];
      const dx = x - pts.rise[0], dz = z - pts.rise[1];
      const k = clamp01((pts.rise[2] - Math.hypot(dx, dz)) / 2.5), kk = k * k * (3 - 2 * k);
      const wy = y * kk - (1 - kk) * 0.7 + pts.site[1];
      cam.project(x + pts.site[0], wy, z + pts.site[2], this.projected);
      const cw = this.projected[2];
      if (cw <= 0.05) continue;
      const dm = Math.hypot(x - pts.mast[0], z - pts.mast[1]);
      const cover = 1 - smoothstep(pts.mast[2] - 0.3, pts.mast[2] + 0.3, dm);
      const flick = hash12(x * 13.1 + tstep, z * 13.1 + tstep) >= 0.94 ? 1 : 0;
      let alpha = (0.34 + 0.6 * clamp01(y * 1.5)) * ((0.45 + 0.5 * flick) * (1 - cover) + cover);
      alpha = alpha * (1 - route) + 0.85 * route;
      let signal = 0;
      if (pts.wave > 0) {
        const wave = Math.exp(-Math.pow((dm - pts.wave) * 2.4, 2)) * (1 - smoothstep(9, 13, pts.wave));
        signal = wave;
        alpha = Math.max(alpha, wave);
      }
      const machineDist = Math.hypot(x - pts.machine[0], z - pts.machine[1]);
      const machine = Math.exp(-machineDist * machineDist * 5) * 0.85;
      signal += (1 - signal) * machine;
      alpha *= kk * pts.alpha;
      const alphaBand = clamp(Math.round(alpha * (POINT_ALPHA_BANDS - 1)), 0, POINT_ALPHA_BANDS - 1);
      if (!alphaBand) continue;
      const colorBand = clamp(Math.round(signal * (POINT_COLOR_BANDS - 1)), 0, POINT_COLOR_BANDS - 1);
      const size = Math.max(1 / this.scale, 0.075 * cam.projPx / cw * (1 + 0.1 * route));
      const o2 = i * 3;
      this.pointScreen[o2] = this.projected[0];
      this.pointScreen[o2 + 1] = this.projected[1];
      this.pointScreen[o2 + 2] = size;
      const bucket = alphaBand * POINT_COLOR_BANDS + colorBand;
      this.pointBucket[i] = bucket;
      this.pointBucketCount[bucket]++;
    }
    let total = 0;
    for (let b = 0; b < POINT_BUCKETS; b++) {
      this.pointBucketStart[b] = total;
      this.pointBucketCursor[b] = total;
      total += this.pointBucketCount[b];
    }
    for (let i = 0; i < this.mapPointCount; i++) {
      const b = this.pointBucket[i];
      if (b !== 0xffff) this.pointIndices[this.pointBucketCursor[b]++] = i;
    }
    for (let a = 1; a < POINT_ALPHA_BANDS; a++)
      for (let c = 0; c < POINT_COLOR_BANDS; c++) {
        const b = a * POINT_COLOR_BANDS + c, count = this.pointBucketCount[b];
        if (!count) continue;
        this.setAlpha(a / (POINT_ALPHA_BANDS - 1));
        this.setFill(this.pointPalette[c].rgb);
        this.ctx.beginPath();
        const end = this.pointBucketStart[b] + count;
        for (let j = this.pointBucketStart[b]; j < end; j++) {
          const o = this.pointIndices[j] * 3, x = this.pointScreen[o], y = this.pointScreen[o + 1], size = this.pointScreen[o + 2];
          this.ctx.rect(x - size / 2, y - size / 2, size, size);
        }
        this.ctx.fill();
      }
  }

  private drawRoundRect(x: number, y: number, hw: number, hh: number, radius: number) {
    const r = clamp(radius, 0, Math.min(hw, hh)), ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x - hw + r, y - hh);
    ctx.lineTo(x + hw - r, y - hh);
    ctx.quadraticCurveTo(x + hw, y - hh, x + hw, y - hh + r);
    ctx.lineTo(x + hw, y + hh - r);
    ctx.quadraticCurveTo(x + hw, y + hh, x + hw - r, y + hh);
    ctx.lineTo(x - hw + r, y + hh);
    ctx.quadraticCurveTo(x - hw, y + hh, x - hw, y + hh - r);
    ctx.lineTo(x - hw, y - hh + r);
    ctx.quadraticCurveTo(x - hw, y - hh, x - hw + r, y - hh);
    ctx.closePath();
  }

  private drawMorph(x: number, y: number, r: number, a: number, b: number, t: number, outline: number, rot: number) {
    const outerA = this.outerShapes[a], outerB = this.outerShapes[b], innerA = this.innerShapes[a], innerB = this.innerShapes[b], ctx = this.ctx;
    const cs = rot ? Math.cos(rot) : 1, sn = rot ? Math.sin(rot) : 0;
    ctx.beginPath();
    for (let i = 0; i < MORPH_POINTS; i++) {
      const o = i * 2, lx = r * (outerA[o] + (outerB[o] - outerA[o]) * t), ly = r * (outerA[o + 1] + (outerB[o + 1] - outerA[o + 1]) * t);
      const px = x + cs * lx - sn * ly, py = y + sn * lx + cs * ly;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    let hasInner = false;
    for (let i = 0; i < MORPH_POINTS * 2; i++) if (innerA[i] !== 0 || innerB[i] !== 0) { hasInner = true; break; }
    if (hasInner) {
      for (let i = 0; i < MORPH_POINTS; i++) {
        const o = i * 2, lx = r * (innerA[o] + (innerB[o] - innerA[o]) * t), ly = r * (innerA[o + 1] + (innerB[o + 1] - innerA[o + 1]) * t);
        const px = x + cs * lx - sn * ly, py = y + sn * lx + cs * ly;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
    }
    if (outline > 0) {
      ctx.lineWidth = outline * 2;
      ctx.lineJoin = 'round';
      ctx.stroke();
    } else ctx.fill('evenodd');
  }

  private drawPrimitives(frame: Frame) {
    const p = frame.prims, ctx = this.ctx;
    for (let i = 0; i < frame.nP; i++) {
      const o = i * PF, x = p[o], y = p[o + 1], hx = p[o + 2], hy = p[o + 3];
      const b0 = p[o + 4], b1 = p[o + 5], b2 = p[o + 6], b3 = p[o + 7];
      const alpha = p[o + 11], type = Math.round(p[o + 12]), rot = p[o + 13], vx = p[o + 14], vy = p[o + 15];
      const extent = rot ? Math.hypot(hx, hy) : 0;
      const canvasRotated = !!rot && type !== 4;
      if (alpha <= 0.002 || x + (extent || hx) < 0 || x - (extent || hx) > this.cssW || y + (extent || hy) < 0 || y - (extent || hy) > this.cssH) continue;
      const color = this.colorAt(p, o + 8);
      this.setAlpha(alpha);
      this.setFill(color.rgb);
      this.setStroke(color.rgb);
      if (canvasRotated) { ctx.save(); ctx.translate(x, y); ctx.rotate(rot); }
      const cx = canvasRotated ? 0 : x, cy = canvasRotated ? 0 : y;
      if (type === 0) {
        const speed = Math.hypot(vx, vy);
        if (speed > 0.6) {
          this.setAlpha(alpha * Math.pow((2 * b0) / (2 * b0 + speed), 0.85));
          ctx.beginPath();
          ctx.moveTo(cx - vx * 0.5, cy - vy * 0.5);
          ctx.lineTo(cx + vx * 0.5, cy + vy * 0.5);
          ctx.lineWidth = b0 * 2;
          ctx.lineCap = 'round';
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(cx, cy, b0, 0, TAU);
          ctx.fill();
        }
      } else if (type === 1) {
        ctx.beginPath();
        if (b3 >= TAU - 1e-3) ctx.arc(cx, cy, b0, 0, TAU);
        else ctx.arc(cx, cy, b0, b2 - Math.PI / 2, b2 + b3 - Math.PI / 2);
        ctx.lineWidth = b1 * 2;
        ctx.lineCap = 'round';
        ctx.stroke();
      } else if (type === 2) {
        this.drawRoundRect(cx, cy, b0, b1, b2);
        if (b3 > 0) { ctx.lineWidth = b3 * 2; ctx.lineJoin = 'round'; ctx.stroke(); }
        else ctx.fill();
      } else if (type === 3) {
        ctx.beginPath();
        ctx.moveTo(cx - b0, cy);
        ctx.lineTo(cx + b0, cy);
        ctx.lineWidth = b1 * 2;
        if (b2 > 0) {
          this.dashPattern[0] = b2 * b3;
          this.dashPattern[1] = b2 * (1 - b3);
          ctx.setLineDash(this.dashPattern);
          ctx.lineDashOffset = 0;
          ctx.lineCap = 'butt';
        }
        else ctx.lineCap = 'round';
        ctx.stroke();
        if (b2 > 0) { ctx.setLineDash(this.solidDash); ctx.lineCap = 'butt'; }
      } else {
        const a = Math.round(b1 % 16), b = Math.round(Math.floor(b1 / 16));
        this.drawMorph(cx, cy, b0, a, b, b2, b3, rot);
      }
      if (canvasRotated) ctx.restore();
    }
  }

  private applyGlyphMask(x: number, y: number, w: number, h: number, mode: number, clipY0: number, clipY1: number) {
    const ctx = this.scratchCtx;
    ctx.globalCompositeOperation = 'destination-in';
    ctx.globalAlpha = 1;
    if (mode & 6) {
      const inner = Math.max(0, this.clipR - 1), outer = Math.max(0.001, this.clipR + 1);
      const gradient = ctx.createRadialGradient(this.clipX, this.clipY, inner, this.clipX, this.clipY, outer);
      const inMode = (mode & 2) !== 0, outMode = (mode & 4) !== 0;
      for (let i = 0; i <= 16; i++) {
        const t = i / 16, d = inner + (outer - inner) * t;
        const disc = smoothstep(this.clipR - 1, this.clipR + 1, d);
        let alpha = 1;
        if (inMode) alpha *= 1 - disc;
        if (outMode) alpha *= disc;
        gradient.addColorStop(t, this.alphaColor(this.white, alpha));
      }
      ctx.fillStyle = gradient;
      ctx.fillRect(x, y, w, h);
    }
    if (clipY0 > -99999) {
      const gradient = ctx.createLinearGradient(0, clipY0 - 0.5, 0, clipY0 + 0.5);
      gradient.addColorStop(0, this.alphaColor(this.white, 0));
      gradient.addColorStop(1, this.alphaColor(this.white, 1));
      ctx.fillStyle = gradient;
      ctx.fillRect(x, y, w, h);
    }
    if (clipY1 < 99999) {
      const gradient = ctx.createLinearGradient(0, clipY1 - 0.5, 0, clipY1 + 0.5);
      gradient.addColorStop(0, this.alphaColor(this.white, 1));
      gradient.addColorStop(1, this.alphaColor(this.white, 0));
      ctx.fillStyle = gradient;
      ctx.fillRect(x, y, w, h);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  private drawGlyphs(frame: Frame) {
    if (!this.atlas || !this.mask || !this.outlineMask) return;
    const g = frame.glyphs, ctx = this.ctx, atlasW = this.atlas.w, atlasH = this.atlas.h;
    for (let i = 0; i < frame.nG; i++) {
      const o = i * GF, cx = g[o], cy = g[o + 1], hx = g[o + 2], hy = g[o + 3];
      const u0 = g[o + 4], v0 = g[o + 5], u1 = g[o + 6], v1 = g[o + 7];
      const alpha = g[o + 11], vx = g[o + 13], vy = g[o + 14], mode = Math.round(g[o + 15]);
      const clipY0 = g[o + 17], clipY1 = g[o + 19];
      if (alpha <= 0.002 || cx + hx < 0 || cx - hx > this.cssW || cy + hy < 0 || cy - hy > this.cssH) continue;
      const tint = this.tintedAtlas(this.colorAt(g, o + 8)), source = mode & 1 ? tint.outline : tint.fill;
      const sx = u0 * atlasW, sy = v0 * atlasH, sw = (u1 - u0) * atlasW, sh = (v1 - v0) * atlasH;
      const dx = cx - hx, dy = cy - hy, dw = hx * 2, dh = hy * 2;
      const blurred = Math.hypot(vx, vy) * this.scale > 0.8;
      const clipped = (mode & 6) !== 0 || clipY0 > -99999 || clipY1 < 99999;
      if (!blurred && !clipped) {
        this.setAlpha(alpha);
        ctx.drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh);
        continue;
      }
      const copies = blurred ? 5 : 1, padX = Math.abs(vx) * 0.5 + 1, padY = Math.abs(vy) * 0.5 + 1;
      const x0 = Math.max(0, dx - padX), y0 = Math.max(0, dy - padY);
      const x1 = Math.min(this.cssW, dx + dw + padX), y1 = Math.min(this.cssH, dy + dh + padY);
      const rw = x1 - x0, rh = y1 - y0;
      if (rw <= 0 || rh <= 0) continue;
      const sctx = this.scratchCtx;
      sctx.clearRect(x0, y0, rw, rh);
      sctx.globalCompositeOperation = copies > 1 ? 'lighter' : 'source-over';
      sctx.globalAlpha = copies > 1 ? alpha / copies : alpha;
      for (let j = 0; j < copies; j++) {
        const t = copies > 1 ? j / (copies - 1) - 0.5 : 0;
        sctx.drawImage(source, sx, sy, sw, sh, dx + vx * t, dy + vy * t, dw, dh);
      }
      if (clipped) {
        this.clipX = frame.clip[0]; this.clipY = frame.clip[1]; this.clipR = frame.clip[2];
        this.applyGlyphMask(x0, y0, rw, rh, mode, clipY0, clipY1);
      }
      sctx.globalCompositeOperation = 'source-over';
      sctx.globalAlpha = 1;
      this.setAlpha(1);
      ctx.drawImage(this.scratch, x0 * this.scale, y0 * this.scale, rw * this.scale, rh * this.scale, x0, y0, rw, rh);
    }
  }

  private useLayer(ctx: CanvasRenderingContext2D) {
    this.targetCtx = ctx;
    this.targetCtx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    this.targetCtx.globalAlpha = 1;
    this.targetCtx.globalCompositeOperation = 'source-over';
    this.activeFill = null;
    this.activeStroke = null;
    this.activeAlpha = -1;
  }

  private drawPartLayer(frame: Frame) {
    const t = Math.floor(frame.part.T * 30), time = Math.floor(frame.time * 12);
    const count = Math.min(this.partCount, Math.max(0, Math.floor(frame.part.count)));
    if (!this.partCacheValid || t !== this.partCacheT || time !== this.partCacheTime || count !== this.partCacheCount || this.scale !== this.partCacheScale || this.cssW !== this.partCacheW || this.cssH !== this.partCacheH) {
      this.useLayer(this.partLayerCtx);
      this.partLayerCtx.clearRect(0, 0, this.cssW, this.cssH);
      this.drawFacets(frame);
      this.partCacheT = t;
      this.partCacheTime = time;
      this.partCacheCount = count;
      this.partCacheScale = this.scale;
      this.partCacheW = this.cssW;
      this.partCacheH = this.cssH;
      this.partCacheValid = true;
      this.useLayer(this.mainCtx);
    }
    const left = Math.max(0, this.partLeft - 2), top = Math.max(0, this.partTop - 2);
    const right = Math.min(this.cssW, this.partRight + 2), bottom = Math.min(this.cssH, this.partBottom + 2);
    if (right <= left || bottom <= top) return;
    const sx = Math.floor(left * this.scale), sy = Math.floor(top * this.scale);
    const sw = Math.max(1, Math.ceil(right * this.scale) - sx), sh = Math.max(1, Math.ceil(bottom * this.scale) - sy);
    this.mainCtx.globalAlpha = 1;
    this.mainCtx.globalCompositeOperation = 'source-over';
    this.mainCtx.drawImage(this.partLayer, sx, sy, sw, sh, sx / this.scale, sy / this.scale, sw / this.scale, sh / this.scale);
  }

  private mapCacheMatches(frame: Frame, time: number) {
    if (!this.mapCacheValid || this.mapCacheTime !== time) return false;
    let k = 0;
    const m = frame.cam.viewProj;
    for (let i = 0; i < 16; i++) if (this.mapCacheKey[k++] !== m[i]) return false;
    const p = frame.pts;
    for (let i = 0; i < 3; i++) if (this.mapCacheKey[k++] !== p.site[i]) return false;
    for (let i = 0; i < 3; i++) if (this.mapCacheKey[k++] !== p.rise[i]) return false;
    for (let i = 0; i < 3; i++) if (this.mapCacheKey[k++] !== p.mast[i]) return false;
    for (let i = 0; i < 2; i++) if (this.mapCacheKey[k++] !== p.machine[i]) return false;
    if (this.mapCacheKey[k++] !== p.wave || this.mapCacheKey[k++] !== p.alpha) return false;
    if (this.mapCacheKey[k++] !== this.cssW || this.mapCacheKey[k++] !== this.cssH || this.mapCacheKey[k++] !== this.scale) return false;
    return this.mapCacheKey[k] === frame.cam.projPx;
  }

  private saveMapCacheKey(frame: Frame, time: number) {
    let k = 0;
    const m = frame.cam.viewProj;
    for (let i = 0; i < 16; i++) this.mapCacheKey[k++] = m[i];
    const p = frame.pts;
    for (let i = 0; i < 3; i++) this.mapCacheKey[k++] = p.site[i];
    for (let i = 0; i < 3; i++) this.mapCacheKey[k++] = p.rise[i];
    for (let i = 0; i < 3; i++) this.mapCacheKey[k++] = p.mast[i];
    for (let i = 0; i < 2; i++) this.mapCacheKey[k++] = p.machine[i];
    this.mapCacheKey[k++] = p.wave;
    this.mapCacheKey[k++] = p.alpha;
    this.mapCacheKey[k++] = this.cssW;
    this.mapCacheKey[k++] = this.cssH;
    this.mapCacheKey[k++] = this.scale;
    this.mapCacheKey[k] = frame.cam.projPx;
    this.mapCacheTime = time;
    this.mapCacheValid = true;
  }

  private drawMapLayer(frame: Frame) {
    const time = Math.floor(frame.time * 12);
    if (!this.mapCacheMatches(frame, time)) {
      this.useLayer(this.mapLayerCtx);
      this.mapLayerCtx.clearRect(0, 0, this.cssW, this.cssH);
      this.drawMapPoints(frame);
      this.saveMapCacheKey(frame, time);
      this.useLayer(this.mainCtx);
    }
    this.mainCtx.globalAlpha = 1;
    this.mainCtx.globalCompositeOperation = 'source-over';
    this.mainCtx.drawImage(this.mapLayer, 0, 0, this.devW, this.devH, 0, 0, this.cssW, this.cssH);
  }

  render(frame: Frame, _warm = false) {
    this.useLayer(this.mainCtx);
    this.scratchCtx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    this.drawBackground(frame);
    if (frame.part.on && this.partCount) this.drawPartLayer(frame);
    if (frame.pts.on && this.mapPointCount) this.drawMapLayer(frame);
    this.drawPrimitives(frame);
    this.drawGlyphs(frame);
    this.ctx.globalAlpha = 1;
    this.ctx.globalCompositeOperation = 'source-over';
  }
}
