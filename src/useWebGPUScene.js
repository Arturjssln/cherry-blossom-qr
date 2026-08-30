import { useCallback, useEffect, useRef } from 'react';

import {
  MAX_BLOCKS,
  MAX_BRANCH_SEGMENTS,
  MAX_FLOWERS,
  MAX_GRASS,
  FALLING_PETAL_COUNT,
} from './constants.js';
import { generateQRMatrix } from './qr.js';
import { buildBlockGrid, buildCanopyCubeFlowers } from './geometry/blocks.js';
import { deriveTreeParams, generateBranchSkeleton } from './geometry/tree.js';
import { generateCanopyFlowers, generateFallingPetals } from './geometry/canopy.js';
import { generateGrass } from './geometry/grass.js';
import { blockFragmentShader, blockVertexShader } from './shaders/blocks.js';
import {
  shadowFragmentShader,
  shadowVertexShader,
  skyFragmentShader,
  skyVertexShader,
} from './shaders/backdrop.js';
import { flowerFragmentShader, flowerVertexShader } from './shaders/flowers.js';
import { branchFragmentShader, branchVertexShader } from './shaders/branches.js';
import { grassFragmentShader, grassVertexShader } from './shaders/grass.js';
import {
  fallingFlowerFragmentShader,
  fallingFlowerVertexShader,
} from './shaders/fallingFlowers.js';

const UNIFORM_BYTES = 32; // 8 x f32
const BRANCH_BUFFER_FLOATS = MAX_BRANCH_SEGMENTS * 12;

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/**
 * Pad and upload the four voxel storage buffers.
 *
 * Clamps to MAX_BLOCKS rather than letting `TypedArray.set` throw: a pathological
 * input should lose some voxels, not crash the scene.
 *
 * @returns {number} the block count actually uploaded — use this as the draw count
 */
function uploadBlockData(device, blockData, buffers) {
  const { types, positions, heights, baseY } = blockData;
  const count = Math.min(blockData.numBlocks, MAX_BLOCKS);
  if (blockData.numBlocks > MAX_BLOCKS) {
    console.warn(
      `Block budget exceeded (${blockData.numBlocks} > ${MAX_BLOCKS}); truncating.`,
    );
  }

  const typeArray = new Uint32Array(MAX_BLOCKS);
  typeArray.set(types.slice(0, count));
  device.queue.writeBuffer(buffers.typeBuffer, 0, typeArray);

  const posArray = new Float32Array(MAX_BLOCKS * 4);
  posArray.set(positions.slice(0, count * 4));
  device.queue.writeBuffer(buffers.posBuffer, 0, posArray);

  const heightArray = new Float32Array(MAX_BLOCKS);
  heightArray.set(heights.slice(0, count));
  device.queue.writeBuffer(buffers.heightBuffer, 0, heightArray);

  const baseYArray = new Float32Array(MAX_BLOCKS);
  baseYArray.set(baseY.slice(0, count));
  device.queue.writeBuffer(buffers.baseYBuffer, 0, baseYArray);

  return count;
}

/**
 * Merge the two blossom sources into one buffer, clamped to MAX_FLOWERS.
 *
 * @returns {number} the flower count actually uploaded
 */
function uploadFlowerData(device, buffer, canopy, cubeFlowers) {
  const total = canopy.count + cubeFlowers.count;
  if (total > MAX_FLOWERS) {
    console.warn(`Flower budget exceeded (${total} > ${MAX_FLOWERS}); truncating.`);
  }

  const padded = new Float32Array(MAX_FLOWERS * 4);
  const fromCanopy = Math.min(canopy.count, MAX_FLOWERS);
  padded.set(canopy.positions.slice(0, fromCanopy * 4));

  const fromCubes = Math.min(cubeFlowers.count, MAX_FLOWERS - fromCanopy);
  if (fromCubes > 0) {
    padded.set(new Float32Array(cubeFlowers.positions.slice(0, fromCubes * 4)), fromCanopy * 4);
  }

  device.queue.writeBuffer(buffer, 0, padded);
  return fromCanopy + fromCubes;
}

/**
 * All passes share the same shape: no vertex buffers, `triangle-list`, no
 * culling, premultiplied-alpha blending, and a depth24plus target.
 */
