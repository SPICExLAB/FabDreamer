/**
 * SVG Path Offset Utility
 *
 * Creates inward offset paths for frame/ring effects with UNIFORM border thickness.
 * Uses Clipper library for robust polygon offsetting that handles self-intersections.
 */

import ClipperLib from 'clipper-lib';

// Clipper uses integer coordinates for precision - scale factor for conversion
const CLIPPER_SCALE = 1000;

/**
 * Parse SVG path d attribute into array of points
 * Handles M, L, Z commands (simple polygon paths from our backend)
 *
 * @param {string} pathD - SVG path d attribute
 * @returns {Array<{x: number, y: number}>} Array of points
 */
export function parsePathToPoints(pathD) {
  if (!pathD) return [];

  const points = [];
  // Match commands: M/m, L/l, Z/z and their coordinates
  const commands = pathD.match(/[MLZmlz][^MLZmlz]*/g) || [];

  let currentX = 0;
  let currentY = 0;

  for (const cmd of commands) {
    const type = cmd[0];
    const coords = cmd.slice(1).trim().split(/[\s,]+/).map(parseFloat).filter(n => !isNaN(n));

    switch (type) {
      case 'M': // Absolute moveto
        if (coords.length >= 2) {
          currentX = coords[0];
          currentY = coords[1];
          points.push({ x: currentX, y: currentY });
        }
        break;
      case 'm': // Relative moveto
        if (coords.length >= 2) {
          currentX += coords[0];
          currentY += coords[1];
          points.push({ x: currentX, y: currentY });
        }
        break;
      case 'L': // Absolute lineto
        for (let i = 0; i < coords.length; i += 2) {
          if (i + 1 < coords.length) {
            currentX = coords[i];
            currentY = coords[i + 1];
            points.push({ x: currentX, y: currentY });
          }
        }
        break;
      case 'l': // Relative lineto
        for (let i = 0; i < coords.length; i += 2) {
          if (i + 1 < coords.length) {
            currentX += coords[i];
            currentY += coords[i + 1];
            points.push({ x: currentX, y: currentY });
          }
        }
        break;
      case 'Z':
      case 'z':
        // Close path - no action needed for points array
        break;
    }
  }

  return points;
}

/**
 * Calculate bounding box of points
 *
 * @param {Array<{x: number, y: number}>} points
 * @returns {{minX: number, minY: number, maxX: number, maxY: number, width: number, height: number}}
 */
export function calculateBoundingBox(points) {
  if (points.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  }

  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;

  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }

  return {
    minX, minY, maxX, maxY,
    width: maxX - minX,
    height: maxY - minY
  };
}

/**
 * Convert points to Clipper integer path format
 * @param {Array<{x: number, y: number}>} points
 * @returns {Array<{X: number, Y: number}>} Clipper path
 */
function pointsToClipperPath(points) {
  return points.map(p => ({
    X: Math.round(p.x * CLIPPER_SCALE),
    Y: Math.round(p.y * CLIPPER_SCALE)
  }));
}

/**
 * Convert Clipper path back to points
 * @param {Array<{X: number, Y: number}>} clipperPath
 * @returns {Array<{x: number, y: number}>} Points
 */
function clipperPathToPoints(clipperPath) {
  return clipperPath.map(p => ({
    x: p.X / CLIPPER_SCALE,
    y: p.Y / CLIPPER_SCALE
  }));
}

/**
 * Offset polygon inward using Clipper library
 * Handles self-intersecting results automatically by clipping to valid geometry
 *
 * @param {Array<{x: number, y: number}>} points - Original polygon points
 * @param {number} offset - Inward offset distance in pixels (positive = shrink)
 * @returns {Array<{x: number, y: number}>} Offset polygon points
 */
