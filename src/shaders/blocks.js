import {
  BLOCK_SIZE,
  FLAT_ANGLE_X,
  ISO_ANGLE_X,
  ISO_ANGLE_Y,
  SKY_COLORS,
  VIEW_SCALE_2D,
  VIEW_SCALE_3D,
  X_OFFSET_2D,
  Y_OFFSET_2D,
} from '../constants.js';
import { ACES_WGSL, CAMERA_WGSL, UNIFORMS_WGSL, vec3 } from './common.js';

/**
 * Voxel pass. One draw of `36 * blockCount` vertices builds every cube on the
 * fly from `vertex_index` - no vertex buffers, just the four storage buffers.
 *
 * The 3D -> 2D transition is done entirely here: canopy cubes, trunk blocks
 * above ground and branch blocks are collapsed toward their base as `progress`
 * moves, leaving only the ground layer - the QR code - standing.
 */
export const blockVertexShader = /* wgsl */ `
${UNIFORMS_WGSL}
${CAMERA_WGSL}

struct BlockOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) faceNx: f32,
  @location(2) faceNy: f32,
  @location(3) faceNz: f32,
  @location(4) blockType: f32,
  @location(5) blockH: f32,
  @location(6) col: f32,
  @location(7) row: f32,
  @location(8) layer: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> blockTypes: array<u32>;
@group(0) @binding(2) var<storage, read> blockPositions: array<vec4f>;
@group(0) @binding(3) var<storage, read> blockHeights: array<f32>;
@group(0) @binding(4) var<storage, read> blockBaseY: array<f32>;

@vertex
fn main(@builtin(vertex_index) vertexIndex: u32) -> BlockOutput {
  var output: BlockOutput;
  let blockIdx = vertexIndex / 36u;
  let localVertIdx = vertexIndex % 36u;
  let faceIdx = localVertIdx / 6u;
  let vertIdx = localVertIdx % 6u;

  let blockCount = u32(uniforms.blockCount);
  if (blockIdx >= blockCount) {
    output.position = vec4f(0.0, 0.0, -10.0, 1.0);
    return output;
  }

  let posData = blockPositions[blockIdx];
  let col = posData.x;
  let row = posData.y;
  output.col = col;
  output.row = row;
  output.layer = blockBaseY[blockIdx] / ${BLOCK_SIZE};

  let gridSize = uniforms.gridSize;
  let blockSize = ${BLOCK_SIZE};
  let halfGrid = gridSize * blockSize * 0.5;
  let cubeSize = blockSize;

  let baseX = col * blockSize - halfGrid;
  let baseY = blockBaseY[blockIdx];
  let baseZ = row * blockSize - halfGrid;
  let h = cubeSize;
  output.blockH = h;

  let typePacked = blockTypes[blockIdx];
  output.blockType = f32(typePacked);

  let quadVerts = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0)
  );
  let qv = quadVerts[vertIdx];
  let hw = cubeSize * 0.5;
  let hd = cubeSize * 0.5;

  var localPos = vec3f(0.0);
  var normal = vec3f(0.0);

  // Gentle sway for cherry blossom blocks (type 1)
  var swayX = 0.0;
  var swayZ = 0.0;
  if (typePacked == 1u && h > 0.15) {
    let time = uniforms.time;
    swayX = sin(time * 0.8 + col * 0.3 + row * 0.2) * 0.002 * h;
    swayZ = sin(time * 0.6 + col * 0.2 + row * 0.4) * 0.0015 * h;
  }

  // Build cube faces
  if (faceIdx == 0u) {
    // Top face
    localPos = vec3f(baseX + (qv.x - 0.5) * cubeSize + swayX, baseY + h, baseZ + (qv.y - 0.5) * cubeSize + swayZ);
    normal = vec3f(0.0, 1.0, 0.0);
  } else if (faceIdx == 1u) {
    // Bottom face
    localPos = vec3f(baseX + (qv.x - 0.5) * cubeSize, baseY, baseZ + (0.5 - qv.y) * cubeSize);
    normal = vec3f(0.0, -1.0, 0.0);
  } else if (faceIdx == 2u) {
    // Front face
    localPos = vec3f(baseX + (qv.x - 0.5) * cubeSize + swayX * qv.y, baseY + qv.y * h, baseZ + hd + swayZ * qv.y);
    normal = vec3f(0.0, 0.0, 1.0);
  } else if (faceIdx == 3u) {
    // Back face
    localPos = vec3f(baseX + (0.5 - qv.x) * cubeSize + swayX * qv.y, baseY + qv.y * h, baseZ - hd + swayZ * qv.y);
    normal = vec3f(0.0, 0.0, -1.0);
  } else if (faceIdx == 4u) {
    // Right face
    localPos = vec3f(baseX + hw + swayX * qv.y, baseY + qv.y * h, baseZ + (qv.x - 0.5) * cubeSize + swayZ * qv.y);
    normal = vec3f(1.0, 0.0, 0.0);
  } else {
    // Left face
    localPos = vec3f(baseX - hw + swayX * qv.y, baseY + qv.y * h, baseZ + (0.5 - qv.x) * cubeSize + swayZ * qv.y);
    normal = vec3f(-1.0, 0.0, 0.0);
  }

  output.uv = qv;
  output.faceNx = normal.x;
  output.faceNy = normal.y;
  output.faceNz = normal.z;

  // Interpolate between 3D isometric and 2D flat view
  let progress = uniforms.progress;

  // Hide block trunk in 3D - keep ground layer (baseY == 0) visible
  if (typePacked == 2u && baseY > 0.001) {
    let trunkVis = smoothstep(0.2, 0.6, progress);
    localPos = vec3f(
      baseX + (localPos.x - baseX) * trunkVis,
      baseY + (localPos.y - baseY) * trunkVis,
      baseZ + (localPos.z - baseZ) * trunkVis,
    );
  }

  // Hide cherry blossom cubes in 3D - flowers replace them (hide earlier)
  if (typePacked == 1u) {
    let cubeVis = smoothstep(0.15, 0.6, progress);
    localPos = vec3f(
      baseX + (localPos.x - baseX) * cubeVis,
      baseY + (localPos.y - baseY) * cubeVis,
      baseZ + (localPos.z - baseZ) * cubeVis,
    );
  }

  // Hide branch blocks in 2D - they'd break QR scanning
  if (typePacked == 5u) {
    let branchVis = smoothstep(0.0, 0.4, 1.0 - progress);
    localPos = vec3f(
      baseX + (localPos.x - baseX) * branchVis,
      baseY + (localPos.y - baseY) * branchVis,
      baseZ + (localPos.z - baseZ) * branchVis,
    );
  }

  let isoAngleY = mix(${ISO_ANGLE_Y}, 0, progress) + uniforms.cameraBobX;
  let isoAngleX = mix(${ISO_ANGLE_X}, ${FLAT_ANGLE_X}, progress) + uniforms.cameraBobY;

  let cy = cos(isoAngleY); let sy = sin(isoAngleY);
  let cx = cos(isoAngleX); let sx = sin(isoAngleX);

  // Apply rotation
  let ry_x = localPos.x * cy - localPos.z * sy;
  let ry_z = localPos.x * sy + localPos.z * cy;
  let rx_y = localPos.y * cx - ry_z * sx;
  let rx_z = localPos.y * sx + ry_z * cx;

  // View scaling
  let viewScale = viewScaleFor(progress, uniforms.gridSize);
  let ar = uniforms.aspectRatio;
  let scaleX = viewScale / max(ar, 1.0);
  let scaleY = viewScale / max(1.0 / ar, 1.0);

  // Centering offsets for 2D view
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

export const blockFragmentShader = /* wgsl */ `
${UNIFORMS_WGSL}

