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
 * Falling blossoms. Same 150-vertex flower geometry as the canopy pass, but the
 * centre is animated: each instance loops on its own period, drifting
 * sinusoidally and tumbling (the tilt angle grows with fall progress) from its
 * origin tip down to the ground.
 */
export const fallingFlowerVertexShader = /* wgsl */ `
${UNIFORMS_WGSL}
${CAMERA_WGSL}

struct FlowerOutput {
  @builtin(position) position: vec4f,
  @location(0) petalT: f32,
  @location(1) normalX: f32,
  @location(2) normalY: f32,
  @location(3) normalZ: f32,
  @location(4) seed: f32,
  @location(5) isCenter: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> petalData: array<vec4f>;

const PI: f32 = 3.14159265;

@vertex
fn main(@builtin(vertex_index) vertexIndex: u32) -> FlowerOutput {
  var output: FlowerOutput;

  let vertsPerFlower = 150u;
  let flowerIdx = vertexIndex / vertsPerFlower;
  let localVert = vertexIndex % vertsPerFlower;

  let petalCount = u32(uniforms.blockCount);
  if (flowerIdx >= petalCount) {
    output.position = vec4f(0.0, 0.0, -10.0, 1.0);
    return output;
  }

  // Hide in 2D mode
  let progress = uniforms.progress;
  let vis = smoothstep(0.0, 0.4, 1.0 - progress);
  if (vis < 0.01) {
    output.position = vec4f(0.0, 0.0, -10.0, 1.0);
    return output;
  }

  let data = petalData[flowerIdx];
  let col = data.x;
  let row = data.y;
  let topY = data.z;
  let seed = data.w;
  output.seed = seed;

  let blockSize = f32(${BLOCK_SIZE});
  let gridSize = uniforms.gridSize;
  let halfGrid = gridSize * blockSize * 0.5;
  let time = uniforms.time;

  // -- Falling animation ---------------------------------------------------
  // Continuous looping fall. Each flower has a different period and phase.
  let cyclePeriod = 8.0 + seed * 6.0;
  let phaseOffset = seed * 100.0;
  // Use fract-based cycling instead of % to avoid precision issues
  let rawCycle = (time + phaseOffset) / cyclePeriod;
  let cycleT = fract(rawCycle);

  // Always visible during fall, brief reset at cycle boundary
  let fadeIn = smoothstep(0.0, 0.05, cycleT);
  let fadeOut = 1.0 - smoothstep(0.95, 1.0, cycleT);
  let fallVis = fadeIn * fadeOut * vis;

  if (fallVis < 0.01) {
    output.position = vec4f(0.0, 0.0, -10.0, 1.0);
    return output;
  }

  // Fall progress (0 = origin, 1 = ground)
  let fallT = cycleT;
  let groundY = blockSize * 1.5;
  let fallHeight = mix(topY, groundY, fallT);

  // Origin in world space
  let originX = col * blockSize - halfGrid;
  let originZ = row * blockSize - halfGrid;

  // Horizontal drift - sinusoidal wobble matching wind direction
  let driftX = sin(time * 0.45 + seed * 5.0) * 0.045 * fallT
             + sin(time * 1.1 + seed * 12.0) * 0.012 * fallT;
  let driftZ = sin(time * 0.35 + seed * 8.0) * 0.03 * fallT
             + cos(time * 0.8 + seed * 3.0) * 0.01 * fallT;

  // Animated flower center position
  let centerX = originX + driftX;
  let centerY = fallHeight;
  let centerZ = originZ + driftZ;

  // -- Flower geometry -----------------------------------------------------
  let flowerScale = blockSize * (0.5 + seed * 0.3) * fallVis;
  let petalLength = flowerScale * 0.85;
  let petalWidth = flowerScale * 0.38;
  let curlHeight = blockSize * 0.15 * fallVis;
  let centerRadius = blockSize * 0.10 * fallVis;

  // Per-flower base rotation + tumbling from fall
  let baseRotation = seed * 6.28318 + time * (0.8 + seed * 1.2);

  // Tumbling tilt - increases as flower falls
  let tiltAngle = 0.3 + fallT * 1.2 + sin(time * 0.9 + seed * 7.0) * 0.4;
  let tiltDir = time * (0.5 + seed * 0.8) + seed * PI * 2.0;
  let tiltCos = cos(tiltAngle);
  let tiltSin = sin(tiltAngle);
  let tiltAxisX = cos(tiltDir);
  let tiltAxisZ = sin(tiltDir);

  var localPos = vec3f(0.0);
  var normal = vec3f(0.0, 1.0, 0.0);
  output.isCenter = 0.0;
  output.petalT = 0.0;

  if (localVert < 120u) {
    // ===== PETAL GEOMETRY (identical to flowers shader) =====
    let petalIdx = localVert / 24u;
    let segVert = localVert % 24u;
    let segIdx = segVert / 6u;
    let triVert = segVert % 6u;

    let petalAngle = f32(petalIdx) * 1.25664 + baseRotation;
    let cosA = cos(petalAngle);
    let sinA = sin(petalAngle);

    var rowIdx: u32;
    var side: f32;
    if (triVert == 0u) { rowIdx = segIdx;     side = -1.0; }
    else if (triVert == 1u) { rowIdx = segIdx;     side =  1.0; }
    else if (triVert == 2u) { rowIdx = segIdx + 1u; side = -1.0; }
    else if (triVert == 3u) { rowIdx = segIdx + 1u; side = -1.0; }
    else if (triVert == 4u) { rowIdx = segIdx;     side =  1.0; }
    else { rowIdx = segIdx + 1u; side =  1.0; }

    let t = f32(rowIdx) * 0.25;
    output.petalT = t;

    let dist = t * petalLength;
    let hw = petalWidth * sin(t * 3.14159) * sqrt(1.0 - t * 0.3);
    let curl = curlHeight * 4.0 * t * (1.0 - t);

    let alongX = dist * cosA;
    let alongZ = dist * sinA;
    let perpX = side * hw * (-sinA);
    let perpZ = side * hw * cosA;

    localPos = vec3f(alongX + perpX, curl, alongZ + perpZ);

    let curlSlope = curlHeight * 4.0 * (1.0 - 2.0 * t);
    normal = normalize(vec3f(
      -curlSlope * cosA + side * 0.2 * sinA,
      1.0,
      -curlSlope * sinA - side * 0.2 * cosA,
    ));
  } else {
    // ===== CENTER DISK =====
    output.isCenter = 1.0;
    let diskVert = localVert - 120u;
    let triIdx = diskVert / 3u;
    let triV = diskVert % 3u;

    let centerElevation = curlHeight * 0.8;

    if (triV == 0u) {
      localPos = vec3f(0.0, centerElevation, 0.0);
      normal = vec3f(0.0, 1.0, 0.0);
    } else {
      let angleIdx = select(triIdx, triIdx + 1u, triV == 2u);
      let diskAngle = f32(angleIdx) * 0.62832 + baseRotation;
      localPos = vec3f(cos(diskAngle) * centerRadius, centerElevation * 0.9, sin(diskAngle) * centerRadius);
      normal = vec3f(0.0, 1.0, 0.0);
    }
  }

  // -- Apply tumbling tilt (Rodrigues rotation) ----------------------------
  let dotAO = tiltAxisX * localPos.x + tiltAxisZ * localPos.z;
  let crossX = -tiltAxisZ * localPos.y;
  let crossY = tiltAxisZ * localPos.x - tiltAxisX * localPos.z;
  let crossZ = tiltAxisX * localPos.y;

  let rotX = localPos.x * tiltCos + crossX * tiltSin + tiltAxisX * dotAO * (1.0 - tiltCos);
  let rotY = localPos.y * tiltCos + crossY * tiltSin;
  let rotZ = localPos.z * tiltCos + crossZ * tiltSin + tiltAxisZ * dotAO * (1.0 - tiltCos);

  localPos = vec3f(centerX + rotX, centerY + rotY, centerZ + rotZ);

  // Rotate normal too
  let nDotA = tiltAxisX * normal.x + tiltAxisZ * normal.z;
  let nCrossX = -tiltAxisZ * normal.y;
  let nCrossY = tiltAxisZ * normal.x - tiltAxisX * normal.z;
  let nCrossZ = tiltAxisX * normal.y;
  normal = normalize(vec3f(
    normal.x * tiltCos + nCrossX * tiltSin + tiltAxisX * nDotA * (1.0 - tiltCos),
    normal.y * tiltCos + nCrossY * tiltSin,
    normal.z * tiltCos + nCrossZ * tiltSin + tiltAxisZ * nDotA * (1.0 - tiltCos),
  ));

  output.normalX = normal.x;
  output.normalY = normal.y;
  output.normalZ = normal.z;

  // -- Camera transform ----------------------------------------------------
  let isoAngleY = mix(${ISO_ANGLE_Y}, 0, progress) + uniforms.cameraBobX;
  let isoAngleX = mix(${ISO_ANGLE_X}, ${FLAT_ANGLE_X}, progress) + uniforms.cameraBobY;

  let cy = cos(isoAngleY); let sy = sin(isoAngleY);
  let cx = cos(isoAngleX); let sx = sin(isoAngleX);

  let ry_x = localPos.x * cy - localPos.z * sy;
  let ry_z = localPos.x * sy + localPos.z * cy;
  let rx_y = localPos.y * cx - ry_z * sx;
  let rx_z = localPos.y * sx + ry_z * cx;

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

export const fallingFlowerFragmentShader = /* wgsl */ `
${UNIFORMS_WGSL}