export function offsetPolygon(points, offset) {
  const rings = offsetPolygonAll([points], offset);
  if (rings.length === 0) return points; // legacy behavior for preview callers

  // Return the largest ring (legacy single-ring contract)
  let largest = rings[0];
  let largestArea = Math.abs(ClipperLib.Clipper.Area(pointsToClipperPath(largest)));
  for (let i = 1; i < rings.length; i++) {
    const area = Math.abs(ClipperLib.Clipper.Area(pointsToClipperPath(rings[i])));
    if (area > largestArea) {
      largestArea = area;
      largest = rings[i];
    }
  }
  return largest;
}

/**
 * Offset a polygon (possibly multiple rings: outer(s) + holes) inward,
 * keeping ALL resulting pieces above a relative area threshold.
 *
 * Fixes the "largest piece only" bug: when an inward offset splits a concave
 * shape into several lobes, every lobe is kept — dropping them silently
 * removed cut lines from frames on thin/concave shapes.
 *
 * @param {Array<Array<{x: number, y: number}>>} rings - Point rings (outer + holes)
 * @param {number} offset - Inward offset distance in pixels (positive = shrink)
 * @param {number} minAreaRatio - Drop result rings below this fraction of the
 *   largest input ring's area (filters offset slivers). Default 2%.
 * @returns {Array<Array<{x: number, y: number}>>} Result rings; EMPTY array when
 *   the offset consumes the shape entirely (callers must handle "no inner boundary")
 */
