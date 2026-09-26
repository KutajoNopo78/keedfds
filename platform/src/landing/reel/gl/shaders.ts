// GLSL for the reel. 2D layers work in CSS pixels (y down) and output premultiplied sRGB;
// the 3D facets are lit in linear light and tone-mapped in their own shader (no post pass).

export const TRI_VS = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Base colour, one soft linear wipe and up to three circle wipes (soft edge = motion blur). */
export const BG_FS = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uScale;
uniform vec3 uBase;
uniform vec4 uWipe;
uniform vec3 uWipeCol;
uniform vec4 uDisc[3];
uniform vec3 uDiscCol[3];
uniform int uDiscN;
out vec4 o;
void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uScale;
  vec3 c = uBase;
  if (uWipe.w > 0.0) {
    float s = dot(p, uWipe.xy) - uWipe.z;
    c = mix(c, uWipeCol, 1.0 - smoothstep(-uWipe.w, uWipe.w, s));
  }
  for (int i = 0; i < 3; i++) {
    if (i >= uDiscN) break;
    float d = length(p - uDisc[i].xy) - uDisc[i].z;
    float soft = max(uDisc[i].w, 0.7);
    c = mix(c, uDiscCol[i], 1.0 - smoothstep(-soft, soft, d));
  }
  o = vec4(c, 1.0);
}`;

const QUAD = /* glsl */ `
vec2 corner() { return vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1)) * 2.0 - 1.0; }
vec4 toClip(vec2 w, vec2 view) { return vec4(w.x / view.x * 2.0 - 1.0, 1.0 - w.y / view.y * 2.0, 0.0, 1.0); }
`;

/** Instanced 2D primitives: iA = centre + half extents, iB = params, iC = rgba, iD = type, rotation, velocity. */
export const PRIM_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec4 iA;
layout(location = 1) in vec4 iB;
layout(location = 2) in vec4 iC;
layout(location = 3) in vec4 iD;
uniform vec2 uView;
out vec2 vL;
out vec2 vV;
flat out vec4 vB;
flat out vec4 vC;
flat out float vType;
${QUAD}
void main() {
  vec2 c = corner();
  float cs = cos(iD.y), sn = sin(iD.y);
  vec2 v = vec2(cs * iD.z + sn * iD.w, -sn * iD.z + cs * iD.w);
  vec2 l = c * (iA.zw + abs(v) * 0.5 + 2.0);
  vec2 w = iA.xy + vec2(cs * l.x - sn * l.y, sn * l.x + cs * l.y);
  vL = l;
  vV = v;
  vB = iB;
  vC = iC;
  vType = iD.x;
  gl_Position = toClip(w, uView);
}`;

