import Konva from 'konva';
import { parsePathToPoints, offsetPolygonAll, splitSubpaths, getShapeCharacteristicDimension, percentToPixelOffset, DEFAULT_BORDER_PERCENT } from '../../utils/svgPathOffset';
import { extractCombinedPathD } from '../../utils/svgDom';

/**
 * Image cache for segment images
 * Avoids re-decoding base64 data for unchanged segments
 */
const imageCache = new Map();
const MAX_CACHE_SIZE = 100; // Limit cache to prevent memory bloat

/**
 * Get or create a cached image from a data URL
 */
const getCachedImage = (dataUrl) => {
  return new Promise((resolve, reject) => {
    // Check cache first
    if (imageCache.has(dataUrl)) {
      resolve(imageCache.get(dataUrl));
      return;
    }

    // Load new image
    const imageObj = new Image();
    imageObj.crossOrigin = 'Anonymous';

    imageObj.onload = () => {
      // Evict oldest entries if cache is full
      if (imageCache.size >= MAX_CACHE_SIZE) {
        const firstKey = imageCache.keys().next().value;
        imageCache.delete(firstKey);
      }
      imageCache.set(dataUrl, imageObj);
      resolve(imageObj);
    };

    imageObj.onerror = (error) => {
      console.error('Error loading image:', error);
      reject(error);
    };

    imageObj.src = dataUrl;
  });
};

/**
 * Clear specific image from cache (call when segment is removed)
 */
export const clearImageFromCache = (dataUrl) => {
  if (dataUrl) {
    imageCache.delete(dataUrl);
  }
};

/**
 * Clear entire image cache (call on app unmount)
 */
export const clearAllImageCache = () => {
  imageCache.clear();
};