export function offsetPolygonAll(rings, offset, minAreaRatio = 0.02) {
  const validRings = (rings || []).filter((pts) => pts && pts.length >= 3);
  if (validRings.length === 0) return [];
  if (offset <= 0) return validRings;

  const co = new ClipperLib.ClipperOffset();
  let refArea = 0;
  for (const pts of validRings) {
    const clipperPath = pointsToClipperPath(pts);
    refArea = Math.max(refArea, Math.abs(ClipperLib.Clipper.Area(clipperPath)));
    co.AddPath(clipperPath, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
  }

  const solution = [];
  co.Execute(solution, -offset * CLIPPER_SCALE);

  const minArea = refArea * minAreaRatio;
  return solution
    .filter((p) => Math.abs(ClipperLib.Clipper.Area(p)) >= minArea)
    .map(clipperPathToPoints);
}

/**
 * Scale points toward bounding box center by a percentage
 * (Legacy function - kept for compatibility but offsetPolygon is preferred)
 *
 * @param {Array<{x: number, y: number}>} points - Original polygon points
 * @param {number} scale - Scale factor (0.8 = 80% of original = 20% border)
 * @returns {Array<{x: number, y: number}>} Scaled polygon points
 */
export function scalePointsToCenter(points, scale) {
  if (points.length < 3 || scale >= 1 || scale <= 0) return points;

  // Use bounding box center for more uniform visual results
  const bbox = calculateBoundingBox(points);
  const centerX = (bbox.minX + bbox.maxX) / 2;
  const centerY = (bbox.minY + bbox.maxY) / 2;

  return points.map(p => ({
    x: centerX + (p.x - centerX) * scale,
    y: centerY + (p.y - centerY) * scale
  }));
}

/**
 * Convert points array back to SVG path d attribute
 *
 * @param {Array<{x: number, y: number}>} points
 * @returns {string} SVG path d attribute
 */
export function pointsToPath(points) {
  if (points.length === 0) return '';

  const parts = points.map((p, i) => {
    const cmd = i === 0 ? 'M' : 'L';
    return `${cmd} ${p.x.toFixed(2)},${p.y.toFixed(2)}`;
  });

  parts.push('Z');
  return parts.join(' ');
}

/**
 * Split a multi-subpath d attribute into individual subpath strings.
 * Each subpath starts with M and ends at the next M or end of string.
 *
 * @param {string} pathD - SVG path d attribute (may contain multiple M...Z subpaths)
 * @returns {string[]} Array of individual subpath d strings
 */
export function splitSubpaths(pathD) {
  if (!pathD) return [];
  const commands = pathD.match(/[MLZmlz][^MLZmlz]*/g) || [];
  const subpaths = [];
  let current = [];

  for (const cmd of commands) {
    const type = cmd[0];
    if ((type === 'M' || type === 'm') && current.length > 0) {
      subpaths.push(current.join(''));
      current = [cmd];
    } else {
      current.push(cmd);
    }
  }
  if (current.length > 0) {
    subpaths.push(current.join(''));
  }
  return subpaths;
}

/**
 * Create inward offset of an SVG path with UNIFORM border thickness
 * Uses Clipper library for robust handling of self-intersections
 *
 * @param {string} pathD - SVG path d attribute ("M x,y L...")
 * @param {number} offset - Inward offset distance in pixels
 * @returns {string} Offset path d attribute
 */
export function offsetPathUniform(pathD, offset) {
  // Offset each ring together so holes offset correctly (multi-subpath aware)
  const rings = splitSubpaths(pathD)
    .map(parsePathToPoints)
    .filter((pts) => pts.length >= 3);
  if (rings.length === 0) return pathD;

  const offsetRings = offsetPolygonAll(rings, offset);
  if (offsetRings.length === 0) {
    // Offset consumed the shape — no inner boundary exists.
    // Return '' so callers render a solid shape instead of a zero-width ring.
    return '';
  }
  return offsetRings.map(pointsToPath).join(' ');
}

/**
 * Scale an SVG path toward its center by a percentage
 * (Legacy - use offsetPathUniform for uniform borders)
 *
 * @param {string} pathD - SVG path d attribute ("M x,y L...")
 * @param {number} scale - Scale factor (0.8 = inner shape is 80% of outer)
 * @returns {string} Scaled path d attribute
 */
export function scalePathToCenter(pathD, scale) {
  const points = parsePathToPoints(pathD);
  if (points.length < 3) return pathD;

  const scaledPts = scalePointsToCenter(points, scale);
  return pointsToPath(scaledPts);
}

/**
 * Legacy: Create inward offset using scale factor
 *
 * @param {string} pathD - SVG path d attribute ("M x,y L...")
 * @param {number} offset - Inset amount in pixels (converted to scale)
 * @returns {string} Offset path d attribute
 */
export function offsetPath(pathD, offset) {
  // Use the new uniform offset algorithm
  return offsetPathUniform(pathD, offset);
}

/**
 * Check if a path is closed (ends with Z) or open (a polyline/stroke)
 * @param {string} pathD - SVG path d attribute
 * @returns {boolean} True if closed, false if open
 */
function isClosedPath(pathD) {
  if (!pathD) return false;
  const trimmed = pathD.trim().toUpperCase();
  return trimmed.endsWith('Z');
}

/**
 * Convert points to SVG path without closing Z (for open polylines)
 * @param {Array<{x: number, y: number}>} points
 * @returns {string} SVG path d attribute (open, no Z)
 */
function pointsToOpenPath(points) {
  if (points.length === 0) return '';

  const parts = points.map((p, i) => {
    const cmd = i === 0 ? 'M' : 'L';
    return `${cmd} ${p.x.toFixed(2)},${p.y.toFixed(2)}`;
  });

  return parts.join(' ');
}

/**
 * Clip an open polyline (stroke path) to a clip boundary
 * Uses Clipper's open path clipping
 *
 * @param {string} subjectPathD - SVG path d attribute of the open polyline
 * @param {string} clipPathD - SVG path d attribute of the clipping boundary (closed)
 * @returns {string|null} Clipped path(s) d attribute, or null if completely outside
 */
function clipOpenPathToFrame(subjectPathD, clipPathD) {
  const subjectPoints = parsePathToPoints(subjectPathD);
  const clipRings = clipPathToRings(clipPathD);

  if (subjectPoints.length < 2 || clipRings.length === 0) {
    return subjectPathD;
  }

  // Convert to Clipper format
  const subjectPath = pointsToClipperPath(subjectPoints);

  // Create Clipper instance
  const clipper = new ClipperLib.Clipper();

  // Add subject as OPEN path (false), clip rings as closed (true)
  clipper.AddPath(subjectPath, ClipperLib.PolyType.ptSubject, false);
  clipRings.forEach((ring) => {
    clipper.AddPath(ring, ClipperLib.PolyType.ptClip, true);
  });

  // For open paths, we need to use PolyTree to get the results
  const solutionPolyTree = new ClipperLib.PolyTree();
  clipper.Execute(
    ClipperLib.ClipType.ctIntersection,
    solutionPolyTree,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftEvenOdd  // clip may be a ring with holes / multiple pieces
  );

  // Extract open paths from PolyTree
  const openPaths = ClipperLib.Clipper.OpenPathsFromPolyTree(solutionPolyTree);

  if (openPaths.length === 0) {
    return null;
  }

  // Convert results back to SVG paths (open, no Z)
  const allPaths = openPaths.map(poly => {
    const points = clipperPathToPoints(poly);
    return pointsToOpenPath(points);
  });

  return allPaths.join(' ');
}

/**
 * Parse a (possibly multi-subpath) clip boundary d string into Clipper rings.
 * Fixes the bug where a multi-piece / holed clip boundary was flattened into
 * one self-crossing polygon.
 */
function clipPathToRings(clipPathD) {
  return splitSubpaths(clipPathD)
    .map(parsePathToPoints)
    .filter((pts) => pts.length >= 3)
    .map(pointsToClipperPath);
}

/**
 * Clip a closed polygon to a clip boundary
 * @param {string} subjectPathD - SVG path d attribute of the closed polygon
 * @param {string} clipPathD - SVG path d attribute of the clipping boundary
 * @returns {string|null} Clipped path d attribute, or null if completely outside
 */
function clipClosedPathToFrame(subjectPathD, clipPathD) {
  const clipRings = clipPathToRings(clipPathD);
  if (clipRings.length === 0) return subjectPathD;

  // Add all subject subpaths with EvenOdd fill so inner subpaths act as holes;
  // a single subpath behaves identically under EvenOdd.
  const clipper = new ClipperLib.Clipper();
  let subjectRings = 0;
  for (const sp of splitSubpaths(subjectPathD)) {
    const pts = parsePathToPoints(sp);
    if (pts.length >= 3) {
      clipper.AddPath(pointsToClipperPath(pts), ClipperLib.PolyType.ptSubject, true);
      subjectRings++;
    }
  }
  if (subjectRings === 0) return subjectPathD;

  clipRings.forEach((ring) => {
    clipper.AddPath(ring, ClipperLib.PolyType.ptClip, true);
  });

  const solution = [];
  clipper.Execute(
    ClipperLib.ClipType.ctIntersection,
    solution,
    ClipperLib.PolyFillType.pftEvenOdd,  // EvenOdd preserves holes
    ClipperLib.PolyFillType.pftEvenOdd   // clip may be a ring with holes / multiple pieces
  );

  if (solution.length === 0) return null;

  const allPaths = solution.map(poly => {
    const points = clipperPathToPoints(poly);
    return pointsToPath(points);
  });

  return allPaths.join(' ');
}

/**
 * Clip a subject path to a clip boundary using Clipper intersection
 * Automatically handles both closed polygons (fill) and open polylines (stroke)
 *
 * @param {string} subjectPathD - SVG path d attribute of the shape to clip
 * @param {string} clipPathD - SVG path d attribute of the clipping boundary
 * @returns {string|null} Clipped path d attribute, or null if completely outside
 */
export function clipPathToFrame(subjectPathD, clipPathD) {
  if (!subjectPathD || !clipPathD) return subjectPathD;

  // Detect if subject is closed (polygon) or open (polyline/stroke)
  const isClosed = isClosedPath(subjectPathD);

  if (isClosed) {
    return clipClosedPathToFrame(subjectPathD, clipPathD);
  } else {
    return clipOpenPathToFrame(subjectPathD, clipPathD);
  }
}

/**
 * Clip multiple SVG paths to a frame boundary
 * Useful for clipping all segment paths in a layer to the frame
 *
 * @param {Array<string>} pathDs - Array of SVG path d attributes to clip
 * @param {string} clipPathD - SVG path d attribute of the clipping boundary
 * @returns {Array<string>} Array of clipped paths (nulls removed)
 */
export function clipPathsToFrame(pathDs, clipPathD) {
  if (!clipPathD || pathDs.length === 0) return pathDs;

  return pathDs
    .map(pathD => clipPathToFrame(pathD, clipPathD))
    .filter(pathD => pathD !== null);
}

/**
 * Apply SVG transform to path points (flattening the transform)
 * Supports: translate, scale, rotate
 *
 * @param {Array<{x: number, y: number}>} points - Original points
 * @param {string} transformStr - SVG transform string
 * @returns {Array<{x: number, y: number}>} Transformed points
 */
export function applyTransformToPoints(points, transformStr) {
  if (!transformStr || points.length === 0) return points;

  // Parse transform string - handle multiple transforms
  // Format: "translate(x, y) scale(sx, sy) rotate(angle, cx, cy)"
  let result = [...points.map(p => ({ x: p.x, y: p.y }))];

  // Split into individual transforms (applied right-to-left in SVG, so reverse)
  const transforms = transformStr.match(/\w+\([^)]+\)/g) || [];

  // Apply transforms in reverse order (SVG applies right-to-left)
  for (let i = transforms.length - 1; i >= 0; i--) {
    const t = transforms[i];

    if (t.startsWith('translate')) {
      const match = t.match(/translate\(\s*([^,\s]+)[\s,]+([^)]+)\)/);
      if (match) {
        const tx = parseFloat(match[1]);
        const ty = parseFloat(match[2]);
        result = result.map(p => ({ x: p.x + tx, y: p.y + ty }));
      }
    } else if (t.startsWith('scale')) {
      const match = t.match(/scale\(\s*([^,\s]+)(?:[\s,]+([^)]+))?\)/);
      if (match) {
        const sx = parseFloat(match[1]);
        const sy = match[2] ? parseFloat(match[2]) : sx;
        result = result.map(p => ({ x: p.x * sx, y: p.y * sy }));
      }
    } else if (t.startsWith('rotate')) {
      const match = t.match(/rotate\(\s*([^,\s]+)(?:[\s,]+([^,\s]+)[\s,]+([^)]+))?\)/);
      if (match) {
        const angle = parseFloat(match[1]) * Math.PI / 180;
        const cx = match[2] ? parseFloat(match[2]) : 0;
        const cy = match[3] ? parseFloat(match[3]) : 0;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        result = result.map(p => {
          const dx = p.x - cx;
          const dy = p.y - cy;
          return {
            x: cx + dx * cos - dy * sin,
            y: cy + dx * sin + dy * cos
          };
        });
      }
    }
  }

  return result;
}

