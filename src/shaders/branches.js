import {
  FLAT_ANGLE_X,
  ISO_ANGLE_X,
  ISO_ANGLE_Y,
  VIEW_SCALE_2D,
  VIEW_SCALE_3D,
  X_OFFSET_2D,
  Y_OFFSET_2D,
} from '../constants.js';
import { ACES_WGSL, CAMERA_WGSL, UNIFORMS_WGSL } from './common.js';

/**
 * Branch pass: extrudes each skeleton segment into an 8-sided tapered cylinder
 * (48 vertices) with a locally-built frame, so branches can point any direction.
 *
 * Note this pass reuses `uniforms.blockCount` as the *segment* count - it gets
 * its own uniform buffer for exactly that reason.
 */
export const branchVertexShader = /* wgsl */ `
${UNIFORMS_WGSL}
${CAMERA_WGSL}

struct BranchOutput {
  @builtin(position) position: vec4f,
  @location(0) normalX: f32,
  @location(1) normalY: f32,
  @location(2) normalZ: f32,
  @location(3) depth: f32,
  @location(4) vSeed: f32,
  @location(5) ringT: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> branchData: array<vec4f>;

const VERTS_PER_SEG: u32 = 48u;
const RADIAL: u32 = 8u;
const PI: f32 = 3.14159265;

@vertex
fn main(@builtin(vertex_index) vertexIndex: u32) -> BranchOutput {
  var output: BranchOutput;

  let segIdx = vertexIndex / VERTS_PER_SEG;
  let localVert = vertexIndex % VERTS_PER_SEG;

  let segCount = u32(uniforms.blockCount); // reuse blockCount uniform for segment count
  if (segIdx >= segCount) {
    output.position = vec4f(0.0, 0.0, -10.0, 1.0);
    return output;
  }

  // Read segment data (3 vec4f per segment)
  let startData = branchData[segIdx * 3u + 0u];
  let endData   = branchData[segIdx * 3u + 1u];
  let segMeta   = branchData[segIdx * 3u + 2u];

  let startPos = startData.xyz;
  let startR   = startData.w;
  let endPos   = endData.xyz;
  let endR     = endData.w;
  let depth    = segMeta.x;
  let seed     = segMeta.y;

  output.depth = depth;
  output.vSeed = seed;

  // Hide branches in 2D mode
  let progress = uniforms.progress;
  let branchVis = smoothstep(0.0, 0.4, 1.0 - progress);
  if (branchVis < 0.01) {
    output.position = vec4f(0.0, 0.0, -10.0, 1.0);
    return output;
  }

  // Which quad around the cylinder (0-7) and which triangle vertex (0-5)
  let quadIdx = localVert / 6u;
  let triVert = localVert % 6u;

  // Two angles for the quad edges
  let angle0 = f32(quadIdx) / f32(RADIAL) * 2.0 * PI;
  let angle1 = f32(quadIdx + 1u) / f32(RADIAL) * 2.0 * PI;

  // Determine which ring (bottom=0, top=1) and which angle
  var ringT: f32;
  var angle: f32;
  // Quad: two triangles - (b0,b1,t0) and (t0,b1,t1)
  if (triVert == 0u) { ringT = 0.0; angle = angle0; }
  else if (triVert == 1u) { ringT = 0.0; angle = angle1; }
  else if (triVert == 2u) { ringT = 1.0; angle = angle0; }
  else if (triVert == 3u) { ringT = 1.0; angle = angle0; }
  else if (triVert == 4u) { ringT = 0.0; angle = angle1; }
  else { ringT = 1.0; angle = angle1; }

  output.ringT = ringT;

  // Interpolate position and radius along the segment
  let pos = mix(startPos, endPos, ringT);
  let radius = mix(startR, endR, ringT) * branchVis;

  // Build local coordinate frame around the segment direction
  let dir = normalize(endPos - startPos);
  var refUp = vec3f(0.0, 1.0, 0.0);
  if (abs(dot(dir, refUp)) > 0.95) {
    refUp = vec3f(1.0, 0.0, 0.0);
  }
  let right = normalize(cross(dir, refUp));
  let up = normalize(cross(right, dir));

  // Wind - same direction as flowers/grass, scaled by branch depth
  let time = uniforms.time;
  let windAmount = min(depth / 4.0, 1.0) * 0.016 * branchVis;
  let windBase = sin(time * 0.45 + pos.x * 15.0 + pos.z * 10.0) * windAmount;
  let windTurb = sin(time * 1.1 + pos.x * 40.0 + pos.z * 30.0) * windAmount * 0.25;
  let windOffX = windBase + windTurb;
  let windOffZ = sin(time * 0.35 + pos.z * 12.0 + pos.x * 8.0) * windAmount * 0.6;
  let windedPos = pos + vec3f(windOffX, 0.0, windOffZ);

  // Cylinder surface position
  let cx = cos(angle);
  let cy = sin(angle);
  let localPos = windedPos + right * cx * radius + up * cy * radius;

  // Normal
  let normal = normalize(right * cx + up * cy);
  output.normalX = normal.x;
  output.normalY = normal.y;
  output.normalZ = normal.z;

  // Camera transform (identical to blocks/flowers shader)
  let isoAngleY = mix(${ISO_ANGLE_Y}, 0, progress) + uniforms.cameraBobX;
  let isoAngleX = mix(${ISO_ANGLE_X}, ${FLAT_ANGLE_X}, progress) + uniforms.cameraBobY;

  let cosY = cos(isoAngleY); let sinY = sin(isoAngleY);
  let cosX = cos(isoAngleX); let sinX = sin(isoAngleX);

  let ry_x = localPos.x * cosY - localPos.z * sinY;
  let ry_z = localPos.x * sinY + localPos.z * cosY;
  let rx_y = localPos.y * cosX - ry_z * sinX;
  let rx_z = localPos.y * sinX + ry_z * cosX;

  let viewScale = viewScaleFor(progress, uniforms.gridSize);
  let ar = uniforms.aspectRatio;
  let scaleX = viewScale / max(ar, 1.0);
  let scaleY = viewScale / max(1.0 / ar, 1.0);

  let yOffsetScene = mix(0.0, ${Y_OFFSET_2D}, progress);
  let xOffsetScene = mix(0.0, ${X_OFFSET_2D}, progress);

  output.position = vec4f(
    (ry_x + xOffsetScene) * scaleX,
    (rx_y + yOffsetScene) * scaleY,
    rx_z * 0.01 + 0.5,
    1.0
  );

  return output;
}
`;

