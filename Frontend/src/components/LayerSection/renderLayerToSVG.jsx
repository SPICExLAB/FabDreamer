/**
 * PNG to SVG conversion using Web Worker
 *
 * This module offloads CPU-intensive vectorization to a Web Worker,
 * preventing UI freezes during the conversion process.
 */

// Create worker instance (singleton)
let worker = null;
let workerReady = false;
let pendingRequests = new Map();
let requestId = 0;

/**
 * Initialize the worker if not already created
 */
const getWorker = () => {
  if (!worker) {
    // Vite-compatible Web Worker import
    worker = new Worker(
      new URL('../../workers/vectorWorker.js', import.meta.url),
      { type: 'module' }
    );

    worker.onmessage = (e) => {
      const { type, id, success, svgString, error } = e.data;

      // Handle ready signal
      if (type === 'ready') {
        workerReady = true;
        console.log('[VectorWorker] Ready');
        return;
      }

      // Handle response to a request
      const pending = pendingRequests.get(id);
      if (pending) {
        pendingRequests.delete(id);
        if (success) {
          pending.resolve(svgString);
        } else {
          pending.reject(new Error(error || 'Worker error'));
        }
      }
    };

    worker.onerror = (error) => {
      console.error('[VectorWorker] Error:', error);
      // Reject all pending requests
      pendingRequests.forEach((pending) => {
        pending.reject(new Error('Worker crashed'));
      });
      pendingRequests.clear();
      // Reset worker for retry
      worker = null;
      workerReady = false;
    };
  }
  return worker;
};

/**
 * Convert PNG data URL to SVG string using Web Worker
 *
 * @param {string} pngDataUrl - PNG image as data URL
 * @param {number} width - Output SVG width
 * @param {number} height - Output SVG height
 * @param {string} quality - 'fast', 'default', or 'high'
 * @returns {Promise<string>} SVG string
 */
export const renderLayerToSVG = async (pngDataUrl, width, height, quality = 'default') => {
  return new Promise((resolve, reject) => {
    try {
      const w = getWorker();
      const id = ++requestId;

      // Store the promise handlers
      pendingRequests.set(id, { resolve, reject });

      // Set timeout for the request (30 seconds max)
      const timeout = setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new Error('Vectorization timeout'));
        }
      }, 30000);

      // Modify handlers to clear timeout
      const originalResolve = resolve;
      const originalReject = reject;
      pendingRequests.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          originalResolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          originalReject(error);
        },
      });

      // Send request to worker
      w.postMessage({
        id,
        pngDataUrl,
        width,
        height,
        quality,
      });

    } catch (error) {
      console.error('[renderLayerToSVG] Error:', error);
      reject(error);
    }
  });
};

/**
 * Terminate the worker (call on app unmount if needed)
 */
export const terminateVectorWorker = () => {
  if (worker) {
    worker.terminate();
    worker = null;
    workerReady = false;
    pendingRequests.clear();
    console.log('[VectorWorker] Terminated');
  }
};

/**
 * Check if worker is ready
 */
export const isVectorWorkerReady = () => workerReady;
