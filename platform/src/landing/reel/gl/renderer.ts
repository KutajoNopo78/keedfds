import { attribs, buffer } from './core';
import { tetrahedron } from './geometry';
import { BG_FS, PART_FS, PART_VS, PRIM_FS, PRIM_VS, PTS_FS, PTS_VS, TEXT_FS, TEXT_VS, TRI_VS } from './shaders';
import { SDF, type Atlas, type Glyph } from '../atlas';

export type Col = readonly [number, number, number];
const PF = 16;
const GF = 20;
const MAXP = 1600;
const MAXG = 900;

/** Everything one frame draws, written by the scenes into preallocated arrays. */
export class Frame {
  base = new Float32Array(3);
  wipe = new Float32Array(4);
  wipeCol = new Float32Array(3);
  disc = new Float32Array(12);
  discCol = new Float32Array(9);
  discN = 0;
  clip = new Float32Array(3);
  prims = new Float32Array(MAXP * PF);
  nP = 0;
  glyphs = new Float32Array(MAXG * GF);
  nG = 0;
  time = 0;
  part = { on: false, T: 0, appear: 1, gone: 0, goneTo: new Float32Array(3), fly0: 9, spread: 0.55, dur: 0.9, ring: new Float32Array(16), exc: new Float32Array(16), count: 1e9 };
  pts = { on: false, rise: new Float32Array(3), wave: -1, machine: new Float32Array(2), alpha: 1, site: new Float32Array(3), mast: new Float32Array(3) };
  cam = new Camera();

