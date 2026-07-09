/**
 * Segment transform calculation utilities
 *
 * Centralized transform logic used by:
 * - LayerManager.jsx (composeLayerSvg, composeLayerTraceSvg)
 * - exportXToolSvg.js (generateXToolSvg, generateXToolSvgWithPng)
 *
 * Coordinate system:
 * - Backend SVG: 1024x1024 with paths at natural pixel positions
 * - Editing canvas: width x height (scaled from 1024)
 * - segment.scaleX/Y = editingSize / 1024 (how PNG is scaled to fit canvas)
 * - We use viewBox="0 0 1024 1024" so SVG auto-scales to canvas size
 */

import { CANVAS_SIZE, EPSILON, TRANSLATE_THRESHOLD } from '../constants/canvas';

/**
 * Calculate segment transform values for SVG composition
 *
 * @param {Object} segment - Segment with position and transform data
 * @param {number} segment.x - Current X position in editing coordinates
 * @param {number} segment.y - Current Y position in editing coordinates
 * @param {number} segment.scaleX - Current X scale (or undefined for default)
 * @param {number} segment.scaleY - Current Y scale (or undefined for default)
 * @param {number} segment.rotation - Rotation in degrees (or 0)
 * @param {number} segment.originalX - Original X position in 1024 coords
 * @param {number} segment.originalY - Original Y position in 1024 coords
 * @param {number} segment.originalWidth - Original width in 1024 coords
 * @param {number} segment.originalHeight - Original height in 1024 coords
 * @param {number} canvasWidth - Current editing canvas width
 * @param {number} canvasHeight - Current editing canvas height
 * @returns {Object} Transform values and SVG transform string
 */
export const calculateSegmentTransform = (segment, canvasWidth, canvasHeight) => {
  const sourceSize = CANVAS_SIZE;

  // Base scale: ratio from 1024 to editing canvas (default when no user scaling)
  const defaultScaleX = canvasWidth / sourceSize;
  const defaultScaleY = canvasHeight / sourceSize;

  // Current scale (may differ from default if user scaled the segment)
  const currentScaleX = segment.scaleX || defaultScaleX;
  const currentScaleY = segment.scaleY || defaultScaleY;

  // User's scaling factor (1.0 = no scaling)
  const userScaleX = currentScaleX / defaultScaleX;
  const userScaleY = currentScaleY / defaultScaleY;
  const hasUserScale = Math.abs(userScaleX - 1) > EPSILON || Math.abs(userScaleY - 1) > EPSILON;

  const rotation = segment.rotation || 0;

  // Original center (where the shape was in the SVG, in 1024 coords)
  const originalCx = segment.originalX + segment.originalWidth / 2;
  const originalCy = segment.originalY + segment.originalHeight / 2;

  // Current position in 1024 coords (Konva's reported position converted back)
  const currentX = segment.x / defaultScaleX;
  const currentY = segment.y / defaultScaleY;

  return {
    defaultScaleX,
    defaultScaleY,
    currentScaleX,
    currentScaleY,
    userScaleX,
    userScaleY,
    hasUserScale,
    rotation,
    originalCx,
    originalCy,
    currentX,
    currentY,
  };
};

/**
 * Build SVG transform string for a segment
 *
 * SVG transforms apply right-to-left, so we build the string in reverse order:
 * Final order: translate → scale → rotate (applied as rotate first, then scale, then translate)
 *
 * @param {Object} transformValues - Values from calculateSegmentTransform
 * @param {Object} segment - Original segment for originalX/Y
 * @returns {string} SVG transform attribute value (empty string if no transform needed)
 */
export const buildSvgTransformString = (transformValues, segment) => {
  const {
    userScaleX,
    userScaleY,
    hasUserScale,
    rotation,
    originalCx,
    originalCy,
    currentX,
    currentY,
  } = transformValues;

  const transforms = [];

  if (rotation !== 0 || hasUserScale) {
    // Calculate where the original corner ends up after rotation and scaling around center
    const rad = (rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);

    // Vector from original center to original corner
    const dx = segment.originalX - originalCx;
    const dy = segment.originalY - originalCy;

    // After scaling around center
    const scaledDx = dx * userScaleX;
    const scaledDy = dy * userScaleY;

    // After rotating around center
    const transformedCornerX = originalCx + scaledDx * cos - scaledDy * sin;
    const transformedCornerY = originalCy + scaledDx * sin + scaledDy * cos;

    // Translation needed to move from transformed position to Konva's reported position
    const translateX = currentX - transformedCornerX;
    const translateY = currentY - transformedCornerY;

    // Build transform string - order matters! (applied right-to-left in SVG)
    // translate goes FIRST so it's applied LAST (not affected by scale/rotate)
    if (Math.abs(translateX) > TRANSLATE_THRESHOLD || Math.abs(translateY) > TRANSLATE_THRESHOLD) {
      transforms.push(`translate(${translateX}, ${translateY})`);
    }
    if (hasUserScale) {
      transforms.push(`translate(${originalCx}, ${originalCy}) scale(${userScaleX}, ${userScaleY}) translate(${-originalCx}, ${-originalCy})`);
    }
    if (rotation !== 0) {
      transforms.push(`rotate(${rotation}, ${originalCx}, ${originalCy})`);
    }
  } else {
    // No rotation or scaling - just translate by delta
    const deltaX = currentX - segment.originalX;
    const deltaY = currentY - segment.originalY;
    if (Math.abs(deltaX) > TRANSLATE_THRESHOLD || Math.abs(deltaY) > TRANSLATE_THRESHOLD) {
      transforms.push(`translate(${deltaX}, ${deltaY})`);
    }
  }

  return transforms.length > 0 ? transforms.join(' ') : '';
};

/**
 * Convenience function: get complete SVG transform string for a segment
 * Combines calculateSegmentTransform and buildSvgTransformString
 *
 * @param {Object} segment - Segment with position and transform data
 * @param {number} canvasWidth - Current editing canvas width
 * @param {number} canvasHeight - Current editing canvas height
 * @returns {string} SVG transform attribute value
 */
export const getSegmentSvgTransform = (segment, canvasWidth, canvasHeight) => {
  const transformValues = calculateSegmentTransform(segment, canvasWidth, canvasHeight);
  return buildSvgTransformString(transformValues, segment);
};
