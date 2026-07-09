/**
 * Utility for generating trace SVGs from extracted PNGs
 *
 * Uses web workers for non-blocking edge detection
 */

// Worker pool for parallel processing
let workerPool = [];
let nextRequestId = 0;
const pendingRequests = new Map();

/**
 * Initialize a trace worker
 */
const createWorker = () => {
  const worker = new Worker(
    new URL('../workers/traceWorker.js', import.meta.url),
    { type: 'module' }
  );

  worker.onmessage = (e) => {
    const { id, type, ...data } = e.data;

    if (type === 'ready') {
      console.log('[generateTrace] Worker ready');
      return;
    }

    const pending = pendingRequests.get(id);
    if (pending) {
      pendingRequests.delete(id);
      if (data.success) {
        pending.resolve(data);
      } else {
        pending.reject(new Error(data.error));
      }
    }
  };

  worker.onerror = (error) => {
    console.error('[generateTrace] Worker error:', error);
  };

  return worker;
};

/**
 * Get or create a worker from the pool
 */
const getWorker = () => {
  if (workerPool.length === 0) {
    // Create workers on demand (up to navigator.hardwareConcurrency)
    const maxWorkers = Math.min(navigator.hardwareConcurrency || 4, 4);
    for (let i = 0; i < maxWorkers; i++) {
      workerPool.push(createWorker());
    }
  }
  // Round-robin worker selection
  return workerPool[nextRequestId % workerPool.length];
};

/**
 * Generate trace SVG for a single segment
 *
 * @param {string} pngDataUrl - Base64 data URL of extracted PNG
 * @param {string} segmentId - Segment identifier for logging
 * @returns {Promise<{svgTrace: string, pathCount: number, duration: number}>}
 */
export const generateTraceForSegment = (pngDataUrl, segmentId) => {
  return new Promise((resolve, reject) => {
    const id = nextRequestId++;
    const worker = getWorker();

    pendingRequests.set(id, { resolve, reject });

    worker.postMessage({
      id,
      pngDataUrl,
      segmentId,
    });
  });
};

/**
 * Generate traces for multiple segments in parallel
 *
 * @param {Array<{id: string, pngDataUrl: string}>} segments - Segments to process
 * @param {Function} onProgress - Callback(segmentId, svgTrace) as each completes
 * @returns {Promise<Map<string, string>>} - Map of segmentId -> svgTrace
 */
export const generateTracesForSegments = async (segments, onProgress) => {
  const results = new Map();

  const promises = segments.map(async (segment) => {
    try {
      const result = await generateTraceForSegment(segment.pngDataUrl, segment.id);
      results.set(segment.id, result.svgTrace);

      if (onProgress) {
        onProgress(segment.id, result.svgTrace, result.pathCount);
      }
    } catch (error) {
      console.warn(`[generateTrace] Failed for segment ${segment.id}:`, error);
      results.set(segment.id, '');
    }
  });

  await Promise.all(promises);
  return results;
};

/**
 * Terminate all workers (cleanup)
 */
export const terminateTraceWorkers = () => {
  workerPool.forEach(worker => worker.terminate());
  workerPool = [];
  pendingRequests.clear();
};
