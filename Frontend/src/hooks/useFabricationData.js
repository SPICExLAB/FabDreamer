import { useState, useCallback, useRef } from 'react';
import { unionOverlappingSegments } from '../utils/frameUnion';

/**
 * Compute a lightweight fingerprint for a layer to detect changes.
 * Uses segment IDs, transforms, and content references.
 */
const fingerprint = (layer) => {
  if (!layer) return '';
  const segParts = (layer.segments || []).map((seg) =>
    `${seg.id}|${seg.x}|${seg.y}|${seg.scaleX}|${seg.scaleY}|${seg.rotation}|${seg.isFrame}|${seg.borderPercent}|${seg.engraveStyle}|${seg.svg?.length || 0}|${seg.svg_trace?.length || 0}`
  );
  return `${layer.id}:${layer.isFrameActive}:${layer.frameShape}:${layer.frameStrokeWidth}:${segParts.join(';')}`;
};

/**
 * Deep-clone a layer, producing a plain object copy that won't share references
 * with the original Stage 2 data.
 */
const deepCloneLayer = (layer) => ({
  ...layer,
  segments: layer.segments.map((seg) => ({
    ...seg,
    crop: seg.crop ? { ...seg.crop } : undefined,
  })),
});

/**
 * Hook that manages an isolated copy of layer data for Stage 3 (Fabrication).
 *
 * On first entry, deep-clones the Stage 2 layers.
 * On re-entry, compares fingerprints per layer:
 *   - Unchanged layers keep their fab copy (with any applied fixes)
 *   - Changed layers are re-cloned from Stage 2 (fixes discarded)
 */
const useFabricationData = () => {
  const [fabLayers, setFabLayers] = useState(null);
  const [fabLayerPreviews, setFabLayerPreviews] = useState(null);
  const [changedLayerIds, setChangedLayerIds] = useState([]);
  const [analysisResults, setAnalysisResults] = useState(null);
  // Pending fix awaiting user confirmation — { layerId, partId, svgUpdates: [...] }
  const [pendingFix, setPendingFix] = useState(null);
  const fingerprintsRef = useRef({}); // layerId → fingerprint string
  // Keep a ref to current fabLayers so enterFabrication can read previous
  // state synchronously without a state updater function.
  const fabLayersRef = useRef(null);
  // Flag to suppress the [fabLayers] recompose effect when enterFabrication
  // already handled recomposition via onProcessed callback.
  const skipNextRecomposeRef = useRef(false);

  /**
   * Call when entering fabrication mode.
   * @param {Array} layers - Stage 2 layers
   * @param {Object} layerPreviews - Stage 2 layer previews { layerId: { svg, svg_trace, png } }
   * @param {{ width: number, height: number }} editingSize - Current editing canvas dimensions
   * @param {Function} [onProcessed] - Callback receiving processed fab layers for immediate recompose.
   */
  const enterFabrication = useCallback((layers, layerPreviews, editingSize, onProcessed) => {
    if (!layers || layers.length === 0) return;

    // Only bring visible layers into Stage 3
    const visibleLayers = layers.filter((l) => l.isVisible);
    if (visibleLayers.length === 0) return;

    const { width = 1024, height = 1024 } = editingSize || {};

    const newFingerprints = {};
    visibleLayers.forEach((layer) => {
      newFingerprints[layer.id] = fingerprint(layer);
    });

    const prevFabLayers = fabLayersRef.current;
    let processed;

    if (!prevFabLayers) {
      // First entry: deep-clone everything → all layers are "changed"
      const cloned = visibleLayers.map(deepCloneLayer);
      processed = cloned.map((l) => {
        return unionOverlappingSegments(l, width, height);
      });
      fingerprintsRef.current = newFingerprints;
      setChangedLayerIds(visibleLayers.map((l) => l.id));
    } else {
      // Re-entry: compare fingerprints per layer
      const prevFingerprints = fingerprintsRef.current;
      const changed = [];
      processed = visibleLayers.map((srcLayer) => {
        const prevFP = prevFingerprints[srcLayer.id];
        const newFP = newFingerprints[srcLayer.id];

        if (prevFP && prevFP === newFP) {
          // Layer unchanged → keep existing fab copy (preserves fixes)
          const existing = prevFabLayers.find((l) => l.id === srcLayer.id);
          if (existing) return existing;
        }

        // Layer changed or new → fresh clone + union
        changed.push(srcLayer.id);
        const cloned = deepCloneLayer(srcLayer);
        return unionOverlappingSegments(cloned, width, height);
      });

      fingerprintsRef.current = newFingerprints;
      setChangedLayerIds(changed);

      // Clear analysis results for changed layers, keep results for unchanged
      if (changed.length > 0) {
        setAnalysisResults((prev) => {
          if (!prev) return prev;
          const changedSet = new Set(changed.map(String));
          const filtered = prev.map((lr) =>
            changedSet.has(String(lr.layerId))
              ? { ...lr, issues: [] } // Clear issues for changed layers (will re-analyze)
              : lr
          );
          return filtered;
        });
      }
    }

    // Update ref synchronously so it's immediately available
    fabLayersRef.current = processed;

    // Set state — all calls are at the top level (not inside an updater),
    // so React batches them correctly.
    if (onProcessed) {
      skipNextRecomposeRef.current = true;
      onProcessed(processed);
    }
    setFabLayers(processed);
  }, []);

  /**
   * Wrapper around setFabLayers that also updates the ref.
   */
  const setFabLayersWrapped = useCallback((layersOrUpdater) => {
    setFabLayers((prev) => {
      const next = typeof layersOrUpdater === 'function'
        ? layersOrUpdater(prev)
        : layersOrUpdater;
      fabLayersRef.current = next;
      return next;
    });
  }, []);

  /**
   * Reset fabrication data (e.g., when going back to Stage 2).
   */
  const resetFabrication = useCallback(() => {
    setFabLayers(null);
    setFabLayerPreviews(null);
    setChangedLayerIds([]);
    setAnalysisResults(null);
    setPendingFix(null);
    fingerprintsRef.current = {};
    fabLayersRef.current = null;
  }, []);

  const clearChangedLayerIds = useCallback(() => {
    setChangedLayerIds([]);
  }, []);

  return {
    fabLayers,
    setFabLayers: setFabLayersWrapped,
    fabLayerPreviews,
    setFabLayerPreviews,
    enterFabrication,
    resetFabrication,
    changedLayerIds,
    clearChangedLayerIds,
    skipNextRecomposeRef,
    analysisResults,
    setAnalysisResults,
    pendingFix,
    setPendingFix,
  };
};

export default useFabricationData;
