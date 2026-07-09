/**
 * Web Worker for image vectorization using imageTracer
 *
 * This worker offloads the CPU-intensive PNG → SVG conversion
 * from the main thread, preventing UI freezes.
 *
 * Uses OffscreenCanvas (supported in Web Workers) to load images.
 */

import { ImageTracer } from 'imagetracer';

// Create our own imageTracer instance with optimized settings
const tracer = new ImageTracer();

// Optimized preset for laser-cut layer vectorization
// Balance between quality and speed
const OPTIMIZED_PRESET = {
  // Core tracing settings
  ltres: 0.5,           // Line tracing resolution (lower = faster, less detail)
  qtres: 0.5,           // Quadratic tracing resolution
  pathomit: 4,          // Skip paths smaller than 4 pixels (removes tiny artifacts)
  rightangleenhance: true,

  // Color quantization - our PNGs have solid colors, don't need 64
  colorsampling: 2,     // Deterministic sampling
  numberofcolors: 24,   // Reduced from 64 - faster quantization
  mincolorratio: 0,
  colorquantcycles: 2,  // Reduced from 3 - faster

  // Output settings
  layering: 0,          // Sequential layering (faster)
  strokewidth: 1,
  linefilter: false,
  scale: 1,
  roundcoords: 1,       // Round to 1 decimal (smaller SVG)
  viewbox: false,
  desc: false,

  // No blur (we want crisp edges)
  blurradius: 0,
  blurdelta: 20,
};

/**
 * Convert base64 data URL to Blob
 */
const dataUrlToBlob = (dataUrl) => {
  const [header, base64] = dataUrl.split(',');
  const mimeMatch = header.match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/png';
  const binary = atob(base64);
  const array = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    array[i] = binary.charCodeAt(i);
  }
  return new Blob([array], { type: mime });
};

// Handle messages from main thread
self.onmessage = async (e) => {
  const { id, pngDataUrl, width, height, quality } = e.data;

  const startTime = performance.now();

  try {
    // Select preset based on quality parameter
    const options = quality === 'high'
      ? { ...OPTIMIZED_PRESET, numberofcolors: 48, pathomit: 0, roundcoords: 2 }
      : quality === 'fast'
      ? { ...OPTIMIZED_PRESET, numberofcolors: 16, pathomit: 8, ltres: 1, qtres: 1 }
      : OPTIMIZED_PRESET;

    // Convert data URL to blob directly (more efficient than fetch)
    const blob = dataUrlToBlob(pngDataUrl);
    const bitmap = await createImageBitmap(blob);

    // Create OffscreenCanvas to get ImageData
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);

    // Release bitmap memory
    bitmap.close();

    // Trace the image to SVG
    const svgString = tracer.imageDataToSVG(imageData, options);

    // Wrap SVG if needed
    const fullSvgString = svgString.startsWith('<svg')
      ? svgString
      : `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${svgString}</svg>`;

    const duration = Math.round(performance.now() - startTime);
    console.log(`[VectorWorker] Traced in ${duration}ms (${quality} quality)`);

    // Send result back
    self.postMessage({
      id,
      success: true,
      svgString: fullSvgString,
      duration,
    });

  } catch (error) {
    console.error('[VectorWorker] Error:', error);
    self.postMessage({
      id,
      success: false,
      error: error.message,
    });
  }
};

// Signal that worker is ready
self.postMessage({ type: 'ready' });