export const renderLayerToPng = (layer, width, height) => {
  return new Promise((resolve, reject) => {
    try {
      const stage = new Konva.Stage({
        container: document.createElement('div'),
        width: width,
        height: height,
      });

      const contentLayer = new Konva.Layer();
      const frameLayer = new Konva.Layer();
      stage.add(contentLayer, frameLayer);

      // Create a group that will be clipped
      const clippedGroup = new Konva.Group({
        clipFunc: (ctx) => {
          if (layer.isFrameActive) {
            if (layer.frameShape.includes('square')) {
              const strokeWidth = (layer.frameStrokeWidth ?? 50);
              ctx.beginPath();
              ctx.rect(
                strokeWidth,
                strokeWidth,
                width - 2 * strokeWidth,
                height - 2 * strokeWidth
              );
            } else {
              const strokeWidth = (layer.frameStrokeWidth ?? 50);
              const radiusX = (width - 2 * strokeWidth) / 2;
              const radiusY = (height - 2 * strokeWidth) / 2;
              ctx.beginPath();
              ctx.ellipse(
                width / 2,
                height / 2,
                radiusX,
                radiusY,
                0,
                0,
                2 * Math.PI
              );
            }
          } else {
            // If frame is not active, show everything
            ctx.beginPath();
            ctx.rect(0, 0, width, height);
          }
        },
      });

      contentLayer.add(clippedGroup);

      const totalImages = layer.segments.length;

      const renderFrame = () => {
        if (layer.isFrameActive) {
          const strokeWidth = (layer.frameStrokeWidth ?? 50);

          // Draw the frame shape
          const frameShape = new Konva.Shape({
            sceneFunc: (context, shape) => {
              context.beginPath();
              if (layer.frameShape.includes('square')) {
                // Outer rectangle
                context.rect(0, 0, width, height);
                // Inner rectangle (for hole)
                context.moveTo(strokeWidth, strokeWidth);
                context.lineTo(width - strokeWidth, strokeWidth);
                context.lineTo(width - strokeWidth, height - strokeWidth);
                context.lineTo(strokeWidth, height - strokeWidth);
                context.closePath();
              } else {
                // Outer ellipse
                context.ellipse(
                  width / 2,
                  height / 2,
                  width / 2,
                  height / 2,
                  0,
                  0,
                  2 * Math.PI
                );
                // Inner ellipse (for hole)
                const radiusX = (width - 2 * strokeWidth) / 2;
                const radiusY = (height - 2 * strokeWidth) / 2;
                context.moveTo(width / 2 + radiusX, height / 2);
                context.ellipse(
                  width / 2,
                  height / 2,
                  radiusX,
                  radiusY,
                  0,
                  0,
                  2 * Math.PI
                );
              }
              // Use evenodd fill rule for proper hole rendering
              const ctx = context._context;
              ctx.fillStyle = shape.fill();
              ctx.fill('evenodd');
            },
            fill: 'rgb(156, 163, 175)',
          });

          frameLayer.add(frameShape);
        }

        stage.draw();
        const dataUrl = stage.toDataURL();
        stage.destroy();
        resolve(dataUrl);
      };

      if (totalImages === 0) {
        renderFrame();
        return;
      }

      // Separate frame segments from normal segments
      const frameSegments = layer.segments.filter(s => s.isFrame);
      const normalSegments = layer.segments.filter(
        (s) => !s.isFrame && typeof s.styledSvg === 'string' && s.styledSvg.length > 0
      );
      // SVG-only segments (fabrication fix tabs/bridges) — no image, just path data
      const svgOnlySegments = layer.segments.filter(
        (s) => !s.isFrame && !s.styledSvg && s.svg
      );

      // Render frame segments as ring shapes (no image loading needed)
      frameSegments.forEach((segment) => {
        if (!segment.svg) return;

        const pathD = extractCombinedPathD(segment.svg);
        if (!pathD) return;

        const outerRings = splitSubpaths(pathD)
          .map(parsePathToPoints)
          .filter((pts) => pts.length >= 3);
        if (outerRings.length === 0) return;

        // Calculate pixel offset from percentage
        const charDimension = getShapeCharacteristicDimension(segment.svg);
        const borderPercent = segment.borderPercent || DEFAULT_BORDER_PERCENT;
        const borderWidth = percentToPixelOffset(borderPercent, charDimension);
        const innerRings = offsetPolygonAll(outerRings, borderWidth);

        // Calculate the scale from 1024 to canvas
        const baseScaleX = segment.scaleX || 1;
        const baseScaleY = segment.scaleY || 1;

        // Create ring shape using Konva.Shape
        const frameShape = new Konva.Shape({
          x: segment.x,
          y: segment.y,
          scaleX: baseScaleX,
          scaleY: baseScaleY,
          rotation: segment.rotation || 0,
          // Offset to draw relative to segment's original position
          offsetX: segment.originalX,
          offsetY: segment.originalY,
          sceneFunc: (context, shape) => {
            context.beginPath();
            const traceRing = (ring) => {
              context.moveTo(ring[0].x, ring[0].y);
              for (let i = 1; i < ring.length; i++) {
                context.lineTo(ring[i].x, ring[i].y);
              }
              context.closePath();
            };
            // Draw all outer rings then all inner rings — evenodd resolves holes
            outerRings.forEach(traceRing);
            innerRings.forEach(traceRing);
            const ctx = context._context;
            ctx.fillStyle = shape.fill();
            ctx.fill('evenodd');
          },
          fill: 'rgb(156, 163, 175)',
        });

        clippedGroup.add(frameShape);
      });

      // Render SVG-only segments (fix tabs/bridges) as vector shapes
      svgOnlySegments.forEach((segment) => {
        if (!segment.svg) return;
        const svgStr = segment.svg;
        const dMatches = svgStr.match(/\bd="([^"]+)"/g);
        if (!dMatches) return;

        const baseScaleX = segment.scaleX || 1;
        const baseScaleY = segment.scaleY || 1;

        dMatches.forEach((dAttr) => {
          const pathD = dAttr.slice(3, -1); // strip d=" and trailing "
          const pts = parsePathToPoints(pathD);
          if (pts.length < 3) return;

          const fixShape = new Konva.Shape({
            x: segment.x || 0,
            y: segment.y || 0,
            scaleX: baseScaleX,
            scaleY: baseScaleY,
            rotation: segment.rotation || 0,
            offsetX: segment.originalX || 0,
            offsetY: segment.originalY || 0,
            sceneFunc: (context, shape) => {
              context.beginPath();
              context.moveTo(pts[0].x, pts[0].y);
              for (let i = 1; i < pts.length; i++) {
                context.lineTo(pts[i].x, pts[i].y);
              }
              context.closePath();
              context.fillStrokeShape(shape);
            },
            fill: 'rgb(200, 200, 200)',
            stroke: 'rgb(120, 120, 120)',
            strokeWidth: 1 / baseScaleX,
          });
          clippedGroup.add(fixShape);
        });
      });

      // Load images for normal segments in parallel using cache
      if (normalSegments.length === 0) {
        contentLayer.batchDraw();
        renderFrame();
        return;
      }

      const imagePromises = normalSegments.map((segment) =>
        getCachedImage(segment.styledSvg).then((imageObj) => ({
          segment,
          imageObj,
        }))
      );

      Promise.all(imagePromises)
        .then((results) => {
          results.forEach(({ segment, imageObj }) => {
            // Build Konva Image config
            const imageConfig = {
              x: segment.x,
              y: segment.y,
              image: imageObj,
              width: segment.originalWidth,
              height: segment.originalHeight,
              scaleX: segment.scaleX || 1,
              scaleY: segment.scaleY || 1,
              rotation: segment.rotation || 0,
            };

            // If segment has crop config, add it (for full-size images with transparency)
            if (segment.crop && segment.crop.width && segment.crop.height) {
              imageConfig.crop = {
                x: segment.crop.x,
                y: segment.crop.y,
                width: segment.crop.width,
                height: segment.crop.height,
              };
            }

            const konvaImage = new Konva.Image(imageConfig);
            clippedGroup.add(konvaImage);
          });

          contentLayer.batchDraw();
          renderFrame();
        })
        .catch(reject);
    } catch (error) {
      console.error('Error rendering layer to PNG:', error);
      reject(error);
    }
  });
};