/**
 * Apply SVG transform to a path and return flattened path
 *
 * @param {string} pathD - SVG path d attribute
 * @param {string} transformStr - SVG transform string
 * @returns {string} Transformed path d attribute
 */
export function applyTransformToPath(pathD, transformStr) {
  if (!transformStr) return pathD;

  // Handle multi-subpath paths (e.g. outer + holes with fill-rule="evenodd")
  // Transform each subpath independently to preserve M...Z structure
  const subpaths = splitSubpaths(pathD);
  if (subpaths.length <= 1) {
    // Single subpath — original behavior
    const points = parsePathToPoints(pathD);
    if (points.length < 3) return pathD;
    const transformedPoints = applyTransformToPoints(points, transformStr);
    return pointsToPath(transformedPoints);
  }

  // Multiple subpaths — transform each separately and rejoin
  const transformedParts = subpaths.map(sp => {
    const points = parsePathToPoints(sp);
    if (points.length < 3) return sp;
    const transformed = applyTransformToPoints(points, transformStr);
    return pointsToPath(transformed);
  });

  return transformedParts.join(' ');
}

/**
 * Clip a path to a frame boundary, handling transforms
 * Flattens both paths to same coordinate space, clips, returns result
 *
 * @param {string} subjectPathD - Path to clip
 * @param {string} subjectTransform - Transform for subject path
 * @param {string} clipPathD - Frame boundary path
 * @param {string} clipTransform - Transform for clip path (optional)
 * @returns {{pathD: string, clipped: boolean}} Clipped path and whether clipping occurred
 */
