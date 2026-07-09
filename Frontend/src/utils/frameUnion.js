/**
 * Frame Union Utility
 *
 * One-time boolean union of overlapping segments with frame rings.
 * Called when entering Stage 3 (Fabrication) to eliminate internal cut lines
 * where a segment's clipped edge meets the frame's inner edge.
 *
 * Stage 2 uses SVG <clipPath> (fast, reversible). Stage 3 computes the
 * geometric union once on a deep-cloned layer copy, so Stage 2 data is
 * never modified.
 */

import {
  getShapeCharacteristicDimension,
  offsetPathUniform,
  percentToPixelOffset,
  DEFAULT_BORDER_PERCENT,
  applyTransformToPath,
  unionPolygonPaths,
  pathsOverlap,
  clipPathToFrame,
} from './svgPathOffset';
import { extractCombinedPathD } from './svgDom';
import { getSegmentSvgTransform } from './transformUtils';
import { CANVAS_SIZE } from '../constants/canvas';

/**
 * Compute the frame ring path and inner boundary path for a layer.
 * Handles both segment frames (a segment with isFrame=true) and outer frames
 * (layer.isFrameActive with shape/strokeWidth).
 *
 * @param {Object} layer - Layer data
 * @param {number} width - Editing canvas width
 * @param {number} height - Editing canvas height
 * @returns {{ innerBoundaryPathD: string, frameRingPathD: string } | null}
 */
function computeFramePaths(layer, width, height) {
  const sourceSize = CANVAS_SIZE;

  // --- Segment frame ---
  const frameSegment = layer.segments?.find(seg => seg.isFrame);
  if (frameSegment && frameSegment.svg) {
    const outerPathD = extractCombinedPathD(frameSegment.svg);
    if (!outerPathD) return null;

    const charDim = getShapeCharacteristicDimension(frameSegment.svg);
    const borderPercent = frameSegment.borderPercent ?? DEFAULT_BORDER_PERCENT;
    const borderWidth = percentToPixelOffset(borderPercent, charDim);
    const innerPathD = offsetPathUniform(outerPathD, borderWidth);

    const frameTransform = getSegmentSvgTransform(frameSegment, width, height);
    const innerWorld = frameTransform
      ? applyTransformToPath(innerPathD, frameTransform)
      : innerPathD;
    const outerWorld = frameTransform
      ? applyTransformToPath(outerPathD, frameTransform)
      : outerPathD;

    return {
      type: 'segment',
      outerBoundaryPathD: outerWorld,
      innerBoundaryPathD: innerWorld,
      frameRingPathD: `${outerWorld} ${innerWorld}`,
    };
  }

  // --- Outer frame ---
  if (layer.isFrameActive) {
    const strokeWidth = (layer.frameStrokeWidth ?? 50) * (sourceSize / width);
    const isSquare = layer.frameShape?.includes('square');

    if (isSquare) {
      const outerPathD = `M 0 0 L ${sourceSize} 0 L ${sourceSize} ${sourceSize} L 0 ${sourceSize} Z`;
      const innerPathD = `M ${strokeWidth} ${strokeWidth} L ${sourceSize - strokeWidth} ${strokeWidth} L ${sourceSize - strokeWidth} ${sourceSize - strokeWidth} L ${strokeWidth} ${sourceSize - strokeWidth} Z`;
      return {
        type: 'outer',
        outerBoundaryPathD: outerPathD,
        innerBoundaryPathD: innerPathD,
        frameRingPathD: `${outerPathD} ${innerPathD}`,
      };
    }

    // Ellipse approximation
    const outerR = sourceSize / 2;
    const innerR = (sourceSize - 2 * strokeWidth) / 2;
    const cx = sourceSize / 2;
    const cy = sourceSize / 2;
    const segs = 64;

    const buildCirclePath = (r) => {
      let path = '';
      for (let i = 0; i <= segs; i++) {
        const angle = (i / segs) * 2 * Math.PI;
        const x = cx + r * Math.cos(angle);
        const y = cy + r * Math.sin(angle);
        path += i === 0
          ? `M ${x.toFixed(2)} ${y.toFixed(2)}`
          : ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
      }
      return path + ' Z';
    };

    const outerPath = buildCirclePath(outerR);
    const innerPath = buildCirclePath(innerR);
    return {
      type: 'outer',
      outerBoundaryPathD: outerPath,
      innerBoundaryPathD: innerPath,
      frameRingPathD: `${outerPath} ${innerPath}`,
    };
  }

  return null;
}