  reset() {
    this.nP = 0;
    this.nG = 0;
    this.discN = 0;
    this.wipe[3] = 0;
    this.part.on = false;
    this.pts.on = false;
    this.clip[2] = 0;
  }
  setBase(c: Col) {
    this.base[0] = c[0];
    this.base[1] = c[1];
    this.base[2] = c[2];
  }
  addDisc(x: number, y: number, r: number, soft: number, c: Col) {
    if (this.discN >= 3 || r <= 0) return;
    const o = this.discN * 4, k = this.discN * 3;
    this.disc[o] = x;
    this.disc[o + 1] = y;
    this.disc[o + 2] = r;
    this.disc[o + 3] = soft;
    this.discCol[k] = c[0];
    this.discCol[k + 1] = c[1];
    this.discCol[k + 2] = c[2];
    this.discN++;
  }
  setWipe(nx: number, ny: number, off: number, soft: number, c: Col) {
    const l = Math.hypot(nx, ny) || 1;
    this.wipe[0] = nx / l;
    this.wipe[1] = ny / l;
    this.wipe[2] = off;
    this.wipe[3] = soft;
    this.wipeCol[0] = c[0];
    this.wipeCol[1] = c[1];
    this.wipeCol[2] = c[2];
  }
  private p(x: number, y: number, hx: number, hy: number, b0: number, b1: number, b2: number, b3: number, c: Col, a: number, type: number, rot: number, vx: number, vy: number) {
    if (this.nP >= MAXP || a <= 0.002) return;
    const P = this.prims, o = this.nP++ * PF;
    P[o] = x;
    P[o + 1] = y;
    P[o + 2] = hx;
    P[o + 3] = hy;
    P[o + 4] = b0;
    P[o + 5] = b1;
    P[o + 6] = b2;
    P[o + 7] = b3;
    P[o + 8] = c[0];
    P[o + 9] = c[1];
    P[o + 10] = c[2];
    P[o + 11] = Math.min(1, a);
    P[o + 12] = type;
    P[o + 13] = rot;
    P[o + 14] = vx;
    P[o + 15] = vy;
  }
  /** Filled disc; (vx, vy) is the motion-blur smear in px. */
  disc2(x: number, y: number, r: number, c: Col, a = 1, vx = 0, vy = 0) {
    if (r > 0.05) this.p(x, y, r, r, r, 0, 0, 0, c, a, 0, 0, vx, vy);
  }
  /** Ring or arc from a0 (0 = twelve o'clock, clockwise) over `span`. */
  ring(x: number, y: number, R: number, hw: number, c: Col, a = 1, a0 = 0, span = 7) {
    if (R + hw > 0.05) this.p(x, y, R + hw, R + hw, R, hw, a0, span, c, a, 1, 0, 0, 0);
  }
  rect(x: number, y: number, hw: number, hh: number, r: number, c: Col, a = 1, stroke = 0, rot = 0) {
    this.p(x, y, hw + stroke, hh + stroke, hw, hh, r, stroke, c, a, 2, rot, 0, 0);
  }
  seg(x0: number, y0: number, x1: number, y1: number, hw: number, c: Col, a = 1, dash = 0, duty = 0.5) {
    const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) / 2;
    if (L < 0.01) return;
    this.p((x0 + x1) / 2, (y0 + y1) / 2, L + hw, hw, L, hw, dash, duty, c, a, 3, Math.atan2(dy, dx), 0, 0);
  }
  /** SDF morph between shapes a and b (0 dial, 1 drop, 2 pin, 3 counter window, 4 logo ring). */
  morph(x: number, y: number, R: number, a: number, b: number, t: number, outline: number, c: Col, alpha = 1, rot = 0) {
    const e = R * 1.4 + outline + 2;
    this.p(x, y, e, e, R, a + b * 16, t, outline, c, alpha, 4, rot, 0, 0);
  }
  /**
   * Glyph with its pen at (px, py) on the baseline; k = CSS px per raster px. Horizontal scale about the glyph
   * centre, vertical about the baseline. mode: 1 outline, 2 only inside the clip disc, 4 only outside it.
   */
  glyph(g: Glyph, px: number, py: number, k: number, sx: number, sy: number, c: Col, a = 1, vx = 0, vy = 0, mode = 0, clipY1 = 1e6, clipY0 = -1e6) {
    if (this.nG >= MAXG || a <= 0.002) return;
    const G = this.glyphs, o = this.nG++ * GF;
    G[o] = px + g.ox * k;
    G[o + 1] = py + g.oy * k * sy;
    G[o + 2] = (g.w / 2) * k * Math.max(0.001, sx);
    G[o + 3] = (g.h / 2) * k * Math.max(0.001, sy);
    G[o + 4] = g.u0;
    G[o + 5] = g.v0;
    G[o + 6] = g.u1;
    G[o + 7] = g.v1;
    G[o + 8] = c[0];
    G[o + 9] = c[1];
    G[o + 10] = c[2];
    G[o + 11] = Math.min(1, a);
    G[o + 12] = 0;
    G[o + 13] = vx;
    G[o + 14] = vy;
    G[o + 15] = mode;
    G[o + 16] = -1e6;
    G[o + 17] = clipY0;
    G[o + 18] = 1e6;
    G[o + 19] = clipY1;
  }
}

/** Orbit camera without allocations: eye from target, distance, azimuth and elevation. */
export class Camera {
  view = new Float32Array(16);
  proj = new Float32Array(16);
  viewProj = new Float32Array(16);
  eye = new Float32Array(3);
  /** Device px per world unit at w = 1 (for point sizes). */
  projPx = 1;
  private w = 1;
  private h = 1;

