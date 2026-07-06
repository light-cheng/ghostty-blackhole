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

        // Video background
        this.video = null;
        this.videoTexture = null;

        // Bind once
        this._frame = this._frame.bind(this);
        this._onResize = this._onResize.bind(this);
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
        const [vertSrc, fragSrc] = await Promise.all([
            fetch('fullscreen-quad.vert').then(r => r.text()),
            fetch('blackhole.frag').then(r => r.text()),
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

        // Clean up individual shaders
        gl.deleteShader(vert);
        gl.deleteShader(frag);

        // Uniform locations
        this.uResolution = gl.getUniformLocation(this.program, 'iResolution');
        this.uTime = gl.getUniformLocation(this.program, 'iTime');
        this.uDate = gl.getUniformLocation(this.program, 'iDate');
        this.uPreset = gl.getUniformLocation(this.program, 'u_preset');
        this.uDesktop = gl.getUniformLocation(this.program, 'u_desktop');

        // VAO — we draw with gl_VertexID so no buffers needed
        this.vao = gl.createVertexArray();

        // Initial resize
        this._onResize();
        window.addEventListener('resize', this._onResize);
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

    setVideoBackground(video) {
        this.video = video;
        const gl = this.gl;
        this.videoTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
        // Put a single pixel in the texture so it can be used immediately
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }

    _frame() {
        if (!this.running) return;

        this._onResize(); // cheap — bails early if no change

        const gl = this.gl;
        const now = performance.now() / 1000;
        const time = now - this.startTime;

        gl.useProgram(this.program);

        // Uniforms
        gl.uniform2f(this.uResolution, this.canvas.width, this.canvas.height);
        gl.uniform1f(this.uTime, time);
        gl.uniform1i(this.uPreset, this.preset);

        // iDate: (year, month-1, day, seconds-since-midnight)
        const d = new Date();
        const secs = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()
                   + d.getMilliseconds() / 1000;
        gl.uniform4f(this.uDate, d.getFullYear(), d.getMonth(), d.getDate(), secs);

        // Update and bind video texture
        if (this.video && this.video.readyState >= 2) {
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
            // Flip Y so it renders correctly
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
            gl.uniform1i(this.uDesktop, 0);
        }

        // Draw fullscreen triangle (3 vertices, no buffer, VAO bound)
        gl.bindVertexArray(this.vao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);

        this.rafId = requestAnimationFrame(this._frame);
    }

    // ----------------------------------------------------------------
    //  Cleanup
    // ----------------------------------------------------------------

    destroy() {
        this.stop();
        window.removeEventListener('resize', this._onResize);
        const gl = this.gl;
        if (this.program) gl.deleteProgram(this.program);
        if (this.vao) gl.deleteVertexArray(this.vao);
        if (this.videoTexture) gl.deleteTexture(this.videoTexture);
        this.gl = null;
    }
}
