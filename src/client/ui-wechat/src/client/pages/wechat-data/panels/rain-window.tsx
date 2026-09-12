/**
 * RainWindow — 移植自 Kimi「雨窗手记」的 WebGL 雨玻璃着色器（学习移植）。
 * 在聊天空状态右侧渲染「雨打玻璃」：真实水珠、流动雨痕、远处夜景焦外。
 * 原实现：https://2lt3tc7rdlpgi.ok.kimi.link/
 */
import { useEffect, useRef } from 'react'

const VERT_SRC = `#version 300 es
// Fullscreen triangle. No attributes, no buffers — gl_VertexID does the work.
void main() {
	vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
	gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`

const FRAG_SRC = `#version 300 es
precision highp float;

out vec4 fragColor;

uniform vec2  uRes;
uniform float uPx;
uniform float uTime;
uniform sampler2D uBg0;
uniform sampler2D uBg1;
uniform sampler2D uBg2;
uniform sampler2D uText;
uniform vec2  uBgScale;
uniform vec2  uBgOffset;
uniform float uIntensity;
uniform float uSpeed;
uniform float uDropSize;
uniform float uTrail;
uniform float uWind;
uniform float uMist;
uniform float uRefract;
uniform float uDisperse;
uniform float uSpecular;
uniform float uBlur;
uniform float uBright;
uniform float uFlash;
uniform float uGrain;

const float FLATTEN = 0.62;

float h11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }

vec4 h42(vec2 p) {
	vec4 q = fract(p.xyxy * vec4(0.1031, 0.1030, 0.0973, 0.1099));
	q += dot(q, q.wzxy + 33.33);
	return fract((q.xxyz + q.yzzw) * q.zywx);
}

float cap(float d2, float rad) {
	float k = 1.0 - d2 / (rad * rad);
	return k > 0.0 ? sqrt(k) : 0.0;
}

vec2 sag(vec2 d, float rad) {
	float g = 0.20 * min(1.0, rad * 5.0);
	d.y *= (d.y < 0.0 ? 1.0 - g : 1.0 + g) / 1.09;
	return d;
}

vec2 wobble(vec2 d, float rad, float seed) {
	float a = 0.085 * min(1.0, rad * 5.0);
	float w = 2.1 / max(rad, 1e-3);
	return d + rad * a * vec2(sin(d.y * w + seed * 12.9), sin(d.x * w * 0.83 + seed * 7.7));
}

float smax(float a, float b, float k) {
	float h = clamp(0.5 + 0.5 * (a - b) / k, 0.0, 1.0);
	return mix(b, a, h) + k * h * (1.0 - h);
}

vec2 merge(vec2 a, vec2 b) {
	return vec2(smax(a.x, b.x, 0.42 * max(a.x, b.x) + 1e-7), max(a.y, b.y));
}

vec2 iso(vec2 d, float aspect) { return vec2(d.x, d.y * aspect); }

vec2 rot(vec2 p, float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c) * p; }

float pathX(float y, float x0, float sway, float room) {
	float a = y * 7.0 + sway;
	return 0.5 + x0 + sin(a + sin(a)) * room * (1.0 - y);
}

float vnoise(vec2 p) {
	vec2 i = floor(p), f = fract(p);
	f = f * f * (3.0 - 2.0 * f);
	float a = h11(dot(i, vec2(1.0, 57.0)));
	float b = h11(dot(i + vec2(1.0, 0.0), vec2(1.0, 57.0)));
	float c = h11(dot(i + vec2(0.0, 1.0), vec2(1.0, 57.0)));
	float d = h11(dot(i + vec2(1.0, 1.0), vec2(1.0, 57.0)));
	return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

vec3 runners(vec2 p, vec2 cells, float t, float sd, float rest) {
	float aspect = cells.x / cells.y;
	vec2 g = p * cells;
	g.y += h11(floor(g.x) * 1.73 + sd * 9.13) * 17.0;
	vec2 id = floor(g);
	vec2 f  = fract(g);
	vec4 r  = h42(id + vec2(sd * 37.13, sd * 11.71));
	if (r.w > uIntensity) return vec3(0.0);
	float tt   = t * mix(0.24, 0.58, r.y) * uSpeed + r.z * 7.13;
	float ph   = fract(tt);
	vec4  q    = h42(id * 1.7 + vec2(floor(tt) * 13.31 + sd * 5.0, floor(tt) * 7.77));
	float s    = clamp((ph - rest) / (1.0 - rest), 0.0, 1.0);
	float y0   = mix(0.52, 0.92, q.x);
	float y    = mix(y0, 0.08, s * s);
	float grow = smoothstep(0.0, rest * 0.35, ph);
	float amp  = grow * (1.0 - smoothstep(0.86, 1.0, s));
	float x0   = (q.y - 0.5) * 0.18;
	float sway = q.w * 29.0;
	float rad  = min(mix(0.14, 0.36, q.z * q.z) * uDropSize, 0.33) * mix(0.55, 1.0, grow);
	float unit = 1.0 / cells.x;
	float room = max(0.0, 0.47 - abs(x0) - rad * 1.15);
	vec2 d = iso(f - vec2(pathX(y, x0, sway, room), y), aspect);
	d.y /= 1.0 + s * 0.45;
	d = wobble(sag(d, rad), rad, r.x + sd);
	float hc   = cap(dot(d, d), rad) * amp;
	float head = smoothstep(0.0, 0.16, hc);
	float behind = smoothstep(0.0, 0.02, f.y - y)
	             * (1.0 - smoothstep(y0 - 0.05, y0 + 0.01, f.y)) * step(0.002, s);
	float fresh  = 1.0 - clamp((f.y - y) / max(1e-3, y0 - y), 0.0, 1.0);
	float slat   = f.x - pathX(f.y, x0, sway, room);
	float lat    = abs(slat);
	float swath = (1.0 - smoothstep(rad * 0.4, rad * 2.4, lat)) * behind * mix(0.4, 1.0, fresh) * amp;
	float nb   = 11.0 + 9.0 * q.y;
	float ty   = f.y * nb;
	float br   = h11(floor(ty) * 1.37 + q.y * 53.0 + sd * 7.0);
	float brad = rad * (0.18 + 0.40 * br) * mix(0.25, 1.0, fresh);
	vec2  bd   = iso(vec2(slat - (br - 0.5) * rad * 0.7, (fract(ty) - 0.5) / nb), aspect);
	bd = wobble(sag(bd, brad), brad, br + sd);
	float bc   = cap(dot(bd, bd), brad) * behind * step(0.36, br) * amp * uTrail;
	float fw   = max(1e-4, rad * mix(0.10, 0.55, fresh) * exp(-(f.y - y) * 4.5));
	float film = cap(lat * lat, fw) * behind * amp * uTrail;
	float height = max(hc * rad, max(bc * brad, film * fw)) * unit * FLATTEN;
	float water  = max(head, smoothstep(0.0, 0.16, max(bc, film)));
	return vec3(height, water, max(swath, water));
}

vec2 beading(vec2 p, float cells, vec2 radRange, float cover, float t, float sd) {
	vec2 g  = p * cells;
	vec2 id = floor(g);
	vec2 f  = fract(g);
	vec4 r  = h42(id + vec2(sd * 17.31, sd * 91.77));
	if (r.z > cover) return vec2(0.0);
	float sz  = fract(r.z * 7.31 + r.x * 3.17);
	vec2  c   = vec2(0.36) + 0.28 * r.xy;
	float rad = mix(radRange.x, radRange.y, sz * sz)
	          * mix(0.5, 1.0, 0.5 + 0.5 * sin(t * 0.07 + r.w * 6.2832));
	vec2  d   = wobble(sag(f - c, rad), rad, r.x + sd);
	float k   = cap(dot(d, d), rad);
	return vec2(k * rad / cells * FLATTEN, smoothstep(0.0, 0.16, k));
}

vec4 pane(vec2 p, float t, float wipe) {
	p.x += uWind * 0.55 * p.y + sin(p.y * 5.3) * 0.012;
	vec3 a = runners(p, vec2( 9.0,  1.3), t * 0.52, 1.0, 0.78);
	vec3 b = runners(p, vec2(17.0,  3.0), t * 0.82, 2.0, 0.64);
	vec3 c = runners(p, vec2(27.0,  6.0), t * 1.15, 3.0, 0.50);
	vec3 d = runners(p, vec2(44.0, 13.0), t * 1.50, 4.0, 0.36);
	vec2 run = merge(merge(vec2(a.x, a.y), vec2(b.x, b.y)),
	                 merge(vec2(c.x, c.y), vec2(d.x, d.y)));
	float clear = max(max(max(a.z, b.z), max(c.z, d.z)), wipe);
	float uneven = mix(0.58, 1.26, vnoise(p * 1.35 + 11.0)) * mix(0.78, 1.12, vnoise(p * 3.1));
	float cv = clamp(uMist, 0.0, 1.4) * uneven;
	vec2 m = beading(rot(p, 0.37), 24.0, vec2(0.17, 0.30), 0.44 * cv, t, 5.0);
	m = merge(m, beading(rot(p, 1.94), 38.0, vec2(0.16, 0.31), 0.66 * cv, t, 9.0));
	m = merge(m, beading(rot(p, 0.91), 60.0, vec2(0.16, 0.32), 0.86 * cv, t, 4.0));
	m = merge(m, beading(rot(p, 2.63), 94.0, vec2(0.17, 0.33), 1.00 * cv, t, 6.0));
	m *= 1.0 - smoothstep(0.0, 0.45, clear);
	vec2 all = merge(run, m);
	return vec4(all.x, clamp(max(run.y, clear), 0.0, 1.0), m.y, clamp(all.y, 0.0, 1.0));
}

vec3 scene(vec2 uv, float b) {
	uv = clamp(uv, 0.0015, 0.9985);
	b = clamp(b, 0.0, 1.0);
	vec3 s = texture(uBg0, uv).rgb;
	vec3 m = texture(uBg1, uv).rgb;
	vec3 h = texture(uBg2, uv).rgb;
	return b < 0.5 ? mix(s, m, b * 2.0) : mix(m, h, b * 2.0 - 1.0);
}

void main() {
	vec2 uv = gl_FragCoord.xy / uRes;
	vec2 p  = (gl_FragCoord.xy - 0.5 * uRes) / uPx;
	float t = uTime;
	float wipe = texture(uText, uv).r;
	vec4  P = pane(p, t, wipe);
	float e = 1.7 / uPx;
	float hx = pane(p + vec2(e, 0.0), t, wipe).x;
	float hy = pane(p + vec2(0.0, e), t, wipe).x;
	vec2  n  = vec2(hx - P.x, hy - P.x) / e;
	float nl = length(n);
	n *= 1.0 / (1.0 + nl * 0.22);
	vec2 off = -n * uRefract * 0.075 * (uPx / uRes.y);
	vec2 buv = (uv + off - 0.5) * uBgScale + 0.5 + uBgOffset;
	float blur = clamp(mix(uBlur, 0.0, P.y) + P.z * 0.25, 0.0, 1.0);
	vec3 col = scene(buv, blur);
	if (uDisperse > 0.001) {
		float k = uDisperse * 0.12 * smoothstep(0.05, 0.5, P.w);
		col.r = scene(buv + off * k, blur).r;
		col.b = scene(buv - off * k, blur).b;
	}
	vec3 N = normalize(vec3(-n, 1.0));
	vec3 H = normalize(vec3(-0.34, 0.50, 0.80) + vec3(0.0, 0.0, 1.0));
	float ndh = max(dot(N, H), 0.0);
	col += (pow(ndh, 220.0) * 2.2 + pow(ndh, 6.0) * 0.10 * P.w)
	     * uSpecular * vec3(0.74, 0.85, 1.0);
	col *= 1.0 - smoothstep(0.35, 2.2, nl) * 0.30;
	col = mix(col, col * vec3(0.88, 0.94, 1.05), P.z * 0.45);
	col += uFlash * (0.06 + 0.26 * P.w) * vec3(0.62, 0.74, 0.98);
	col *= uBright;
	vec2 q = uv - 0.5;
	col *= 1.0 - 0.42 * pow(clamp(dot(q, q) * 2.0, 0.0, 1.0), 1.35);
	col += (h11(dot(gl_FragCoord.xy, vec2(12.9898, 78.233)) + fract(t) * 91.3) - 0.5) * uGrain;
	fragColor = vec4(max(col, 0.0), 1.0);
}
`

