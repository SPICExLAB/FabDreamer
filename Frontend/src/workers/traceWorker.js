/**
 * Web Worker for generating trace SVG from extracted PNG
 *
 * Uses Potrace WASM to produce smooth Bezier curve paths for laser engraving.
 * Falls back to Sobel edge detection if WASM fails to load.
 *
 * Output: SVG with filled black paths (Bezier curves) for engrave regions
 */

import { potrace, init as potraceInit } from 'esm-potrace-wasm';

let potraceReady = false;
let potraceInitFailed = false;

/**
 * Initialize Potrace WASM (once per worker)
 */
const ensurePotrace = async () => {
  if (potraceReady) return true;
  if (potraceInitFailed) return false;
  try {
    await potraceInit();
    potraceReady = true;
    return true;
  } catch (err) {
    potraceInitFailed = true;
    console.warn('[TraceWorker] Potrace WASM init failed, using Sobel fallback:', err.message);
    return false;
  }
};

// ---------------------------------------------------------------------------
// Shared: load PNG → ImageData
// ---------------------------------------------------------------------------

const loadImageData = async (dataUrl) => {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);

  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
};

// Sobel kernels for edge detection (shared by Potrace preprocessing and fallback)
const SOBEL_X = [[-1,0,1],[-2,0,2],[-1,0,1]];
const SOBEL_Y = [[-1,-2,-1],[0,0,0],[1,2,1]];

// ---------------------------------------------------------------------------
// Potrace pipeline
// ---------------------------------------------------------------------------

/**
 * Pre-process ImageData into a binary bitmap suitable for Potrace.
 *
 * Uses Sobel edge detection (same as the original pipeline) to find internal
 * detail edges (color boundaries, shading changes), then feeds the edge map
 * to Potrace for smooth Bezier curve tracing.
 *
 * 1. Convert to grayscale, build alpha mask
 * 2. Sobel edge detection to find gradient boundaries
 * 3. Erode alpha mask by 2px to exclude outer segment boundary
 * 4. Keep only interior edges (not touching transparency)
 * 5. Return binary ImageData: edge pixels = black, rest = white
 */
/**
 * Compute Sobel edge map + eroded interior mask from grayscale/alpha arrays.
 * Returns { edges, eroded, edgeCount, opaqueCount } for density analysis.
 */
const computeEdges = (gray, alpha, width, height, sobelThreshold, erodeRadius) => {
  const totalPixels = width * height;
  const edges = new Uint8Array(totalPixels);
  let edgeCount = 0;
  let opaqueCount = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      if (alpha[idx] < 128) continue;
      opaqueCount++;

      let gx = 0, gy = 0;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const p = gray[(y + ky) * width + (x + kx)];
          gx += p * SOBEL_X[ky + 1][kx + 1];
          gy += p * SOBEL_Y[ky + 1][kx + 1];
        }
      }
      if (Math.sqrt(gx * gx + gy * gy) > sobelThreshold) {
        edges[idx] = 1;
        edgeCount++;
      }
    }
  }

  const eroded = new Uint8Array(totalPixels);
  for (let y = erodeRadius; y < height - erodeRadius; y++) {
    for (let x = erodeRadius; x < width - erodeRadius; x++) {
      let allOpaque = true;
      outer:
      for (let dy = -erodeRadius; dy <= erodeRadius; dy++) {
        for (let dx = -erodeRadius; dx <= erodeRadius; dx++) {
          if (alpha[(y + dy) * width + (x + dx)] < 128) {
            allOpaque = false;
            break outer;
          }
        }
      }
      eroded[y * width + x] = allOpaque ? 1 : 0;
    }
  }

  return { edges, eroded, edgeCount, opaqueCount };
};

/**
 * Build binary ImageData from edge + eroded mask (for Potrace input).
 */
const buildBinaryImage = (edges, eroded, width, height) => {
  const totalPixels = width * height;
  const out = new ImageData(width, height);
  const od = out.data;
  for (let i = 0; i < totalPixels; i++) {
    const idx = i * 4;
    if (edges[i] === 1 && eroded[i] === 1) {
      od[idx] = 0; od[idx + 1] = 0; od[idx + 2] = 0; od[idx + 3] = 255;
    } else {
      od[idx] = 255; od[idx + 1] = 255; od[idx + 2] = 255; od[idx + 3] = 255;
    }
  }
  return out;
};

// Edge density thresholds for adaptive behavior
const DENSITY_LOW = 0.06;   // below: simple element, keep detail
const DENSITY_HIGH = 0.15;  // above: complex element, raise threshold

