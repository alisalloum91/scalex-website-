

"use client"

import { useEffect, useRef } from "react"

/**
 * Real-time GPU fluid simulation (Navier-Stokes) rendered to a full-screen canvas.
 * Self-contained raw WebGL — no external dependencies.
 *
 * Pipeline per frame:
 *  - advect velocity & dye
 *  - compute curl + apply vorticity confinement (adds swirl)
 *  - compute divergence
 *  - Jacobi pressure solve
 *  - subtract pressure gradient (make velocity divergence-free)
 *  - splat dye/velocity from pointer movement
 *  - display dye field with subtle bloom-ish tonemapping
 */

interface FluidConfig {
  simResolution?: number
  dyeResolution?: number
  densityDissipation?: number
  velocityDissipation?: number
  pressureIterations?: number
  curl?: number
  splatRadius?: number
  splatForce?: number
  palette?: [number, number, number][]
}

const DEFAULTS: Required<FluidConfig> = {
  simResolution: 128,
  dyeResolution: 1024,
  densityDissipation: 0.97,
  velocityDissipation: 0.98,
  pressureIterations: 20,
  curl: 30,
  splatRadius: 0.25,
  splatForce: 6000,
  // teal -> cyan -> warm amber accent set, themed against a dark background
  palette: [
    [0.0, 0.55, 0.62],
    [0.1, 0.7, 0.75],
    [0.9, 0.55, 0.2],
    [0.2, 0.45, 0.85],
  ],
}