function createPipeline(device, format, bindGroupLayout, opts) {
  const defaultBlend = {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  };

  const vertexModule = device.createShaderModule({ code: opts.vertex });
  const fragmentModule = device.createShaderModule({ code: opts.fragment });

  vertexModule.getCompilationInfo().then((info) => {
    for (const m of info.messages) {
      if (m.type === 'error') console.error('Vertex shader error:', m.message, 'line:', m.lineNum);
    }
  });
  fragmentModule.getCompilationInfo().then((info) => {
    for (const m of info.messages) {
      if (m.type === 'error') console.error('Fragment shader error:', m.message, 'line:', m.lineNum);
    }
  });

  return device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: { module: vertexModule, entryPoint: 'main' },
    fragment: {
      module: fragmentModule,
      entryPoint: 'main',
      targets: [{ format, blend: opts.blend ?? defaultBlend }],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: {
      depthWriteEnabled: opts.depthWrite,
      depthCompare: opts.depthCompare,
      format: 'depth24plus',
    },
  });
}

/**
 * Build every pass and drive the render loop.
 *
 * `isFlat` is a *ref*, not state, so toggling the view never re-runs WebGPU
 * initialisation - the loop just eases `progress` toward the new target.
 *
 * @param {object} args
 * @param {React.RefObject<HTMLCanvasElement>} args.canvasRef
 * @param {number} args.canvasWidth
 * @param {number} args.canvasHeight
 * @param {string} args.qrContent  text to encode (URL or any string)
 * @param {React.MutableRefObject<boolean>} args.isFlat  true = show the QR code
 * @param {React.MutableRefObject<number>} args.seasonRef 0..3
 */
