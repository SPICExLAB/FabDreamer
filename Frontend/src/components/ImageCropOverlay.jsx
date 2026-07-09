import React, { useState, useRef, useEffect, useCallback } from 'react';

/**
 * Full-screen overlay for cropping uploaded images to a square format.
 *
 * Features:
 * - Draggable crop box
 * - Resizable corners
 * - Maintains 1:1 aspect ratio
 * - Preview of cropped area
 */
const ImageCropOverlay = ({ imageDataUrl, onConfirm, onCancel }) => {
  const containerRef = useRef(null);
  const imageRef = useRef(null);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageDimensions, setImageDimensions] = useState({ width: 0, height: 0 });
  const [displayDimensions, setDisplayDimensions] = useState({ width: 0, height: 0, offsetX: 0, offsetY: 0 });

  // Crop box state (in display coordinates)
  const [cropBox, setCropBox] = useState({ x: 0, y: 0, size: 200 });
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [displayScale, setDisplayScale] = useState(1); // display-to-original ratio
  const wasInteractingRef = useRef(false); // Tracks recent drag/resize to prevent accidental cancel

  // Calculate actual crop size in original image coordinates
  const actualCropSize = Math.round(cropBox.size / displayScale);
  const isLowQuality = actualCropSize < 1024;
  const qualityPercent = Math.min(100, Math.round((actualCropSize / 1024) * 100));

  // Calculate display dimensions when image loads
  useEffect(() => {
    if (!imageLoaded || !containerRef.current) return;

    const container = containerRef.current;
    const containerWidth = container.clientWidth - 80; // Padding
    const containerHeight = container.clientHeight - 200; // Space for text and button

    const img = imageRef.current;
    const imgWidth = img.naturalWidth;
    const imgHeight = img.naturalHeight;

    setImageDimensions({ width: imgWidth, height: imgHeight });

    // Scale image to fit container
    const scale = Math.min(containerWidth / imgWidth, containerHeight / imgHeight);
    const displayWidth = imgWidth * scale;
    const displayHeight = imgHeight * scale;
    const offsetX = (containerWidth - displayWidth) / 2 + 40;
    const offsetY = 40;

    setDisplayScale(scale); // Store scale for crop size calculation
    setDisplayDimensions({ width: displayWidth, height: displayHeight, offsetX, offsetY });

    // Initialize crop box to center, size = min dimension * 0.8
    const initialSize = Math.min(displayWidth, displayHeight) * 0.8;
    setCropBox({
      x: offsetX + (displayWidth - initialSize) / 2,
      y: offsetY + (displayHeight - initialSize) / 2,
      size: initialSize,
    });
  }, [imageLoaded]);

  // Mouse handlers for dragging
  const handleMouseDown = useCallback((e, action, corner) => {
    e.preventDefault();
    e.stopPropagation();

    wasInteractingRef.current = true;
    if (action === 'drag') {
      setIsDragging(true);
      setDragStart({ x: e.clientX - cropBox.x, y: e.clientY - cropBox.y });
    } else if (action === 'resize') {
      setIsResizing(true);
      setDragStart({ x: e.clientX, y: e.clientY, initialSize: cropBox.size, initialX: cropBox.x, initialY: cropBox.y, corner: corner || 'se' });
    }
  }, [cropBox]);

  const handleMouseMove = useCallback((e) => {
    if (!isDragging && !isResizing) return;

    const { offsetX, offsetY, width: displayWidth, height: displayHeight } = displayDimensions;

    if (isDragging) {
      let newX = e.clientX - dragStart.x;
      let newY = e.clientY - dragStart.y;

      // Constrain to image bounds
      newX = Math.max(offsetX, Math.min(newX, offsetX + displayWidth - cropBox.size));
      newY = Math.max(offsetY, Math.min(newY, offsetY + displayHeight - cropBox.size));

      setCropBox(prev => ({ ...prev, x: newX, y: newY }));
    } else if (isResizing) {
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      const corner = dragStart.corner;
      const minSize = Math.max(100, 256 * displayScale);

      let newSize, newX, newY;

      if (corner === 'se') {
        // Bottom-right: grow/shrink from top-left anchor
        const delta = (dx + dy) / 2;
        newSize = dragStart.initialSize + delta;
        newX = dragStart.initialX;
        newY = dragStart.initialY;
        const maxSize = Math.min(displayWidth - (newX - offsetX), displayHeight - (newY - offsetY));
        newSize = Math.max(minSize, Math.min(newSize, maxSize));
      } else if (corner === 'nw') {
        // Top-left: anchor at bottom-right
        const delta = (dx + dy) / 2;
        newSize = dragStart.initialSize - delta;
        newSize = Math.max(minSize, newSize);
        const brX = dragStart.initialX + dragStart.initialSize;
        const brY = dragStart.initialY + dragStart.initialSize;
        newX = brX - newSize;
        newY = brY - newSize;
        newX = Math.max(offsetX, newX);
        newY = Math.max(offsetY, newY);
        newSize = Math.min(brX - offsetX, brY - offsetY, newSize);
      } else if (corner === 'ne') {
        // Top-right: anchor at bottom-left
        const delta = (dx - dy) / 2;
        newSize = dragStart.initialSize + delta;
        newSize = Math.max(minSize, newSize);
        const blX = dragStart.initialX;
        const blY = dragStart.initialY + dragStart.initialSize;
        newX = blX;
        newY = blY - newSize;
        newY = Math.max(offsetY, newY);
        const maxW = displayWidth - (newX - offsetX);
        newSize = Math.min(maxW, blY - offsetY, newSize);
        newY = blY - newSize;
      } else if (corner === 'sw') {
        // Bottom-left: anchor at top-right
        const delta = (-dx + dy) / 2;
        newSize = dragStart.initialSize + delta;
        newSize = Math.max(minSize, newSize);
        const trX = dragStart.initialX + dragStart.initialSize;
        const trY = dragStart.initialY;
        newX = trX - newSize;
        newY = trY;
        newX = Math.max(offsetX, newX);
        const maxH = displayHeight - (newY - offsetY);
        newSize = Math.min(trX - offsetX, maxH, newSize);
        newX = trX - newSize;
      }

      setCropBox({ x: newX, y: newY, size: newSize });
    }
  }, [isDragging, isResizing, dragStart, cropBox, displayDimensions, displayScale]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    setIsResizing(false);
    // Delay clearing the flag so the click event on backdrop doesn't fire cancel
    setTimeout(() => { wasInteractingRef.current = false; }, 100);
  }, []);

  // Add global mouse listeners
  useEffect(() => {
    if (isDragging || isResizing) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [isDragging, isResizing, handleMouseMove, handleMouseUp]);

  // Handle confirm - crop and return
  const handleConfirm = useCallback(() => {
    if (!imageRef.current) return;

    const { offsetX, offsetY } = displayDimensions;

    // Convert display coordinates to original image coordinates
    // displayScale = displaySize / originalSize, so originalSize = displaySize / displayScale
    const toOriginal = 1 / displayScale;

    const cropX = (cropBox.x - offsetX) * toOriginal;
    const cropY = (cropBox.y - offsetY) * toOriginal;
    const cropSize = cropBox.size * toOriginal;

    console.log(`Cropping: display box ${cropBox.size}px -> original ${Math.round(cropSize)}px -> output 1024px`);

    // Create canvas and crop
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 1024;
    const ctx = canvas.getContext('2d');

    // Draw cropped area scaled to 1024x1024
    ctx.drawImage(
      imageRef.current,
      cropX, cropY, cropSize, cropSize,
      0, 0, 1024, 1024
    );

    const croppedDataUrl = canvas.toDataURL('image/png');
    onConfirm(croppedDataUrl);
  }, [cropBox, displayDimensions, displayScale, onConfirm]);

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 bg-black/80 z-[100] flex flex-col items-center justify-center"
      onClick={(e) => {
        // Only cancel if clicking the backdrop directly — not after drag/resize
        if (e.target === containerRef.current && !wasInteractingRef.current) onCancel();
      }}
    >
      {/* Header text */}
      <div className="text-center mb-6 px-8">
        <h2 className="text-xl font-semibold text-white mb-2">
          Crop Your Image
        </h2>
        <p className="text-gray-300 text-sm max-w-md">
          Select the square area you want to work with. The system works best with square images
          to ensure accurate layer analysis and segmentation.
        </p>
      </div>

      {/* Image container with crop box */}
      <div
        className="relative rounded-lg overflow-hidden"
        style={{ width: displayDimensions.width, height: displayDimensions.height }}
      >
        {/* Original image */}
        <img
          ref={imageRef}
          src={imageDataUrl}
          alt="Upload"
          className="absolute top-0 left-0"
          style={{ width: displayDimensions.width, height: displayDimensions.height }}
          onLoad={() => setImageLoaded(true)}
        />

        {/* Dark overlay with cutout for crop area using clip-path */}
        {imageLoaded && (
          <div
            className="absolute inset-0 bg-black/60 pointer-events-none"
            style={{
              clipPath: `polygon(
                0% 0%,
                0% 100%,
                ${cropBox.x - displayDimensions.offsetX}px 100%,
                ${cropBox.x - displayDimensions.offsetX}px ${cropBox.y - displayDimensions.offsetY}px,
                ${cropBox.x - displayDimensions.offsetX + cropBox.size}px ${cropBox.y - displayDimensions.offsetY}px,
                ${cropBox.x - displayDimensions.offsetX + cropBox.size}px ${cropBox.y - displayDimensions.offsetY + cropBox.size}px,
                ${cropBox.x - displayDimensions.offsetX}px ${cropBox.y - displayDimensions.offsetY + cropBox.size}px,
                ${cropBox.x - displayDimensions.offsetX}px 100%,
                100% 100%,
                100% 0%
              )`
            }}
          />
        )}

        {/* Crop box border and handles */}
        {imageLoaded && (
          <div
            className="absolute border-2 border-white cursor-move"
            style={{
              left: cropBox.x - displayDimensions.offsetX,
              top: cropBox.y - displayDimensions.offsetY,
              width: cropBox.size,
              height: cropBox.size,
            }}
            onMouseDown={(e) => handleMouseDown(e, 'drag')}
          >
            {/* Corner resize handles — all 4 are interactive */}
            <div
              className="absolute -right-2 -bottom-2 w-5 h-5 bg-white rounded-full cursor-se-resize shadow-lg border-2 border-blue-500"
              onMouseDown={(e) => handleMouseDown(e, 'resize', 'se')}
            />
            <div
              className="absolute -left-2 -top-2 w-5 h-5 bg-white rounded-full cursor-nw-resize shadow-lg border-2 border-blue-500"
              onMouseDown={(e) => handleMouseDown(e, 'resize', 'nw')}
            />
            <div
              className="absolute -right-2 -top-2 w-5 h-5 bg-white rounded-full cursor-ne-resize shadow-lg border-2 border-blue-500"
              onMouseDown={(e) => handleMouseDown(e, 'resize', 'ne')}
            />
            <div
              className="absolute -left-2 -bottom-2 w-5 h-5 bg-white rounded-full cursor-sw-resize shadow-lg border-2 border-blue-500"
              onMouseDown={(e) => handleMouseDown(e, 'resize', 'sw')}
            />

            {/* Grid lines (rule of thirds) */}
            <div className="absolute inset-0 pointer-events-none">
              <div className="absolute left-1/3 top-0 bottom-0 w-px bg-white/40" />
              <div className="absolute left-2/3 top-0 bottom-0 w-px bg-white/40" />
              <div className="absolute top-1/3 left-0 right-0 h-px bg-white/40" />
              <div className="absolute top-2/3 left-0 right-0 h-px bg-white/40" />
            </div>

            {/* Size indicator with quality warning */}
            <div className={`absolute -bottom-10 left-1/2 transform -translate-x-1/2 px-3 py-1.5 rounded text-xs font-medium ${
              isLowQuality ? 'bg-yellow-500 text-black' : 'bg-green-600 text-white'
            }`}>
              {actualCropSize} × {actualCropSize}px
              {isLowQuality && ` (${qualityPercent}% quality)`}
            </div>
          </div>
        )}
      </div>

      {/* Quality warning */}
      {imageLoaded && isLowQuality && (
        <div className="mt-4 px-4 py-2 bg-yellow-500/20 border border-yellow-500 rounded-lg max-w-md text-center">
          <p className="text-yellow-300 text-sm">
            <strong>Low resolution warning:</strong> Your selection is {actualCropSize}px,
            which will be upscaled to 1024px. For best segmentation results,
            try selecting a larger area or use a higher resolution image.
          </p>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-4 mt-6">
        <button
          onClick={onCancel}
          className="px-6 py-2.5 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleConfirm}
          disabled={!imageLoaded}
          className="px-6 py-2.5 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Confirm Crop
        </button>
      </div>
    </div>
  );
};

export default ImageCropOverlay;
