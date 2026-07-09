import React, { useEffect, useState, useRef } from 'react';

const DraggedEntity = ({ entity, onDragEnd }) => {
  const backgroundExpansion = 10;

  // Calculate display dimensions (guard against NaN/undefined)
  const displayWidth = (entity.width || 100) * (entity.scale || 1);
  const displayHeight = (entity.height || 100) * (entity.scale || 1);
  const totalWidth = displayWidth + backgroundExpansion * 2;
  const totalHeight = displayHeight + backgroundExpansion * 2;

  const [position, setPosition] = useState({
    x: entity.initialMouseX - totalWidth / 2,
    y: entity.initialMouseY - totalHeight / 2,
  });
  const svgRef = useRef(null);

  useEffect(() => {
    const handleMouseMove = (e) => {
      setPosition({
        x: e.clientX - totalWidth / 2,
        y: e.clientY - totalHeight / 2,
      });
    };

    const handleMouseUp = (e) => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      onDragEnd(entity, { x: e.clientX, y: e.clientY });
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [entity, onDragEnd, totalWidth, totalHeight]);

  // If entity has crop config, we need to show only the cropped region
  const hasCrop = entity.crop && entity.crop.width && entity.crop.height;

  // For cropped images: scale factor from crop region to display dimensions
  const cropScaleX = hasCrop ? displayWidth / entity.crop.width : 1;
  const cropScaleY = hasCrop ? displayHeight / entity.crop.height : 1;

  // Full image dimensions when scaled
  const fullImageWidth = hasCrop ? 1024 * cropScaleX : displayWidth;
  const fullImageHeight = hasCrop ? 1024 * cropScaleY : displayHeight;

  // Offset to position the crop region at the display location
  const imageOffsetX = hasCrop ? -entity.crop.x * cropScaleX : 0;
  const imageOffsetY = hasCrop ? -entity.crop.y * cropScaleY : 0;

  return (
    <div
      style={{
        position: 'fixed',
        left: position.x,
        top: position.y,
        zIndex: 1000,
        cursor: 'grabbing',
        pointerEvents: 'none',
      }}
    >
      {hasCrop ? (
        // For full-size images with crop: use SVG with sticker effect
        <svg
          width={totalWidth}
          height={totalHeight}
          viewBox={`0 0 ${totalWidth} ${totalHeight}`}
          style={{ filter: 'drop-shadow(0px 5px 5px rgba(0,0,0,0.3))' }}
        >
          <defs>
            {/* Filter to expand the mask for white border effect */}
            <filter id={`expandMask-${entity.id}`}>
              <feMorphology operator="dilate" radius={backgroundExpansion / 2} />
            </filter>
            {/* ClipPath for the sticker effect - includes expansion area */}
            <clipPath id={`stickerClip-${entity.id}`}>
              <rect
                x={backgroundExpansion / 2}
                y={backgroundExpansion / 2}
                width={displayWidth + backgroundExpansion}
                height={displayHeight + backgroundExpansion}
              />
            </clipPath>
            {/* ClipPath for the actual image - exact crop area */}
            <clipPath id={`cropClip-${entity.id}`}>
              <rect
                x={backgroundExpansion}
                y={backgroundExpansion}
                width={displayWidth}
                height={displayHeight}
              />
            </clipPath>
          </defs>
          {/* White expanded background (sticker effect) - uses larger clip */}
          <mask id={`expandedMask-${entity.id}`}>
            <g clipPath={`url(#stickerClip-${entity.id})`}>
              <image
                href={entity.svgUrl}
                x={backgroundExpansion + imageOffsetX}
                y={backgroundExpansion + imageOffsetY}
                width={fullImageWidth}
                height={fullImageHeight}
                filter={`url(#expandMask-${entity.id})`}
              />
            </g>
          </mask>
          <rect
            x="0"
            y="0"
            width={totalWidth}
            height={totalHeight}
            fill="white"
            mask={`url(#expandedMask-${entity.id})`}
          />
          {/* The actual cropped image */}
          <g clipPath={`url(#cropClip-${entity.id})`}>
            <image
              href={entity.svgUrl}
              x={backgroundExpansion + imageOffsetX}
              y={backgroundExpansion + imageOffsetY}
              width={fullImageWidth}
              height={fullImageHeight}
            />
          </g>
        </svg>
      ) : (
        // Original SVG approach for pre-cropped images
        <svg
          ref={svgRef}
          width={totalWidth}
          height={totalHeight}
          viewBox={`0 0 ${totalWidth} ${totalHeight}`}
          style={{ filter: 'drop-shadow(0px 5px 5px rgba(0,0,0,0.3))' }}
        >
          <defs>
            <filter id="whiteFill">
              <feFlood floodColor="white" result="white" />
              <feComposite in="white" in2="SourceAlpha" operator="in" />
            </filter>
            <filter id="expandMask">
              <feMorphology operator="dilate" radius={backgroundExpansion / 2} />
            </filter>
          </defs>
          <mask id="expandedMask">
            <image
              href={entity.svgUrl}
              x={backgroundExpansion}
              y={backgroundExpansion}
              width={displayWidth}
              height={displayHeight}
              filter="url(#expandMask)"
            />
          </mask>
          <rect
            x="0"
            y="0"
            width="100%"
            height="100%"
            fill="white"
            mask="url(#expandedMask)"
          />
          <image
            href={entity.svgUrl}
            x={backgroundExpansion}
            y={backgroundExpansion}
            width={displayWidth}
            height={displayHeight}
          />
        </svg>
      )}
    </div>
  );
};

export default DraggedEntity;
