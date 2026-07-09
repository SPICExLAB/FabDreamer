import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  useMemo,
} from 'react';
import { renderLayerToPng } from './LayerSection/renderLayerToPng';
import { offsetPathUniform, getShapeCharacteristicDimension, percentToPixelOffset, DEFAULT_BORDER_PERCENT, applyTransformToPath, clipPathToFrame } from '../utils/svgPathOffset';
import { extractPathElements, extractCombinedPathD } from '../utils/svgDom';
import { getSegmentSvgTransform } from '../utils/transformUtils';
import { CANVAS_SIZE } from '../constants/canvas';
import useFabricationData from '../hooks/useFabricationData';

/**
 * Compose layer SVG from per-segment SVGs with transforms
 * Uses backend-generated SVGs directly - fast and accurate
 * Also includes frame border (square or ellipse) if active
 *
 * Coordinate system:
 * - Backend SVG: 1024x1024 with paths at natural pixel positions
 * - Editing canvas: width x height (scaled from 1024)
 * - segment.scaleX/Y = editingSize / 1024 (how PNG is scaled to fit canvas)
 * - We use viewBox="0 0 1024 1024" so SVG auto-scales to canvas size
 *
 * Clipping: When a frame is present (segment frame or outer frame), all
 * non-frame segment paths are clipped to the inner boundary of the frame.
 */
/**
 * Compute the clip boundary path from layer frame data.
 * Returns null if no frame boundary exists.
 */
const getClipBoundaryPath = (layerData, width, height) => {
  const sourceSize = CANVAS_SIZE;
  let clipBoundaryPath = null;

  const frameSegment = layerData.segments?.find((seg) => seg.isFrame);
  // In Stage 3, frameUnion sets frameMerged=true (and borderPercent=0) but
  // stores the original in _originalBorderPercent — the clip window stays valid.
  const effectiveBorderPercent = frameSegment?.frameMerged
    ? (frameSegment?._originalBorderPercent || 0)
    : (frameSegment?.borderPercent || frameSegment?._originalBorderPercent || 0);
  if (frameSegment && frameSegment.svg && effectiveBorderPercent !== 0 && !layerData.frameDisabled) {
    const outerPathD = extractCombinedPathD(frameSegment.svg);
    if (outerPathD) {
      const charDimension = getShapeCharacteristicDimension(frameSegment.svg);
      const borderPercent = effectiveBorderPercent ?? DEFAULT_BORDER_PERCENT;
      const borderWidth = percentToPixelOffset(borderPercent, charDimension);
      const innerPathD = offsetPathUniform(outerPathD, borderWidth);
      if (innerPathD) {
        const frameTransform = getSegmentSvgTransform(frameSegment, width, height);
        clipBoundaryPath = frameTransform ? applyTransformToPath(innerPathD, frameTransform) : innerPathD;
      }
    }
  }

  if (!clipBoundaryPath && layerData.isFrameActive) {
    const strokeWidth = (layerData.frameStrokeWidth ?? 50) * (sourceSize / width);
    const isSquare = layerData.frameShape?.includes('square');
    if (isSquare) {
      clipBoundaryPath = `M ${strokeWidth} ${strokeWidth} L ${sourceSize - strokeWidth} ${strokeWidth} L ${sourceSize - strokeWidth} ${sourceSize - strokeWidth} L ${strokeWidth} ${sourceSize - strokeWidth} Z`;
    } else {
      const innerR = (sourceSize - 2 * strokeWidth) / 2;
      const cx = sourceSize / 2;
      const cy = sourceSize / 2;
      const segments = 64;
      let innerPath = '';
      for (let i = 0; i <= segments; i++) {
        const angle = (i / segments) * 2 * Math.PI;
        const x = cx + innerR * Math.cos(angle);
        const y = cy + innerR * Math.sin(angle);
        innerPath += i === 0 ? `M ${x.toFixed(2)} ${y.toFixed(2)}` : ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
      }
      innerPath += ' Z';
      clipBoundaryPath = innerPath;
    }
  }

  return clipBoundaryPath;
};