export const PRIM_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vL;
in vec2 vV;
flat in vec4 vB;
flat in vec4 vC;
flat in float vType;
out vec4 o;
const float TAU = 6.2831853;
float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}
float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
// iq's uneven capsule (y up): circle r1 at the origin, circle r2 at (0, h)
float sdUneven(vec2 p, float r1, float r2, float h) {
  p.x = abs(p.x);
  float b = (r1 - r2) / h;
  float a = sqrt(1.0 - b * b);
  float k = dot(p, vec2(-b, a));
  if (k < 0.0) return length(p) - r1;
  if (k > a * h) return length(p - vec2(0.0, h)) - r2;
  return dot(p, vec2(a, b)) - r1;
}
// the readings as shapes: dial, drop (oil), pin (location), counter window (mileage), and the logo ring
float shape(int id, vec2 p, float R) {
  if (id == 0) return length(p) - R;
  if (id == 1) return sdUneven(vec2(p.x, -p.y + 0.35 * R), 0.68 * R, 0.05 * R, 1.3 * R);
  if (id == 2) {
    float d = sdUneven(vec2(p.x, p.y + 0.35 * R), 0.64 * R, 0.04 * R, 1.28 * R);
    return max(d, -(length(p - vec2(0.0, -0.35 * R)) - 0.27 * R));
  }
  if (id == 3) return sdRoundBox(p, vec2(0.84 * R, 0.62 * R), 0.16 * R);
  // logo ring: r 16.8, stroke 7.2, knockout 8.8 round the index dot at one o'clock (grid of 64)
  float ring = abs(length(p) - R) - 0.2143 * R;
  return max(ring, -(length(p - R * vec2(0.5, -0.8660254)) - 0.5238 * R));
}
void main() {
  int type = int(vType + 0.5);
  vec2 p = vL;
  float d, blur = 1.0, extra = 1.0;
  if (type == 0) {
    float r = vB.x, sp = length(vV);
    if (sp > 0.6) {
      d = sdSeg(p, -vV * 0.5, vV * 0.5) - r;
      blur = pow(2.0 * r / (2.0 * r + sp), 0.85);
    } else d = length(p) - r;
  } else if (type == 1) {
    float R = vB.x, hw = vB.y, a0 = vB.z, span = vB.w, len = length(p);
    if (span >= TAU - 1e-3) d = abs(len - R) - hw;
    else {
      float rel = mod(atan(p.x, -p.y) - a0, TAU);
      if (rel <= span) d = abs(len - R) - hw;
      else d = min(length(p - R * vec2(sin(a0), -cos(a0))), length(p - R * vec2(sin(a0 + span), -cos(a0 + span)))) - hw;
    }
  } else if (type == 2) {
    d = sdRoundBox(p, vB.xy, vB.z);
    if (vB.w > 0.0) d = abs(d) - vB.w;
  } else if (type == 3) {
    d = length(vec2(max(abs(p.x) - vB.x, 0.0), p.y)) - vB.y;
    if (vB.z > 0.0) {
      float m = mod(p.x + vB.x, vB.z) - vB.z * vB.w;
      extra = 1.0 - smoothstep(-0.6, 0.6, m);
    }
  } else {
    int a = int(mod(vB.y, 16.0) + 0.5);
    int b = int(floor(vB.y / 16.0) + 0.5);
    d = mix(shape(a, p, vB.x), shape(b, p, vB.x), vB.z);
    if (vB.w > 0.0) d = abs(d) - vB.w;
  }
  float aa = max(length(fwidth(p)), 1e-3) * 0.7;
  float a = clamp(0.5 - d / aa, 0.0, 1.0) * blur * extra * vC.a;
  if (a < 0.002) discard;
  o = vec4(vC.rgb * a, a);
}`;

/** SDF glyphs: gA = centre + half size, gB = uv rect, gC = rgba, gD = rotation, velocity, mode; gE = clip rect. */
export const TEXT_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec4 gA;
layout(location = 1) in vec4 gB;
layout(location = 2) in vec4 gC;
layout(location = 3) in vec4 gD;
layout(location = 4) in vec4 gE;
uniform vec2 uView;
uniform vec2 uAtlas;
uniform float uScale;
out vec2 vUv;
out vec2 vW;
out vec2 vDuv;
flat out vec4 vRect;
flat out vec4 vC;
flat out float vMode;
flat out vec4 vClip;
flat out float vPx;
${QUAD}
void main() {
  vec2 c = corner();
  float cs = cos(gD.x), sn = sin(gD.x);
  vec2 v = vec2(cs * gD.y + sn * gD.z, -sn * gD.y + cs * gD.z);
  vec2 l = c * (gA.zw + abs(v) * 0.5 + 1.5);
  vec2 w = gA.xy + vec2(cs * l.x - sn * l.y, sn * l.x + cs * l.y);
  vec2 uvSize = gB.zw - gB.xy;
  vUv = gB.xy + (l / (2.0 * gA.zw) + 0.5) * uvSize;
  vDuv = v / (2.0 * gA.zw) * uvSize;
  vRect = gB;
  vC = gC;
  vMode = gD.w;
  vClip = gE;
  vW = w;
  vPx = 2.0 * gA.z / (uvSize.x * uAtlas.x) * uScale;
  gl_Position = toClip(w, uView);
}`;

