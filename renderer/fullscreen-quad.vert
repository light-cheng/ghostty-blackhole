#version 300 es

// Fullscreen quad vertex shader — emits a triangle that covers the entire viewport.
// Uses gl_VertexID so no vertex buffer is needed.

void main() {
    // Generate a full-screen triangle from vertex ID (0, 1, 2)
    vec2 pos = vec2(
        float((gl_VertexID & 1) << 2) - 1.0,
        float((gl_VertexID & 2) << 1) - 1.0
    );
    gl_Position = vec4(pos, 0.0, 1.0);
}