export function useWebGPUScene({
  canvasRef,
  canvasWidth,
  canvasHeight,
  qrContent,
  isFlat,
  seasonRef,
}) {
  const animationRef = useRef(null);
  const startTimeRef = useRef(Date.now());
  const progressRef = useRef(0);      // eased, fed to the shaders
  const rawProgressRef = useRef(0);   // linear approach toward 0/1
  const lastFrameRef = useRef(Date.now());

  const deviceRef = useRef(null);
  const typeBufferRef = useRef(null);
  const posBufferRef = useRef(null);
  const heightBufferRef = useRef(null);
  const baseYBufferRef = useRef(null);
  const flowerBufferRef = useRef(null);
  const branchBufferRef = useRef(null);
  const fallingPetalBufferRef = useRef(null);
  const grassBufferRef = useRef(null);

  const blockMetaRef = useRef({ numBlocks: 0, gridSize: 0 });
  const flowerMetaRef = useRef({ flowerCount: 0 });
  const branchMetaRef = useRef({ segmentCount: 0 });
  const petalMetaRef = useRef({ petalCount: 0 });
  const grassMetaRef = useRef({ grassCount: 0 });

  const qrContentRef = useRef(qrContent);
  qrContentRef.current = qrContent;

  // --- Rebuild geometry when the encoded text changes -----------------------
  // The device and pipelines are untouched; only storage-buffer contents and
  // the draw counts change, so this is cheap.
  useEffect(() => {
    const device = deviceRef.current;
    const typeBuffer = typeBufferRef.current;
    const posBuffer = posBufferRef.current;
    const heightBuffer = heightBufferRef.current;
    const baseYBuffer = baseYBufferRef.current;
    const flowerBuffer = flowerBufferRef.current;
    const branchBuffer = branchBufferRef.current;
    const fallingPetalBuffer = fallingPetalBufferRef.current;
    const grassBuffer = grassBufferRef.current;

    if (!device || !typeBuffer || !posBuffer || !heightBuffer || !baseYBuffer) return;

    const qr = generateQRMatrix(qrContent);
    const blockData = buildBlockGrid(qr);
    const numBlocks = uploadBlockData(device, blockData, {
      typeBuffer, posBuffer, heightBuffer, baseYBuffer,
    });
    blockMetaRef.current = { numBlocks, gridSize: blockData.gridSize };

    const treeParams = deriveTreeParams(qr);
    const skeleton = generateBranchSkeleton(treeParams, blockData.gridSize);
    branchMetaRef.current = { segmentCount: skeleton.segmentCount };

    if (branchBuffer) {
      const padded = new Float32Array(BRANCH_BUFFER_FLOATS);
      padded.set(skeleton.segments);
      device.queue.writeBuffer(branchBuffer, 0, padded);
    }

    if (flowerBuffer) {
      const canopy = generateCanopyFlowers(skeleton.tips, treeParams);
      const cubeFlowers = buildCanopyCubeFlowers(qr);
      flowerMetaRef.current = {
        flowerCount: uploadFlowerData(device, flowerBuffer, canopy, cubeFlowers),
      };
    }

    if (fallingPetalBuffer) {
      const petals = generateFallingPetals(skeleton.tips, blockData.gridSize, FALLING_PETAL_COUNT);
      petalMetaRef.current = { petalCount: petals.count };
      const padded = new Float32Array(FALLING_PETAL_COUNT * 4);
      padded.set(petals.positions);
      device.queue.writeBuffer(fallingPetalBuffer, 0, padded);
    }

    if (grassBuffer) {
      const grass = generateGrass(blockData.gridSize, qr);
      grassMetaRef.current = { grassCount: grass.count };
      const padded = new Float32Array(MAX_GRASS * 4);
      padded.set(grass.positions);
      device.queue.writeBuffer(grassBuffer, 0, padded);
    }
  }, [qrContent]);

  // --- One-time WebGPU setup ------------------------------------------------
  const init = useCallback(async () => {
    try {
      if (!canvasRef.current) return;
      const canvas = canvasRef.current;
      const context = canvas.getContext('webgpu');
      if (!context) return;

      const adapter = await navigator.gpu?.requestAdapter();
      if (!adapter) return;
      const device = await adapter.requestDevice();
      deviceRef.current = device;

      const format = navigator.gpu.getPreferredCanvasFormat();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = canvasWidth * dpr;
      canvas.height = canvasHeight * dpr;
      context.configure({ device, format, alphaMode: 'premultiplied' });

      // --- Geometry -------------------------------------------------------
      const qr = generateQRMatrix(qrContentRef.current);
      const blockData = buildBlockGrid(qr);

      const treeParams = deriveTreeParams(qr);
      const skeleton = generateBranchSkeleton(treeParams, blockData.gridSize);
      branchMetaRef.current = { segmentCount: skeleton.segmentCount };

      const canopy = generateCanopyFlowers(skeleton.tips, treeParams);
      const cubeFlowers = buildCanopyCubeFlowers(qr);

      // --- Buffers --------------------------------------------------------
      const UNIFORM = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
      const STORAGE = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;

      // Each pass that reuses `blockCount` for its own instance count needs its
      // own uniform buffer; the flower pass shares the block one.
      const blockUniforms = device.createBuffer({ size: UNIFORM_BYTES, usage: UNIFORM });
      const branchUniforms = device.createBuffer({ size: UNIFORM_BYTES, usage: UNIFORM });
      const grassUniforms = device.createBuffer({ size: UNIFORM_BYTES, usage: UNIFORM });
      const fallingUniforms = device.createBuffer({ size: UNIFORM_BYTES, usage: UNIFORM });

      const typeBuffer = device.createBuffer({ size: MAX_BLOCKS * 4, usage: STORAGE });
      const posBuffer = device.createBuffer({ size: MAX_BLOCKS * 16, usage: STORAGE });
      const heightBuffer = device.createBuffer({ size: MAX_BLOCKS * 4, usage: STORAGE });
      const baseYBuffer = device.createBuffer({ size: MAX_BLOCKS * 4, usage: STORAGE });
      const flowerBuffer = device.createBuffer({ size: MAX_FLOWERS * 16, usage: STORAGE });
      const branchBuffer = device.createBuffer({ size: BRANCH_BUFFER_FLOATS * 4, usage: STORAGE });
      const grassBuffer = device.createBuffer({ size: MAX_GRASS * 16, usage: STORAGE });
      const fallingPetalBuffer = device.createBuffer({
        size: FALLING_PETAL_COUNT * 16,
        usage: STORAGE,
      });

      typeBufferRef.current = typeBuffer;
      posBufferRef.current = posBuffer;
      heightBufferRef.current = heightBuffer;
      baseYBufferRef.current = baseYBuffer;
      flowerBufferRef.current = flowerBuffer;
      branchBufferRef.current = branchBuffer;
      grassBufferRef.current = grassBuffer;
      fallingPetalBufferRef.current = fallingPetalBuffer;

      blockMetaRef.current = {
        numBlocks: uploadBlockData(device, blockData, {
          typeBuffer, posBuffer, heightBuffer, baseYBuffer,
        }),
        gridSize: blockData.gridSize,
      };
      flowerMetaRef.current = {
        flowerCount: uploadFlowerData(device, flowerBuffer, canopy, cubeFlowers),
      };

      const branchArray = new Float32Array(BRANCH_BUFFER_FLOATS);
      branchArray.set(skeleton.segments);
      device.queue.writeBuffer(branchBuffer, 0, branchArray);

      const grass = generateGrass(blockData.gridSize, qr);
      grassMetaRef.current = { grassCount: grass.count };
      const grassArray = new Float32Array(MAX_GRASS * 4);
      grassArray.set(grass.positions);
      device.queue.writeBuffer(grassBuffer, 0, grassArray);

      const petals = generateFallingPetals(
        skeleton.tips,
        blockData.gridSize,
        FALLING_PETAL_COUNT,
      );
      petalMetaRef.current = { petalCount: petals.count };
      const petalArray = new Float32Array(FALLING_PETAL_COUNT * 4);
      petalArray.set(petals.positions);
      device.queue.writeBuffer(fallingPetalBuffer, 0, petalArray);

      // --- Bind groups -----------------------------------------------------
      const uniformEntry = {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      };
      const storageEntry = (binding) => ({
        binding,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'read-only-storage' },
      });

      const blockLayout = device.createBindGroupLayout({
        entries: [uniformEntry, storageEntry(1), storageEntry(2), storageEntry(3), storageEntry(4)],
      });
      const blockBindGroup = device.createBindGroup({
        layout: blockLayout,
        entries: [
          { binding: 0, resource: { buffer: blockUniforms } },
          { binding: 1, resource: { buffer: typeBuffer } },
          { binding: 2, resource: { buffer: posBuffer } },
          { binding: 3, resource: { buffer: heightBuffer } },
          { binding: 4, resource: { buffer: baseYBuffer } },
        ],
      });

      const uniformOnlyLayout = device.createBindGroupLayout({ entries: [uniformEntry] });
      const backdropBindGroup = device.createBindGroup({
        layout: uniformOnlyLayout,
        entries: [{ binding: 0, resource: { buffer: blockUniforms } }],
      });

      const instancedLayout = () =>
        device.createBindGroupLayout({ entries: [uniformEntry, storageEntry(1)] });

      const flowerLayout = instancedLayout();
      const flowerBindGroup = device.createBindGroup({
        layout: flowerLayout,
        entries: [
          { binding: 0, resource: { buffer: blockUniforms } },
          { binding: 1, resource: { buffer: flowerBuffer } },
        ],
      });

      const branchLayout = instancedLayout();
      const branchBindGroup = device.createBindGroup({
        layout: branchLayout,
        entries: [
          { binding: 0, resource: { buffer: branchUniforms } },
          { binding: 1, resource: { buffer: branchBuffer } },
        ],
      });

      const grassLayout = instancedLayout();
      const grassBindGroup = device.createBindGroup({
        layout: grassLayout,
        entries: [
          { binding: 0, resource: { buffer: grassUniforms } },
          { binding: 1, resource: { buffer: grassBuffer } },
        ],
      });

      const fallingLayout = instancedLayout();
      const fallingBindGroup = device.createBindGroup({
        layout: fallingLayout,
        entries: [
          { binding: 0, resource: { buffer: fallingUniforms } },
          { binding: 1, resource: { buffer: fallingPetalBuffer } },
        ],
      });

      // --- Pipelines -------------------------------------------------------
      const skyPipeline = createPipeline(device, format, uniformOnlyLayout, {
        vertex: skyVertexShader,
        fragment: skyFragmentShader,
        depthWrite: false,
        depthCompare: 'always',
      });

      const shadowPipeline = createPipeline(device, format, uniformOnlyLayout, {
        vertex: shadowVertexShader,
        fragment: shadowFragmentShader,
        depthWrite: false,
        depthCompare: 'always',
        blend: {
          color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
      });

      const blockPipeline = createPipeline(device, format, blockLayout, {
        vertex: blockVertexShader,
        fragment: blockFragmentShader,
        depthWrite: true,
        depthCompare: 'less',
      });

      // The decorative passes are non-essential - if one fails to compile the
      // scene still renders, just without that layer.
      let branchPipeline = null;
      try {
        branchPipeline = createPipeline(device, format, branchLayout, {
          vertex: branchVertexShader,
          fragment: branchFragmentShader,
          depthWrite: true,
          depthCompare: 'less',
        });
      } catch (err) {
        console.error('Branch pipeline failed (non-fatal):', err);
      }

      let grassPipeline = null;
      try {
        grassPipeline = createPipeline(device, format, grassLayout, {
          vertex: grassVertexShader,
          fragment: grassFragmentShader,
          depthWrite: true,
          depthCompare: 'less',
        });
      } catch (err) {
        console.error('Grass pipeline failed (non-fatal):', err);
      }

      const flowerPipeline = createPipeline(device, format, flowerLayout, {
        vertex: flowerVertexShader,
        fragment: flowerFragmentShader,
        depthWrite: true,
        depthCompare: 'less',
      });

      let fallingPipeline = null;
      try {
        fallingPipeline = createPipeline(device, format, fallingLayout, {
          vertex: fallingFlowerVertexShader,
          fragment: fallingFlowerFragmentShader,
          depthWrite: true,
          depthCompare: 'less',
        });
      } catch (err) {
        console.error('Falling flower pipeline failed (non-fatal):', err);
      }

      const depthTexture = device.createTexture({
        size: [canvas.width, canvas.height],
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });

      const aspectRatio = canvas.width / canvas.height;

      // --- Frame loop -------------------------------------------------------
      const frame = () => {
        const now = Date.now();
        const dt = Math.min((now - lastFrameRef.current) / 1000, 0.05);
        lastFrameRef.current = now;

        // Ease `progress` toward the current view, frame-rate independent.
        const target = isFlat.current ? 1 : 0;
        rawProgressRef.current += (target - rawProgressRef.current) * Math.min(1, 4 * dt);
        if (Math.abs(rawProgressRef.current - target) < 0.001) rawProgressRef.current = target;
        progressRef.current = easeInOutCubic(rawProgressRef.current);

        const time = (now - startTimeRef.current) / 1000;
        const progress = progressRef.current;
        const { numBlocks, gridSize } = blockMetaRef.current;
        const { segmentCount } = branchMetaRef.current;
        const { grassCount } = grassMetaRef.current;
        const { petalCount } = petalMetaRef.current;
        const { flowerCount } = flowerMetaRef.current;

        // Idle camera drift, only while in 3D.
        const bobScale = 1 - progress;
        const bobX = Math.sin(time * 0.15) * 0.003 * bobScale;
        const bobY = Math.sin(time * 0.11 + 1) * 0.002 * bobScale;
        const season = seasonRef ? seasonRef.current : 0;

        const writeUniforms = (buffer, count) => {
          device.queue.writeBuffer(
            buffer,
            0,
            new Float32Array([aspectRatio, time, count, progress, gridSize, bobX, bobY, season]),
          );
        };
        writeUniforms(blockUniforms, numBlocks);
        writeUniforms(branchUniforms, segmentCount);
        writeUniforms(grassUniforms, grassCount);
        writeUniforms(fallingUniforms, petalCount);

        const encoder = device.createCommandEncoder();
        const view = context.getCurrentTexture().createView();
        const pass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view,
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: 'clear',
              storeOp: 'store',
            },
          ],
          depthStencilAttachment: {
            view: depthTexture.createView(),
            depthClearValue: 1,
            depthLoadOp: 'clear',
            depthStoreOp: 'store',
          },
        });

        pass.setPipeline(skyPipeline);
        pass.setBindGroup(0, backdropBindGroup);
        pass.draw(3);

        pass.setPipeline(shadowPipeline);
        pass.setBindGroup(0, backdropBindGroup);
        pass.draw(6);

        pass.setPipeline(blockPipeline);
        pass.setBindGroup(0, blockBindGroup);
        pass.draw(36 * numBlocks);

        if (grassCount > 0 && grassPipeline) {
          pass.setPipeline(grassPipeline);
          pass.setBindGroup(0, grassBindGroup);
          pass.draw(3 * grassCount);
        }

        if (segmentCount > 0 && branchPipeline) {
          pass.setPipeline(branchPipeline);
          pass.setBindGroup(0, branchBindGroup);
          pass.draw(48 * segmentCount);
        }

        if (flowerCount > 0) {
          pass.setPipeline(flowerPipeline);
          pass.setBindGroup(0, flowerBindGroup);
          pass.draw(150 * flowerCount);
        }

        if (petalCount > 0 && fallingPipeline) {
          pass.setPipeline(fallingPipeline);
          pass.setBindGroup(0, fallingBindGroup);
          pass.draw(150 * petalCount);
        }

        pass.end();
        device.queue.submit([encoder.finish()]);
        animationRef.current = requestAnimationFrame(frame);
      };

      frame();
    } catch (err) {
      console.error('WebGPU init failed:', err);
    }
    // `isFlat` and `canvasRef` are refs; only the size actually forces a rebuild.
  }, [canvasWidth, canvasHeight, canvasRef, isFlat]);

  useEffect(() => {
    // Small delay so the container has been measured before we size the canvas.
    const timer = setTimeout(init, 100);
    return () => {
      clearTimeout(timer);
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [init]);
}