export const TEXT_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uAtlas;
uniform float uRadius;
uniform float uCutoff;
uniform vec3 uDisc;
in vec2 vUv;
in vec2 vW;
in vec2 vDuv;
flat in vec4 vRect;
flat in vec4 vC;
flat in float vMode;
flat in vec4 vClip;
flat in float vPx;
out vec4 o;
float cover(vec2 uv, bool outline) {
  float d = (1.0 - texture(uTex, clamp(uv, vRect.xy, vRect.zw)).r - uCutoff) * uRadius;
  if (outline) d = abs(d + 2.6) - 2.6;
  return clamp(0.5 - d * vPx, 0.0, 1.0);
}
void main() {
  int mode = int(vMode + 0.5);
  bool outline = (mode & 1) == 1;
  float a;
  if (length(vDuv * uAtlas) * vPx > 0.8) {
    a = 0.0;
    for (int i = 0; i < 9; i++) a += cover(vUv - vDuv * (float(i) / 8.0 - 0.5), outline);
    a /= 9.0;
  } else a = cover(vUv, outline);
  if (vClip.x < vClip.z) {
    a *= step(vClip.x, vW.x) * step(vW.x, vClip.z);
    a *= smoothstep(vClip.y - 0.5, vClip.y + 0.5, vW.y) * (1.0 - smoothstep(vClip.w - 0.5, vClip.w + 0.5, vW.y));
  }
  float r = length(vW - uDisc.xy);
  if ((mode & 2) == 2) a *= 1.0 - smoothstep(uDisc.z - 1.0, uDisc.z + 1.0, r);
  if ((mode & 4) == 4) a *= smoothstep(uDisc.z - 1.0, uDisc.z + 1.0, r);
  a *= vC.a;
  if (a < 0.002) discard;
  o = vec4(vC.rgb * a, a);
}`;

const LIGHT = /* glsl */ `
uniform vec3 uCam;
uniform vec3 uKeyDir;
uniform vec3 uKeyCol;
uniform vec3 uSky;
uniform vec3 uGround;
vec3 env(vec3 r) {
  vec3 c = mix(uGround, uSky, smoothstep(-0.35, 0.75, r.y));
  float strip = smoothstep(0.48, 0.56, r.y) * (1.0 - smoothstep(0.78, 0.9, r.y));
  c += vec3(1.0, 0.96, 0.9) * 1.35 * strip * smoothstep(1.0, 0.15, abs(r.x));
  c += uKeyCol * 2.2 * pow(max(dot(r, uKeyDir), 0.0), 28.0);
  return c;
}
`;

const NOISE = /* glsl */ `
float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i), n100 = hash13(i + vec3(1, 0, 0)), n010 = hash13(i + vec3(0, 1, 0)), n110 = hash13(i + vec3(1, 1, 0));
  float n001 = hash13(i + vec3(0, 0, 1)), n101 = hash13(i + vec3(1, 0, 1)), n011 = hash13(i + vec3(0, 1, 1)), n111 = hash13(i + vec3(1, 1, 1));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
