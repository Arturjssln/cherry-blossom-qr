import {
  BLOCK_SIZE,
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
 * Grass pass: three vertices per blade. Base pair sits on the ground block, the
 * tip is offset by a per-blade tilt plus the shared wind function, and droops
 * more the taller it is.
 */
export const grassVertexShader = /* wgsl */ `
${UNIFORMS_WGSL}
${CAMERA_WGSL}

struct GrassOutput {
  @builtin(position) position: vec4f,
  @location(0) greenT: f32,
  @location(1) normalY: f32,
  @location(2) seed: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> grassData: array<vec4f>;

const PI: f32 = 3.14159265;

@vertex
fn main(@builtin(vertex_index) vertexIndex: u32) -> GrassOutput {
  var output: GrassOutput;

  let bladeIdx = vertexIndex / 3u;
  let vertIdx = vertexIndex % 3u;

  let grassCount = u32(uniforms.blockCount);
  if (bladeIdx >= grassCount) {
    output.position = vec4f(0.0, 0.0, -10.0, 1.0);
    return output;
  }

  // Hide grass in 2D mode
  let progress = uniforms.progress;
  let vis = smoothstep(0.0, 0.3, 1.0 - progress);
  if (vis < 0.01) {
    output.position = vec4f(0.0, 0.0, -10.0, 1.0);
    return output;
  }

  let data = grassData[bladeIdx];
  let col = data.x;
  let row = data.y;
  let seed = data.z;
  let bladeHeight = data.w * vis;

  output.seed = seed;

  let blockSize = f32(${BLOCK_SIZE});
  let gridSize = uniforms.gridSize;
  let halfGrid = gridSize * blockSize * 0.5;

  let baseX = col * blockSize - halfGrid;
  let baseY = 0.0; // ground level
  let baseZ = row * blockSize - halfGrid;

  // Random rotation angle per blade
  let angle = seed * PI * 2.0;
  let cosA = cos(angle);
  let sinA = sin(angle);

  // Blade dimensions - wider for better coverage
  let halfWidth = blockSize * 0.22;

  var localPos = vec3f(0.0);

  // Subtle tilt + gentle wind on tips only
  let tiltX = (seed - 0.5) * 0.4;
  let tiltZ = (fract(seed * 7.13) - 0.5) * 0.4;
  let time = uniforms.time;
  let windBase = sin(time * 0.45 + col * 0.25 + row * 0.15) * 0.02;
  let windTurb = sin(time * 1.1 + col * 0.8 + row * 0.6) * 0.005;
  let windX = windBase + windTurb;
  let windZ = sin(time * 0.35 + col * 0.15 + row * 0.25) * 0.012;
  let tipOffX = (tiltX + windX) * bladeHeight * 4.0;
  let tipOffZ = (tiltZ + windZ) * bladeHeight * 4.0;

  // Y offset: grass sits on top of the ground block
  let yLift = blockSize * 1.0;

  if (vertIdx == 0u) {
    // Base left
    localPos = vec3f(baseX - halfWidth * cosA, baseY + yLift, baseZ - halfWidth * sinA);
    output.greenT = 0.0;
    output.normalY = 0.3;
  } else if (vertIdx == 1u) {
    // Base right
    localPos = vec3f(baseX + halfWidth * cosA, baseY + yLift, baseZ + halfWidth * sinA);
    output.greenT = 0.0;
    output.normalY = 0.3;
  } else {
    // Tip - tilted outward with curl for natural droop
    let curlDroop = bladeHeight * seed * 0.15; // taller blades droop more
    localPos = vec3f(baseX + tipOffX, baseY + yLift + bladeHeight - curlDroop, baseZ + tipOffZ);
    output.greenT = 1.0;
    output.normalY = 0.9;
  }

  // Camera transform
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

export const grassFragmentShader = /* wgsl */ `
${UNIFORMS_WGSL}

struct GrassInput {
  @location(0) greenT: f32,
  @location(1) normalY: f32,
  @location(2) seed: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

${ACES_WGSL}

@fragment
fn main(input: GrassInput) -> @location(0) vec4f {
  let season = uniforms.season;

  // -- Grass base palette (overridden per season) --------------------------
  var darkGreen  = vec3f(0.12, 0.32, 0.06);
  var midGreen   = vec3f(0.22, 0.48, 0.12);
  var lightGreen = vec3f(0.35, 0.58, 0.20);
  var coralPink  = vec3f(0.65, 0.28, 0.30);
  var dustyRose  = vec3f(0.55, 0.32, 0.28);
  var mossGreen  = vec3f(0.30, 0.40, 0.15);
  var yellowFlower = vec3f(0.75, 0.68, 0.20);
  var whiteFlower = vec3f(0.88, 0.86, 0.78);
  var lavender = vec3f(0.55, 0.42, 0.62);

  if (season > 0.5 && season < 1.5) {
    // Summer - lush vibrant greens, no pink
    darkGreen  = vec3f(0.08, 0.35, 0.04);
    midGreen   = vec3f(0.18, 0.52, 0.10);
    lightGreen = vec3f(0.30, 0.65, 0.18);
    mossGreen  = vec3f(0.25, 0.45, 0.12);
    coralPink  = vec3f(0.28, 0.50, 0.15);
    dustyRose  = vec3f(0.22, 0.42, 0.12);
    yellowFlower = vec3f(0.70, 0.72, 0.22);
    whiteFlower = vec3f(0.82, 0.88, 0.72);
    lavender = vec3f(0.35, 0.55, 0.25);
  } else if (season > 1.5 && season < 2.5) {
    // Autumn - dry golden, brown, burnt orange grass
    darkGreen  = vec3f(0.40, 0.30, 0.10);
    midGreen   = vec3f(0.55, 0.40, 0.12);
    lightGreen = vec3f(0.70, 0.52, 0.18);
    mossGreen  = vec3f(0.48, 0.35, 0.10);
    coralPink  = vec3f(0.65, 0.32, 0.12);
    dustyRose  = vec3f(0.58, 0.35, 0.15);
    yellowFlower = vec3f(0.80, 0.62, 0.18);
    whiteFlower = vec3f(0.78, 0.72, 0.55);
    lavender = vec3f(0.55, 0.38, 0.22);
  } else if (season > 2.5) {
    // Winter - sparse, frost-tinted, muted brown/gray
    darkGreen  = vec3f(0.32, 0.30, 0.25);
    midGreen   = vec3f(0.42, 0.40, 0.32);
    lightGreen = vec3f(0.52, 0.50, 0.42);
    mossGreen  = vec3f(0.38, 0.36, 0.28);
    coralPink  = vec3f(0.45, 0.38, 0.32);
    dustyRose  = vec3f(0.40, 0.35, 0.30);
    yellowFlower = vec3f(0.55, 0.50, 0.38);
    whiteFlower = vec3f(0.75, 0.75, 0.72);
    lavender = vec3f(0.48, 0.45, 0.48);
  }

  let tier = fract(input.seed * 7.31);
  var baseColor: vec3f;
  var tipColor: vec3f;
  if (tier < 0.22) {
    baseColor = darkGreen;
    tipColor = midGreen;
  } else if (tier < 0.42) {
    baseColor = midGreen;
    tipColor = lightGreen;
  } else if (tier < 0.55) {
    baseColor = mossGreen;
    tipColor = lightGreen;
  } else if (tier < 0.68) {
    baseColor = dustyRose;
    tipColor = coralPink;
  } else if (tier < 0.76) {
    baseColor = coralPink;
    tipColor = vec3f(0.72, 0.35, 0.35);
  } else if (tier < 0.84) {
    baseColor = midGreen;
    tipColor = yellowFlower;
  } else if (tier < 0.92) {
    baseColor = mossGreen;
    tipColor = whiteFlower;
  } else {
    baseColor = dustyRose;
    tipColor = lavender;
  }

  let color = mix(baseColor, tipColor, input.greenT);

  // Strong sun for grass vibrancy
  let sunDir = normalize(vec3f(-0.4, 0.85, -0.3));
  let N = normalize(vec3f(0.0, input.normalY, 0.3));
  let NdotL = max(dot(N, sunDir), 0.0);
  let ambient = vec3f(0.22, 0.24, 0.18);
  let sunCol = vec3f(1.20, 1.20, 1.20);

  let lit = color * (ambient + sunCol * NdotL * 0.85);

  let hdr = acesFilm(lit * 1.1);
  var ldr = pow(hdr, vec3f(1.0 / 2.2));

  let gray = dot(ldr, vec3f(0.299, 0.587, 0.114));
  ldr = mix(vec3f(gray), ldr, 1.6);

  return vec4f(ldr, 1.0);
}
`;
