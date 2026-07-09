import React, { useEffect, useState, useCallback } from 'react';
import FinalPreview from './FinalPreview/FinalPreview';
import SlicingOverlay from './FinalPreview/SlicingOverlay';
import PhysicalPropertyBar from './FinalPreview/PhysicalPropertyBar';
import woodTextureImage from './FinalPreview/vecteezy_pine-wooden-board-texture-surface-table-top_47508175.jpg';
import { IoResize } from 'react-icons/io5';

const FinalPreviewSection = ({
  className,
  rightColumnWidth,
  totalHeight,
  visibleLayers,
  updateQueue,
  clearUpdateQueue,
  layerPreviews,
  activeLayerId,
  isFabricationMode = false,
  highlightedSegment = null,
  drawBridgeMode = null,
  onBridgeDrawn = null,
}) => {
  const [isTextureLoading, setIsTextureLoading] = useState(true);
  //const [isLayerProcessing, setIsLayerProcessing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [size, setSize] = useState(rightColumnWidth);
  const [startPos, setStartPos] = useState({ x: 0, y: 0 });
  const [scaleRatio, setScaleRatio] = useState(1);
  //   const processingLayersRef = useRef(new Set());
  //   const prevUpdateQueueRef = useRef([]);

  useEffect(() => {
    setSize(rightColumnWidth);
    setScaleRatio(1);
  }, [rightColumnWidth]);

  const handleMouseDown = (e) => {
    e.preventDefault();
    setIsDragging(true);
    setStartPos({ x: e.clientX, y: e.clientY });
  };

  const handleMouseMove = useCallback(
    (e) => {
      if (isDragging) {
        const deltaX = startPos.x - e.clientX;
        const newSize = rightColumnWidth * scaleRatio + deltaX;
        const constrainedSize = Math.max(
          rightColumnWidth,
          Math.min(newSize, totalHeight)
        );

        setSize(constrainedSize);
      }
    },
    [isDragging, scaleRatio, rightColumnWidth, startPos, totalHeight]
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    setScaleRatio(size / rightColumnWidth);
  }, [size, rightColumnWidth]);

  useEffect(() => {
    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    } else {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, handleMouseMove, handleMouseUp]);

  useEffect(() => {
    const image = new Image();
    image.src = woodTextureImage;
    image.onload = () => {
      setIsTextureLoading(false);
    };
    image.onerror = () => {
      console.error('Failed to load wood texture');
      setIsTextureLoading(false);
    };
  }, []);

  const renderContent = () => {
    if (isTextureLoading) {
      return (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-200 z-10">
          <p className="text-sm font-semibold text-gray-600">
            Loading polywood texture...
          </p>
        </div>
      );
    }

    if (visibleLayers.length === 0) {
      return (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-200 z-10">
          <p className="text-sm font-semibold text-gray-600">
            Add a layer to view effect
          </p>
        </div>
      );
    }

    return (
      <>
        <FinalPreview
          visibleLayers={visibleLayers}
          layerPreviews={layerPreviews}
          woodTextureUrl={woodTextureImage}
          activeLayerId={activeLayerId}
          updateQueue={updateQueue}
          clearUpdateQueue={clearUpdateQueue}
          isFabricationMode={isFabricationMode}
          highlightedSegment={highlightedSegment}
          drawBridgeMode={drawBridgeMode}
          onBridgeDrawn={onBridgeDrawn}
        />
        {/* Fabrication mode overlays */}
        {isFabricationMode && (
          <>
            <SlicingOverlay />
            <PhysicalPropertyBar />
          </>
        )}
      </>
    );
  };

  // In fabrication mode: fill container, no absolute positioning
  // In editing mode: floating preview with resize handle
  if (isFabricationMode) {
    return (
      <div
        className="relative w-full h-full"
        style={{
          boxShadow: '0 -2px 20px rgba(0, 0, 0, 0.05), 0 5px 10px rgba(0, 0, 0, 0.1)',
        }}
      >
        {renderContent()}
      </div>
    );
  }

  return (
    <div
      className="relative"
      style={{
        width: size,
        height: size,
        bottom: 0,
        right: 0,
        position: 'absolute',
        boxShadow:
          '0 -2px 20px rgba(0, 0, 0, 0.05), 0 5px 10px rgba(0, 0, 0, 0.1)',
      }}
    >
      {renderContent()}
      {visibleLayers.length > 0 && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            cursor: 'nwse-resize',
            transform: 'rotate(90deg)',
            color: 'gray',
          }}
          onMouseDown={handleMouseDown}
        >
          <IoResize size={20} />
        </div>
      )}
    </div>
  );
};

export default FinalPreviewSection;