/**
 * Union overlapping non-frame segments on a layer.
 *
 * For each layer, flattens every non-frame segment's SVG to world coordinates,
 * detects pairwise overlap via Clipper intersection, groups overlapping segments
 * into clusters (transitive closure), and unions each cluster into a single
 * synthetic segment. Original segments' outlines are hidden (svg set to null)
 * but their svg_trace is preserved for engrave paths.
 *
 * Must run BEFORE unionOverlappingSegmentsWithFrame so that frame union sees
 * already-merged outlines instead of individual overlapping pieces.
 *
 * @param {Object} layer - Deep-cloned layer from fabLayers
 * @param {number} width - Editing canvas width
 * @param {number} height - Editing canvas height
 * @returns {Object} Modified layer (or original if no union needed)
 */
export function unionOverlappingSegments(layer, width, height) {
  if (!layer.segments || layer.segments.length === 0) return layer;

  // Unified merge: segments + frame ring in one transitive graph.
  // A chain like C→B→A→frame is detected as one connected component.
  const framePaths = computeFramePaths(layer, width, height);

  // Collect non-frame segments with valid SVG outlines.
  // Exclude frame-union-* from pairwise overlap (they contain the frame ring
  // and would merge with any bridge that extends to the frame edge).
  // Frame ring connectivity is handled separately via computeFramePaths.
  const candidates = [];
  layer.segments.forEach((seg, idx) => {
    if (seg.isFrame || !seg.svg) return;
    if (seg.id && String(seg.id).startsWith('frame-union-')) return;
    const pathD = extractCombinedPathD(seg.svg);
    if (!pathD) return;

    const transform = seg.skipTransform
      ? ''
      : getSegmentSvgTransform(seg, width, height);
    const flatPathD = transform ? applyTransformToPath(pathD, transform) : pathD;

    candidates.push({ segment: seg, index: idx, flatPathD });
  });

  // Check if an existing frame-union exists (from previous bridge)
  const existingFrameUnion = layer.segments?.find(
    s => s.id && String(s.id).startsWith('frame-union-') && s.svg
  );
  const existingFrameUnionPathD = existingFrameUnion ? extractCombinedPathD(existingFrameUnion.svg) : null;

  if (candidates.length === 0) return layer;

  // Union-find: candidates[0..N-1] are segments, index N is the frame ring (if exists)
  const FRAME_IDX = candidates.length; // virtual index for frame
  const totalNodes = candidates.length + (framePaths ? 1 : 0);
  const parent = Array.from({ length: totalNodes }, (_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const unite = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  // Check all segment pairs for overlap
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      if (pathsOverlap(candidates[i].flatPathD, candidates[j].flatPathD)) {
        unite(i, j);
      }
    }
  }

  // Check each segment against frame ring OR existing frame-union (if exists)
  if (framePaths) {
    for (let i = 0; i < candidates.length; i++) {
      // Check against frame ring — must be a REAL area intersection with the
      // ring region (outer minus window). The old vertex-outside-window test
      // also fired for segments merely NEAR the ring, welding floating pieces
      // into the frame path — which inverted the 3D render and silently
      // suppressed floating-part detection.
      if (pathsOverlap(candidates[i].flatPathD, framePaths.frameRingPathD)) {
        unite(i, FRAME_IDX);
        continue;
      }
      // Check against existing frame-union shape (handles bridges to already-connected elements)
      if (existingFrameUnionPathD && pathsOverlap(candidates[i].flatPathD, existingFrameUnionPathD)) {
        unite(i, FRAME_IDX);
      }
    }
  }

  // Group into clusters
  const clusters = {};
  candidates.forEach((c, i) => {
    const root = find(i);
    if (!clusters[root]) clusters[root] = [];
    clusters[root].push(c);
  });

  // Determine which clusters are connected to frame
  const frameRoot = framePaths ? find(FRAME_IDX) : -1;

  // Process clusters
  const mergedIndices = new Set();
  const syntheticSegments = [];
  let frameUnionCreated = false;

  Object.entries(clusters).forEach(([rootStr, cluster]) => {
    const root = parseInt(rootStr);
    const isConnectedToFrame = framePaths && find(root) === frameRoot;

    if (isConnectedToFrame) {
      // Connected to frame → union all segments with frame ring
      cluster.forEach(c => mergedIndices.add(c.index));

      const clippedPaths = [];
      cluster.forEach(c => {
        const clipped = clipPathToFrame(c.flatPathD, framePaths.outerBoundaryPathD);
        if (clipped) clippedPaths.push(clipped);
      });

      if (clippedPaths.length > 0) {
        // Use existing frame-union path (includes previous bridges) or fresh frame ring
        const basePath = existingFrameUnionPathD || framePaths.frameRingPathD;
        const mergedPathD = unionPolygonPaths(basePath, clippedPaths);
        if (mergedPathD) {
          frameUnionCreated = true;
          syntheticSegments.push({
            id: `frame-union-${layer.id}`,
            name: 'Frame Union',
            svg: `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg"><path fill="rgb(156,163,175)" fill-rule="evenodd" d="${mergedPathD}"/></svg>`,
            svg_trace: null,
            skipTransform: true,
            skipClip: true,
            isFrame: false,
            engraveStyle: 'outline',
            x: 0,
            y: 0,
            scaleX: width / CANVAS_SIZE,
            scaleY: height / CANVAS_SIZE,
            rotation: 0,
          });
          console.log(`[unionMerge] Layer ${layer.id}: ${cluster.length} segment(s) merged with frame`);
        }
      }
    } else if (cluster.length >= 2) {
      // Not connected to frame, but 2+ segments overlap each other → segment union
      cluster.forEach(c => mergedIndices.add(c.index));

      const firstPath = cluster[0].flatPathD;
      const restPaths = cluster.slice(1).map(c => c.flatPathD);
      const mergedPathD = unionPolygonPaths(firstPath, restPaths);

      if (mergedPathD) {
        syntheticSegments.push({
          id: `segment-union-${layer.id}-${root}`,
          name: `Merged (${cluster.map(c => c.segment.name || c.segment.id).join(' + ')})`,
          svg: `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg"><path fill="rgb(156,163,175)" d="${mergedPathD}"/></svg>`,
          svg_trace: null,
          skipTransform: true,
          skipClip: true,
          isFrame: false,
          engraveStyle: 'outline',
          x: 0,
          y: 0,
          scaleX: width / CANVAS_SIZE,
          scaleY: height / CANVAS_SIZE,
          rotation: 0,
        });
        console.log(`[unionMerge] Layer ${layer.id}: ${cluster.length} segments merged (floating union)`);
      } else {
        cluster.forEach(c => mergedIndices.delete(c.index));
      }
    }
    // Single segments not connected to frame → left unchanged
  });

  if (mergedIndices.size === 0 && !frameUnionCreated) return layer;

  // Build modified segments array
  const modifiedLayer = { ...layer };
  modifiedLayer.segments = [
    ...syntheticSegments,
    ...layer.segments.map((seg, idx) => {
      if (mergedIndices.has(idx)) {
        return { ...seg, svg: null, _originalSvg: seg._originalSvg || seg.svg };
      }
      // Remove old frame-union when a new one is created (replaced by syntheticSegments)
      if (frameUnionCreated && seg.id && String(seg.id).startsWith('frame-union-')) {
        return null;
      }
      if (seg.isFrame && frameUnionCreated && framePaths?.type === 'segment') {
        return { ...seg, frameMerged: true, borderPercent: 0, _originalBorderPercent: seg.borderPercent };
      }
      return seg;
    }).filter(Boolean),
  ];

  if (frameUnionCreated && framePaths?.type === 'outer') {
    modifiedLayer.frameDisabled = true;
  }

  return modifiedLayer;
}