  set(tx: number, ty: number, tz: number, dist: number, az: number, el: number, fov: number, w: number, h: number) {
    const ce = Math.cos(el);
    const ex = tx + dist * ce * Math.sin(az), ey = ty + dist * Math.sin(el), ez = tz + dist * ce * Math.cos(az);
    this.eye[0] = ex;
    this.eye[1] = ey;
    this.eye[2] = ez;
    let zx = ex - tx, zy = ey - ty, zz = ez - tz;
    let l = Math.hypot(zx, zy, zz) || 1;
    zx /= l; zy /= l; zz /= l;
    let xx = zz, xy = 0, xz = -zx; // up (0,1,0) × z
    l = Math.hypot(xx, xy, xz) || 1;
    xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    const V = this.view;
    V[0] = xx; V[1] = yx; V[2] = zx; V[3] = 0;
    V[4] = xy; V[5] = yy; V[6] = zy; V[7] = 0;
    V[8] = xz; V[9] = yz; V[10] = zz; V[11] = 0;
    V[12] = -(xx * ex + xy * ey + xz * ez);
    V[13] = -(yx * ex + yy * ey + yz * ez);
    V[14] = -(zx * ex + zy * ey + zz * ez);
    V[15] = 1;
    const f = 1 / Math.tan(fov / 2), near = 0.05, far = 80, nf = 1 / (near - far);
    const P = this.proj;
    P.fill(0);
    P[0] = f / (w / h);
    P[5] = f;
    P[10] = (far + near) * nf;
    P[11] = -1;
    P[14] = 2 * far * near * nf;
    const M = this.viewProj;
    for (let c = 0; c < 4; c++)
      for (let r = 0; r < 4; r++) M[c * 4 + r] = P[r] * V[c * 4] + P[4 + r] * V[c * 4 + 1] + P[8 + r] * V[c * 4 + 2] + P[12 + r] * V[c * 4 + 3];
    this.w = w;
    this.h = h;
    this.projPx = (h / 2) * f;
  }

  /** Screen position (CSS px) into out[0..1], out[2] = w (> 0 in front). */
  project(x: number, y: number, z: number, out: Float32Array | number[]) {
    const m = this.viewProj;
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    out[0] = (cx / cw * 0.5 + 0.5) * this.w;
    out[1] = (1 - (cy / cw * 0.5 + 0.5)) * this.h;
    out[2] = cw;
  }
}

interface Prog {
  p: WebGLProgram;
  vs: WebGLShader;
  fs: WebGLShader;
  u: Record<string, WebGLUniformLocation | null>;
  name: string;
}