export function clipPathWithTransform(subjectPathD, subjectTransform, clipPathD, clipTransform = '') {
  // Flatten both paths to same coordinate space
  const flatSubject = applyTransformToPath(subjectPathD, subjectTransform);
  const flatClip = clipTransform ? applyTransformToPath(clipPathD, clipTransform) : clipPathD;

  // Clip
  const clippedPath = clipPathToFrame(flatSubject, flatClip);

  if (clippedPath === null) {
    return { pathD: null, clipped: true };
  }

  // Check if clipping actually changed the path (simple length comparison)
  const wasClipped = clippedPath.length !== flatSubject.length;

  return { pathD: clippedPath, clipped: wasClipped };
}

/**
 * Extract path d attribute from SVG string
 *
 * @param {string} svgString - Full SVG string
 * @returns {string|null} Path d attribute or null
 */
export function extractPathD(svgString) {
  if (!svgString) return null;

  const match = svgString.match(/<path[^>]*d="([^"]*)"[^>]*>/);
  return match ? match[1] : null;
}

/**
 * Create a frame SVG from segment SVG with UNIFORM border thickness
 *
 * @param {string} svgString - Original segment SVG
 * @param {number} borderWidth - Border width in pixels
 * @returns {string} Frame SVG with outer and inner paths (ring shape)
 */
