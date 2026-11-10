/**
 * Black Hole WebGL 2.0 Renderer
 *
 * Sets up a WebGL 2 context, compiles the black-hole shader pair,
 * and runs a requestAnimationFrame loop feeding iTime / iResolution / iDate.
 *
 * Usage:
 *   import { BlackHoleRenderer } from './blackhole-renderer.js';
 *   const renderer = new BlackHoleRenderer(canvas);
 *   await renderer.init();
 *   renderer.start();
 */

export class BlackHoleRenderer {
    /** @param {HTMLCanvasElement} canvas */
    constructor(canvas) {
        this.canvas = canvas;
        /** @type {WebGL2RenderingContext} */
        this.gl = null;
        this.program = null;
        this.vao = null;
        this.startTime = performance.now() / 1000;
        this.running = false;
        this.rafId = null;
        this.preset = 0; // 0 = Inferno, 1 = Icy, 2 = Purple

        // Uniform locations
        this.uResolution = null;
        this.uTime = null;
        this.uDate = null;
        this.uPreset = null;
        this.uDesktop = null;
        this.uHasDesktop = null;

        // Video background
        this.video = null;
        this.videoTexture = null;
        this.placeholderTexture = null;
        this.videoTexWidth = 0;
        this.videoTexHeight = 0;
        this.newFrame = true;
        this._rvfcId = null;
        this.hasDesktop = false;

        // Resize handling
        this._resizeObserver = null;
        this._useWindowResize = false;

        // Bind once
        this._frame = this._frame.bind(this);
        this._onResize = this._onResize.bind(this);
        this._onContextLost = this._onContextLost.bind(this);
        this._onContextRestored = this._onContextRestored.bind(this);
    }

    // ----------------------------------------------------------------
    //  Initialisation
    // ----------------------------------------------------------------

    async init() {
        this.gl = this.canvas.getContext('webgl2', {
            antialias: false,
            alpha: true, // MUST BE TRUE for transparent overlay to work!
            depth: false,
            stencil: false,
            powerPreference: 'high-performance',
        });

        if (!this.gl) {
            throw new Error('WebGL 2 is not available on this device.');
        }

        const gl = this.gl;

        // Fetch shader sources (relative to the HTML page)
        const [vertRes, fragRes] = await Promise.all([
            fetch('fullscreen-quad.vert'),
            fetch('blackhole.frag'),
        ]);
        if (!vertRes.ok || !fragRes.ok) {
            // Electron serves these shaders over file:// where a successful
            // response can report status 0 (ok === false). Only a real HTTP
            // error (404/500) is fatal; the compile step still catches a
            // missing/empty shader body.
            if (vertRes.status !== 0 || fragRes.status !== 0) {
                throw new Error(
                    `Shader fetch failed (${vertRes.status}/${fragRes.status}).`
                );
            }
        }
        const [vertSrc, fragSrc] = await Promise.all([
            vertRes.text(),
            fragRes.text(),
        ]);

        // Compile
        const vert = this._compileShader(gl.VERTEX_SHADER, vertSrc);
        const frag = this._compileShader(gl.FRAGMENT_SHADER, fragSrc);

        // Link
        this.program = gl.createProgram();
        gl.attachShader(this.program, vert);
        gl.attachShader(this.program, frag);
        gl.linkProgram(this.program);

        if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
            const log = gl.getProgramInfoLog(this.program);
            gl.deleteProgram(this.program);
            throw new Error('Shader program link failed:\n' + log);
        }

        // Uniform calls below require the linked program to be current.
        gl.useProgram(this.program);

        // Clean up individual shaders
        gl.deleteShader(vert);
        gl.deleteShader(frag);

        // Uniform locations
        this.uResolution = gl.getUniformLocation(this.program, 'iResolution');
        this.uTime = gl.getUniformLocation(this.program, 'iTime');
        this.uDate = gl.getUniformLocation(this.program, 'iDate');
        this.uPreset = gl.getUniformLocation(this.program, 'u_preset');
        this.uDesktop = gl.getUniformLocation(this.program, 'u_desktop');
        this.uHasDesktop = gl.getUniformLocation(this.program, 'u_hasDesktop');