const preprocessForPotrace = (imageData) => {
  const { width, height, data } = imageData;
  const totalPixels = width * height;
  const BASE_THRESHOLD = 25;
  const ERODE_RADIUS = 2;

  // Build grayscale + alpha (shared across passes)
  const gray = new Uint8Array(totalPixels);
  const alpha = new Uint8Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    const idx = i * 4;
    gray[i] = Math.round(data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114);
    alpha[i] = data[idx + 3];
  }

  // First pass: detect edges at base threshold
  let result = computeEdges(gray, alpha, width, height, BASE_THRESHOLD, ERODE_RADIUS);
  const density = result.opaqueCount > 0 ? result.edgeCount / result.opaqueCount : 0;

  // Adaptive: if edge density is high, re-run with a higher threshold
  let usedThreshold = BASE_THRESHOLD;
  if (density > DENSITY_HIGH) {
    // Scale threshold up proportionally — cap at 80
    usedThreshold = Math.min(80, Math.round(BASE_THRESHOLD * (density / DENSITY_LOW)));
    result = computeEdges(gray, alpha, width, height, usedThreshold, ERODE_RADIUS);
    console.log(`[Potrace] Adaptive: density ${(density * 100).toFixed(1)}% → threshold ${usedThreshold}`);
  }

  return { imageData: buildBinaryImage(result.edges, result.eroded, width, height), density, usedThreshold };
};

/**
 * Run Potrace on preprocessed ImageData, return SVG string
 */
const runPotrace = async (imageData, width, height) => {
  const { imageData: processed, density } = preprocessForPotrace(imageData);

  // Adaptive turdsize: suppress small blobs for complex elements
  const turdsize = density > DENSITY_HIGH ? 10 : density > DENSITY_LOW ? 5 : 2;

  const svgStr = await potrace(processed, {
    turdsize,
    alphamax: 1,
    opticurve: 1,
    opttolerance: 0.2,
    pathonly: false,
    extractcolors: false,
    posterizelevel: 1,
  });

  // pathonly=false returns a full SVG string with <path> elements
  if (typeof svgStr !== 'string' || !svgStr.includes('<path')) {
    return { svg: '', pathCount: 0 };
  }

  // Potrace SVG may wrap paths in <g transform="translate(0,H) scale(1,-1)">
  // for Y-axis flip. Since composeLayerTraceSvg extracts only <path> tags
  // (losing <g> wrappers), we must bake any group transform into each <path>
  // element's own transform attribute so it survives regex extraction.
  const gTransformMatch = svgStr.match(/<g\s[^>]*transform="([^"]*)"/);
  const groupTransform = gTransformMatch ? gTransformMatch[1] : '';

  // Extract <path> elements, restyle for engrave (stroke-only, matching Sobel format).
  // extractcolors=false means no background rectangle — just traced edge paths.
  const pathMatches = svgStr.match(/<path[^>]*>/g) || [];
  if (pathMatches.length === 0) {
    return { svg: '', pathCount: 0 };
  }

  const transformAttr = groupTransform ? ` transform="${groupTransform}"` : '';
  const pathElements = pathMatches
    .map(p => {
      const dMatch = p.match(/\bd="([^"]*)"/);
      if (!dMatch) return null;
      return `<path d="${dMatch[1]}" fill="none" stroke="black" stroke-width="1"${transformAttr}/>`;
    })
    .filter(Boolean)
    .join('\n');

  if (!pathElements) {
    return { svg: '', pathCount: 0 };
  }

  const pathCount = (pathElements.match(/<path/g) || []).length;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
