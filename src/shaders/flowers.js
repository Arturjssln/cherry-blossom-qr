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
 * Canopy blossoms.
 *
 * 150 vertices per flower: 5 petals x 4 quad-strip segments (120) + a 10-slice
 * centre disk (30). Petals are parametric - width follows sin(t*PI), height
 * follows a parabolic curl - then the whole flower is tilted around a random
 * horizontal axis with a Rodrigues rotation.
 *
 * The `seed` in `flowerPositions[i].w` doubles as a leaf flag: `>= 1` means
 * leaf (3 longer, narrower petals; green), `< 1` means blossom.
 */
export const flowerVertexShader = /* wgsl */ `
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
@group(0) @binding(1) var<storage, read> flowerPositions: array<vec4f>;

@vertex
fn main(@builtin(vertex_index) vertexIndex: u32) -> FlowerOutput {
  var output: FlowerOutput;

  let vertsPerFlower = 150u;
  let flowerIdx = vertexIndex / vertsPerFlower;
  let localVert = vertexIndex % vertsPerFlower;

  let flowerData = flowerPositions[flowerIdx];
  let col = flowerData.x;
  let row = flowerData.y;
  let topY = flowerData.z;
  let rawSeed = flowerData.w;

  // seed >= 1.0 means leaf, actual seed is rawSeed - 1.0
  let isLeaf = step(1.0, rawSeed);
  let seed = rawSeed - isLeaf;
  output.seed = rawSeed;

  let progress = uniforms.progress;

  // Visibility: flowers shrink away as we approach 2D mode
  let vis = smoothstep(0.0, 0.6, 1.0 - progress);
  if (vis < 0.01) {
    output.position = vec4f(0.0, 0.0, -10.0, 1.0);
    return output;
  }

  let blockSize = f32(${BLOCK_SIZE});
  let gridSize = uniforms.gridSize;
  let halfGrid = gridSize * blockSize * 0.5;

  // Flower center in world space
  let centerX = col * blockSize - halfGrid;
  let centerY = topY;
  let centerZ = row * blockSize - halfGrid;

  // Wind - coherent with grass and branches
  let time = uniforms.time;
  let isGroundPetal = step(topY, blockSize * 2.5);
  let windFactor = (1.0 - isGroundPetal) * vis;
  // Primary wind direction + secondary turbulence
  let windBase = sin(time * 0.45 + col * 0.25 + row * 0.15) * 0.028;
  let windTurb = sin(time * 1.1 + col * 0.8 + row * 0.6) * 0.008;
  let swayX = (windBase + windTurb) * windFactor;
  let swayZ = sin(time * 0.35 + col * 0.15 + row * 0.25) * 0.018 * windFactor;

  // Flower sizing - leaves are longer and narrower
  let baseScale = blockSize * (0.7 + seed * 0.3) * vis;
  let flowerScale = mix(baseScale, baseScale * 0.9, isLeaf);
  let petalLength = mix(flowerScale * 0.85, flowerScale * 1.3, isLeaf);
  let petalWidth = mix(flowerScale * 0.38, flowerScale * 0.18, isLeaf);
  let curlHeight = mix(blockSize * 0.18, blockSize * 0.08, isLeaf) * vis;
  let centerRadius = mix(blockSize * 0.12, blockSize * 0.04, isLeaf) * vis;

  // Per-flower rotation
  let baseRotation = seed * 6.28318;

  // Gentle tilt - subtle variation, mostly upward-facing
  let tiltAngle = (seed * 0.25 + 0.05) * (1.0 - isLeaf * 0.5);
  let tiltDir = seed * 6.28318 * 3.17;
  let tiltCos = cos(tiltAngle);
  let tiltSin = sin(tiltAngle);
  let tiltAxisX = cos(tiltDir);
  let tiltAxisZ = sin(tiltDir);

  var localPos = vec3f(0.0);
  var normal = vec3f(0.0, 1.0, 0.0);
  output.isCenter = 0.0;
  output.petalT = 0.0;

  if (localVert < 120u) {
    // ===== PETAL GEOMETRY =====
    // 5 petals, each with 4 quad-strip segments (8 triangles = 24 verts)
    let petalIdx = localVert / 24u;
    let segVert = localVert % 24u;
    let segIdx = segVert / 6u;       // segment 0-3
    let triVert = segVert % 6u;      // vertex within segment quad

    // Petal direction angle
    let petalAngle = f32(petalIdx) * 1.25664 + baseRotation; // 2pi/5
    let cosA = cos(petalAngle);
    let sinA = sin(petalAngle);

    // Collapse petals 3+4 for leaves (show only 3 petals)
    var petalScale = 1.0;
    if (isLeaf > 0.5 && petalIdx >= 3u) {
      petalScale = 0.0;
    }

    // Which row in the quad strip (0-4 for 5 rows)
    var rowIdx: u32;
    var side: f32; // -1 left, +1 right
    if (triVert == 0u) { rowIdx = segIdx;     side = -1.0; }
    else if (triVert == 1u) { rowIdx = segIdx;     side =  1.0; }
    else if (triVert == 2u) { rowIdx = segIdx + 1u; side = -1.0; }
    else if (triVert == 3u) { rowIdx = segIdx + 1u; side = -1.0; }
    else if (triVert == 4u) { rowIdx = segIdx;     side =  1.0; }
    else { rowIdx = segIdx + 1u; side =  1.0; }

    // Parametric t along petal length (0=base, 1=tip)
    let t = f32(rowIdx) * 0.25;
    output.petalT = t;

    // Distance from center along petal direction
    let dist = t * petalLength * petalScale;

    // Half-width: sin curve, widest mid-petal, tapered at ends
    let hw = petalWidth * sin(t * 3.14159) * sqrt(1.0 - t * 0.3) * petalScale;

    // Parabolic upward curl
    let curl = curlHeight * 4.0 * t * (1.0 - t);

    // Position in petal-local space (along petal direction + perpendicular)
    let alongX = dist * cosA;
    let alongZ = dist * sinA;
    let perpX = side * hw * (-sinA);
    let perpZ = side * hw * cosA;

    localPos = vec3f(
      centerX + alongX + perpX + swayX,
      centerY + curl,
      centerZ + alongZ + perpZ + swayZ,
    );

    // Normal from curl derivative
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
    let triIdx = diskVert / 3u;     // 0-9 (10 triangles)
    let triV = diskVert % 3u;       // 0-2

    let centerElevation = curlHeight * 0.8;

    if (triV == 0u) {
      // Center point
      localPos = vec3f(centerX + swayX, centerY + centerElevation, centerZ + swayZ);
      normal = vec3f(0.0, 1.0, 0.0);
    } else {
      let angleIdx = select(triIdx, triIdx + 1u, triV == 2u);
      let angle = f32(angleIdx) * 0.62832 + baseRotation; // 2pi/10
      localPos = vec3f(
        centerX + cos(angle) * centerRadius + swayX,
        centerY + centerElevation * 0.9,
        centerZ + sin(angle) * centerRadius + swayZ,
      );
      normal = vec3f(0.0, 1.0, 0.0);
    }
  }

  // Apply random tilt - rotate offset from center around a random horizontal axis
  let offX = localPos.x - centerX - swayX;
  let offY = localPos.y - centerY;
  let offZ = localPos.z - centerZ - swayZ;

  // Rodrigues rotation around axis (tiltAxisX, 0, tiltAxisZ)
  let dotAO = tiltAxisX * offX + tiltAxisZ * offZ;
  let crossX = -tiltAxisZ * offY;
  let crossY = tiltAxisZ * offX - tiltAxisX * offZ;
  let crossZ = tiltAxisX * offY;

  let rotX = offX * tiltCos + crossX * tiltSin + tiltAxisX * dotAO * (1.0 - tiltCos);
  let rotY = offY * tiltCos + crossY * tiltSin;
  let rotZ = offZ * tiltCos + crossZ * tiltSin + tiltAxisZ * dotAO * (1.0 - tiltCos);

  localPos = vec3f(
    centerX + swayX + rotX,
    centerY + rotY,
    centerZ + swayZ + rotZ,
  );

  // Also rotate normal
  let nDotA = tiltAxisX * normal.x + tiltAxisZ * normal.z;
  let nCrossX = -tiltAxisZ * normal.y;
  let nCrossY = tiltAxisZ * normal.x - tiltAxisX * normal.z;
  let nCrossZ = tiltAxisX * normal.y;
  normal = normalize(vec3f(
    normal.x * tiltCos + nCrossX * tiltSin + tiltAxisX * nDotA * (1.0 - tiltCos),
    normal.y * tiltCos + nCrossY * tiltSin,
    normal.z * tiltCos + nCrossZ * tiltSin + tiltAxisZ * nDotA * (1.0 - tiltCos),
  ));

  // Scale toward center for 2D transition
  localPos = vec3f(
    centerX + swayX + (localPos.x - centerX - swayX) * vis,
    centerY + (localPos.y - centerY) * vis,
    centerZ + swayZ + (localPos.z - centerZ - swayZ) * vis,
  );

  output.normalX = normal.x;
  output.normalY = normal.y;
  output.normalZ = normal.z;

  // Camera transform (identical to blocks shader)
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

/**
 * Blossom / leaf shading. Season drives everything: in summer and autumn the
 * "flowers" are re-coloured and re-shaped as leaves, and a seeded fraction is
 * `discard`ed so the canopy thins out toward winter.
 */
export const flowerFragmentShader = /* wgsl */ `
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
  let rawSeed = input.seed;
  let origIsLeaf = step(1.0, rawSeed);
  let seed = rawSeed - origIsLeaf;

  let season = uniforms.season;

  // -- Season determines what the tree looks like -------------------------
  // Spring: cherry blossoms (mostly flowers, some leaves)
  // Summer: dense green foliage (almost all leaves, no flowers)
  // Autumn: colored leaves falling (all leaves in warm tones)
  // Winter: mostly bare (many hidden via discard, sparse pale buds)

  let leafChance = fract(seed * 4.37);
  var isLeaf = origIsLeaf;
  let isGroundFlower = step(input.petalT, 0.01) * (1.0 - origIsLeaf);

  if (season > 0.5 && season < 1.5) {
    // Summer: all canopy = leaves
    isLeaf = 1.0;
    if (leafChance < 0.95 && input.isCenter < 0.5) {
      // Keep only ~5% as tiny ground details
    }
  } else if (season > 1.5 && season < 2.5) {
    // Autumn: sparse canopy (40% hidden = bare branches showing)
    isLeaf = 1.0;
    if (leafChance < 0.40) {
      discard;
    }
  } else if (season > 2.5) {
    // Winter: 80% hidden (bare branches), rest are sparse pale buds
    if (leafChance < 0.80) {
      discard;
    }
  }

  // -- Leaf colors per season ---------------------------------------------
  var leafDark   = vec3f(0.25, 0.40, 0.22);
  var leafMedium = vec3f(0.40, 0.55, 0.30);
  var leafLight  = vec3f(0.55, 0.68, 0.38);
  var leafOlive  = vec3f(0.48, 0.52, 0.28);

  if (season > 0.5 && season < 1.5) {
    // Summer - rich dark greens, dense foliage
    leafDark   = vec3f(0.08, 0.28, 0.05);
    leafMedium = vec3f(0.14, 0.38, 0.08);
    leafLight  = vec3f(0.22, 0.48, 0.12);
    leafOlive  = vec3f(0.18, 0.35, 0.10);
  } else if (season > 1.5 && season < 2.5) {
    // Autumn - warm oranges, reds, golds, browns
    leafDark   = vec3f(0.55, 0.18, 0.08);
    leafMedium = vec3f(0.72, 0.32, 0.10);
    leafLight  = vec3f(0.85, 0.52, 0.15);
    leafOlive  = vec3f(0.78, 0.58, 0.12);
  } else if (season > 2.5) {
    // Winter - muted gray-brown bare twigs
    leafDark   = vec3f(0.35, 0.32, 0.28);
    leafMedium = vec3f(0.45, 0.42, 0.38);
    leafLight  = vec3f(0.55, 0.52, 0.48);
    leafOlive  = vec3f(0.40, 0.38, 0.35);
  }

  // -- Petal/flower colors per season --------------------------------------
  var shadeDeep   = vec3f(0.85, 0.22, 0.38);
  var shadeMedium = vec3f(0.92, 0.40, 0.52);
  var shadeLight  = vec3f(0.96, 0.58, 0.66);
  var shadePale   = vec3f(0.98, 0.75, 0.80);
  var shadeBlush  = vec3f(0.97, 0.65, 0.72);
  var shadeWhite  = vec3f(0.99, 0.88, 0.90);
  var stamenGold  = vec3f(0.92, 0.78, 0.35);

  if (season > 0.5 && season < 1.5) {
    // Summer - the few remaining flowers are tiny cream/white
    shadeDeep   = vec3f(0.92, 0.90, 0.82);
    shadeMedium = vec3f(0.95, 0.93, 0.86);
    shadeLight  = vec3f(0.97, 0.95, 0.90);
    shadePale   = vec3f(0.98, 0.97, 0.94);
    shadeBlush  = vec3f(0.96, 0.94, 0.88);
    shadeWhite  = vec3f(0.99, 0.98, 0.96);
    stamenGold  = vec3f(0.88, 0.82, 0.35);
  } else if (season > 1.5 && season < 2.5) {
    // Autumn - no flowers, but "petals" become extra leaf colors
    shadeDeep   = vec3f(0.70, 0.15, 0.05);
    shadeMedium = vec3f(0.82, 0.28, 0.08);
    shadeLight  = vec3f(0.92, 0.48, 0.12);
    shadePale   = vec3f(0.95, 0.65, 0.22);
    shadeBlush  = vec3f(0.88, 0.38, 0.10);
    shadeWhite  = vec3f(0.95, 0.78, 0.35);
    stamenGold  = vec3f(0.80, 0.60, 0.15);
  } else if (season > 2.5) {
    // Winter - sparse pale frost buds
    shadeDeep   = vec3f(0.72, 0.75, 0.80);
    shadeMedium = vec3f(0.82, 0.84, 0.88);
    shadeLight  = vec3f(0.90, 0.92, 0.95);
    shadePale   = vec3f(0.95, 0.96, 0.98);
    shadeBlush  = vec3f(0.85, 0.87, 0.92);
    shadeWhite  = vec3f(0.97, 0.98, 0.99);
    stamenGold  = vec3f(0.70, 0.68, 0.60);
  }

  // -- Compute base color ---------------------------------------------------
  var baseColor = vec3f(0.0);

  if (isLeaf > 0.5) {
    let leafTier = fract(seed * 5.17);
    var leafBase: vec3f;
    var leafTip: vec3f;
    if (leafTier < 0.35) {
      leafBase = leafDark;
      leafTip = leafMedium;
    } else if (leafTier < 0.6) {
      leafBase = leafMedium;
      leafTip = leafLight;
    } else if (leafTier < 0.85) {
      leafBase = leafOlive;
      leafTip = leafLight;
    } else {
      leafBase = leafDark;
      leafTip = leafOlive;
    }
    baseColor = mix(leafBase, leafTip, t);
  } else if (input.isCenter > 0.5) {
    // Stamen visible only in spring; blend to leaf color otherwise
    let goldVar = fract(seed * 13.3) * 0.15;
    let goldColor = stamenGold * (0.9 + goldVar);
    let centerLeaf = mix(leafDark, leafMedium, fract(seed * 5.17));
    baseColor = mix(goldColor, centerLeaf, min(season, 1.0));
  } else {
    // In summer/autumn, even petal geometry uses leaf colors (no flowers exist)
    if (season > 0.5 && season < 2.5) {
      let leafTier2 = fract(seed * 8.13);
      var lBase: vec3f;
      var lTip: vec3f;
      if (leafTier2 < 0.3) { lBase = leafDark; lTip = leafMedium; }
      else if (leafTier2 < 0.6) { lBase = leafMedium; lTip = leafLight; }
      else if (leafTier2 < 0.85) { lBase = leafOlive; lTip = leafLight; }
      else { lBase = leafDark; lTip = leafOlive; }
      baseColor = mix(lBase, lTip, t);
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
  }

  // Neutral directional light - no warm tint
  let sunDir = normalize(vec3f(-0.4, 0.85, -0.3));
  let sunColor = vec3f(1.20, 1.20, 1.20);
  let ambient = vec3f(0.28, 0.28, 0.30);
  let NdotL = max(dot(N, sunDir), 0.0);

  // Subsurface scattering - warm glow through petals
  let NdotLBack = max(dot(-N, sunDir), 0.0);
  let sssColor = mix(vec3f(1.0, 0.55, 0.65), vec3f(0.6, 0.8, 0.4), isLeaf);
  let subsurface = NdotLBack * 0.22 * sssColor;

  // Sky fill - warm tinted
  let skyFill = vec3f(0.90, 0.85, 0.88);
  let skyContrib = max(N.y, 0.0) * 0.12 * skyFill;

  // Depth-based darkening - flowers deeper inside the canopy are darker
  let depthDarken = mix(0.92, 1.0, fract(seed * 11.3));
  let undersideDarken = mix(0.55, 1.0, max(N.y, 0.0)) * depthDarken;

  // Rim light - warm edge glow
  let viewDir = normalize(vec3f(0.4, 0.6, 0.7));
  let rimDot = 1.0 - max(dot(N, viewDir), 0.0);
  let rim = pow(rimDot, 3.0) * 0.10 * vec3f(1.0, 0.85, 0.88);

  let lit = baseColor * undersideDarken * (ambient + sunColor * NdotL * 0.88) + subsurface + skyContrib + rim;

  let hdr = acesFilm(lit * 1.05);
  var ldr = pow(hdr, vec3f(1.0 / 2.2));

  // Saturation boost - vivid colors
  let gray = dot(ldr, vec3f(0.299, 0.587, 0.114));
  ldr = mix(vec3f(gray), ldr, 1.6);

  return vec4f(ldr, 1.0);
}
`;