        // VAO — we draw with gl_VertexID so no buffers needed
        this.vao = gl.createVertexArray();

        // Always keep a complete texture bound so the sampler never sees an
        // incomplete texture while no desktop capture is available.
        this._createPlaceholderTexture();
        this._setDesktopSampler();

        // Initial resize + observe future size changes without a per-frame read
        this._onResize();
        if (typeof ResizeObserver === 'function') {
            this._resizeObserver = new ResizeObserver(() => this._onResize());
            this._resizeObserver.observe(this.canvas);
        } else {
            this._useWindowResize = true;
            window.addEventListener('resize', this._onResize);
        }

        this.canvas.addEventListener('webglcontextlost', this._onContextLost);
        this.canvas.addEventListener('webglcontextrestored', this._onContextRestored);
    }

    _createPlaceholderTexture() {
        const gl = this.gl;
        this.placeholderTexture = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.placeholderTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }

    /** Point sampler unit 0 at the desktop texture; the program must be current. */
    _setDesktopSampler() {
        const gl = this.gl;
        if (!gl || !this.program || this.uDesktop === null) return;
        gl.useProgram(this.program);
        gl.uniform1i(this.uDesktop, 0);
    }

    // ----------------------------------------------------------------
    //  Shader compilation helper
    // ----------------------------------------------------------------

    /**
     * @param {number} type  gl.VERTEX_SHADER or gl.FRAGMENT_SHADER
     * @param {string} src   GLSL source
     * @returns {WebGLShader}
     */
    _compileShader(type, src) {
        const gl = this.gl;
        const shader = gl.createShader(type);
        gl.shaderSource(shader, src);
        gl.compileShader(shader);

        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const info = gl.getShaderInfoLog(shader);
            const typeName = type === gl.VERTEX_SHADER ? 'VERTEX' : 'FRAGMENT';
            gl.deleteShader(shader);
            throw new Error(`${typeName} shader compile failed:\n${info}`);
        }
        return shader;
    }

    // ----------------------------------------------------------------
    //  Resize handling — match canvas to CSS / device pixels
    // ----------------------------------------------------------------

    _onResize() {
        if (!this.gl) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 1.0); // Cap at 1.0 for performance
        const w = Math.round(this.canvas.clientWidth * dpr);
        const h = Math.round(this.canvas.clientHeight * dpr);

        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w;
            this.canvas.height = h;
            this.gl.viewport(0, 0, w, h);
        }
    }

    // ----------------------------------------------------------------
    //  Render loop
    // ----------------------------------------------------------------

    start() {
        if (this.running) return;
        this.running = true;
        this.startTime = performance.now() / 1000;
        this._onResize(); // fallback for the first frame / missed observer events
        this.rafId = requestAnimationFrame(this._frame);
    }

    stop() {
        this.running = false;
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }

    reset() {
        this.startTime = performance.now() / 1000;
    }

    setPreset(index) {
        this.preset = index;
    }

    // ----------------------------------------------------------------
    //  Desktop video background
    // ----------------------------------------------------------------

    /**
     * @param {HTMLVideoElement} video
     */
    setVideoBackground(video) {
        const gl = this.gl;
        if (!gl || !video) return;

        this.clearVideoBackground();

        this.video = video;
        this.videoTexWidth = 0;
        this.videoTexHeight = 0;
        this.newFrame = true;
        // hasDesktop stays false until a real frame is uploaded; a 1x1 black
        // texture must never be exposed as the desktop.

        this.videoTexture = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
        // Complete 1x1 texture until a real video frame arrives.
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        this._setDesktopSampler();

        this._uploadVideoFrame(true);
        this._startFrameWatcher();
    }

    setHasDesktop(on) {
        this.hasDesktop = !!on;
    }

    clearVideoBackground() {
        const gl = this.gl;

        if (this._rvfcId !== null && this.video &&
            typeof this.video.cancelVideoFrameCallback === 'function') {
            this.video.cancelVideoFrameCallback(this._rvfcId);
        }
        this._rvfcId = null;

        if (this.videoTexture && gl) gl.deleteTexture(this.videoTexture);
        this.videoTexture = null;
        this.video = null;
        this.videoTexWidth = 0;
        this.videoTexHeight = 0;
        this.newFrame = false;
        this.hasDesktop = false;

        if (gl && this.placeholderTexture) {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.placeholderTexture);
            this._setDesktopSampler();
        }
    }

    _startFrameWatcher() {
        const video = this.video;
        if (!video || typeof video.requestVideoFrameCallback !== 'function') return;
        this._rvfcId = video.requestVideoFrameCallback(() => {
            this._rvfcId = null;
            if (!this.video) return;
            this.newFrame = true;
            this._startFrameWatcher();
        });
    }

    /**
     * Upload the current video frame only when it is new (rVFC driven).
     * `force` is used for the first allocation.
     */
    _uploadVideoFrame(force) {
        const gl = this.gl;
        const video = this.video;
        if (!gl || !video || !this.videoTexture) return;

        const useRVFC = typeof video.requestVideoFrameCallback === 'function';
        if (!force && useRVFC && !this.newFrame) return;
        if (video.readyState < 2) return;

        const w = video.videoWidth;
        const h = video.videoHeight;
        if (!w || !h) return;

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
        // Flip Y so it renders correctly
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

        if (w !== this.videoTexWidth || h !== this.videoTexHeight) {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            this.videoTexWidth = w;
            this.videoTexHeight = h;
        }
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, video);

        this.newFrame = false;
        this.hasDesktop = true;
        // _frame() sets the sampler uniform right after this call.
    }

    _frame() {
        if (!this.running) return;

        const gl = this.gl;
        if (!gl) return;

        const now = performance.now() / 1000;
        const time = now - this.startTime;

        gl.useProgram(this.program);

        // Uniforms
        gl.uniform2f(this.uResolution, this.canvas.width, this.canvas.height);
        gl.uniform1f(this.uTime, time);
        gl.uniform1i(this.uPreset, this.preset);

        // iDate: (year, month-1, day, seconds-since-midnight)
        // The current shader does not use it; skip the per-frame Date work
        // when the location was optimized out.
        if (this.uDate) {
            const d = new Date();
            const secs = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()
                       + d.getMilliseconds() / 1000;
            gl.uniform4f(this.uDate, d.getFullYear(), d.getMonth(), d.getDate(), secs);
        }

        // Update and bind the video texture when a new frame is available.
        this._uploadVideoFrame(false);
        if (!this.hasDesktop || !this.video) {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.placeholderTexture);
        }
        gl.uniform1i(this.uDesktop, 0);
        gl.uniform1i(this.uHasDesktop, this.hasDesktop ? 1 : 0);

        // Draw fullscreen triangle (3 vertices, no buffer, VAO bound)
        gl.bindVertexArray(this.vao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);

        this.rafId = requestAnimationFrame(this._frame);
    }

    // ----------------------------------------------------------------
    //  Context lifecycle
    // ----------------------------------------------------------------

    _onContextLost(event) {
        event.preventDefault();
        this.stop();
        console.warn('[BlackHoleRenderer] WebGL context lost; overlay stopped.');
    }

    _onContextRestored() {
        console.warn('[BlackHoleRenderer] WebGL context restored; please restart the app to re-initialise.');
    }

    // ----------------------------------------------------------------
    //  Cleanup
    // ----------------------------------------------------------------

    destroy() {
        this.stop();

        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }
        if (this._useWindowResize) {
            window.removeEventListener('resize', this._onResize);
        }
        this.canvas.removeEventListener('webglcontextlost', this._onContextLost);
        this.canvas.removeEventListener('webglcontextrestored', this._onContextRestored);

        const gl = this.gl;
        this.clearVideoBackground();

        if (gl) {
            if (this.placeholderTexture) gl.deleteTexture(this.placeholderTexture);
            if (this.program) gl.deleteProgram(this.program);
            if (this.vao) gl.deleteVertexArray(this.vao);
        }
        this.placeholderTexture = null;
        this.program = null;
        this.vao = null;
        this.gl = null;
    }
}