`;

// thin-film interference (first order, n = 1.46): the temper colours of heat-treated steel
const FILM = /* glsl */ `
vec3 thinFilm(float cosI, float d) {
  const float n = 1.46;
  float sinT2 = (1.0 - cosI * cosI) / (n * n);
  float opd = 2.0 * n * d * sqrt(max(0.0, 1.0 - sinT2));
  vec3 f = 0.5 - 0.5 * cos(6.2831853 * opd / vec3(650.0, 540.0, 460.0));
  return mix(vec3(dot(f, vec3(0.3333))), f, 0.95);
}
`;

/** Facets: a hollow torus shell (the logo ring) that flies, staggered, into the machine. */
export const PART_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec3 aBary;
layout(location = 3) in vec3 aA;
layout(location = 4) in vec3 aNA;
layout(location = 5) in vec3 aB;
layout(location = 6) in vec3 aNB;
layout(location = 7) in vec4 aSeed;
layout(location = 8) in vec3 aOrder;
uniform mat4 uViewProj;
uniform mat4 uRingModel;
uniform mat4 uExcModel;
uniform float uT;
uniform float uTime;
uniform float uAppear;
uniform float uFly0;
uniform float uFlySpread;
uniform float uFlyDur;
uniform float uGone;
uniform vec3 uGoneTo;
uniform float uSize;
uniform vec3 uPaper;
out vec3 vBary;
// Smooth values keep the dithered fade stable at its edge.
out float vFade;
out float vSeed;
flat out vec3 vColor;
flat out vec3 vEdgeColor;
${NOISE}
${LIGHT}
${FILM}
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
mat3 axisAngle(vec3 ax, float a) {
  float s = sin(a), c = cos(a), ic = 1.0 - c;
  return mat3(c + ax.x * ax.x * ic, ax.y * ax.x * ic + ax.z * s, ax.z * ax.x * ic - ax.y * s,
              ax.x * ax.y * ic - ax.z * s, c + ax.y * ax.y * ic, ax.z * ax.y * ic + ax.x * s,
              ax.x * ax.z * ic + ax.y * s, ax.y * ax.z * ic - ax.x * s, c + ax.z * ax.z * ic);
}
mat3 frame(vec3 n) {
  vec3 up = abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t = normalize(cross(up, n));
  return mat3(t, cross(n, t), n);
}
vec3 bezier(vec3 a, vec3 b, vec3 c, vec3 d, float t) {
  float it = 1.0 - t;
  return it * it * it * a + 3.0 * it * it * t * b + 3.0 * it * t * t * c + t * t * t * d;
}
float inOutCubic(float t) { return t < 0.5 ? 4.0 * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 3.0) * 0.5; }
float smoother(float t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
mat3 rot3(mat4 m) { mat3 r = mat3(m); return mat3(normalize(r[0]), normalize(r[1]), normalize(r[2])); }
void main() {
  float n = 0.62 * vnoise(aA * 5.4 + 3.1) + 0.38 * vnoise(aA * 12.6 - 1.7);
  float appear = smoothstep(n - 0.02, n + 0.12, uAppear);
  mat3 RA = rot3(uRingModel), RB = rot3(uExcModel);
  vec3 A = (uRingModel * vec4(aA, 1.0)).xyz, NA = RA * aNA;
  vec3 B = (uExcModel * vec4(aB, 1.0)).xyz, NB = RB * aNB;
  float fs = uFly0 + aOrder.x * uFlySpread;
  float f = clamp((uT - fs) / (uFlyDur * (0.84 + 0.32 * aSeed.w)), 0.0, 1.0);
  float fe = inOutCubic(f);
  vec3 P1 = A + NA * 0.42 + vec3(0.0, 0.75, 0.0) + aSeed.xyz * 0.5;
  vec3 P2 = B + NB * 0.55 + vec3(0.0, 0.6, 0.0) + aSeed.zxy * 0.38;
  vec3 pos = bezier(A, P1, P2, B, fe);
  // anticipation: each facet tucks into the shell before it leaves; follow-through on arrival
  pos -= NA * 0.04 * sin(3.14159 * clamp((uT - fs + 0.18) / 0.18, 0.0, 1.0)) * step(f, 0.0);
  float k = clamp((f - 0.78) / 0.22, 0.0, 1.0);
  pos += normalize(B - P2) * 0.06 * sin(3.14159 * k) * (1.0 - k * 0.4) * step(0.001, f);
  pos += NB * step(0.999, f) * 0.006 * sin(uTime * 1.3 + aSeed.w * 23.0);
  float g = smoothstep(aSeed.w * 0.55, aSeed.w * 0.55 + 0.45, uGone);
  pos = mix(pos, uGoneTo, g * g);
  // one face lies on the surface, facing out; whole turns in flight so each facet lands as it left
  vec3 cr = cross(NA, NB);
  float cl = length(cr);
  vec3 ax = cl > 1e-4 ? cr / cl : normalize(cross(NA, abs(NA.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  mat3 swing = axisAngle(ax, acos(clamp(dot(NA, NB), -1.0, 1.0)) * fe);
  mat3 pre0 = axisAngle(vec3(0.70710678, -0.70710678, 0.0), 2.186276);
  float tilt = 0.16 + 0.3 * fract(aSeed.w * 7.13) + 0.1 * sin(uTime * 0.8 + aSeed.w * 31.0);
  float td = aSeed.x * 3.14159;
  mat3 lean = axisAngle(vec3(cos(td), sin(td), 0.0), tilt);
  mat3 twist = axisAngle(vec3(0.0, 0.0, 1.0), aSeed.y * 3.14159);
  float spin = 6.2831853 * (1.0 + floor(aSeed.w * 2.0)) * smoother(f) + 0.45 * sin(3.14159 * k) * (1.0 - k);
  mat3 tumble = axisAngle(normalize(aSeed.xyz + vec3(0.001, 0.002, 0.003)), spin);
  mat3 R = swing * RA * frame(aNA) * twist * lean * tumble * pre0;
  float s = uSize * appear * (1.0 + 0.22 * sin(3.14159 * f)) * (1.0 - g);
  vec3 w = pos + R * (aPos * s);
  vBary = aBary;
  vFade = appear * (1.0 - g);
  vSeed = aSeed.w;
  vec3 vS = swing * NA;
  vec3 N = normalize(R * aNormal);
  vec3 V = normalize(uCam - w);
  if (dot(N, V) < 0.0) N = -N;
  float cosT = clamp(dot(N, V), 0.0, 1.0);
  float d = 192.0 + 62.0 * sin(dot(w, vec3(0.8, 0.45, -0.4)) * 0.95 - uTime * 0.2);
  d += 30.0 * (vnoise(w * 1.2 + vec3(0.0, uTime * 0.04, 0.0)) - 0.5) + vSeed * 12.0 + aOrder.z * fe;
  vec3 film = thinFilm(cosT, d);
  vec3 H = normalize(uKeyDir + V);
  float diff = max(dot(N, uKeyDir), 0.0);
  float spec = pow(max(dot(N, H), 0.0), 64.0);
  float fres = 0.06 + 0.94 * pow(1.0 - cosT, 4.0);
  float shell = mix(0.26, 1.0, smoothstep(-0.35, 0.3, dot(normalize(vS), V)));
  vec3 col = vec3(0.012, 0.011, 0.009) + film * (0.1 + 0.7 * diff + 1.05 * fres) * shell;
  col += spec * (1.4 + 0.9 * sin(3.14159 * f)) * mix(vec3(1.0), film * 1.5, 0.5) * shell;
  col += env(reflect(-V, N)) * film * fres * 0.45 * shell;
  vec3 withEdge = col + (0.06 + 1.2 * spec + 0.35 * fres + 0.12 * diff) * mix(uPaper, film, 0.6) * shell;
  // Pre-tone both edge endpoints; the fragment stage only evaluates the barycentric mask.
  vColor = pow(aces(col * 1.1), vec3(1.0 / 2.2));
  vEdgeColor = pow(aces(withEdge * 1.1), vec3(1.0 / 2.2));
  gl_Position = uViewProj * vec4(w, 1.0);
}`;