interface RainWindowProps {
  className?: string | undefined
  label?: string
  /** 是否播放动画；false 时暂停 rAF（窗口隐藏时省电）。 */
  active?: boolean
}

function get2d(c: HTMLCanvasElement): CanvasRenderingContext2D | null {
  return c.getContext('2d')
}

function blurCopyFrom(sharp: HTMLCanvasElement, px: number): HTMLCanvasElement {
  const c2 = document.createElement('canvas')
  c2.width = sharp.width
  c2.height = sharp.height
  const g = get2d(c2)
  if (g) {
    g.filter = `blur(${px}px)`
    g.drawImage(sharp, 0, 0)
  }
  return c2
}

function makeScene(w: number, h: number): { sharp: HTMLCanvasElement; soft: HTMLCanvasElement; heavy: HTMLCanvasElement } {
  const sharp = document.createElement('canvas')
  sharp.width = w
  sharp.height = h
  const x = get2d(sharp)
  if (x) {
    const grad = x.createLinearGradient(0, 0, 0, h)
    grad.addColorStop(0, '#050a14')
    grad.addColorStop(0.42, '#0a1526')
    grad.addColorStop(0.72, '#13233a')
    grad.addColorStop(1, '#0a1120')
    x.fillStyle = grad
    x.fillRect(0, 0, w, h)
    const palette = ['rgba(255,176,92,', 'rgba(255,214,150,', 'rgba(120,200,255,', 'rgba(255,120,110,', 'rgba(176,150,255,', 'rgba(140,255,214,']
    const layers = [
      { n: Math.round((w * h) / 3000), y0: 0.44, y1: 0.72, r0: 2, r1: 9, a0: 0.3, a1: 0.7 },
      { n: Math.round((w * h) / 8000), y0: 0.42, y1: 0.75, r0: 6, r1: 24, a0: 0.16, a1: 0.42 },
    ]
    for (const L of layers) {
      for (let i = 0; i < L.n; i++) {
        const cx = Math.random() * w
        const cy = (L.y0 + Math.random() * (L.y1 - L.y0)) * h
        const r = L.r0 + Math.random() * (L.r1 - L.r0)
        const grad2 = x.createRadialGradient(cx, cy, 0, cx, cy, r)
        const c = palette[Math.floor(Math.random() * palette.length)] ?? 'rgba(255,176,92,'
        const a = L.a0 + Math.random() * (L.a1 - L.a0)
        grad2.addColorStop(0, `${c}${a})`)
        grad2.addColorStop(1, `${c}0)`)
        x.fillStyle = grad2
        x.fillRect(cx - r, cy - r, r * 2, r * 2)
      }
    }
    for (let i = 0; i < 7; i++) {
      const y = (0.6 + Math.random() * 0.34) * h
      const lg = x.createLinearGradient(0, y, w, y + (Math.random() - 0.5) * 60)
      const a = 0.05 + Math.random() * 0.06
      lg.addColorStop(0, 'rgba(255,190,120,0)')
      lg.addColorStop(0.5, `rgba(255,190,120,${a})`)
      lg.addColorStop(1, 'rgba(255,190,120,0)')
      x.fillStyle = lg
      x.fillRect(0, y - 10, w, 20 + Math.random() * 18)
    }
  }
  return { sharp, soft: blurCopyFrom(sharp, 6), heavy: blurCopyFrom(sharp, 14) }
}

