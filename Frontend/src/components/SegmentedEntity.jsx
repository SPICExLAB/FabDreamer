import React, { useEffect, useRef, useCallback, useState, useMemo } from 'react';
import { Image, Shape } from 'react-konva';
import { parsePathToPoints, offsetPolygonAll, splitSubpaths, getShapeCharacteristicDimension, percentToPixelOffset, DEFAULT_BORDER_PERCENT } from '../utils/svgPathOffset';
import { extractCombinedPathD } from '../utils/svgDom';

// Cache for image alpha data to avoid recreating canvas on every hit test
const alphaDataCache = new WeakMap();

const getAlphaData = (image) => {
  if (!image) return null;

  if (alphaDataCache.has(image)) {
    return alphaDataCache.get(image);
  }

  try {
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const imageData = ctx.getImageData(0, 0, image.width, image.height);
    alphaDataCache.set(image, imageData);
    return imageData;
  } catch (e) {
    // CORS error - cache null to avoid retrying
    alphaDataCache.set(image, null);
    return null;
  }
};

const SegmentedEntity = ({
  entity,
  rootEntity,
  scaleX = 1,
  scaleY = 1,
  onDragStart,
  onDragMove,
  onDragEnd,
  onTransformEnd,
  onClick,
  isInEditingSection = false,
  isDragging,
  isSelected = false,
  isTracing = false, // True when trace is being generated
  isSubSegmenting = false, // True when sub-segmentation is in progress
}) => {
  const imageRef = useRef(null);
  const [position, setPosition] = useState({ x: entity.x, y: entity.y });

  // NOTE: Transformer node attachment is now handled in EditingSection
  // to support multi-select. Do NOT add transformer.nodes() here as it
  // would overwrite the multi-select state.

  const handleDragStart = useCallback(
    (e) => {
      // Prevent non-selected segments from being dragged when a Transformer
      // handle overlaps them — the drag should only affect the selected segment
      if (isInEditingSection && !isSelected) {
        // Cancel the drag by resetting position
        e.target.stopDrag();
        return;
      }
      if (onDragStart) {
        onDragStart(entity, e);
      }
      setPosition({ x: e.target.x(), y: e.target.y() });
    },
    [onDragStart, entity, isInEditingSection, isSelected]
  );

  const handleDragMove = useCallback(
    (e) => {
      if (isInEditingSection && onDragMove) {
        const newPos = { x: e.target.x(), y: e.target.y() };
        setPosition(newPos);
        onDragMove(e, newPos);
      } else {
        e.target.position(position);
      }
    },
    [isInEditingSection, onDragMove, position]
  );

  const handleDragEnd = useCallback(
    (e) => {
      if (isInEditingSection && onDragEnd) {
        onDragEnd(e, position);
      }
    },
    [isInEditingSection, onDragEnd, position]
  );

  const handleTransformEnd = useCallback(
    (e) => {
      if (onTransformEnd) {
        const node = e.target;
        const newProps = {
          x: node.x(),
          y: node.y(),
          scaleX: node.scaleX(),
          scaleY: node.scaleY(),
          rotation: node.rotation(),
        };
        onTransformEnd(e, newProps);
      }
    },
    [onTransformEnd]
  );

  const handleClick = useCallback(
    (e) => {
      e.cancelBubble = true;
      if (onClick) {
        onClick(entity, e);
      }
    },
    [onClick, entity]
  );

  // Parse frame segment paths if needed (multi-ring: all outer pieces + all offset pieces)
  const framePathData = useMemo(() => {
    if (!entity.isFrame || !entity.svg) return null;

    const pathD = extractCombinedPathD(entity.svg);
    if (!pathD) return null;

    const outerRings = splitSubpaths(pathD)
      .map(parsePathToPoints)
      .filter((pts) => pts.length >= 3);
    if (outerRings.length === 0) return null;

    // Calculate pixel offset from percentage
    const charDimension = getShapeCharacteristicDimension(entity.svg);
    const borderPercent = entity.borderPercent || DEFAULT_BORDER_PERCENT;
    const borderWidth = percentToPixelOffset(borderPercent, charDimension);
    const innerRings = offsetPolygonAll(outerRings, borderWidth);

    return { outerRings, innerRings };
  }, [entity.isFrame, entity.svg, entity.borderPercent]);

  // For frame segments, we can render even without an image
  if (!entity) {
    return null;
  }

  // Non-frame segments need an image
  if (!entity.isFrame && !entity.image) {
    return null;
  }

  const xPosition = isInEditingSection ? position.x : entity.x * scaleX;
  const yPosition = isInEditingSection ? position.y : entity.y * scaleY;

  const displayedImage =
    isInEditingSection && entity.styledImage
      ? entity.styledImage
      : entity.image;

  // If entity has crop config, use it to extract element from full-size image
  const cropConfig = entity.crop ? {
    x: entity.crop.x,
    y: entity.crop.y,
    width: entity.crop.width,
    height: entity.crop.height,
  } : undefined;

  // In SegmentSection (not editing), require svg_trace before dragging
  // svg_trace can be a non-empty string OR null with _traceComplete flag (0 paths found)
  // In EditingSection, always allow dragging
  // Frame segments can always be dragged - but not when sub-segmenting
  const hasTrace = !!entity.svg_trace || entity.svg_trace === '';
  const canDrag = !isSubSegmenting && (isInEditingSection || entity.isFrame || hasTrace);

  // Show reduced opacity when tracing, when trace not ready, or when sub-segmenting
  // svg_trace === '' means trace completed with 0 paths (solid element) — not loading
  const showLoadingState = !entity.isFrame && (isTracing || isSubSegmenting || (!isInEditingSection && !hasTrace));

  // Render frame segment as ring shape
  // Works just like Image: x,y is top-left, path points start at (0,0)
  if (entity.isFrame && framePathData) {
    const { outerRings, innerRings } = framePathData;

    // Calculate bounding box across all outer rings
    const allOuterPts = outerRings.flat();
    const minX = Math.min(...allOuterPts.map(p => p.x));
    const minY = Math.min(...allOuterPts.map(p => p.y));
    const maxX = Math.max(...allOuterPts.map(p => p.x));
    const maxY = Math.max(...allOuterPts.map(p => p.y));
    const pathWidth = maxX - minX;
    const pathHeight = maxY - minY;

    // Translate points so top-left is at (0,0) - just like Image content
    const localOuterRings = outerRings.map(ring => ring.map(p => ({ x: p.x - minX, y: p.y - minY })));
    const localInnerRings = innerRings.map(ring => ring.map(p => ({ x: p.x - minX, y: p.y - minY })));
    const traceRing = (context, ring) => {
      context.moveTo(ring[0].x, ring[0].y);
      for (let i = 1; i < ring.length; i++) {
        context.lineTo(ring[i].x, ring[i].y);
      }
      context.closePath();
    };

    return (
      <Shape
        ref={imageRef}
        id={entity.id}
        x={xPosition}
        y={yPosition}
        width={pathWidth}
        height={pathHeight}
        scaleX={scaleX}
        scaleY={scaleY}
        rotation={entity.rotation || 0}
        draggable={canDrag}
        onDragStart={canDrag ? handleDragStart : undefined}
        onDragMove={canDrag ? handleDragMove : undefined}
        onDragEnd={canDrag ? handleDragEnd : undefined}
        onClick={handleClick}
        onTransformEnd={onTransformEnd}
        opacity={isDragging ? 0.5 : 1}
        sceneFunc={(context, shape) => {
          context.beginPath();
          // Draw all outer rings then all inner rings (holes) — evenodd resolves them
          localOuterRings.forEach(ring => traceRing(context, ring));
          localInnerRings.forEach(ring => traceRing(context, ring));
          // Use evenodd fill rule for proper hole rendering
          const ctx = context._context;
          ctx.fillStyle = shape.fill();
          ctx.fill('evenodd');
        }}
        hitFunc={(context, shape) => {
          // Hit detection for the ring shape
          context.beginPath();
          localOuterRings.forEach(ring => traceRing(context, ring));
          // Draw inner rings in REVERSE order (counter-clockwise) for holes
          localInnerRings.forEach(ring => {
            context.moveTo(ring[ring.length - 1].x, ring[ring.length - 1].y);
            for (let i = ring.length - 2; i >= 0; i--) {
              context.lineTo(ring[i].x, ring[i].y);
            }
            context.closePath();
          });
          context.fillStrokeShape(shape);
        }}
        fill="rgb(156, 163, 175)"
      />
    );
  }

  // Calculate dimensions for rendering
  const renderWidth = entity.originalWidth || entity.width || 100;
  const renderHeight = entity.originalHeight || entity.height || 100;

  // Render normal segment as image with custom hitFunc for transparent pixel detection
  return (
    <Image
      ref={imageRef}
      id={entity.id}
      image={displayedImage}
      x={xPosition}
      y={yPosition}
      width={renderWidth}
      height={renderHeight}
      scaleX={scaleX}
      scaleY={scaleY}
      rotation={entity.rotation || 0}
      crop={cropConfig}
      draggable={canDrag}
      onDragStart={canDrag ? handleDragStart : undefined}
      onDragMove={canDrag ? handleDragMove : undefined}
      onDragEnd={canDrag ? handleDragEnd : undefined}
      onClick={handleClick}
      onTransformEnd={onTransformEnd}
      opacity={isDragging ? 0.5 : showLoadingState ? 0.6 : 1}
      hitFunc={(context, shape) => {
        // Custom hit function that only registers hits on non-transparent pixels
        const image = shape.image();
        const alphaData = getAlphaData(image);

        if (!alphaData) {
          // Fallback to bounding box if we can't read alpha
          context.beginPath();
          context.rect(0, 0, shape.width(), shape.height());
          context.closePath();
          context.fillStrokeShape(shape);
          return;
        }

        // Draw only opaque pixels as hit region
        const width = shape.width();
        const height = shape.height();
        const imgWidth = image.width;
        const imgHeight = image.height;
        const crop = shape.crop() || { x: 0, y: 0, width: imgWidth, height: imgHeight };

        context.beginPath();

        // Sample at reasonable intervals for performance
        const step = Math.max(1, Math.floor(Math.min(width, height) / 50));
        for (let y = 0; y < height; y += step) {
          for (let x = 0; x < width; x += step) {
            // Map to image coordinates
            const imgX = Math.floor(crop.x + (x / width) * crop.width);
            const imgY = Math.floor(crop.y + (y / height) * crop.height);

            if (imgX >= 0 && imgX < imgWidth && imgY >= 0 && imgY < imgHeight) {
              const alphaIndex = (imgY * imgWidth + imgX) * 4 + 3;
              if (alphaData.data[alphaIndex] > 10) {
                context.rect(x, y, step, step);
              }
            }
          }
        }

        context.closePath();
        context.fillStrokeShape(shape);
      }}
    />
  );
};

export default React.memo(SegmentedEntity);