const composeLayerSvg = (layerData, width, height) => {
  const paths = [];
  const sourceSize = CANVAS_SIZE;

  const clipBoundaryPath = getClipBoundaryPath(layerData, width, height);

  // Second pass: Add segment paths (with clipping if frame exists)
  if (layerData.segments && layerData.segments.length > 0) {
    layerData.segments.forEach((segment) => {
      if (!segment.svg) {
        // Segments merged by frameUnion intentionally have svg=null (outline
        // lives in the synthetic frame-union segment; trace is preserved)
        if (!segment._originalSvg) {
          console.warn(`[composeLayerSvg] Segment ${segment.id} has no SVG`);
        }
        return;
      }

      // Validate SVG is a proper string starting with '<'
      if (typeof segment.svg !== 'string' || !segment.svg.startsWith('<')) {
        console.warn(`[composeLayerSvg] Segment ${segment.id} has invalid SVG: "${String(segment.svg).substring(0, 30)}"`);
        return;
      }

      // Extract ALL path elements from segment SVG (DOM-based; multi-path safe)
      const pathElements = extractPathElements(segment.svg);
      if (pathElements.length === 0) return;

      // Calculate transform using utility function
      // skipTransform: merged SVG from backend already has coords in viewBox space
      const transform = segment.skipTransform ? '' : getSegmentSvgTransform(segment, width, height);

      // Handle frame segments - create ring with uniformly offset inner path
      // Combine outer and inner in ONE path with two subpaths (both start with M, end with Z)
      // SVGLoader.createShapes will create 2 shapes from this, and CutBoard's hole detection
      // will recognize the smaller inner shape as a hole in the larger outer shape
      if (segment.isFrame) {
        // Skip rendering if merged by frameUnion.js or frameDisabled (triple union bridge fix)
        if (segment.frameMerged || segment.borderPercent === 0 || layerData.frameDisabled) {
          // Frame ring was merged — don't render it
        } else {
          const outerPathD = extractCombinedPathD(segment.svg);
          if (outerPathD) {
            // Calculate pixel offset from percentage
            const charDimension = getShapeCharacteristicDimension(segment.svg);
            const borderPercent = segment.borderPercent ?? DEFAULT_BORDER_PERCENT;
            const borderWidth = percentToPixelOffset(borderPercent, charDimension);
            const innerPathD = offsetPathUniform(outerPathD, borderWidth);
            // Combine outer+inner subpaths in a single evenodd path.
            // innerPathD may be '' when the border consumes the shape → solid fill.
            const frameD = innerPathD ? `${outerPathD} ${innerPathD}` : outerPathD;
            const framePath = `<path fill="rgb(156,163,175)" fill-rule="evenodd" d="${frameD}"/>`;
            if (transform) {
              paths.push(`<g transform="${transform}">${framePath}</g>`);
            } else {
              paths.push(framePath);
            }
          }
        }
      } else {
        // Normal segment - clip path geometry to frame boundary using Clipper.js
        // This modifies the actual path data so Three.js SVGLoader respects clipping
        pathElements.forEach((pathEl) => {
          const pathTag = pathEl.outerHTML;
          const pathD = pathEl.d;

          if (clipBoundaryPath && !segment?.skipClip) {
            // Flatten path with transform to world coords, then clip
            const flattenedPath = transform ? applyTransformToPath(pathD, transform) : pathD;
            const clippedPath = clipPathToFrame(flattenedPath, clipBoundaryPath);

            if (clippedPath === null) {
              return; // Path completely outside frame — skip
            }

            // Already in world coords after flattening, no transform wrapper needed.
            // Rebuild the tag explicitly (clipped output may contain hole subpaths → evenodd).
            const fill = pathEl.fill || 'white';
            paths.push(`<path d="${clippedPath}" fill="${fill}" stroke="none" fill-rule="evenodd"/>`);
          } else {
            if (transform) {
              paths.push(`<g transform="${transform}">${pathTag}</g>`);
            } else {
              paths.push(pathTag);
            }
          }
        });
      }
    });
  }

  // Add frame border if active (in 1024 coords, will scale with viewBox)
  // Skip if frame was merged into a segment (triple union bridge fix)
  let framePath = '';
  if (layerData.isFrameActive && !layerData.frameDisabled) {
    if (layerData.frameMergedSvgPath) {
      // Bridge-merged boundary: use pre-computed path (has gap where bridge connects)
      framePath = `<path fill="rgb(156,163,175)" fill-rule="evenodd" d="${layerData.frameMergedSvgPath}"/>`;
    } else {
      // Scale strokeWidth to 1024 coordinate space
      const strokeWidth = (layerData.frameStrokeWidth ?? 50) * (sourceSize / width);
      const isSquare = layerData.frameShape?.includes('square');

      if (isSquare) {
        // Square frame: outer rect with inner rect hole
        framePath = `<path fill="rgb(156,163,175)" fill-rule="evenodd" d="
          M 0 0 L ${sourceSize} 0 L ${sourceSize} ${sourceSize} L 0 ${sourceSize} Z
          M ${strokeWidth} ${strokeWidth} L ${strokeWidth} ${sourceSize - strokeWidth} L ${sourceSize - strokeWidth} ${sourceSize - strokeWidth} L ${sourceSize - strokeWidth} ${strokeWidth} Z
        "/>`;
      } else {
        // Ellipse frame: use polygon approximation for better SVGLoader compatibility
        // SVGLoader doesn't handle arc (A) commands well for hole detection
        const outerR = sourceSize / 2;
        const innerR = (sourceSize - 2 * strokeWidth) / 2;
        const cx = sourceSize / 2;
        const cy = sourceSize / 2;
        const segments = 64;  // Number of polygon segments for smooth circle

        // Generate outer circle points (counterclockwise)
        let outerPath = '';
        for (let i = 0; i <= segments; i++) {
          const angle = (i / segments) * 2 * Math.PI;
          const x = cx + outerR * Math.cos(angle);
          const y = cy + outerR * Math.sin(angle);
          outerPath += i === 0 ? `M ${x.toFixed(2)} ${y.toFixed(2)}` : ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
        }
        outerPath += ' Z';

        // Generate inner circle points (clockwise for hole)
        let innerPath = '';
        for (let i = segments; i >= 0; i--) {
          const angle = (i / segments) * 2 * Math.PI;
          const x = cx + innerR * Math.cos(angle);
          const y = cy + innerR * Math.sin(angle);
          innerPath += i === segments ? `M ${x.toFixed(2)} ${y.toFixed(2)}` : ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
        }
        innerPath += ' Z';

        framePath = `<path fill="rgb(156,163,175)" fill-rule="evenodd" d="${outerPath} ${innerPath}"/>`;
      }
    }
  }

  // Use viewBox="0 0 1024 1024" - SVG will auto-scale content to width x height
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${sourceSize} ${sourceSize}">
${paths.join('\n')}
${framePath}
</svg>`;
};

/**
 * Compose trace SVG from per-segment svg_trace (internal edge details)
 * These are black stroke paths representing internal details for engraving
 * Only includes traces from segments with engraveStyle === 'traced' (default)
 *
 * Clipping: When a frame is present (segment frame or outer frame), all
 * trace paths are clipped to the inner boundary of the frame.
 */
const composeLayerTraceSvg = (layerData, width, height) => {
  const paths = [];
  const sourceSize = CANVAS_SIZE;

  // Get clip boundary for SVG <clipPath> (works in browsers/SVG viewers, not Three.js SVGLoader).
  // CutBoard handles clipping separately via isPointInPolygon for 3D rendering.
  const clipBoundaryPath = getClipBoundaryPath(layerData, width, height);

  // Second pass: Add segment trace paths
  if (layerData.segments && layerData.segments.length > 0) {
    layerData.segments.forEach((segment) => {
      // Skip frame segments - they don't have internal trace details
      if (segment.isFrame) {
        return;
      }
      // Only include trace for segments with 'traced' style (default)
      const engraveStyle = segment.engraveStyle || 'traced';
      if (engraveStyle !== 'traced') {
        return;  // Segment is outline-only, no trace
      }
      if (!segment.svg_trace) {
        return;  // No trace data for this segment
      }

      // Validate svg_trace is a proper string starting with '<'
      if (typeof segment.svg_trace !== 'string' || !segment.svg_trace.startsWith('<')) {
        console.warn(`[composeLayerTraceSvg] Segment ${segment.id} has invalid svg_trace`);
        return;
      }

      // Extract path elements from segment trace SVG (DOM-based)
      const tracePathElements = extractPathElements(segment.svg_trace);
      if (tracePathElements.length === 0) return;

      // Always apply transform for traces — trace SVGs are always in the
      // segment's original 1024-coord space.  skipTransform only applies to
      // outline SVGs that were flattened by bridge fix / frame-union.
      const transform = getSegmentSvgTransform(segment, width, height);

      // Trace paths use relative commands (c, l) that clipPathToFrame can't handle.
      // Clipping is done at the line-segment level in CutBoard for 3D rendering.
      tracePathElements.forEach((pathEl) => {
        if (transform) {
          paths.push(`<g transform="${transform}">${pathEl.outerHTML}</g>`);
        } else {
          paths.push(pathEl.outerHTML);
        }
      });
    });
  }

  if (paths.length === 0) {
    return '';  // No trace data
  }

  // Wrap in SVG <clipPath> when a frame boundary exists (clips trace paths in SVG export)
  if (clipBoundaryPath) {
    const clipId = `trace-clip-${layerData.id || 'default'}`;
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${sourceSize} ${sourceSize}">
<defs><clipPath id="${clipId}"><path d="${clipBoundaryPath}"/></clipPath></defs>
<g clip-path="url(#${clipId})">
${paths.join('\n')}
</g>
</svg>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${sourceSize} ${sourceSize}">
${paths.join('\n')}
</svg>`;
};

