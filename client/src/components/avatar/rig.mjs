// Adapted from the user-supplied Nalu-Interactive-Avatar.html.
// Canonical source: train/shared/nalu-avatar. Publish with scripts/sync-nalu-avatar.mjs.

/* Nalu — original-artwork cursor rig.
 * Uses the supplied PNG as a texture. No substitute particles, eyes, or pupils.
 * Dependency-free WebGL 1; bounded 2.5D motion, not a reconstructed 360° model.
 */


  const VERTEX = `
    precision highp float;
    attribute vec2 aUV;
    varying vec2 vUV;
    uniform vec2 uLook;
    uniform vec2 uGaze;
    uniform vec2 uFollow;
    uniform float uTime;
    uniform float uAlive;
    uniform float uBounce;
    uniform float uStrength;

    float softOval(vec2 p, vec2 c, vec2 r) {
      vec2 d = (p-c)/r;
      return exp(-0.5 * dot(d, d));
    }
    void main() {
      vUV = aUV;
      vec2 uv = aUV;
      vec2 gaze = uGaze * uStrength;
      vec2 look = uLook * uStrength;

      // The two existing glowing ovals move as complete patches of artwork.
      // The smooth surrounding warp carries their original light falloff too.
      float e1 = softOval(uv, vec2(0.557, 0.536), vec2(0.047, 0.064));
      float e2 = softOval(uv, vec2(0.716, 0.521), vec2(0.041, 0.060));
      float eyes = max(e1, e2);
      uv += gaze * vec2(0.0105, 0.0065) * eyes;

      // Approximate volume behind the original pixels. Rear particles and
      // ears have less depth than the cheeks and muzzle, giving real parallax.
      // Smooth depth fields avoid pinching or stretching the outer beads.
      float face = softOval(aUV, vec2(0.537, 0.569), vec2(0.245, 0.208));
      float muzzle = softOval(aUV, vec2(0.751, 0.575), vec2(0.120, 0.111));
      float earL = softOval(aUV, vec2(0.405, 0.298), vec2(0.060, 0.145));
      float earR = softOval(aUV, vec2(0.622, 0.330), vec2(0.065, 0.120));
      float depth = 0.180 * face + 0.050 * muzzle + 0.020 * earL + 0.018 * earR;

      vec2 pivot = vec2(0.521, 0.535);
      vec2 p = uv - pivot;
      float breathe = uAlive * sin(uTime * 1.7) * 0.0035;
      p *= vec2(1.0 + breathe, 1.0 + breathe * 0.60);
      p *= vec2(1.0 - uBounce * 0.045, 1.0 + uBounce * 0.035);

      float yaw = look.x * 0.24;
      float pitch = look.y * 0.17;
      float roll = look.x * 0.035;
      float x = p.x * cos(yaw) + (depth - 0.075) * sin(yaw);
      float z = (depth - 0.075) * cos(yaw) - p.x * sin(yaw);
      float y = p.y * cos(pitch) + z * sin(pitch);
      vec2 turned = vec2(x * cos(roll) - y * sin(roll),
                         x * sin(roll) + y * cos(roll));
      vec2 follow = uFollow * uStrength * vec2(0.020, 0.012);
      float hover = uAlive * sin(uTime * 1.45) * 0.0040 - uBounce * 0.026;
      vec2 displaced = pivot + turned + follow + vec2(0.0, hover);

      // Anchor the paper edges and the *original* ground shadow. Only the
      // avatar and its surrounding particles move, never a rotating card.
      float edge = smoothstep(0.015, 0.105, aUV.x)
                 * (1.0-smoothstep(0.905, 0.988, aUV.x));
      float height = smoothstep(0.007, 0.063, aUV.y)
                   * (1.0-smoothstep(0.833, 0.873, aUV.y));
      vec2 position = mix(aUV, displaced, edge * height);
      gl_Position = vec4(position.x * 2.0 - 1.0,
                         1.0 - position.y * 2.0, 0.0, 1.0);
    }
  `;
  const FRAGMENT = `
    precision highp float;
    varying vec2 vUV;
    uniform sampler2D uTexture;
    uniform float uTransparent;
    void main() {
      vec4 color = texture2D(uTexture, vUV);
      // Optional paper matte for the transparent desktop overlay. The source
      // texture is unchanged; saturated gold and dark particles stay visible.
      float paper = min(color.r, min(color.g, color.b));
      float alpha = 1.0 - smoothstep(0.60, 0.94, paper);
      vec3 unpapered = clamp((color.rgb - vec3(1.0 - alpha)) / max(alpha, 0.001), 0.0, 1.0);
      alpha *= 1.0 - smoothstep(0.815, 0.83, vUV.y);
      gl_FragColor = mix(color, vec4(unpapered, alpha), uTransparent);
    }
  `;

  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const damp = (from, to, rate, dt) => from + (to - from) * (1 - Math.exp(-rate * dt));

  export class NaluAvatar {
    constructor(canvas, options) {
      if (!(canvas instanceof HTMLCanvasElement)) throw new TypeError('NaluAvatar requires a canvas.');
      if (!options || !options.src) throw new TypeError('Provide the original artwork with options.src.');
      this.canvas = canvas;
      this.options = options;
      this.strength = clamp(Number(options.strength) || 1, 0.25, 1.5);
      this.paused = false;
      this.running = false;
      this.ready = false;
      this.destroyed = false;
      this.active = true;
      this.visible = true;
      this.phase = null;
      this.input = 0;
      this.energy = 0;
      this.target = [0, 0];
      this.look = [0, 0];
      this.gaze = [0, 0];
      this.follow = [0, 0];
      this.clock = 0;
      this.bounceStart = -100;
      this.last = 0;
      this.raf = 0;
      this.media = matchMedia('(prefers-reduced-motion: reduce)');
      this.reduced = this.media.matches;
      this.motionEnabled = !this.reduced;
      this._abort = new AbortController();
      this._tick = this._tick.bind(this);
      this._lastPointer = null;
      this.loaded = this._init();
    }

    async _init() {
      const gl = this.canvas.getContext('webgl', {
        alpha: !!this.options.transparent, antialias: true, depth: false, stencil: false,
        premultipliedAlpha: false, preserveDrawingBuffer: false,
        powerPreference: 'default'
      });
      if (!gl) throw new Error('WebGL is not available in this browser.');
      this.gl = gl;
      this._createPipeline();
      const image = new Image();
      // Use a local file/data URL or a same-origin image. Remote hosts must
      // serve Access-Control-Allow-Origin when options.crossOrigin is set.
      if (this.options.crossOrigin) image.crossOrigin = this.options.crossOrigin;
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('The original Nalu artwork could not be loaded.'));
        image.src = this.options.src;
      });
      if (this.destroyed) return this;
      this.image = image;
      this.texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.useProgram(this.program);
      gl.uniform1i(this.uniforms.uTexture, 0);
      gl.uniform1f(this.uniforms.uTransparent, this.options.transparent ? 1 : 0);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      this.ready = true;
      this._wireEvents();
      this.resize();
      this.renderStill();
      if (this.options.autoPlay !== false) this.play();
      return this;
    }

    _shader(type, code) {
      const gl = this.gl;
      const shader = gl.createShader(type);
      gl.shaderSource(shader, code);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error('Nalu shader compilation failed: ' + log);
      }
      return shader;
    }

    _createPipeline() {
      const gl = this.gl;
      const vs = this._shader(gl.VERTEX_SHADER, VERTEX);
      const fs = this._shader(gl.FRAGMENT_SHADER, FRAGMENT);
      const program = gl.createProgram();
      gl.attachShader(program, vs); gl.attachShader(program, fs);
      gl.linkProgram(program);
      gl.deleteShader(vs); gl.deleteShader(fs);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error('Nalu shader link failed: ' + gl.getProgramInfoLog(program));
      }
      this.program = program;
      gl.useProgram(program);
      this.uniforms = {};
      ['uLook','uGaze','uFollow','uTime','uAlive','uBounce','uStrength','uTexture','uTransparent']
        .forEach(key => this.uniforms[key] = gl.getUniformLocation(program, key));
      // Dense enough for smooth local eye movement; texture resolution is
      // independent of this grid, so the individual beads stay photographic.
      const n = 160;
      const uv = new Float32Array((n + 1) * (n + 1) * 2);
      for (let row = 0; row <= n; row++) {
        for (let col = 0; col <= n; col++) {
          const i = (row * (n + 1) + col) * 2;
          uv[i] = col / n; uv[i + 1] = row / n;
        }
      }
      const indices = new Uint16Array(n * n * 6);
      let k = 0;
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const a = y * (n + 1) + x, b = a + 1, c = a + n + 1, d = c + 1;
          indices[k++] = a; indices[k++] = c; indices[k++] = b;
          indices[k++] = b; indices[k++] = c; indices[k++] = d;
        }
      }
      this.count = indices.length;
      this.uvBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
      const location = gl.getAttribLocation(program, 'aUV');
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
      this.indexBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    }

    _wireEvents() {
      const signal = this._abort.signal;
      const surface = this.options.trackTarget || window;
      surface.addEventListener('pointermove', e => {
        this._lastPointer = [e.clientX, e.clientY];
        this._track(e.clientX, e.clientY);
      }, {passive: true, signal});
      document.addEventListener('pointerleave', () => this.returnHome(), {signal});
      window.addEventListener('blur', () => this.returnHome(), {signal});
      window.addEventListener('scroll', () => {
        if (this._lastPointer) this._track(...this._lastPointer);
      }, {passive: true, capture: true, signal});
      this.canvas.addEventListener('pointerup', e => {
        if (e.pointerType !== 'mouse') this.returnHome();
      }, {signal});
      this.canvas.addEventListener('pointercancel', () => this.returnHome(), {signal});
      this.canvas.addEventListener('click', () => this.bounce(), {signal});
      this.canvas.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault(); this.bounce();
        } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
          e.preventDefault();
          const dx = e.key === 'ArrowLeft' ? -0.25 : e.key === 'ArrowRight' ? 0.25 : 0;
          const dy = e.key === 'ArrowUp' ? -0.25 : e.key === 'ArrowDown' ? 0.25 : 0;
          this.setLook(this.target[0] + dx, this.target[1] + dy);
        } else if (e.key === 'Escape') this.returnHome();
      }, {signal});
      document.addEventListener('visibilitychange', () => this._resume(), {signal});
      this.media.addEventListener('change', e => this.setReducedMotion(e.matches), {signal});
      this.canvas.addEventListener('webglcontextlost', e => {
        e.preventDefault(); this.ready = false; this._stopLoop();
        this.options.onError?.(new Error('Nalu graphics context lost.'));
      }, {signal});
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(this.canvas);
      if (typeof IntersectionObserver !== 'undefined') {
        this.intersection = new IntersectionObserver(entries => {
          this.visible = entries[0].isIntersecting;
          this._resume();
        });
        this.intersection.observe(this.canvas);
      }
    }

    _track(x, y) {
      if (this.paused) return;
      const r = this.canvas.getBoundingClientRect();
      // Absolute cursor position, relative to Nalu's face, across the page.
      this.setLook((x - (r.left + r.width * 0.54)) / (r.width * 0.64),
                   (y - (r.top + r.height * 0.51)) / (r.height * 0.64));
    }

    setLook(x, y) {
      if (this.reduced || this.paused || !Number.isFinite(x) || !Number.isFinite(y)) return;
      this.target[0] = clamp(x, -1, 1);
      this.target[1] = clamp(y, -1, 1);
    }

    returnHome() {
      this.target = [0, 0]; this._lastPointer = null;
    }

    resize() {
      if (!this.ready || this.destroyed) return;
      const r = this.canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const w = Math.max(1, Math.round(r.width * dpr));
      const h = Math.max(1, Math.round(r.height * dpr));
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w; this.canvas.height = h;
        this.gl.viewport(0, 0, w, h);
      }
      this._draw();
    }

    _draw(pose) {
      if (!this.ready || this.destroyed) return;
      const gl = this.gl, u = this.uniforms;
      const p = pose || this._fixedPose || {};
      const alive = p.alive === undefined ? (this.motionEnabled ? 1 : 0) : p.alive;
      const look = p.look || this.look;
      const gaze = p.gaze || this.gaze;
      const follow = p.follow || this.follow;
      const t = p.time === undefined ? this.clock : p.time;
      const elapsed = this.clock - this.bounceStart;
      const b = p.bounce === undefined
        ? (elapsed >= 0 && elapsed < 1.1 && this.motionEnabled
            ? Math.sin(elapsed * 12) * Math.exp(-elapsed * 4.3) : this.energy * 0.45)
        : p.bounce;
      gl.useProgram(this.program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.uniform2fv(u.uLook, look);
      gl.uniform2fv(u.uGaze, gaze);
      gl.uniform2fv(u.uFollow, follow);
      gl.uniform1f(u.uTime, t);
      gl.uniform1f(u.uAlive, alive);
      gl.uniform1f(u.uBounce, b);
      gl.uniform1f(u.uStrength, this.strength * (this.reduced && !this.motionEnabled ? 0.35 : 1));
      gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_SHORT, 0);
    }

    _tick(ms) {
      this.raf = 0;
      if (this.paused || this.destroyed || !this.active || !this.visible || this.reduced || document.hidden) { this.running = false; return; }
      const dt = Math.min(0.05, this.last ? (ms-this.last)/1000 : 1/60);
      this.last = ms;
      this.clock += dt * (this.phase === 'thinking' ? 1.5 : 1);
      this.energy = damp(this.energy, this.phase === 'listening' || this.phase === 'talking' ? this.input : 0, 12, dt);
      for (let i=0; i<2; i++) {
        this.gaze[i] = damp(this.gaze[i], this.target[i], 14, dt);
        this.look[i] = damp(this.look[i], this.target[i], 7.5, dt);
        this.follow[i] = damp(this.follow[i], this.target[i], 4.2, dt);
      }
      this._draw();
      this.raf = requestAnimationFrame(this._tick);
    }

    bounce() {
      if (!this.ready || this.paused || this.reduced) return;
      this.bounceStart = this.clock;
      if (typeof this.options.onInteract === 'function') this.options.onInteract();
    }

    setStrength(value) {
      if (Number.isFinite(Number(value))) this.strength = clamp(Number(value), 0.25, 1.5);
      if (this.paused) this._draw();
    }

    setActivity(phase, input = this.input) {
      this.phase = ['listening', 'talking', 'thinking'].includes(phase) ? phase : null;
      if (Number.isFinite(input)) this.input = clamp(input, 0, 1);
    }

    setReducedMotion(reduced) {
      this.reduced = !!reduced;
      this.motionEnabled = !this.reduced;
      if (this.reduced) {
        this.returnHome(); this.look = [0, 0]; this.gaze = [0, 0]; this.follow = [0, 0];
        this.energy = 0; this.clock = 0;
        this._draw({alive: 0, bounce: 0});
      }
      this._resume();
    }

    setActive(active) { this.active = !!active; this._resume(); }
    pause() { this.paused = true; this._stopLoop(); }
    play() {
      if (this.destroyed) return;
      this.paused = false;
      this._fixedPose = null;
      this._resume();
    }
    _resume() {
      if (!this.ready || this.destroyed || this.paused || !this.active || !this.visible || this.reduced || document.hidden) {
        this._stopLoop(); return;
      }
      if (this.running) return;
      this.running = true; this.last = 0;
      this.raf = requestAnimationFrame(this._tick);
    }
    _stopLoop() {
      cancelAnimationFrame(this.raf); this.raf = 0; this.running = false; this.last = 0;
    }

    // Useful for previewing, testing, and neutral-pose comparison. Zero pose
    // maps the source pixels directly to the canvas without deformation.
    renderStill(x=0, y=0) {
      this.pause();
      this.look = [x,y]; this.gaze = [x,y]; this.follow = [x,y];
      this._fixedPose = {look:[x,y], gaze:[x,y], follow:[x,y], time:0, alive:0, bounce:0};
      this._draw(this._fixedPose);
    }

    destroy() {
      if (this.destroyed) return;
      this._stopLoop(); this._abort.abort();
      if (this.observer) this.observer.disconnect();
      if (this.intersection) this.intersection.disconnect();
      if (this.gl) {
        this.gl.deleteTexture(this.texture);
        this.gl.deleteBuffer(this.uvBuffer);
        this.gl.deleteBuffer(this.indexBuffer);
        this.gl.deleteProgram(this.program);
      }
      this.destroyed = true; this.ready = false;
    }
  }