function makeTextMask(w: number, h: number, label: string): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = Math.max(2, Math.round(w))
  c.height = Math.max(2, Math.round(h))
  const g = get2d(c)
  if (g) {
    g.fillStyle = '#000'
    g.fillRect(0, 0, c.width, c.height)
    g.fillStyle = '#fff'
    g.font = '13px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(label, c.width / 2, c.height / 2)
  }
  return c
}

function glGetUniform(gl: WebGL2RenderingContext, program: WebGLProgram, name: string): WebGLUniformLocation {
  const loc = gl.getUniformLocation(program, name)
  if (loc === null) throw new Error('missing uniform ' + name)
  return loc
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type)
  if (!s) return null
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    return null
  }
  return s
}

let sceneCache: { sharp: HTMLCanvasElement; soft: HTMLCanvasElement; heavy: HTMLCanvasElement } | null = null
function getScene() {
  if (!sceneCache) sceneCache = makeScene(900, 840)
  return sceneCache
}

export function RainWindow({ className, label = '选择左侧会话查看消息', active = true }: RainWindowProps): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const apiRef = useRef<{ start: () => void; stop: () => void } | null>(null)
  const labelRef = useRef(label)
  labelRef.current = label

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const fallback = (): void => {
      canvas.style.background = 'radial-gradient(120% 90% at 50% 20%, #0a1526 0%, #0a1120 60%, #050a14 100%)'
    }
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' })
    if (!gl) {
      fallback()
      return
    }
    const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC)
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC)
    if (!vs || !fs) {
      fallback()
      return
    }
    const program = gl.createProgram()
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      fallback()
      return
    }
    gl.useProgram(program)

    const u = {
      uRes: glGetUniform(gl, program, 'uRes'),
      uPx: glGetUniform(gl, program, 'uPx'),
      uTime: glGetUniform(gl, program, 'uTime'),
      uBgScale: glGetUniform(gl, program, 'uBgScale'),
      uBgOffset: glGetUniform(gl, program, 'uBgOffset'),
      uIntensity: glGetUniform(gl, program, 'uIntensity'),
      uSpeed: glGetUniform(gl, program, 'uSpeed'),
      uDropSize: glGetUniform(gl, program, 'uDropSize'),
      uTrail: glGetUniform(gl, program, 'uTrail'),
      uWind: glGetUniform(gl, program, 'uWind'),
      uMist: glGetUniform(gl, program, 'uMist'),
      uRefract: glGetUniform(gl, program, 'uRefract'),
      uDisperse: glGetUniform(gl, program, 'uDisperse'),
      uSpecular: glGetUniform(gl, program, 'uSpecular'),
      uBlur: glGetUniform(gl, program, 'uBlur'),
      uBright: glGetUniform(gl, program, 'uBright'),
      uFlash: glGetUniform(gl, program, 'uFlash'),
      uGrain: glGetUniform(gl, program, 'uGrain'),
    }

    const makeTexture = (source: TexImageSource, unit: number): WebGLTexture => {
      const tex = gl.createTexture()
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
      return tex
    }

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.uniform1i(glGetUniform(gl, program, 'uBg0'), 0)
    gl.uniform1i(glGetUniform(gl, program, 'uBg1'), 1)
    gl.uniform1i(glGetUniform(gl, program, 'uBg2'), 2)
    gl.uniform1i(glGetUniform(gl, program, 'uText'), 3)

    const scene = getScene()
    makeTexture(scene.sharp, 0)
    makeTexture(scene.soft, 1)
    makeTexture(scene.heavy, 2)

    let textTex: WebGLTexture | null = makeTexture(makeTextMask(2, 2, ''), 3)
    let raf = 0
    const start = performance.now()
    let flash = 0
    let flashTarget = 0
    let dpr = 1
    let w = 1
    let h = 1

    const resize = (): void => {
      const rect = canvas.parentElement?.getBoundingClientRect()
      if (!rect) return
      w = Math.max(1, rect.width)
      h = Math.max(1, rect.height)
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.uniform2f(u.uBgScale, 1, 1)
      gl.uniform2f(u.uBgOffset, 0, 0)
      if (!textTex) textTex = makeTexture(makeTextMask(canvas.width, canvas.height, labelRef.current), 3)
      gl.activeTexture(gl.TEXTURE3)
      gl.bindTexture(gl.TEXTURE_2D, textTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, makeTextMask(canvas.width, canvas.height, labelRef.current))
    }

    resize()

    const draw = (now: number): void => {
      if (Math.random() < 0.0012) flashTarget = 0.35 + Math.random() * 0.65
      flashTarget *= 0.995
      flash = Math.max(flash * 0.985, flashTarget)
      gl.uniform2f(u.uRes, canvas.width, canvas.height)
      gl.uniform1f(u.uPx, 900 * dpr)
      gl.uniform1f(u.uTime, (now - start) / 1000)
      gl.uniform1f(u.uIntensity, 0.5)
      gl.uniform1f(u.uSpeed, 0.9)
      gl.uniform1f(u.uDropSize, 1.0)
      gl.uniform1f(u.uTrail, 0.4)
      gl.uniform1f(u.uWind, 0.45)
      gl.uniform1f(u.uMist, 0.75)
      gl.uniform1f(u.uRefract, 1.3)
      gl.uniform1f(u.uDisperse, 1.2)
      gl.uniform1f(u.uSpecular, 0.8)
      gl.uniform1f(u.uBlur, 0.35)
      gl.uniform1f(u.uBright, 0.95)
      gl.uniform1f(u.uFlash, flash)
      gl.uniform1f(u.uGrain, 0.05)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      raf = requestAnimationFrame(draw)
    }

    const api = {
      start: () => { resize(); if (!raf) raf = requestAnimationFrame(draw) },
      stop: () => { if (raf) { cancelAnimationFrame(raf); raf = 0 } },
    }
    apiRef.current = api

    const ro = new ResizeObserver(() => { resize() })
    if (canvas.parentElement) ro.observe(canvas.parentElement)

    return () => {
      api.stop()
      apiRef.current = null
      ro.disconnect()
      // 显式丢弃 WebGL 上下文：Chromium 同时存活的上下文数量有限，
      // 只等 GC 会让反复开关聊天页时累积的上下文长期占着显存/内存。
      try { gl.getExtension('WEBGL_lose_context')?.loseContext() } catch { /* 尽力而为 */ }
    }
  }, [])

  // 聊天界面可见时播放，隐藏时暂停（避免反复重建/空转）
  useEffect(() => {
    const api = apiRef.current
    if (!api) return
    if (active) api.start()
    else api.stop()
    return () => { api.stop() }
  }, [active])

  return <canvas ref={ref} className={className ?? ''} aria-hidden="true" />
}