export const branchFragmentShader = /* wgsl */ `
${UNIFORMS_WGSL}

struct BranchInput {
  @location(0) normalX: f32,
  @location(1) normalY: f32,
  @location(2) normalZ: f32,
  @location(3) depth: f32,
  @location(4) vSeed: f32,
  @location(5) ringT: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

${ACES_WGSL}

@fragment
fn main(input: BranchInput) -> @location(0) vec4f {
  let N = normalize(vec3f(input.normalX, input.normalY, input.normalZ));
  let depth = input.depth;
  let seed = input.vSeed;
  let t = input.ringT;

  // Bark - deep chocolate brown
  let barkBase  = vec3f(0.28, 0.16, 0.10);
  let barkLight = vec3f(0.40, 0.26, 0.18);
  let barkDark  = vec3f(0.16, 0.09, 0.05);
  let barkHighlight = vec3f(0.50, 0.34, 0.24); // sunlit edge

  // Trunk is darkest, tips get a warm highlight
  let depthT = min(depth / 5.0, 1.0);
  var bark = mix(barkBase, barkLight, depthT * 0.5);
  bark = mix(bark, barkHighlight, depthT * depthT * 0.2);

  // Procedural bark noise
  let noise1 = fract(sin(seed * 43.7 + depth * 17.3) * 43758.5);
  let noise2 = fract(sin(seed * 73.1 + depth * 31.1 + 127.1) * 43758.5);

  // Multi-frequency bark grooves - more visible surface detail
  let grooveAngle = fract(sin(seed * 127.1 + t * 31.1) * 43758.5) * 6.28;
  let groove1 = sin(grooveAngle * 8.0 + noise1 * 3.0) * 0.5 + 0.5;
  let groove2 = sin(grooveAngle * 14.0 + noise2 * 5.0 + 1.7) * 0.5 + 0.5;
  let groove3 = sin(grooveAngle * 22.0 + noise1 * 7.0) * 0.5 + 0.5;
  let grooveEffect = (groove1 * 0.5 + groove2 * 0.3 + groove3 * 0.2) * 0.18 + 0.82;

  // Ring pattern - horizontal bark bands
  let ring = sin(t * 18.0 + noise2 * 6.0) * 0.07 + 0.93;

  // Knot detail - occasional dark spots
  let knotNoise = sin(seed * 47.3 + t * 13.0 + noise1 * 8.0);
  let knot = smoothstep(0.88, 0.95, knotNoise) * 0.10;

  // Color variation
  let colorShift = (noise1 - 0.5) * 0.12;
  bark = bark * (1.0 + colorShift) * grooveEffect * ring - knot;

  // Lighting
  let sunDir = normalize(vec3f(-0.4, 0.85, -0.3));
  let sunCol = vec3f(1.20, 1.20, 1.20);
  let ambient = vec3f(0.25, 0.25, 0.28);
  let NdotL = max(dot(N, sunDir), 0.0);

  // Subsurface for thinner branches
  let NdotLBack = max(dot(-N, sunDir), 0.0);
  let sss = NdotLBack * depthT * 0.06 * vec3f(0.6, 0.3, 0.2);

  // Sky fill
  let skyFill = vec3f(0.85, 0.80, 0.90);
  let skyContrib = max(N.y, 0.0) * 0.08 * skyFill;

  // Ambient occlusion: thicker branches are slightly darker at base
  let ao = 0.75 + depthT * 0.25;

  let lit = bark * (ambient + sunCol * NdotL * 0.82) * ao + sss + skyContrib;

  let hdr = acesFilm(lit * 1.05);
  var ldr = pow(hdr, vec3f(1.0 / 2.2));

  let gray = dot(ldr, vec3f(0.299, 0.587, 0.114));
  ldr = mix(vec3f(gray), ldr, 1.25);

  return vec4f(ldr, 1.0);
}
`;