export const PART_FS = /* glsl */ `#version 300 es
precision highp float;
in vec3 vBary;
in float vFade;
in float vSeed;
flat in vec3 vColor;
flat in vec3 vEdgeColor;
out vec4 o;
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void main() {
  if (vFade < 0.999 && vFade < hash12(gl_FragCoord.xy + vSeed * 97.0)) discard;
  float e = min(min(vBary.x, vBary.y), vBary.z);
  float w = fwidth(e);
  float edge = 1.0 - smoothstep(w * 0.5, w * 1.5 + 0.022, e);
  o = vec4(mix(vColor, vEdgeColor, edge), 1.0);
}`;

/** The map: a perspective grid of points; dead zone flickers, the flush wave runs out from the mast. */
export const PTS_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec4 aP;
uniform mat4 uViewProj;
uniform vec3 uSite;
uniform vec3 uRise;
uniform float uSize;
uniform float uProj;
uniform vec3 uMast;
uniform float uWave;
uniform vec2 uMachine;
uniform float uTime;
uniform float uAlpha;
uniform vec3 uPaper;
uniform vec3 uSignal;
out vec4 vCol;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  float k = clamp((uRise.z - length(aP.xz - uRise.xy)) / 2.5, 0.0, 1.0);
  float kk = k * k * (3.0 - 2.0 * k);
  vec3 p = vec3(aP.x, aP.y * kk - (1.0 - kk) * 0.7, aP.z) + uSite;
  vec4 clip = uViewProj * vec4(p, 1.0);
  gl_Position = clip;
  float dm = length(aP.xz - uMast.xy);
  float cover = 1.0 - smoothstep(uMast.z - 0.3, uMast.z + 0.3, dm);
  float route = aP.w;
  float flick = step(0.94, hash(aP.xz * 13.1 + floor(uTime * 12.0)));
  float a = (0.34 + 0.6 * clamp(aP.y * 1.5, 0.0, 1.0)) * mix(0.45 + 0.5 * flick, 1.0, cover);
  a = mix(a, 0.85, route);
  vec3 col = uPaper;
  if (uWave > 0.0) {
    float wv = (dm - uWave) * 2.4;
    float w = exp(-wv * wv) * (1.0 - smoothstep(9.0, 13.0, uWave));
    col = mix(col, uSignal, w);
    a = max(a, w);
  }
  float dmach = length(aP.xz - uMachine);
  col = mix(col, uSignal, exp(-dmach * dmach * 5.0) * 0.85);
  vCol = vec4(col, a * kk * uAlpha);
  gl_PointSize = max(1.0, uSize * uProj / clip.w * mix(1.0, 1.1, route));
}`;

export const PTS_FS = /* glsl */ `#version 300 es
precision highp float;
in vec4 vCol;
out vec4 o;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float a = vCol.a * (1.0 - smoothstep(0.5, 1.0, dot(q, q)));
  if (a < 0.003) discard;
  o = vec4(vCol.rgb * a, a);
}`;