export function createFrameSvg(svgString, borderWidth) {
  if (!svgString || borderWidth <= 0) return svgString;

  const pathD = extractPathD(svgString);
  if (!pathD) return svgString;

  const innerPathD = offsetPathUniform(pathD, borderWidth);

  // Extract SVG wrapper attributes
  const svgMatch = svgString.match(/<svg([^>]*)>/);
  const svgAttrs = svgMatch ? svgMatch[1] : '';

  // Create frame SVG with both paths using evenodd fill rule
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg${svgAttrs}>
  <path fill="rgb(156,163,175)" fill-rule="evenodd" d="${pathD} ${innerPathD}"/>
</svg>`;
}

/**
 * Get the characteristic dimension of a shape (minimum of width/height)
 * Used to calculate pixel offset from percentage
 *
 * @param {string} svgString - Segment SVG
 * @returns {number} Characteristic dimension in pixels
 */
export function getShapeCharacteristicDimension(svgString) {
  const pathD = extractPathD(svgString);
  if (!pathD) return 200;

  const points = parsePathToPoints(pathD);
  const bbox = calculateBoundingBox(points);

  return Math.min(bbox.width, bbox.height);
}

/**
 * Calculate pixel offset from percentage
 * @param {number} percent - Border percentage (0-50)
 * @param {number} charDimension - Characteristic dimension of shape
 * @returns {number} Pixel offset
 */
export function percentToPixelOffset(percent, charDimension) {
  // percent% of the characteristic dimension gives the border width
  // e.g., 10% of 200px = 20px border
  return (percent / 100) * charDimension;
}

/**
 * Calculate percentage from pixel offset
 * @param {number} pixels - Pixel offset
 * @param {number} charDimension - Characteristic dimension of shape
 * @returns {number} Border percentage
 */
export function pixelOffsetToPercent(pixels, charDimension) {
  if (charDimension <= 0) return 10;
  return (pixels / charDimension) * 100;
}

/**
 * Default border percentage (10% of characteristic dimension)
 */
export const DEFAULT_BORDER_PERCENT = 10;

/**
 * Minimum border percentage
 */
export const MIN_BORDER_PERCENT = 5;

/**
 * Maximum border percentage (30% - Clipper handles self-intersection properly)
 * With Clipper, we can allow much larger offsets as it clips self-intersecting
 * results into valid geometry.
 */
export const MAX_BORDER_PERCENT = 30;

/**
 * Split a multi-subpath SVG path into separate subpath strings.
 * E.g., "M 0,0 L 10,0 Z M 2,2 L 8,2 Z" → ["M 0,0 L 10,0 Z", "M 2,2 L 8,2 Z"]
 *
 * @param {string} pathD - SVG path d attribute (may contain multiple M...Z subpaths)
 * @returns {Array<string>} Individual subpath strings
 */
export function parsePathToSubPaths(pathD) {
  if (!pathD) return [];
  return pathD.split(/(?=[Mm])/).filter(s => s.trim());
}

/**
 * Check if a segment path overlaps the frame ring area.
 * Returns true if any vertex of the segment falls outside the inner boundary polygon.
 * Uses Clipper's PointInPolygon for accuracy (handles non-axis-aligned boundaries).
 *
 * @param {string} segmentPathD - Flattened segment path (world coords)
 * @param {string} innerBoundaryPathD - Inner boundary of the frame (world coords)
 * @returns {boolean} True if the segment extends into the frame ring area
 */
export function pathOverlapsFrameRing(segmentPathD, innerBoundaryPathD) {
  const segPoints = parsePathToPoints(segmentPathD);
  const innerRings = clipPathToRings(innerBoundaryPathD);

  if (segPoints.length < 3 || innerRings.length === 0) return false;

  // Shrink inner boundary slightly so segments touching the inner edge
  // are detected as overlapping the frame ring
  const TOUCH_TOLERANCE = 5 * CLIPPER_SCALE;
  const co = new ClipperLib.ClipperOffset();
  innerRings.forEach((ring) => {
    co.AddPath(ring, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
  });
  const shrunk = [];
  co.Execute(shrunk, -TOUCH_TOLERANCE); // Negative = shrink inward
  const testRings = shrunk.length > 0 ? shrunk : innerRings;

  for (const p of segPoints) {
    const cp = { X: Math.round(p.x * CLIPPER_SCALE), Y: Math.round(p.y * CLIPPER_SCALE) };
    // PointInPolygon: 0 = outside, 1 = inside, -1 = on boundary.
    // A point is inside the (possibly multi-piece) window if it's inside ANY ring.
    const insideAny = testRings.some(
      (ring) => ClipperLib.Clipper.PointInPolygon(cp, ring) !== 0
    );
    if (!insideAny) {
      return true;
    }
  }
  return false;
}

/**
 * Boolean union of a frame ring with segment paths using Clipper.js.
 * Frame ring is added as Subject (pftEvenOdd handles the inner hole).
 * Segment paths are added as Clip.
 * Returns merged SVG path d-string suitable for fill-rule="evenodd".
 *
 * @param {string} frameRingPathD - Frame ring path (outer + inner subpaths)
 * @param {Array<string>} segmentPathDs - Flattened segment paths to union with the ring
 * @returns {string|null} Merged SVG path d-string, or null on failure
 */
export function unionPolygonPaths(frameRingPathD, segmentPathDs) {
  const clipper = new ClipperLib.Clipper();

  // Add frame ring subpaths as Subject
  const frameSubs = parsePathToSubPaths(frameRingPathD);
  frameSubs.forEach(sub => {
    const pts = parsePathToPoints(sub);
    if (pts.length >= 3) {
      clipper.AddPath(pointsToClipperPath(pts), ClipperLib.PolyType.ptSubject, true);
    }
  });

  // Add segment paths as Clip
  segmentPathDs.forEach(pathD => {
    const subs = parsePathToSubPaths(pathD);
    subs.forEach(sub => {
      const pts = parsePathToPoints(sub);
      if (pts.length >= 3) {
        clipper.AddPath(pointsToClipperPath(pts), ClipperLib.PolyType.ptClip, true);
      }
    });
  });

  const solution = [];
  clipper.Execute(
    ClipperLib.ClipType.ctUnion,
    solution,
    ClipperLib.PolyFillType.pftEvenOdd,   // Subject (frame ring): EvenOdd for inner hole
    ClipperLib.PolyFillType.pftNonZero     // Clip (segments): NonZero so overlapping areas merge
  );

  if (solution.length === 0) return null;

  return solution.map(poly => {
    const points = clipperPathToPoints(poly);
    return pointsToPath(points);
  }).join(' ');
}

/**
 * Check if two flattened SVG paths overlap (have any intersection area).
 * Uses Clipper.js intersection to test for overlap.
 *
 * @param {string} pathDA - First SVG path d attribute (flattened to world coords)
 * @param {string} pathDB - Second SVG path d attribute (flattened to world coords)
 * @returns {boolean} True if the paths have any overlapping area
 */
export function pathsOverlap(pathDA, pathDB) {
  if (!pathDA || !pathDB) return false;

  // Slightly inflate both paths so touching edges (zero-area intersection)
  // register as overlapping. Without this, segments that touch but don't
  // overlap would not be merged, leaving double-cut lines.
  const TOUCH_TOLERANCE = 5 * CLIPPER_SCALE; // 5px in Clipper integer space (generous for touching edges)

  const inflatePolygons = (pathD) => {
    const paths = [];
    parsePathToSubPaths(pathD).forEach(sub => {
      const pts = parsePathToPoints(sub);
      if (pts.length >= 3) {
        paths.push(pointsToClipperPath(pts));
      }
    });
    if (paths.length === 0) return paths;

    // Normalize ring orientations first: an evenodd self-union rewinds holes
    // opposite to their outer ring. Without this, a ring whose window subpath
    // has the SAME winding as its outer (e.g. frame ring paths) collapses to
    // a solid square under ClipperOffset — making everything inside the
    // window falsely "overlap" the ring.
    let normalized = paths;
    if (paths.length > 1) {
      const normalizer = new ClipperLib.Clipper();
      paths.forEach(p => normalizer.AddPath(p, ClipperLib.PolyType.ptSubject, true));
      const unioned = [];
      normalizer.Execute(
        ClipperLib.ClipType.ctUnion,
        unioned,
        ClipperLib.PolyFillType.pftEvenOdd,
        ClipperLib.PolyFillType.pftEvenOdd
      );
      if (unioned.length > 0) normalized = unioned;
    }

    const co = new ClipperLib.ClipperOffset();
    const inflated = [];
    normalized.forEach(p => co.AddPath(p, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon));
    co.Execute(inflated, TOUCH_TOLERANCE);
    return inflated.length > 0 ? inflated : normalized; // fallback if inflate fails
  };

  const clipper = new ClipperLib.Clipper();

  // Add inflated pathA as Subject
  inflatePolygons(pathDA).forEach(path => {
    clipper.AddPath(path, ClipperLib.PolyType.ptSubject, true);
  });

  // Add inflated pathB as Clip
  inflatePolygons(pathDB).forEach(path => {
    clipper.AddPath(path, ClipperLib.PolyType.ptClip, true);
  });

  const solution = [];
  clipper.Execute(
    ClipperLib.ClipType.ctIntersection,
    solution,
    ClipperLib.PolyFillType.pftEvenOdd,
    ClipperLib.PolyFillType.pftEvenOdd
  );

  return solution.length > 0;
}

// Legacy exports for compatibility
export const DEFAULT_BORDER_WIDTH = 30;
export const MIN_BORDER_WIDTH = 5;
export const DEFAULT_FRAME_SCALE = 0.85;
export const MIN_FRAME_SCALE = 0.2;
export const MAX_FRAME_SCALE = 0.95;