/**
 * Perform one-time boolean union of overlapping segments with the frame ring.
 *
 * For each layer that has a frame (segment frame or outer frame):
 * 1. Flatten each non-frame segment's transform into world coords
 * 2. Check if any vertex falls outside the frame's inner boundary
 * 3. Union all overlapping segment paths with the frame ring via Clipper.js
 * 4. Store the merged outline as a new synthetic segment
 * 5. Hide original overlapping segments' outlines (traces preserved)
 * 6. Disable the frame ring rendering (it's now part of the merged outline)
 *
 * @param {Object} layer - Deep-cloned layer from fabLayers
 * @param {number} width - Editing canvas width
 * @param {number} height - Editing canvas height
 * @returns {Object} Modified layer (or original if no union needed)
 */
export function unionOverlappingSegmentsWithFrame(layer, width, height) {
  if (!layer.segments || layer.segments.length === 0) return layer;

  const framePaths = computeFramePaths(layer, width, height);
  if (!framePaths) return layer;

  const { type, outerBoundaryPathD, innerBoundaryPathD, frameRingPathD } = framePaths;

  // Check each non-frame segment for overlap with frame ring
  const overlapping = [];

  layer.segments.forEach(seg => {
    if (seg.isFrame || !seg.svg) return;

    const pathD = extractCombinedPathD(seg.svg);
    if (!pathD) return;

    const transform = seg.skipTransform
      ? ''
      : getSegmentSvgTransform(seg, width, height);
    const flatPathD = transform
      ? applyTransformToPath(pathD, transform)
      : pathD;

    if (pathsOverlap(flatPathD, frameRingPathD)) {
      overlapping.push({ segment: seg, flatPathD });
    }
  });

  if (overlapping.length === 0) return layer;

  // Clip overlapping segments to outer boundary before unioning with frame ring.
  // This removes parts that extend beyond the frame entirely, while keeping the
  // parts inside the ring area (which need to be unioned to eliminate internal cuts).
  const clippedOverlapping = [];
  overlapping.forEach(o => {
    const clipped = clipPathToFrame(o.flatPathD, outerBoundaryPathD);
    if (clipped) {
      clippedOverlapping.push(clipped);
    }
  });

  if (clippedOverlapping.length === 0) {
    return layer;
  }

  // Union: frame ring + all clipped overlapping segment paths
  const mergedPathD = unionPolygonPaths(
    frameRingPathD,
    clippedOverlapping
  );

  if (!mergedPathD) {
    console.warn('[frameUnion] Clipper union returned empty result, skipping');
    return layer;
  }

  // Build modified layer
  const modifiedLayer = { ...layer };
  const sourceSize = CANVAS_SIZE;

  // Synthetic segment carrying the merged outline
  const mergedSegment = {
    id: `frame-union-${layer.id}`,
    name: 'Frame Union',
    svg: `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg"><path fill="rgb(156,163,175)" fill-rule="evenodd" d="${mergedPathD}"/></svg>`,
    svg_trace: null,
    skipTransform: true,
    skipClip: true,
    isFrame: false,
    engraveStyle: 'outline',
    x: 0,
    y: 0,
    scaleX: width / sourceSize,
    scaleY: height / sourceSize,
    rotation: 0,
  };

  modifiedLayer.segments = [
    mergedSegment,
    ...layer.segments.map(seg => {
      // Hide overlapping segments' outlines (traces + transforms preserved)
      if (overlapping.some(o => o.segment === seg)) {
        return { ...seg, svg: null, _originalSvg: seg.svg };
      }
      // For segment frames: set borderPercent=0 so ring renders empty
      // (inner=outer with evenodd → cancels out). Clip boundary stays valid.
      if (seg.isFrame && type === 'segment') {
        return { ...seg, frameMerged: true, borderPercent: 0, _originalBorderPercent: seg.borderPercent };
      }
      return seg;
    }),
  ];

  // For outer frames: disable frame rendering (merged into segments)
  if (type === 'outer') {
    modifiedLayer.frameDisabled = true;
  }

  console.log(
    `[frameUnion] Layer ${layer.id}: unioned ${overlapping.length} segment(s) with ${type} frame`
  );

  return modifiedLayer;
}