const LayerContext = createContext();

export const useLayerManager = () => useContext(LayerContext);

export const BOARD_SIZE = { width: 304.8, height: 304.8 }; // 12in x 12in in mm

export const LayerManager = ({ children }) => {
  const [layers, setLayersState] = useState([]);
  const [layerPreviews, setLayerPreviews] = useState({});
  const [geometryUpdateQueue, setGeometryUpdateQueue] = useState([]);
  const [simpleUpdateQueue, setSimpleUpdateQueue] = useState([]);
  const [activeLayer, setActiveLayer] = useState(null);
  const visibleLayersRef = useRef([]);
  const updateTimeoutRef = useRef({});
  const editingSizeRef = useRef({ width: 0, height: 0 });
  const previewCallbacksRef = useRef({});
  const renderVersionRef = useRef({}); // Track render versions to cancel stale renders

  // UI Mode: 'editing' (Stage 2) or 'fabrication' (Stage 3)
  const [uiMode, setUiMode] = useState('editing');

  // Fabrication settings (Stage 3)
  const [fabricationScale, setFabricationScale] = useState(1.0);
  const [fabricationGap, setFabricationGap] = useState(0.3);
  const [showBoardReference, setShowBoardReference] = useState(true);
  const [visibleLayerRange, setVisibleLayerRange] = useState([0, 100]); // [min, max] layer indices

  // Fabrication data isolation (Stage 3 works on a copy)
  const {
    fabLayers,
    setFabLayers,
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
  } = useFabricationData();

  // Enter fabrication mode → snapshot current layers + recompose previews atomically
  useEffect(() => {
    if (uiMode === 'fabrication') {
      const width = editingSizeRef.current.width || 1024;
      const height = editingSizeRef.current.height || 1024;

      // Pre-compute clip boundaries from original (unprocessed) layers
      // Frame union sets borderPercent=0 on processed layers, which would make clipBoundary null
      const originalClipBoundaries = {};
      layers.forEach((layer) => {
        originalClipBoundaries[layer.id] = getClipBoundaryPath(layer, width, height);
      });

      enterFabrication(layers, layerPreviews, editingSizeRef.current, (processedLayers) => {
        // Called before setFabLayers — both state updates batched by React 18
        const updatedPreviews = {};
        processedLayers.forEach((layer) => {
          const svg = composeLayerSvg(layer, width, height);
          const svg_trace = composeLayerTraceSvg(layer, width, height);
          // Use clip boundary from original layer (before frame union modified borderPercent)
          const clipBoundary = originalClipBoundaries[layer.id];
          // PNG comes from Stage 2 (never modified in Stage 3)
          const png = layerPreviews[layer.id]?.png || null;
          updatedPreviews[layer.id] = { png, svg, svg_trace, clipBoundary };
        });
        setFabLayerPreviews(updatedPreviews);
      });
    }
    // Only trigger on mode change, not on every layer edit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiMode]);

  // Recompose fabLayerPreviews when fabLayers change mid-session (e.g., after bridge fix).
  // Skipped when enterFabrication already handled recomposition via onProcessed callback.
  useEffect(() => {
    if (!fabLayers || uiMode !== 'fabrication') return;

    // enterFabrication already set previews via onProcessed — skip this recompose
    if (skipNextRecomposeRef.current) {
      skipNextRecomposeRef.current = false;
      // Still trigger 3D geometry update
      setGeometryUpdateQueue((current) => [
        ...current,
        ...fabLayers.map((l) => l.id),
      ]);
      return;
    }

    const width = editingSizeRef.current.width || 1024;
    const height = editingSizeRef.current.height || 1024;

    const updatedPreviews = {};
    fabLayers.forEach((layer) => {
      const svg = composeLayerSvg(layer, width, height);
      const svg_trace = composeLayerTraceSvg(layer, width, height);
      // Use clip boundary from original Stage 2 layer (frame union zeroes borderPercent on fab layers)
      const originalLayer = layers.find(l => l.id === layer.id);
      const clipBoundary = originalLayer
        ? getClipBoundaryPath(originalLayer, width, height)
        : (fabLayerPreviews?.[layer.id]?.clipBoundary || null);
      // PNG comes from Stage 2 (never modified in Stage 3)
      const png = layerPreviews[layer.id]?.png || fabLayerPreviews?.[layer.id]?.png || null;
      updatedPreviews[layer.id] = {
        png,
        svg,
        svg_trace,
        clipBoundary,
      };
    });

    setFabLayerPreviews(updatedPreviews);

    // Trigger 3D geometry update for changed layers
    setGeometryUpdateQueue((current) => [
      ...current,
      ...fabLayers.map((l) => l.id),
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fabLayers]);

  // Compute frame dimensions for size indicator
  // Priority: segment frame > outer frame > canvas size
  // Includes center position in 1024 SVG coords for 3D positioning
  const frameDimensions = useMemo(() => {
    const svgSize = 1024;  // SVG viewBox is 0 0 1024 1024

    // Check all visible layers for a segment frame
    const visibleLayers = layers.filter((layer) => layer.isVisible);
    for (const layer of visibleLayers) {
      const frameSegment = layer.segments?.find((seg) => seg.isFrame);
      if (frameSegment) {
        // Segment frame found - convert from editing coords to 1024 SVG coords
        const editingWidth = editingSizeRef.current.width || svgSize;
        const editingHeight = editingSizeRef.current.height || svgSize;
        const scaleToSvg = svgSize / editingWidth;  // Conversion factor

        // Get dimensions in editing coords, then convert to 1024
        const widthEditing = (frameSegment.width || 100) * (frameSegment.scaleX || 1);
        const heightEditing = (frameSegment.height || 100) * (frameSegment.scaleY || 1);

        // Convert dimensions to 1024 coords
        const width = widthEditing * scaleToSvg;
        const height = heightEditing * scaleToSvg;

        // Calculate center in editing coords, then convert to 1024
        const centerXEditing = (frameSegment.x || 0) + widthEditing / 2;
        const centerYEditing = (frameSegment.y || 0) + heightEditing / 2;
        const centerX = centerXEditing * scaleToSvg;
        const centerY = centerYEditing * scaleToSvg;

        return { width, height, centerX, centerY, source: 'segment' };
      }
    }

    // Check if outer frame is active (default square/circle = 1024×1024, centered)
    const hasOuterFrame = visibleLayers.some((layer) => layer.isFrameActive);
    if (hasOuterFrame) {
      return { width: svgSize, height: svgSize, centerX: 512, centerY: 512, source: 'outerFrame' };
    }

    // Default: canvas size, centered
    return { width: svgSize, height: svgSize, centerX: 512, centerY: 512, source: 'canvas' };
  }, [layers]);

  const updateVisibleLayers = useCallback(() => {
    visibleLayersRef.current = layers.filter((layer) => layer.isVisible);
  }, [layers]);

  useEffect(() => {
    updateVisibleLayers();
  }, [layers, updateVisibleLayers]);

  const clearGeometryUpdateQueue = useCallback(() => {
    setGeometryUpdateQueue([]);
  }, []);

  const clearSimpleUpdateQueue = useCallback(() => {
    setSimpleUpdateQueue([]);
  }, []);

  const updateLayerPng = useCallback(
    (layerData, version) => {
      const width = editingSizeRef.current.width;
      const height = editingSizeRef.current.height;

      renderLayerToPng(layerData, width, height)
        .then((pngDataUrl) => {
          // Check if this render is still current
          if (renderVersionRef.current[layerData.id] !== version) {
            return;
          }

          // Compose SVG from per-segment SVGs
          const svgString = composeLayerSvg(layerData, width, height);

          // Compose trace SVG from per-segment svg_trace (internal edge details)
          const svgTraceString = composeLayerTraceSvg(layerData, width, height);

          // Compute clip boundary for CutBoard trace clipping
          const clipBoundary = getClipBoundaryPath(layerData, width, height);

          // Update PNG, SVG, and trace SVG together
          setLayerPreviews((prev) => {
            const updated = {
              ...prev,
              [layerData.id]: {
                ...prev[layerData.id],
                png: pngDataUrl,
                svg: svgString,
                svg_trace: svgTraceString,
                clipBoundary,
              },
            };
            if (previewCallbacksRef.current[layerData.id]) {
              previewCallbacksRef.current[layerData.id]();
              delete previewCallbacksRef.current[layerData.id];
            }
            return updated;
          });

          // Add to geometryUpdateQueue
          setGeometryUpdateQueue((current) => [...current, layerData.id]);
        })
        .catch((error) => {
          console.error('Error in renderLayerToPng:', error);
        });
    },
    []
  );

  const debouncedUpdateLayerPreview = useCallback(
    (layerData, onPreviewReady) => {
      const layerId = layerData.id;

      // Increment version for this layer to invalidate any in-flight renders
      renderVersionRef.current[layerId] = (renderVersionRef.current[layerId] || 0) + 1;
      const currentVersion = renderVersionRef.current[layerId];

      if (updateTimeoutRef.current[layerId]) {
        clearTimeout(updateTimeoutRef.current[layerId]);
      }

      if (onPreviewReady) {
        previewCallbacksRef.current[layerId] = onPreviewReady;
      }

      updateTimeoutRef.current[layerId] = setTimeout(() => {
        // Check if this is still the latest version before starting
        if (renderVersionRef.current[layerId] !== currentVersion) {
          return;
        }
        updateLayerPng(layerData, currentVersion);
      }, 500);
    },
    [updateLayerPng]
  );

 const setLayers = useCallback(
   (layersOrUpdater) => {
     setLayersState((prevLayers) => {
       const newLayers =
         typeof layersOrUpdater === 'function'
           ? layersOrUpdater(prevLayers)
           : layersOrUpdater;

       newLayers.forEach((newLayer, index) => {
         const prevLayer = prevLayers.find((layer) => layer.id === newLayer.id);
         if (prevLayer) {
           // Use smart change detection instead of JSON.stringify
           const hasGeometryChange = hasGeometryChanged(newLayer, prevLayer);

           if (hasGeometryChange) {
             if (newLayer.isVisible) {
               debouncedUpdateLayerPreview(newLayer);
             }
           } else if (newLayer.isVisible !== prevLayer.isVisible) {
             if (newLayer.isVisible) {
               // Layer has become visible, trigger an update
               debouncedUpdateLayerPreview(newLayer);
               setGeometryUpdateQueue((current) => [...current, newLayer.id]);
             }
           }
         } else {
           if (newLayer.isVisible) {
             debouncedUpdateLayerPreview(newLayer);
           }
         }
       });

       return newLayers;
     });
   },
   [debouncedUpdateLayerPreview]
 );

  const addLayer = useCallback(
    (newLayer, onPreviewReady) => {
      setLayersState((prevLayers) => [newLayer, ...prevLayers]);
      setActiveLayer(newLayer.id);
      debouncedUpdateLayerPreview(newLayer, onPreviewReady);
    },
    [debouncedUpdateLayerPreview]
  );

  const duplicateLayer = useCallback(
    (layerId) => {
      setLayersState((prevLayers) => {
        const layerToDuplicate = prevLayers.find(
          (layer) => layer.id === layerId
        );
        if (!layerToDuplicate) {
          console.warn('Layer not found for duplication:', layerId);
          return prevLayers;
        }

        const newLayer = {
          ...layerToDuplicate,
          id: `duplicate-${Date.now()}-${layerId}`,
          name: `${layerToDuplicate.name} (Copy)`,
          segments: layerToDuplicate.segments.map((segment) => ({
            ...segment,
            id: `${segment.id}-duplicate-${Date.now()}`,
          })),
        };

        const updatedLayers = [newLayer, ...prevLayers];
        debouncedUpdateLayerPreview(newLayer);
        return updatedLayers;
      });

      setActiveLayer(`duplicate-${Date.now()}-${layerId}`);
    },
    [debouncedUpdateLayerPreview]
  );

  const deleteLayer = useCallback(
    (layerId) => {
      setLayersState((prevLayers) =>
        prevLayers.filter((layer) => layer.id !== layerId)
      );
      setLayerPreviews((prev) => {
        const { [layerId]: deleted, ...rest } = prev;
        return rest;
      });
      setSimpleUpdateQueue((current) => [...current, 'delete-' + layerId]);

      if (activeLayer === layerId) {
        setLayersState((prevLayers) => {
          const newActiveLayer = prevLayers[0]?.id || null;
          setActiveLayer(newActiveLayer);
          return prevLayers;
        });
      }

      if (updateTimeoutRef.current[layerId]) {
        clearTimeout(updateTimeoutRef.current[layerId]);
        delete updateTimeoutRef.current[layerId];
      }
    },
    [activeLayer]
  );

  const reorderLayers = useCallback((reorderedLayers) => {
    setLayersState((prevLayers) => {
      const changedLayers = reorderedLayers.filter(
        (layer, index) => layer.id !== prevLayers[index]?.id
      );
      setSimpleUpdateQueue((current) => [
        ...current,
        ...changedLayers.map((layer) => 'reorder-' + layer.id),
      ]);
      return reorderedLayers;
    });
  }, []);

  const setEditingSize = useCallback((width, height) => {
    editingSizeRef.current = { width, height };
  }, []);

  /**
   * Export layer data for Stage 3 Fabrication Pipeline
   * Returns structured data ready for backend validation and export
   */
  const exportForFabrication = useCallback(() => {
    const width = editingSizeRef.current.width || 1024;
    const height = editingSizeRef.current.height || 1024;
    const sourceSize = 1024; // Backend coordinate system

    // Calculate scale factor from editing canvas to 1024 coords
    const defaultScaleX = width / sourceSize;
    const defaultScaleY = height / sourceSize;

    return {
      // Layer data with segment details
      layers: layers.map((layer, layerIndex) => ({
        id: layer.id,
        name: layer.name,
        index: layerIndex,
        isVisible: layer.isVisible,
        // Outer frame settings
        isFrameActive: layer.isFrameActive || false,
        frameShape: layer.frameShape || 'squareOutline',
        frameStrokeWidth: layer.frameStrokeWidth || 50,
        // Segments with all transform data
        segments: layer.segments.map((seg) => {
          // Convert editing position back to 1024 coords
          const position1024 = {
            x: seg.x / defaultScaleX,
            y: seg.y / defaultScaleY,
          };

          // Calculate user's scaling factor (1.0 = no scaling)
          const currentScaleX = seg.scaleX || defaultScaleX;
          const currentScaleY = seg.scaleY || defaultScaleY;
          const userScaleX = currentScaleX / defaultScaleX;
          const userScaleY = currentScaleY / defaultScaleY;

          return {
            id: seg.id,
            name: seg.name || seg.id,
            // SVG content
            svg: seg.svg || null,
            svg_trace: seg.svg_trace || null,
            // Position in 1024x1024 coordinate system
            x: position1024.x,
            y: position1024.y,
            // User scaling (1.0 = original size)
            scaleX: userScaleX,
            scaleY: userScaleY,
            // Rotation in degrees
            rotation: seg.rotation || 0,
            // Original position and size in 1024 coords (for reference)
            originalX: seg.originalX,
            originalY: seg.originalY,
            originalWidth: seg.originalWidth,
            originalHeight: seg.originalHeight,
            // Frame segment properties
            isFrame: seg.isFrame || false,
            borderPercent: seg.borderPercent || 0,
            // Engrave style: 'traced' (internal details) or 'outline' (cut only)
            engraveStyle: seg.engraveStyle || 'traced',
          };
        }),
      })),

      // Canvas dimensions
      canvasSize: {
        width: sourceSize,
        height: sourceSize,
        editingWidth: width,
        editingHeight: height,
      },

      // Fabrication settings (per-layer materials read from fabLayers)
      // canvasSizeMm: physical size of the 1024-unit SVG canvas at scale 1.0
      // Based on 3D scene ratio: layer occupies (baseScale / boardScale) of the board
      // baseScale=0.01, boardScale=TARGET_SIZE/512=15/512, board=304.8mm
      // → canvasSizeMm = 304.8 * (0.01 / (15/512)) ≈ 104.4mm
      fabrication: {
        scale: fabricationScale,
        boardSize: BOARD_SIZE,
        canvasSizeMm: BOARD_SIZE.width * (0.01 / (15 / 512)),
      },

      // Pre-composed SVGs for each layer (ready for validation)
      layerSvgs: Object.fromEntries(
        layers.map((layer) => [
          layer.id,
          {
            svg: layerPreviews[layer.id]?.svg || null,
            svg_trace: layerPreviews[layer.id]?.svg_trace || null,
            png: layerPreviews[layer.id]?.png || null,
          },
        ])
      ),

      // Metadata
      exportedAt: new Date().toISOString(),
      version: '1.0',
    };
  }, [layers, layerPreviews, fabricationScale]);

  const value = {
    layers,
    setLayers,
    layerPreviews,
    setLayerPreviews,
    geometryUpdateQueue,
    simpleUpdateQueue,
    clearGeometryUpdateQueue,
    clearSimpleUpdateQueue,
    visibleLayers: visibleLayersRef.current,
    activeLayer,
    setActiveLayer,
    addLayer,
    deleteLayer,
    setEditingSize,
    duplicateLayer,
    reorderLayers,
    // UI Mode
    uiMode,
    setUiMode,
    // Fabrication settings
    fabricationScale,
    setFabricationScale,
    fabricationGap,
    setFabricationGap,
    showBoardReference,
    setShowBoardReference,
    visibleLayerRange,
    setVisibleLayerRange,
    // Frame dimensions for size indicator
    frameDimensions,
    // Stage 3 export
    exportForFabrication,
    // Fabrication data isolation (Stage 3 copy)
    fabLayers,
    setFabLayers,
    fabLayerPreviews,
    setFabLayerPreviews,
    changedLayerIds,
    clearChangedLayerIds,
    analysisResults,
    setAnalysisResults,
    pendingFix,
    setPendingFix,
    editingSize: editingSizeRef.current,
  };

  // DEV: expose layer state for debugging/automation (not included in prod builds)
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    window.__layerManagerDebug = {
      layers, layerPreviews, fabLayers, fabLayerPreviews, uiMode,
      setLayers, setUiMode, editingSize: editingSizeRef.current,
    };
  }

  return (
    <LayerContext.Provider value={value}>{children}</LayerContext.Provider>
  );
};

/**
 * Smart change detection for geometry updates
 * Avoids expensive JSON.stringify of entire layer
 */
const hasGeometryChanged = (newLayer, prevLayer) => {
  // Quick checks first - these are cheap
  if (newLayer.segments.length !== prevLayer.segments.length) return true;
  if (newLayer.isFrameActive !== prevLayer.isFrameActive) return true;
  if (newLayer.frameDisabled !== prevLayer.frameDisabled) return true;
  if (newLayer.frameStrokeWidth !== prevLayer.frameStrokeWidth) return true;
  if (newLayer.frameShape !== prevLayer.frameShape) return true;

  // Check each segment's geometry-affecting properties
  for (let i = 0; i < newLayer.segments.length; i++) {
    const newSeg = newLayer.segments[i];
    const prevSeg = prevLayer.segments[i];

    // Segment identity check
    if (!prevSeg || newSeg.id !== prevSeg.id) return true;

    // Transform changes (these affect 3D geometry position/scale)
    if (
      newSeg.x !== prevSeg.x ||
      newSeg.y !== prevSeg.y ||
      newSeg.scaleX !== prevSeg.scaleX ||
      newSeg.scaleY !== prevSeg.scaleY ||
      newSeg.rotation !== prevSeg.rotation
    ) {
      return true;
    }

    // Frame segment changes (isFrame toggle or border percentage adjustment)
    if (newSeg.isFrame !== prevSeg.isFrame) return true;
    if (newSeg.borderPercent !== prevSeg.borderPercent) return true;

    // Engrave style change (affects svg_trace composition for 3D preview)
    if (newSeg.engraveStyle !== prevSeg.engraveStyle) return true;

    // Content change (styledSvg is the actual PNG data URL)
    // Only compare if the reference changed (quick identity check)
    if (newSeg.styledSvg !== prevSeg.styledSvg) return true;

    // Trace SVG change (internal edge details for engraving)
    if (newSeg.svg_trace !== prevSeg.svg_trace) return true;

    // Crop changes
    if (JSON.stringify(newSeg.crop) !== JSON.stringify(prevSeg.crop)) return true;
  }

  return false;
};