export function FluidSimulation({ config = {} }: { config?: FluidConfig }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const cfg = { ...DEFAULTS, ...config }

    const params: WebGLContextAttributes = {
      alpha: true,
      depth: false,
      stencil: false,
      antialias: false,
      preserveDrawingBuffer: false,
    }

    const gl =
      (canvas.getContext("webgl2", params) as WebGL2RenderingContext | null) ||
      null

    if (!gl) {
      // Graceful fallback handled by caller's static background
      return
    }

    // ---- extension / format setup ------------------------------------------
    gl.getExtension("EXT_color_buffer_float")
    const supportLinear = gl.getExtension("OES_texture_float_linear")

    const halfFloat = gl.HALF_FLOAT
    const rgba = { internalFormat: gl.RGBA16F, format: gl.RGBA }
    const rg = { internalFormat: gl.RG16F, format: gl.RG }
    const r = { internalFormat: gl.R16F, format: gl.RED }
    const filtering = supportLinear ? gl.LINEAR : gl.NEAREST

    // ---- shader helpers ----------------------------------------------------
    function compile(type: number, source: string) {
      const shader = gl!.createShader(type)!
      gl!.shaderSource(shader, source)
      gl!.compileShader(shader)
      if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) {
        console.log("[v0] shader error:", gl!.getShaderInfoLog(shader))
      }
      return shader
    }

    function program(vs: string, fs: string) {
      const p = gl!.createProgram()!
      gl!.attachShader(p, compile(gl!.VERTEX_SHADER, vs))
      gl!.attachShader(p, compile(gl!.FRAGMENT_SHADER, fs))
      gl!.linkProgram(p)
      if (!gl!.getProgramParameter(p, gl!.LINK_STATUS)) {
        console.log("[v0] program error:", gl!.getProgramInfoLog(p))
      }
      return p
    }

    function uniforms(p: WebGLProgram) {
      const map: Record<string, WebGLUniformLocation | null> = {}
      const count = gl!.getProgramParameter(p, gl!.ACTIVE_UNIFORMS)
      for (let i = 0; i < count; i++) {
        const name = gl!.getActiveUniform(p, i)!.name
        map[name] = gl!.getUniformLocation(p, name)
      }
      return map
    }

    const baseVertex = `#version 300 es
      precision highp float;
      in vec2 aPosition;
      out vec2 vUv;
      out vec2 vL;
      out vec2 vR;
      out vec2 vT;
      out vec2 vB;
      uniform vec2 texelSize;
      void main () {
        vUv = aPosition * 0.5 + 0.5;
        vL = vUv - vec2(texelSize.x, 0.0);
        vR = vUv + vec2(texelSize.x, 0.0);
        vT = vUv + vec2(0.0, texelSize.y);
        vB = vUv - vec2(0.0, texelSize.y);
        gl_Position = vec4(aPosition, 0.0, 1.0);
      }
    `

    const clearShader = `#version 300 es
      precision mediump float;
      in vec2 vUv;
      uniform sampler2D uTexture;
      uniform float value;
      out vec4 fragColor;
      void main () { fragColor = value * texture(uTexture, vUv); }
    `

    const splatShader = `#version 300 es
      precision highp float;
      in vec2 vUv;
      uniform sampler2D uTarget;
      uniform float aspectRatio;
      uniform vec3 color;
      uniform vec2 point;
      uniform float radius;
      out vec4 fragColor;
      void main () {
        vec2 p = vUv - point.xy;
        p.x *= aspectRatio;
        vec3 splat = exp(-dot(p, p) / radius) * color;
        vec3 base = texture(uTarget, vUv).xyz;
        fragColor = vec4(base + splat, 1.0);
      }
    `

    const advectionShader = `#version 300 es
      precision highp float;
      in vec2 vUv;
      uniform sampler2D uVelocity;
      uniform sampler2D uSource;
      uniform vec2 texelSize;
      uniform float dt;
      uniform float dissipation;
      out vec4 fragColor;
      void main () {
        vec2 coord = vUv - dt * texture(uVelocity, vUv).xy * texelSize;
        vec4 result = texture(uSource, coord);
        float decay = 1.0 + dissipation * dt;
        fragColor = result / decay;
      }
    `

    const divergenceShader = `#version 300 es
      precision mediump float;
      in vec2 vUv;
      in vec2 vL;
      in vec2 vR;
      in vec2 vT;
      in vec2 vB;
      uniform sampler2D uVelocity;
      out vec4 fragColor;
      void main () {
        float L = texture(uVelocity, vL).x;
        float R = texture(uVelocity, vR).x;
        float T = texture(uVelocity, vT).y;
        float B = texture(uVelocity, vB).y;
        vec2 C = texture(uVelocity, vUv).xy;
        if (vL.x < 0.0) { L = -C.x; }
        if (vR.x > 1.0) { R = -C.x; }
        if (vT.y > 1.0) { T = -C.y; }
        if (vB.y < 0.0) { B = -C.y; }
        float div = 0.5 * (R - L + T - B);
        fragColor = vec4(div, 0.0, 0.0, 1.0);
      }
    `

    const curlShader = `#version 300 es
      precision mediump float;
      in vec2 vUv;
      in vec2 vL;
      in vec2 vR;
      in vec2 vT;
      in vec2 vB;
      uniform sampler2D uVelocity;
      out vec4 fragColor;
      void main () {
        float L = texture(uVelocity, vL).y;
        float R = texture(uVelocity, vR).y;
        float T = texture(uVelocity, vT).x;
        float B = texture(uVelocity, vB).x;
        float vorticity = R - L - T + B;
        fragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
      }
    `

    const vorticityShader = `#version 300 es
      precision highp float;
      in vec2 vUv;
      in vec2 vL;
      in vec2 vR;
      in vec2 vT;
      in vec2 vB;
      uniform sampler2D uVelocity;
      uniform sampler2D uCurl;
      uniform float curl;
      uniform float dt;
      out vec4 fragColor;
      void main () {
        float L = texture(uCurl, vL).x;
        float R = texture(uCurl, vR).x;
        float T = texture(uCurl, vT).x;
        float B = texture(uCurl, vB).x;
        float C = texture(uCurl, vUv).x;
        vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
        force /= length(force) + 0.0001;
        force *= curl * C;
        force.y *= -1.0;
        vec2 velocity = texture(uVelocity, vUv).xy;
        velocity += force * dt;
        velocity = min(max(velocity, -1000.0), 1000.0);
        fragColor = vec4(velocity, 0.0, 1.0);
      }
    `

    const pressureShader = `#version 300 es
      precision mediump float;
      in vec2 vUv;
      in vec2 vL;
      in vec2 vR;
      in vec2 vT;
      in vec2 vB;
      uniform sampler2D uPressure;
      uniform sampler2D uDivergence;
      out vec4 fragColor;
      void main () {
        float L = texture(uPressure, vL).x;
        float R = texture(uPressure, vR).x;
        float T = texture(uPressure, vT).x;
        float B = texture(uPressure, vB).x;
        float divergence = texture(uDivergence, vUv).x;
        float pressure = (L + R + B + T - divergence) * 0.25;
        fragColor = vec4(pressure, 0.0, 0.0, 1.0);
      }
    `

    const gradientSubtractShader = `#version 300 es
      precision mediump float;
      in vec2 vUv;
      in vec2 vL;
      in vec2 vR;
      in vec2 vT;
      in vec2 vB;
      uniform sampler2D uPressure;
      uniform sampler2D uVelocity;
      out vec4 fragColor;
      void main () {
        float L = texture(uPressure, vL).x;
        float R = texture(uPressure, vR).x;
        float T = texture(uPressure, vT).x;
        float B = texture(uPressure, vB).x;
        vec2 velocity = texture(uVelocity, vUv).xy;
        velocity.xy -= vec2(R - L, T - B);
        fragColor = vec4(velocity, 0.0, 1.0);
      }
    `

    const displayShader = `#version 300 es
      precision highp float;
      in vec2 vUv;
      uniform sampler2D uTexture;
      out vec4 fragColor;
      void main () {
        vec3 c = texture(uTexture, vUv).rgb;
        // soft tonemap for a glowing look
        c = c / (1.0 + c);
        float a = max(c.r, max(c.g, c.b));
        fragColor = vec4(c, a);
      }
    `

    // ---- programs ----------------------------------------------------------
    const progs = {
      clear: program(baseVertex, clearShader),
      splat: program(baseVertex, splatShader),
      advection: program(baseVertex, advectionShader),
      divergence: program(baseVertex, divergenceShader),
      curl: program(baseVertex, curlShader),
      vorticity: program(baseVertex, vorticityShader),
      pressure: program(baseVertex, pressureShader),
      gradient: program(baseVertex, gradientSubtractShader),
      display: program(baseVertex, displayShader),
    }
    const u = {
      clear: uniforms(progs.clear),
      splat: uniforms(progs.splat),
      advection: uniforms(progs.advection),
      divergence: uniforms(progs.divergence),
      curl: uniforms(progs.curl),
      vorticity: uniforms(progs.vorticity),
      pressure: uniforms(progs.pressure),
      gradient: uniforms(progs.gradient),
      display: uniforms(progs.display),
    }

    // ---- fullscreen quad ---------------------------------------------------
    const vao = gl.createVertexArray()
    gl.bindVertexArray(vao)
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    )
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

    function blit(target: FBO | null) {
      if (target) {
        gl!.viewport(0, 0, target.width, target.height)
        gl!.bindFramebuffer(gl!.FRAMEBUFFER, target.fbo)
      } else {
        gl!.viewport(0, 0, gl!.drawingBufferWidth, gl!.drawingBufferHeight)
        gl!.bindFramebuffer(gl!.FRAMEBUFFER, null)
      }
      gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4)
    }

    // ---- framebuffer objects ----------------------------------------------
    interface FBO {
      texture: WebGLTexture
      fbo: WebGLFramebuffer
      width: number
      height: number
      texelSizeX: number
      texelSizeY: number
      attach: (id: number) => number
    }
    interface DoubleFBO {
      width: number
      height: number
      texelSizeX: number
      texelSizeY: number
      read: FBO
      write: FBO
      swap: () => void
    }

    function createFBO(
      w: number,
      h: number,
      internalFormat: number,
      format: number,
      type: number,
      param: number,
    ): FBO {
      gl!.activeTexture(gl!.TEXTURE0)
      const texture = gl!.createTexture()!
      gl!.bindTexture(gl!.TEXTURE_2D, texture)
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, param)
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, param)
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE)
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE)
      gl!.texImage2D(gl!.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null)

      const fbo = gl!.createFramebuffer()!
      gl!.bindFramebuffer(gl!.FRAMEBUFFER, fbo)
      gl!.framebufferTexture2D(
        gl!.FRAMEBUFFER,
        gl!.COLOR_ATTACHMENT0,
        gl!.TEXTURE_2D,
        texture,
        0,
      )
      gl!.viewport(0, 0, w, h)
      gl!.clear(gl!.COLOR_BUFFER_BIT)

      return {
        texture,
        fbo,
        width: w,
        height: h,
        texelSizeX: 1 / w,
        texelSizeY: 1 / h,
        attach(id: number) {
          gl!.activeTexture(gl!.TEXTURE0 + id)
          gl!.bindTexture(gl!.TEXTURE_2D, texture)
          return id
        },
      }
    }

    function createDoubleFBO(
      w: number,
      h: number,
      internalFormat: number,
      format: number,
      type: number,
      param: number,
    ): DoubleFBO {
      let fbo1 = createFBO(w, h, internalFormat, format, type, param)
      let fbo2 = createFBO(w, h, internalFormat, format, type, param)
      return {
        width: w,
        height: h,
        texelSizeX: 1 / w,
        texelSizeY: 1 / h,
        get read() {
          return fbo1
        },
        set read(v) {
          fbo1 = v
        },
        get write() {
          return fbo2
        },
        set write(v) {
          fbo2 = v
        },
        swap() {
          const temp = fbo1
          fbo1 = fbo2
          fbo2 = temp
        },
      }
    }

    function getResolution(resolution: number) {
      let aspect = gl!.drawingBufferWidth / gl!.drawingBufferHeight
      if (aspect < 1) aspect = 1 / aspect
      const min = Math.round(resolution)
      const max = Math.round(resolution * aspect)
      if (gl!.drawingBufferWidth > gl!.drawingBufferHeight) {
        return { width: max, height: min }
      }
      return { width: min, height: max }
    }

    let dye: DoubleFBO
    let velocity: DoubleFBO
    let divergence: FBO
    let curlFBO: FBO
    let pressure: DoubleFBO

    function initFramebuffers() {
      const simRes = getResolution(cfg.simResolution)
      const dyeRes = getResolution(cfg.dyeResolution)

      dye = createDoubleFBO(
        dyeRes.width,
        dyeRes.height,
        rgba.internalFormat,
        rgba.format,
        halfFloat,
        filtering,
      )
      velocity = createDoubleFBO(
        simRes.width,
        simRes.height,
        rg.internalFormat,
        rg.format,
        halfFloat,
        filtering,
      )
      divergence = createFBO(
        simRes.width,
        simRes.height,
        r.internalFormat,
        r.format,
        halfFloat,
        gl!.NEAREST,
      )
      curlFBO = createFBO(
        simRes.width,
        simRes.height,
        r.internalFormat,
        r.format,
        halfFloat,
        gl!.NEAREST,
      )
      pressure = createDoubleFBO(
        simRes.width,
        simRes.height,
        r.internalFormat,
        r.format,
        halfFloat,
        gl!.NEAREST,
      )
    }

    function resizeCanvas() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = Math.floor(canvas!.clientWidth * dpr)
      const h = Math.floor(canvas!.clientHeight * dpr)
      if (canvas!.width !== w || canvas!.height !== h) {
        canvas!.width = w
        canvas!.height = h
        return true
      }
      return false
    }

    resizeCanvas()
    initFramebuffers()

    // ---- pointer state -----------------------------------------------------
    interface Pointer {
      id: number
      x: number
      y: number
      dx: number
      dy: number
      down: boolean
      moved: boolean
      color: [number, number, number]
    }
    const pointers: Pointer[] = []
    let colorIndex = 0

    function nextColor(): [number, number, number] {
      const base = cfg.palette[colorIndex % cfg.palette.length]
      colorIndex++
      return [base[0] * 0.6, base[1] * 0.6, base[2] * 0.6]
    }

    function getPointer(id: number) {
      let p = pointers.find((x) => x.id === id)
      if (!p) {
        p = {
          id,
          x: 0,
          y: 0,
          dx: 0,
          dy: 0,
          down: false,
          moved: false,
          color: nextColor(),
        }
        pointers.push(p)
      }
      return p
    }

    function updatePointer(p: Pointer, x: number, y: number) {
      p.dx = (x - p.x) * 5
      p.dy = (y - p.y) * 5
      p.x = x
      p.y = y
      p.moved = Math.abs(p.dx) > 0 || Math.abs(p.dy) > 0
    }

    function clientToCanvas(clientX: number, clientY: number) {
      const rect = canvas!.getBoundingClientRect()
      const x = (clientX - rect.left) / rect.width
      const y = 1 - (clientY - rect.top) / rect.height
      return { x, y }
    }

    // ---- simulation steps --------------------------------------------------
    let lastTime = performance.now()

    function step(dt: number) {
      gl!.disable(gl!.BLEND)
      gl!.bindVertexArray(vao)

      // curl
      gl!.useProgram(progs.curl)
      gl!.uniform2f(u.curl.texelSize, velocity.texelSizeX, velocity.texelSizeY)
      gl!.uniform1i(u.curl.uVelocity, velocity.read.attach(0))
      blit(curlFBO)

      // vorticity
      gl!.useProgram(progs.vorticity)
      gl!.uniform2f(
        u.vorticity.texelSize,
        velocity.texelSizeX,
        velocity.texelSizeY,
      )
      gl!.uniform1i(u.vorticity.uVelocity, velocity.read.attach(0))
      gl!.uniform1i(u.vorticity.uCurl, curlFBO.attach(1))
      gl!.uniform1f(u.vorticity.curl, cfg.curl)
      gl!.uniform1f(u.vorticity.dt, dt)
      blit(velocity.write)
      velocity.swap()

      // divergence
      gl!.useProgram(progs.divergence)
      gl!.uniform2f(
        u.divergence.texelSize,
        velocity.texelSizeX,
        velocity.texelSizeY,
      )
      gl!.uniform1i(u.divergence.uVelocity, velocity.read.attach(0))
      blit(divergence)

      // clear pressure
      gl!.useProgram(progs.clear)
      gl!.uniform1i(u.clear.uTexture, pressure.read.attach(0))
      gl!.uniform1f(u.clear.value, 0.8)
      blit(pressure.write)
      pressure.swap()

      // pressure solve
      gl!.useProgram(progs.pressure)
      gl!.uniform2f(
        u.pressure.texelSize,
        velocity.texelSizeX,
        velocity.texelSizeY,
      )
      gl!.uniform1i(u.pressure.uDivergence, divergence.attach(0))
      for (let i = 0; i < cfg.pressureIterations; i++) {
        gl!.uniform1i(u.pressure.uPressure, pressure.read.attach(1))
        blit(pressure.write)
        pressure.swap()
      }

      // gradient subtract
      gl!.useProgram(progs.gradient)
      gl!.uniform2f(
        u.gradient.texelSize,
        velocity.texelSizeX,
        velocity.texelSizeY,
      )
      gl!.uniform1i(u.gradient.uPressure, pressure.read.attach(0))
      gl!.uniform1i(u.gradient.uVelocity, velocity.read.attach(1))
      blit(velocity.write)
      velocity.swap()

      // advect velocity
      gl!.useProgram(progs.advection)
      gl!.uniform2f(
        u.advection.texelSize,
        velocity.texelSizeX,
        velocity.texelSizeY,
      )
      gl!.uniform1i(u.advection.uVelocity, velocity.read.attach(0))
      gl!.uniform1i(u.advection.uSource, velocity.read.attach(0))
      gl!.uniform1f(u.advection.dt, dt)
      gl!.uniform1f(u.advection.dissipation, 1 - cfg.velocityDissipation)
      blit(velocity.write)
      velocity.swap()

      // advect dye
      gl!.uniform1i(u.advection.uVelocity, velocity.read.attach(0))
      gl!.uniform1i(u.advection.uSource, dye.read.attach(1))
      gl!.uniform2f(u.advection.texelSize, dye.texelSizeX, dye.texelSizeY)
      gl!.uniform1f(u.advection.dissipation, 1 - cfg.densityDissipation)
      blit(dye.write)
      dye.swap()
    }

    function splat(x: number, y: number, dx: number, dy: number, color: number[]) {
      // velocity splat
      gl!.useProgram(progs.splat)
      gl!.uniform1i(u.splat.uTarget, velocity.read.attach(0))
      gl!.uniform1f(
        u.splat.aspectRatio,
        canvas!.width / canvas!.height,
      )
      gl!.uniform2f(u.splat.point, x, y)
      gl!.uniform3f(u.splat.color, dx, dy, 0)
      gl!.uniform1f(u.splat.radius, cfg.splatRadius / 100)
      blit(velocity.write)
      velocity.swap()

      // dye splat
      gl!.uniform1i(u.splat.uTarget, dye.read.attach(0))
      gl!.uniform3f(u.splat.color, color[0], color[1], color[2])
      blit(dye.write)
      dye.swap()
    }

    function splatPointer(p: Pointer) {
      const dx = p.dx * cfg.splatForce
      const dy = p.dy * cfg.splatForce
      splat(p.x, p.y, dx, dy, p.color)
    }

    // a few initial splashes so the canvas isn't empty on load
    function seed() {
      for (let i = 0; i < 8; i++) {
        const color = nextColor().map((c) => c * 8) as number[]
        const x = Math.random()
        const y = Math.random()
        const dx = 1000 * (Math.random() - 0.5)
        const dy = 1000 * (Math.random() - 0.5)
        splat(x, y, dx, dy, color)
      }
    }
    seed()

    // ---- render loop -------------------------------------------------------
    let raf = 0
    let running = true

    function render() {
      if (!running) return
      const now = performance.now()
      let dt = (now - lastTime) / 1000
      dt = Math.min(dt, 0.016666)
      lastTime = now

      if (resizeCanvas()) initFramebuffers()

      for (const p of pointers) {
        if (p.moved) {
          p.moved = false
          splatPointer(p)
        }
      }

      step(dt)

      // display to screen
      gl!.useProgram(progs.display)
      gl!.uniform1i(u.display.uTexture, dye.read.attach(0))
      gl!.enable(gl!.BLEND)
      gl!.blendFunc(gl!.ONE, gl!.ONE_MINUS_SRC_ALPHA)
      blit(null)

      raf = requestAnimationFrame(render)
    }
    raf = requestAnimationFrame(render)

    // ---- event listeners ---------------------------------------------------
    function onPointerMove(e: PointerEvent) {
      const p = getPointer(e.pointerId)
      const { x, y } = clientToCanvas(e.clientX, e.clientY)
      updatePointer(p, x, y)
    }
    function onPointerDown(e: PointerEvent) {
      const p = getPointer(e.pointerId)
      const { x, y } = clientToCanvas(e.clientX, e.clientY)
      p.x = x
      p.y = y
      p.down = true
      p.color = nextColor().map((c) => c * 6) as [number, number, number]
    }
    function onPointerUp(e: PointerEvent) {
      const p = pointers.find((x) => x.id === e.pointerId)
      if (p) p.down = false
    }
    function onVisibility() {
      if (document.hidden) {
        running = false
        cancelAnimationFrame(raf)
      } else if (!running) {
        running = true
        lastTime = performance.now()
        raf = requestAnimationFrame(render)
      }
    }

    window.addEventListener("pointermove", onPointerMove)
    window.addEventListener("pointerdown", onPointerDown)
    window.addEventListener("pointerup", onPointerUp)
    document.addEventListener("visibilitychange", onVisibility)

    return () => {
      running = false
      cancelAnimationFrame(raf)
      window.removeEventListener("pointermove", onPointerMove)
      window.removeEventListener("pointerdown", onPointerDown)
      window.removeEventListener("pointerup", onPointerUp)
      document.removeEventListener("visibilitychange", onVisibility)
      const ext = gl.getExtension("WEBGL_lose_context")
      ext?.loseContext()
    }
  }, [config])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="fixed inset-0 h-full w-full"
    />
  )
}