${pathElements}
</svg>`;

  return { svg, pathCount };
};

// ---------------------------------------------------------------------------
// Sobel fallback (original pipeline)
// ---------------------------------------------------------------------------

const sobelEdgeDetection = (imageData, threshold = 25) => {
  const { width, height, data } = imageData;
  const totalPixels = width * height;
  const gray = new Uint8Array(totalPixels);
  const alpha = new Uint8Array(totalPixels);

  for (let i = 0; i < totalPixels; i++) {
    const idx = i * 4;
    gray[i] = Math.round(data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114);
    alpha[i] = data[idx + 3];
  }

  const result = new Uint8Array(totalPixels);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      if (alpha[idx] < 128) continue;
      let gx = 0, gy = 0;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const p = gray[(y + ky) * width + (x + kx)];
          gx += p * SOBEL_X[ky + 1][kx + 1];
          gy += p * SOBEL_Y[ky + 1][kx + 1];
        }
      }
      if (Math.sqrt(gx * gx + gy * gy) > threshold) result[idx] = 255;
    }
  }

  // Remove edges touching transparency
  const interior = new Uint8Array(totalPixels);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      if (result[idx] === 0) continue;
      let touchesTrans = false;
      for (let dy = -1; dy <= 1 && !touchesTrans; dy++)
        for (let dx = -1; dx <= 1 && !touchesTrans; dx++)
          if (alpha[(y + dy) * width + (x + dx)] < 128) touchesTrans = true;
      if (!touchesTrans) interior[idx] = 255;
    }
  }

  return { edges: interior, width, height };
};

const edgesToSvgPaths = (edges, width, height, minLength = 8) => {
  const visited = new Uint8Array(width * height);
  const paths = [];
  const dx = [1,1,0,-1,-1,-1,0,1];
  const dy = [0,1,1,1,0,-1,-1,-1];

  for (let sy = 0; sy < height; sy++) {
    for (let sx = 0; sx < width; sx++) {
      const si = sy * width + sx;
      if (edges[si] === 0 || visited[si]) continue;
      const points = [];
      let x = sx, y = sy, lastDir = 0;
      do {
        points.push({ x, y });
        visited[y * width + x] = 1;
        let found = false;
        for (let i = 0; i < 8; i++) {
          const dir = (lastDir + i + 5) % 8;
          const nx = x + dx[dir], ny = y + dy[dir];
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const ni = ny * width + nx;
            if (edges[ni] === 255 && !visited[ni]) {
              x = nx; y = ny; lastDir = dir; found = true; break;
            }
          }
        }
        if (!found) break;
      } while (points.length < 10000);
      if (points.length >= minLength) {
        const simplified = douglasPeucker(points, 1.5);
        if (simplified.length >= 2) paths.push(simplified);
      }
    }
  }
  return paths;
};

const douglasPeucker = (points, epsilon) => {
  if (points.length <= 2) return points;
  let maxDist = 0, maxIdx = 0;
  const first = points[0], last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i], first, last);
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }
  if (maxDist > epsilon) {
    const left = douglasPeucker(points.slice(0, maxIdx + 1), epsilon);
    const right = douglasPeucker(points.slice(maxIdx), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
};

const perpDist = (p, a, b) => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return Math.sqrt((p.x - a.x) ** 2 + (p.y - a.y) ** 2);
  return Math.abs((dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len);
};

const sobelFallback = (imageData) => {
  const { width, height, data } = imageData;
  const totalPixels = width * height;

  // First pass to check density
  let { edges } = sobelEdgeDetection(imageData);
  let opaqueCount = 0;
  let edgeCount = 0;
  for (let i = 0; i < totalPixels; i++) {
    if (data[i * 4 + 3] >= 128) opaqueCount++;
    if (edges[i] === 255) edgeCount++;
  }
  const density = opaqueCount > 0 ? edgeCount / opaqueCount : 0;

  // Re-run with higher threshold if too dense
  if (density > DENSITY_HIGH) {
    const newThreshold = Math.min(80, Math.round(25 * (density / DENSITY_LOW)));
    ({ edges } = sobelEdgeDetection(imageData, newThreshold));
    console.log(`[Sobel] Adaptive: density ${(density * 100).toFixed(1)}% → threshold ${newThreshold}`);
  }

  const paths = edgesToSvgPaths(edges, width, height);
  if (paths.length === 0) return { svg: '', pathCount: 0 };

  const pathStrings = paths.map(pts => {
    const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x},${p.y}`).join(' ');
    return `<path d="${d}" fill="none" stroke="black" stroke-width="1"/>`;
  });

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
${pathStrings.join('\n')}
</svg>`;

  return { svg, pathCount: paths.length };
};

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = async (e) => {
  const { id, pngDataUrl, segmentId } = e.data;
  const startTime = performance.now();

  try {
    const imageData = await loadImageData(pngDataUrl);
    const { width, height } = imageData;

    let result;
    const usePotrace = await ensurePotrace();

    if (usePotrace) {
      result = await runPotrace(imageData, width, height);
    } else {
      result = sobelFallback(imageData);
    }

    const duration = Math.round(performance.now() - startTime);

    self.postMessage({
      id,
      segmentId,
      success: true,
      svgTrace: result.svg,
      pathCount: result.pathCount,
      duration,
    });
  } catch (error) {
    console.error('[TraceWorker] Error:', error);
    self.postMessage({
      id,
      segmentId,
      success: false,
      error: error.message,
    });
  }
};

// Signal ready
self.postMessage({ type: 'ready' });