struct FlowerInput {
  @location(0) petalT: f32,
  @location(1) normalX: f32,
  @location(2) normalY: f32,
  @location(3) normalZ: f32,
  @location(4) seed: f32,
  @location(5) isCenter: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

${ACES_WGSL}

@fragment
fn main(input: FlowerInput) -> @location(0) vec4f {
  let N = normalize(vec3f(input.normalX, input.normalY, input.normalZ));
  let t = input.petalT;
  let seed = input.seed;

  // Season-based palette (matches canopy flowers)
  let season = uniforms.season;

  let fallChance = fract(seed * 4.37);
  // Summer: nothing falls
  if (season > 0.5 && season < 1.5) { discard; }

  // Winter: render as snow - all white, show all particles
  if (season > 2.5) {
    let snowWhite = vec3f(0.95, 0.96, 0.98);
    let snowLit = snowWhite * (0.85 + max(dot(N, normalize(vec3f(-0.4, 0.85, -0.3))), 0.0) * 0.15);
    let snowHdr = pow(snowLit, vec3f(1.0 / 2.2));
    return vec4f(snowHdr, 1.0);
  }

  var shadeDeep    = vec3f(0.85, 0.22, 0.38);
  var shadeMedium  = vec3f(0.92, 0.40, 0.52);
  var shadeLight   = vec3f(0.96, 0.58, 0.66);
  var shadePale    = vec3f(0.98, 0.75, 0.80);
  var shadeBlush   = vec3f(0.97, 0.65, 0.72);
  var shadeWhite   = vec3f(0.99, 0.88, 0.90);
  var stamenGold   = vec3f(0.92, 0.78, 0.35);

  if (season > 0.5 && season < 1.5) {
    // Summer - falling green leaves
    shadeDeep = vec3f(0.15, 0.40, 0.10); shadeMedium = vec3f(0.25, 0.52, 0.18);
    shadeLight = vec3f(0.38, 0.62, 0.25); shadePale = vec3f(0.48, 0.68, 0.32);
    shadeBlush = vec3f(0.30, 0.55, 0.20); shadeWhite = vec3f(0.55, 0.72, 0.38);
    stamenGold = vec3f(0.55, 0.60, 0.22);
  } else if (season > 1.5 && season < 2.5) {
    // Autumn - falling orange/red leaves
    shadeDeep = vec3f(0.70, 0.15, 0.05); shadeMedium = vec3f(0.82, 0.28, 0.08);
    shadeLight = vec3f(0.92, 0.48, 0.12); shadePale = vec3f(0.95, 0.65, 0.22);
    shadeBlush = vec3f(0.88, 0.38, 0.10); shadeWhite = vec3f(0.95, 0.78, 0.35);
    stamenGold = vec3f(0.80, 0.60, 0.15);
  } else if (season > 2.5) {
    // Winter - sparse pale flakes
    shadeDeep = vec3f(0.78, 0.80, 0.85); shadeMedium = vec3f(0.85, 0.87, 0.90);
    shadeLight = vec3f(0.92, 0.93, 0.96); shadePale = vec3f(0.95, 0.96, 0.98);
    shadeBlush = vec3f(0.88, 0.90, 0.94); shadeWhite = vec3f(0.97, 0.98, 0.99);
    stamenGold = vec3f(0.75, 0.74, 0.70);
  }

  var baseColor = vec3f(0.0);

  if (input.isCenter > 0.5) {
    let goldVar = fract(seed * 13.3) * 0.15;
    baseColor = stamenGold * (0.9 + goldVar);
  } else {
    let tier = fract(seed * 7.31);
    var petalBase: vec3f;
    var petalTip: vec3f;
    if (tier < 0.2) {
      petalBase = shadeDeep;
      petalTip = shadeMedium;
    } else if (tier < 0.35) {
      petalBase = shadeMedium;
      petalTip = shadeLight;
    } else if (tier < 0.50) {
      petalBase = shadeLight;
      petalTip = shadePale;
    } else if (tier < 0.65) {
      petalBase = shadeBlush;
      petalTip = shadePale;
    } else if (tier < 0.80) {
      petalBase = shadePale;
      petalTip = shadeWhite;
    } else {
      petalBase = shadeDeep;
      petalTip = shadeBlush;
    }
    baseColor = mix(petalBase, petalTip, t);

    let veinT = abs(t - 0.5) * 2.0;
    let veinDarken = 1.0 - (1.0 - veinT) * 0.08;
    baseColor = baseColor * veinDarken;
  }

  // Neutral directional light - no warm tint
  let sunDir = normalize(vec3f(-0.4, 0.85, -0.3));
  let sunColor = vec3f(1.20, 1.20, 1.20);
  let ambient = vec3f(0.28, 0.28, 0.30);
  let NdotL = max(dot(N, sunDir), 0.0);

  let NdotLBack = max(dot(-N, sunDir), 0.0);
  let sssColor = vec3f(1.0, 0.55, 0.65);
  let subsurface = NdotLBack * 0.22 * sssColor;

  let skyFill = vec3f(0.90, 0.85, 0.88);
  let skyContrib = max(N.y, 0.0) * 0.12 * skyFill;

  let undersideDarken = mix(0.55, 1.0, max(N.y, 0.0));

  let viewDir = normalize(vec3f(0.4, 0.6, 0.7));
  let rimDot = 1.0 - max(dot(N, viewDir), 0.0);
  let rim = pow(rimDot, 3.0) * 0.10 * vec3f(1.0, 0.85, 0.88);

  let lit = baseColor * undersideDarken * (ambient + sunColor * NdotL * 0.88) + subsurface + skyContrib + rim;

  let hdr = acesFilm(lit * 1.05);
  var ldr = pow(hdr, vec3f(1.0 / 2.2));

  let gray = dot(ldr, vec3f(0.299, 0.587, 0.114));
  ldr = mix(vec3f(gray), ldr, 1.6);

  return vec4f(ldr, 1.0);
}
`;