export interface Build {
  instances: Float32Array;
  count: number;
  size: number;
  points: Float32Array;
  pointCount: number;
  coverU: number;
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private par: { COMPLETION_STATUS_KHR: number } | null;
  private progs: Prog[] = [];
  private bg: Prog;
  private prim: Prog;
  private text: Prog;
  private part: Prog;
  private pts: Prog;
  linked = false;
  private empty: WebGLVertexArrayObject;
  private primVao: WebGLVertexArrayObject;
  private primBuf: WebGLBuffer;
  private glyphVao: WebGLVertexArrayObject;
  private glyphBuf: WebGLBuffer;
  private partVao: WebGLVertexArrayObject | null = null;
  partCount = 0;
  partSize = 0.02;
  private ptsVao: WebGLVertexArrayObject | null = null;
  private ptsCount = 0;
  private tex: WebGLTexture | null = null;
  private atlasW = 1;
  private atlasH = 1;
  devW = 1;
  devH = 1;
  cssW = 1;
  cssH = 1;
  scale = 1;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, depth: true, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('webgl2');
    this.gl = gl;
    // compile on the driver's threads; nothing blocks until every program reports completion
    this.par = gl.getExtension('KHR_parallel_shader_compile');
    this.bg = this.make(TRI_VS, BG_FS, 'bg');
    this.prim = this.make(PRIM_VS, PRIM_FS, 'prim');
    this.text = this.make(TEXT_VS, TEXT_FS, 'text');
    this.part = this.make(PART_VS, PART_FS, 'facets');
    this.pts = this.make(PTS_VS, PTS_FS, 'points');
    this.empty = gl.createVertexArray()!;
    this.primBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.primBuf);
    gl.bufferData(gl.ARRAY_BUFFER, MAXP * PF * 4, gl.DYNAMIC_DRAW);
    this.primVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.primVao);
    attribs(gl, this.primBuf, [[0, 4], [1, 4], [2, 4], [3, 4]], 1);
    this.glyphBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphBuf);
    gl.bufferData(gl.ARRAY_BUFFER, MAXG * GF * 4, gl.DYNAMIC_DRAW);
    this.glyphVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.glyphVao);
    attribs(gl, this.glyphBuf, [[0, 4], [1, 4], [2, 4], [3, 4], [4, 4]], 1);
    gl.bindVertexArray(null);
  }

  private make(vsSrc: string, fsSrc: string, name: string): Prog {
    const gl = this.gl;
    const vs = gl.createShader(gl.VERTEX_SHADER)!;
    gl.shaderSource(vs, vsSrc);
    gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(fs, fsSrc);
    gl.compileShader(fs);
    const p = gl.createProgram()!;
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    const pr = { p, vs, fs, u: {}, name };
    this.progs.push(pr);
    return pr;
  }

  /** True once every program is linked; never blocks while the extension says compilation is running. */
  poll(): boolean {
    if (this.linked) return true;
    const gl = this.gl;
    if (this.par) for (const pr of this.progs) if (!gl.getProgramParameter(pr.p, this.par.COMPLETION_STATUS_KHR)) return false;
    for (const pr of this.progs) {
      if (!gl.getProgramParameter(pr.p, gl.LINK_STATUS)) throw new Error(`${pr.name}: ${gl.getProgramInfoLog(pr.p)} ${gl.getShaderInfoLog(pr.vs)} ${gl.getShaderInfoLog(pr.fs)}`);
      const n = gl.getProgramParameter(pr.p, gl.ACTIVE_UNIFORMS) as number;
      for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(pr.p, i)!;
        pr.u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(pr.p, info.name);
      }
    }
    this.linked = true;
    return true;
  }

  setAtlas(a: Atlas) {
    const gl = this.gl;
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, a.w, a.h, 0, gl.RED, gl.UNSIGNED_BYTE, a.data);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.atlasW = a.w;
    this.atlasH = a.h;
  }

  setBuild(b: Build) {
    const gl = this.gl;
    this.partVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.partVao);
    attribs(gl, buffer(gl, tetrahedron()), [[0, 3], [1, 3], [2, 3]]);
    attribs(gl, buffer(gl, b.instances), [[3, 3], [4, 3], [5, 3], [6, 3], [7, 4], [8, 3]], 1);
    this.partCount = b.count;
    this.partSize = b.size;
    this.ptsVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.ptsVao);
    attribs(gl, buffer(gl, b.points), [[0, 4]]);
    this.ptsCount = b.pointCount;
    gl.bindVertexArray(null);
  }

  resize(cssW: number, cssH: number, pr: number) {
    const w = Math.max(2, Math.round(cssW * pr)), h = Math.max(2, Math.round(cssH * pr));
    if (w !== this.canvas.width || h !== this.canvas.height) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.devW = w;
    this.devH = h;
    this.cssW = cssW;
    this.cssH = cssH;
    this.scale = w / cssW;
  }

  /**
   * Renders a full frame into the still-hidden canvas with every program and state on, so each
   * pipeline (and, in software GL, each pixel routine) is built before it first appears.
   */
  warm(F: Frame) {
    const on = F.part.on, pon = F.pts.on;
    F.part.on = !!this.partVao;
    F.pts.on = !!this.ptsVao;
    this.render(F, true);
    F.part.on = on;
    F.pts.on = pon;
  }

  render(F: Frame, warm = false) {
    const gl = this.gl;
    gl.viewport(0, 0, this.devW, this.devH);
    gl.depthMask(true);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    let u = this.bg.u;
    gl.useProgram(this.bg.p);
    gl.uniform2f(u.uRes, this.devW, this.devH);
    gl.uniform1f(u.uScale, this.scale);
    gl.uniform3fv(u.uBase, F.base);
    gl.uniform4fv(u.uWipe, F.wipe);
    gl.uniform3fv(u.uWipeCol, F.wipeCol);
    gl.uniform4fv(u.uDisc, F.disc);
    gl.uniform3fv(u.uDiscCol, F.discCol);
    gl.uniform1i(u.uDiscN, F.discN);
    gl.bindVertexArray(this.empty);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const cam = F.cam;
    if (F.part.on && this.partVao) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.useProgram(this.part.p);
      u = this.part.u;
      gl.uniformMatrix4fv(u.uViewProj, false, cam.viewProj);
      gl.uniformMatrix4fv(u.uRingModel, false, F.part.ring);
      gl.uniformMatrix4fv(u.uExcModel, false, F.part.exc);
      gl.uniform1f(u.uT, F.part.T);
      gl.uniform1f(u.uTime, F.time);
      gl.uniform1f(u.uAppear, F.part.appear);
      gl.uniform1f(u.uFly0, F.part.fly0);
      gl.uniform1f(u.uFlySpread, F.part.spread);
      gl.uniform1f(u.uFlyDur, F.part.dur);
      gl.uniform1f(u.uGone, F.part.gone);
      gl.uniform3fv(u.uGoneTo, F.part.goneTo);
      gl.uniform1f(u.uSize, this.partSize);
      gl.uniform3fv(u.uCam, cam.eye);
      gl.uniform3f(u.uKeyDir, 0.5, 0.74, 0.45);
      gl.uniform3f(u.uKeyCol, 1.7, 1.58, 1.43);
      gl.uniform3f(u.uSky, 0.062, 0.056, 0.05);
      gl.uniform3f(u.uGround, 0.012, 0.01, 0.008);
      gl.uniform3f(u.uPaper, 0.88, 0.83, 0.74);
      gl.bindVertexArray(this.partVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 12, Math.min(this.partCount, F.part.count));
    }
    if (F.pts.on && this.ptsVao) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.pts.p);
      u = this.pts.u;
      const P = F.pts;
      gl.uniformMatrix4fv(u.uViewProj, false, cam.viewProj);
      gl.uniform3fv(u.uSite, P.site);
      gl.uniform3fv(u.uRise, P.rise);
      gl.uniform1f(u.uSize, 0.075);
      gl.uniform1f(u.uProj, cam.projPx * this.scale);
      gl.uniform3fv(u.uMast, P.mast);
      gl.uniform1f(u.uWave, P.wave);
      gl.uniform2fv(u.uMachine, P.machine);
      gl.uniform1f(u.uTime, F.time);
      gl.uniform1f(u.uAlpha, P.alpha);
      gl.uniform3f(u.uPaper, 0.949, 0.922, 0.867);
      gl.uniform3f(u.uSignal, 1, 0.29, 0.078);
      gl.bindVertexArray(this.ptsVao);
      gl.drawArrays(gl.POINTS, 0, this.ptsCount);
      gl.depthMask(true);
    }

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const nP = warm ? Math.max(1, F.nP) : F.nP;
    if (nP) {
      gl.useProgram(this.prim.p);
      gl.uniform2f(this.prim.u.uView, this.cssW, this.cssH);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.primBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, F.prims, 0, nP * PF);
      gl.bindVertexArray(this.primVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nP);
    }
    const nG = warm ? Math.max(1, F.nG) : F.nG;
    if (nG && this.tex) {
      gl.useProgram(this.text.p);
      u = this.text.u;
      gl.uniform2f(u.uView, this.cssW, this.cssH);
      gl.uniform2f(u.uAtlas, this.atlasW, this.atlasH);
      gl.uniform1f(u.uScale, this.scale);
      gl.uniform1f(u.uRadius, SDF.radius);
      gl.uniform1f(u.uCutoff, SDF.cutoff);
      gl.uniform3fv(u.uDisc, F.clip);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.uniform1i(u.uTex, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.glyphBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, F.glyphs, 0, nG * GF);
      gl.bindVertexArray(this.glyphVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nG);
    }
    gl.bindVertexArray(null);
  }
}