struct BlockInput {
  @location(0) uv: vec2f,
  @location(1) faceNx: f32,
  @location(2) faceNy: f32,
  @location(3) faceNz: f32,
  @location(4) blockType: f32,
  @location(5) blockH: f32,
  @location(6) col: f32,
  @location(7) row: f32,
  @location(8) layer: f32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

${ACES_WGSL}

@fragment
fn main(input: BlockInput) -> @location(0) vec4f {
  let uv = input.uv;
  let N = normalize(vec3f(input.faceNx, input.faceNy, input.faceNz));
  let blockType = i32(input.blockType + 0.5);
  let progress = uniforms.progress;

  // ============================================
  // COLOR PALETTES - seasonal
  // ============================================

  let season = uniforms.season;

  // Dirt/path (QR light modules)
  let dirtLight = vec3f(0.82, 0.76, 0.66);
  let dirtMid = vec3f(0.76, 0.70, 0.60);
  let dirtDark = vec3f(0.68, 0.62, 0.52);

  // Canopy blocks - changes with season
  var sakuraLight = vec3f(0.88, 0.48, 0.55);  // Spring: pink
  var sakuraMid = vec3f(0.78, 0.34, 0.42);
  var sakuraDeep = vec3f(0.65, 0.24, 0.32);
  var sakuraRich = vec3f(0.52, 0.16, 0.24);

  // Grass - changes with season
  var grassDark = vec3f(0.10, 0.30, 0.06);
  var grassMid = vec3f(0.16, 0.42, 0.10);
  var grassBright = vec3f(0.24, 0.52, 0.14);

  if (season > 0.5 && season < 1.5) {
    // Summer - canopy is green foliage, grass is lush
    sakuraLight = vec3f(0.28, 0.52, 0.18);
    sakuraMid   = vec3f(0.18, 0.42, 0.10);
    sakuraDeep  = vec3f(0.12, 0.32, 0.08);
    sakuraRich  = vec3f(0.08, 0.24, 0.05);
    grassDark   = vec3f(0.06, 0.32, 0.04);
    grassMid    = vec3f(0.12, 0.45, 0.08);
    grassBright = vec3f(0.20, 0.55, 0.12);
  } else if (season > 1.5 && season < 2.5) {
    // Autumn - canopy is orange/red/gold, grass is dry golden
    sakuraLight = vec3f(0.92, 0.55, 0.18);
    sakuraMid   = vec3f(0.82, 0.35, 0.12);
    sakuraDeep  = vec3f(0.70, 0.22, 0.08);
    sakuraRich  = vec3f(0.55, 0.15, 0.05);
    grassDark   = vec3f(0.40, 0.30, 0.10);
    grassMid    = vec3f(0.55, 0.40, 0.12);
    grassBright = vec3f(0.68, 0.50, 0.16);
  } else if (season > 2.5) {
    // Winter - canopy is bare dark bark, grass is frost gray
    sakuraLight = vec3f(0.42, 0.36, 0.30);
    sakuraMid   = vec3f(0.35, 0.28, 0.22);
    sakuraDeep  = vec3f(0.28, 0.22, 0.16);
    sakuraRich  = vec3f(0.22, 0.16, 0.10);
    grassDark   = vec3f(0.30, 0.28, 0.22);
    grassMid    = vec3f(0.40, 0.38, 0.30);
    grassBright = vec3f(0.50, 0.48, 0.40);
  }

  // Trunk - rich warm brown (same all seasons)
  let barkLight = vec3f(0.42, 0.24, 0.14);
  let barkMid = vec3f(0.34, 0.18, 0.10);
  let barkDark = vec3f(0.24, 0.12, 0.06);
  let barkDeep = vec3f(0.18, 0.08, 0.04);

  // ============================================
  // LIGHTING SETUP
  // ============================================

  let sunDir = normalize(vec3f(-0.4, 0.85, -0.3));
  let sunCol = vec3f(1.20, 1.20, 1.20);  // neutral white light - no warm tint
  let ambient = vec3f(0.28, 0.28, 0.30);
  let skyFill = ${vec3(SKY_COLORS.skyFill)};
  let bounce = ${vec3(SKY_COLORS.bounce)};

  let NdSun = max(dot(N, sunDir), 0.0);
  let NdUp = max(dot(N, vec3f(0.0, 1.0, 0.0)), 0.0);

  // ============================================
  // PER-BLOCK NOISE
  // ============================================

  let layer = input.layer;
  let seed = vec2f(input.col, input.row);
  let blockSeed = seed.x * 17.3 + seed.y * 31.1 + layer * 73.7;
  let noise1 = fract(sin(blockSeed) * 43758.5);
  let noise2 = fract(sin(blockSeed * 1.7 + 127.1) * 43758.5);
  let noise3 = fract(sin(blockSeed * 2.3 + 311.7) * 43758.5);

  // ============================================
  // TREE SHADOW CALCULATION
  // ============================================

  let gridSize = uniforms.gridSize;
  let cx = gridSize * 0.5;
  let cy = gridSize * 0.5;
  let shadowOffsetX = 1.5;
  let shadowOffsetY = 1.5;
  let dx = input.col - (cx + shadowOffsetX);
  let dy = input.row - (cy + shadowOffsetY);
  let distFromShadowCenter = sqrt(dx * dx + dy * dy);
  let canopyRadius = gridSize * 0.46;
  let trunkRadius = 2.5;
  let shadowT = 1.0 - smoothstep(trunkRadius, canopyRadius, distFromShadowCenter);
  // Stronger AO near trunk base, softer toward edges
  let trunkAO = (1.0 - smoothstep(0.0, trunkRadius * 1.5, distFromShadowCenter)) * 0.20;
  let treeShadow = 1.0 - shadowT * 0.35 - trunkAO;

  // Canopy self-shadowing
  let maxCanopyLayer = 15.0;
  let layerRatio = min(layer / maxCanopyLayer, 1.0);
  let canopyAO = 0.65 + layerRatio * 0.35;

  var albedo = vec3f(0.5);

  // ============================================
  // TOP FACE - What QR scanner sees in 2D
  // ============================================

  if (input.faceNy > 0.5) {
    let topWarmTint = vec3f(1.1, 1.08, 1.02);

    // Darken dark QR modules and brighten light ones - consistent in both views
    let isDarkModule = step(0.5, f32(blockType));

    if (blockType == 0) {
      // SAND/DIRT - high noise variation to break grid look
      var dirtColor = dirtMid;
      let t = noise1;
      if (t < 0.4) {
        dirtColor = mix(dirtLight, dirtMid, t / 0.4);
      } else if (t < 0.7) {
        dirtColor = mix(dirtMid, dirtDark, (t - 0.4) / 0.3);
      } else {
        // Some grains are darker
        dirtColor = mix(dirtDark, dirtDark * 0.85, (t - 0.7) / 0.3);
      }
      // Strong per-block variation for sandy texture
      let shift = (noise2 - 0.5) * 0.18;
      let grain = (noise3 - 0.5) * 0.08;
      dirtColor = dirtColor * (1.0 + shift + grain) * treeShadow;

      // Seasonal ground cover speckles under canopy
      let distFromCenter = sqrt((input.col - cx) * (input.col - cx) + (input.row - cy) * (input.row - cy));
      let underCanopy = step(distFromCenter, canopyRadius);
      let speckleChance = noise3 * underCanopy;

      if (season < 0.5) {
        // Spring: scattered pink petal speckles
        let petalTint = vec3f(0.90, 0.72, 0.70);
        dirtColor = mix(dirtColor, petalTint, step(0.85, speckleChance) * 0.4);
      } else if (season < 1.5) {
        // Summer: clean ground, maybe tiny green speckles
        let greenSpeck = vec3f(0.55, 0.68, 0.42);
        dirtColor = mix(dirtColor, greenSpeck, step(0.92, speckleChance) * 0.2);
      } else if (season < 2.5) {
        // Autumn: scattered fallen leaf speckles (orange/brown)
        let leafSpeck = mix(vec3f(0.85, 0.52, 0.15), vec3f(0.72, 0.35, 0.10), noise1);
        dirtColor = mix(dirtColor, leafSpeck, step(0.70, speckleChance) * 0.5);
      } else {
        // Winter: snow patches
        let snowPatch = vec3f(0.92, 0.93, 0.96);
        dirtColor = mix(dirtColor, snowPatch, step(0.55, speckleChance) * 0.7);
      }

      albedo = dirtColor * topWarmTint;

    } else if (blockType == 1) {
      // CHERRY BLOSSOM
      var cherryColor = sakuraMid;
      let t = noise1;
      if (t < 0.33) {
        cherryColor = mix(sakuraLight, sakuraMid, t / 0.33);
      } else if (t < 0.66) {
        cherryColor = mix(sakuraMid, sakuraDeep, (t - 0.33) / 0.33);
      } else {
        cherryColor = mix(sakuraDeep, sakuraRich, (t - 0.66) / 0.34);
      }
      let shift = (noise2 - 0.5) * 0.15;
      cherryColor = cherryColor * (1.0 + shift);

      // Edge rounding effect (fades in 2D)
      let edgeX = min(uv.x, 1.0 - uv.x);
      let edgeY = min(uv.y, 1.0 - uv.y);
      let edgeDist = min(edgeX, edgeY);
      let roundedEdge = smoothstep(0.0, 0.12, edgeDist);
      let edgeDarken = mix(0.88, 1.0, roundedEdge);
      let finalEdge = mix(edgeDarken, 1.0, progress);

      albedo = cherryColor * topWarmTint * canopyAO * finalEdge;

    } else if (blockType == 2) {
      // TRUNK top face - sandy at ground level, bark higher up
      let trunkMaxLayer = 18.0;
      let heightRatio = min(layer / trunkMaxLayer, 1.0);

      // Ground-level trunk blocks blend into surrounding sand
      let sandColor = vec3f(0.85, 0.78, 0.64);
      let sandShift = (noise1 - 0.5) * 0.1;
      let groundSand = sandColor * (1.0 + sandShift) * treeShadow;

      var barkColor = mix(barkMid, barkLight, noise1 * 0.4);
      let shift = (noise2 - 0.5) * 0.15;
      barkColor = barkColor * (1.0 + shift);
      let aoShadow = 0.6 + heightRatio * 0.4;

      // Blend: ground level = sand, upper = bark
      let sandBlend = smoothstep(0.0, 0.15, heightRatio);
      albedo = mix(groundSand, barkColor * aoShadow, sandBlend) * topWarmTint;

    } else if (blockType == 3) {
      // GRASS
      let grassBrown = vec3f(0.28, 0.25, 0.12);
      let grassOlive = vec3f(0.32, 0.35, 0.15);

      var grassColor = grassMid;
      let t = noise1;
      if (t < 0.3) {
        grassColor = mix(grassBright, grassMid, t / 0.3);
      } else if (t < 0.6) {
        grassColor = mix(grassMid, grassDark, (t - 0.3) / 0.3);
      } else if (t < 0.8) {
        grassColor = mix(grassDark, grassBrown, (t - 0.6) / 0.2);
      } else {
        grassColor = mix(grassBrown, grassOlive, (t - 0.8) / 0.2);
      }
      let shift = (noise2 - 0.5) * 0.2;
      grassColor = grassColor * (1.0 + shift);

      albedo = grassColor * topWarmTint;

    } else if (blockType == 5) {
      // BRANCH - circular cross-section on top face
      var branchColor = mix(barkMid, barkLight, noise1 * 0.5);
      let bShift = (noise2 - 0.5) * 0.12;
      branchColor = branchColor * (1.0 + bShift);
      let ringNoise = sin(noise1 * 12.0 + noise2 * 6.0) * 0.06 + 0.94;
      albedo = branchColor * ringNoise * topWarmTint * canopyAO;

    } else {
      // FALLEN PETALS (type 4) - same sandy base as dirt, very subtle pink hint
      // This minimizes the checkerboard between dark/light QR cells
      let sandA = vec3f(0.84, 0.77, 0.63);
      let sandB = vec3f(0.80, 0.73, 0.60);
      let sandPink = vec3f(0.84, 0.74, 0.66); // barely pink

      var fallenColor = sandA;
      if (noise1 < 0.4) {
        fallenColor = mix(sandA, sandB, noise2);
      } else if (noise1 < 0.75) {
        fallenColor = mix(sandB, sandPink, noise2 * 0.5);
      } else {
        fallenColor = mix(sandA, sandPink, noise2 * 0.4);
      }
      let shift = (noise2 - 0.5) * 0.12;
      fallenColor = fallenColor * (1.0 + shift) * treeShadow;
      albedo = fallenColor * topWarmTint;
    }

    // In 3D: subtle contrast between dark/light modules
    // In 2D: strong contrast for QR scanning
    let qrBoost = progress * progress;
    let darkFactor = mix(0.70, 0.45, qrBoost);   // subtle in 3D, moderate in 2D
    let lightFactor = mix(0.4, 0.75, qrBoost);   // subtle in 3D, moderate in 2D
    let darkened = albedo * darkFactor;
    let brightened = mix(albedo, vec3f(1.0), lightFactor);
    albedo = mix(brightened, darkened, isDarkModule);

  // ============================================
  // SIDE FACES
  // ============================================

  } else if (abs(input.faceNz) > 0.5 || abs(input.faceNx) > 0.5) {
    let faceN = normalize(vec3f(input.faceNx, input.faceNy, input.faceNz));
    let sunLight = max(dot(faceN, sunDir), 0.0);
    let shade = 0.3 + sunLight * 0.65;
    let tint = vec3f(0.95, 0.95, 0.98);

    // Ground-level side faces -> warm stone look
    if (layer < 1.0 && (blockType == 0 || blockType == 3 || blockType == 4)) {
      let stoneLight = vec3f(0.78, 0.72, 0.64);
      let stoneMid = vec3f(0.68, 0.62, 0.54);
      let stoneDark = vec3f(0.58, 0.52, 0.45);
      var stoneColor = stoneMid;
      if (noise1 < 0.35) {
        stoneColor = mix(stoneLight, stoneMid, noise2);
      } else if (noise1 < 0.7) {
        stoneColor = mix(stoneMid, stoneDark, noise2 * 0.6);
      } else {
        stoneColor = mix(stoneDark, stoneLight, noise2 * 0.3);
      }
      let stoneShift = (noise3 - 0.5) * 0.08;
      stoneColor = stoneColor * (1.0 + stoneShift);
      albedo = stoneColor * shade * tint;

    } else if (blockType == 0) {
      var dirtColor = dirtMid;
      let t = noise1;
      if (t < 0.4) {
        dirtColor = mix(dirtLight, dirtMid, t / 0.4);
      } else if (t < 0.7) {
        dirtColor = mix(dirtMid, dirtDark, (t - 0.4) / 0.3);
      } else {
        dirtColor = dirtDark * (1.0 - (t - 0.7) * 0.2);
      }
      let shift = (noise2 - 0.5) * 0.2;
      dirtColor = dirtColor * (1.0 + shift);
      albedo = dirtColor * shade * tint;

    } else if (blockType == 1) {
      var cherryColor = sakuraMid;
      let t = noise1;
      if (t < 0.33) {
        cherryColor = mix(sakuraLight, sakuraMid, t / 0.33);
      } else if (t < 0.66) {
        cherryColor = mix(sakuraMid, sakuraDeep, (t - 0.33) / 0.33);
      } else {
        cherryColor = mix(sakuraDeep, sakuraRich, (t - 0.66) / 0.34);
      }
      let shift = (noise2 - 0.5) * 0.25;
      cherryColor = cherryColor * (1.0 + shift);

      let edgeX = min(uv.x, 1.0 - uv.x);
      let edgeY = min(uv.y, 1.0 - uv.y);
      let edgeDist = min(edgeX, edgeY);
      let roundedEdge = smoothstep(0.0, 0.12, edgeDist);
      let edgeDarken = mix(0.7, 1.0, roundedEdge);

      albedo = cherryColor * shade * tint * canopyAO * edgeDarken;

    } else if (blockType == 2) {
      // --- ORGANIC TRUNK: gnarled bark with wood grain ---

      let trunkCx = gridSize * 0.5;
      let trunkCy = gridSize * 0.5;
      let radX = input.col - trunkCx;
      let radZ = input.row - trunkCy;
      let radLen = max(sqrt(radX * radX + radZ * radZ), 0.01);
      let cylNormalX = radX / radLen;
      let cylNormalZ = radZ / radLen;

      let cylN = normalize(vec3f(cylNormalX * 0.8 + faceN.x * 0.2, faceN.y * 0.15, cylNormalZ * 0.8 + faceN.z * 0.2));
      let cylSunLight = max(dot(cylN, sunDir), 0.0);

      let trunkMaxLayer = 18.0;
      let heightRatio = min(layer / trunkMaxLayer, 1.0);

      // Multi-frequency bark grooves for organic gnarled look
      let barkAngle = atan2(radZ, radX);
      let groove1 = sin(barkAngle * 12.0 + noise1 * 2.0) * 0.5 + 0.5;
      let groove2 = sin(barkAngle * 7.0 + noise2 * 3.5 + 1.7) * 0.5 + 0.5;
      let groove3 = sin(barkAngle * 20.0 + noise1 * 5.0) * 0.5 + 0.5;
      let grooveDepth = (groove1 * 0.5 + groove2 * 0.3 + groove3 * 0.2) * 0.25 + 0.75;

      // Twisted wood grain - spiral pattern up the trunk
      let spiralAngle = barkAngle + heightRatio * 2.5 + noise1 * 0.5;
      let woodGrain = sin(spiralAngle * 8.0 + layer * 2.0) * 0.08 + 0.92;

      // Horizontal ring pattern - knot-like detail
      let ringPattern = sin(layer * 3.5 + noise2 * 4.0) * 0.10 + 0.90;
      let knotNoise = sin(barkAngle * 3.0 + layer * 5.0 + noise3 * 6.0);
      let knot = smoothstep(0.85, 0.95, knotNoise) * 0.15;

      // Base bark color - warmer with purple undertone at height
      var barkColor = mix(barkDark, barkMid, heightRatio * 0.7);
      barkColor = mix(barkColor, barkLight, groove1 * 0.3);
      let purpleUndertone = vec3f(0.08, 0.02, 0.10) * heightRatio * 0.3;
      barkColor = barkColor + purpleUndertone;
      let shift = (noise2 - 0.5) * 0.18;
      barkColor = barkColor * (1.0 + shift);
      barkColor = barkColor - knot;

      // Cylindrical AO
      let edgeFade = 1.0 - smoothstep(0.6, 1.0, abs(dot(cylN, normalize(vec3f(faceN.x, 0.0, faceN.z)))));
      let cylAO = 0.7 + edgeFade * 0.3;
      let vertAO = 0.60 + heightRatio * 0.40;

      let trunkShade = 0.22 + cylSunLight * 0.75;
      var trunkAlbedo = barkColor * trunkShade * grooveDepth * woodGrain * ringPattern * cylAO * vertAO * tint;

      // Ground-level trunk sides blend to sand
      let sandSideColor = vec3f(0.78, 0.72, 0.58) * shade * tint;
      let sideBlend = smoothstep(0.0, 0.15, heightRatio);
      albedo = mix(sandSideColor, trunkAlbedo, sideBlend);

    } else if (blockType == 3) {
      let grassBrown = vec3f(0.28, 0.25, 0.12);
      let grassOlive = vec3f(0.32, 0.35, 0.15);

      var grassColor = grassMid;
      let t = noise1;
      if (t < 0.3) {
        grassColor = mix(grassBright, grassMid, t / 0.3);
      } else if (t < 0.6) {
        grassColor = mix(grassMid, grassDark, (t - 0.6) / 0.3);
      } else if (t < 0.8) {
        grassColor = mix(grassDark, grassBrown, (t - 0.6) / 0.2);
      } else {
        grassColor = mix(grassBrown, grassOlive, (t - 0.8) / 0.2);
      }
      let shift = (noise2 - 0.5) * 0.2;
      grassColor = grassColor * (1.0 + shift);
      albedo = grassColor * shade * tint;

    } else if (blockType == 5) {
      // BRANCH side - bark texture with cylindrical shading
      var branchColor = mix(barkDark, barkMid, noise1 * 0.6);
      let grooveSide = sin(layer * 5.0 + noise1 * 3.0) * 0.08 + 0.92;
      let bShift = (noise2 - 0.5) * 0.15;
      branchColor = branchColor * (1.0 + bShift) * grooveSide;
      albedo = branchColor * shade * tint;

    } else {
      // Side face fallen petals - sandy to match top
      let sandSide = vec3f(0.72, 0.66, 0.52);
      let sandSideDark = vec3f(0.62, 0.56, 0.44);
      var fallenColor = mix(sandSide, sandSideDark, noise1 * 0.5);
      let shift = (noise2 - 0.5) * 0.12;
      fallenColor = fallenColor * (1.0 + shift);
      albedo = fallenColor * shade * tint;
    }

  // ============================================
  // BOTTOM FACE
  // ============================================

  } else {
    let bottomTint = vec3f(0.65, 0.62, 0.58); // warm stone underneath
    let fallenBottom = vec3f(0.50, 0.45, 0.38);

    if (blockType == 0) {
      albedo = dirtDark * 0.5 * bottomTint;
    } else if (blockType == 1) {
      albedo = sakuraDeep * 0.5 * bottomTint;
    } else if (blockType == 2) {
      albedo = barkDark * 0.5 * bottomTint;
    } else if (blockType == 3) {
      albedo = grassDark * 0.5 * bottomTint;
    } else if (blockType == 5) {
      albedo = barkDark * 0.5 * bottomTint;
    } else {
      albedo = fallenBottom * 0.6 * bottomTint;
    }
  }

  // ============================================
  // FINAL LIGHTING & TONEMAPPING
  // ============================================

  // Rim light for depth and edge definition
  let viewDir = normalize(vec3f(0.4, 0.6, 0.7));
  let rimDot = 1.0 - max(dot(N, viewDir), 0.0);
  let rimLight = pow(rimDot, 4.0) * 0.06 * vec3f(0.85, 0.75, 0.95);

  let diffuse = albedo * (ambient + sunCol * NdSun * 0.85 + skyFill * NdUp * 0.18 + bounce * 0.15) + rimLight;
  var hdr = diffuse;
  hdr = acesFilm(hdr * 1.15);
  hdr = pow(hdr, vec3f(1.0 / 2.2));

  // Saturation boost
  let grayB = dot(hdr, vec3f(0.299, 0.587, 0.114));
  hdr = mix(vec3f(grayB), hdr, 1.25);

  return vec4f(hdr, 1.0);
}
`;
