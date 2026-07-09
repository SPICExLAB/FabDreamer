import React, { useMemo, useCallback, forwardRef, useState, useEffect, useRef } from 'react';
import { Stage, Layer, Image } from 'react-konva';
import Konva from 'konva';
import SegmentedEntityWrapper from './SegmentedEntityWrapper';
import { LiaFileExportSolid } from 'react-icons/lia';

const SegmentSection = forwardRef(
  (
    {
      className,
      style,
      currentImageIndex,
      currentImage,
      images,
      setImages,
      draggedEntity,
      setDraggedEntity,
      isSegmenting,
      containerSize,
      onAutoLayers,
      traceProgress,
      segmentedImages,
      segmentedImageEditingStates,
      activeSegmentedIndex,
      onSwitchImage,
    },
    ref
  ) => {
    const [isProcessing, setIsProcessing] = useState(false);
    const restImageRef = useRef(null);

    // Get the source type for the current segmented image
    const currentSource = segmentedImages?.[activeSegmentedIndex]?.source;

    // Apply grayscale filter to rest image only for 'grab' path
    // For 'analyze' path, just use opacity (no grayscale)
    useEffect(() => {
      if (restImageRef.current) {
        restImageRef.current.cache();
        if (currentSource === 'grab') {
          // Grab path: grayscale + reduced opacity
          restImageRef.current.filters([Konva.Filters.Grayscale]);
        } else {
          // Analyze path: no filter, just opacity (set on the Image component)
          restImageRef.current.filters([]);
        }
        restImageRef.current.getLayer()?.batchDraw();
      }
    }, [currentImage?.restImage, currentSource]);

    const [scaleX, scaleY] = useMemo(() => {
      if (
        currentImage &&
        currentImage.originalWidth &&
        currentImage.originalHeight
      ) {
        return [
          containerSize.width / currentImage.originalWidth,
          containerSize.height / currentImage.originalHeight,
        ];
      }
      return [1, 1];
    }, [currentImage, containerSize]);

    const handleDragStart = useCallback(
      (segment, e) => {
        console.log('Drag started:', segment.id);

        const dragScale = 0.8;

        setDraggedEntity({
          ...segment,
          svgUrl: segment.svgUrl,
          originalSection: 'segment',
          scale: dragScale,
          width: segment.width * scaleX,
          height: segment.height * scaleY,
          initialMouseX: e.evt.clientX,
          initialMouseY: e.evt.clientY,
        });
      },
      [scaleX, scaleY, setDraggedEntity]
    );

    const checkDragging = (segment) => {
      return draggedEntity && draggedEntity.id === segment.id;
    };

    const consistentStyle = {
      ...style,
      boxShadow: `
        inset 0 0 10px rgba(0,0,0,0.2),
        inset 0 0 20px rgba(0,0,0,0.1),
        inset 0 0 30px rgba(0,0,0,0.05)
      `,
    };

    const handleAutoLayersClick = useCallback(() => {
      setIsProcessing(true);
      onAutoLayers();
      // Assume processing is done after 5 seconds (adjust as needed)
      setTimeout(() => setIsProcessing(false), 5000);
    }, [onAutoLayers]);

    const renderContent = () => {
      if (isSegmenting) {
        return (
          <div className="flex items-center">
            <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mr-2"></div>
            <span>Segmenting image...</span>
          </div>
        );
      }

      if (!currentImage || !currentImage.segments) {
        return <span>No image available</span>;
      }

      return (
        <Stage width={containerSize.width} height={containerSize.height}>
          <Layer>
            {currentImage.restImage && (
              <Image
                ref={restImageRef}
                image={currentImage.restImage}
                width={containerSize.width}
                height={containerSize.height}
                opacity={0.6}
              />
            )}
            {/* Render in REVERSE order so layer 1 (front) is rendered LAST = on top in Konva */}
            {[...currentImage.segments].reverse().map((segment) => (
              <SegmentedEntityWrapper
                images={images}
                key={`segment-${segment.id}`}
                entity={segment}
                scaleX={scaleX}
                scaleY={scaleY}
                onDragStart={handleDragStart}
                isInEditingSection={false}
                isDragging={checkDragging(segment)}
                isTracing={traceProgress?.isGenerating && !segment.svg_trace}
              />
            ))}
          </Layer>
        </Stage>
      );
    };

    return (
      <div
        className={`${className} flex items-center justify-center rounded-lg overflow-hidden relative`}
        style={consistentStyle}
        ref={ref}
      >
        {renderContent()}

        {/* Image switcher bar - show when there are 2+ segmented images */}
        {segmentedImages && segmentedImages.length > 1 && (
          <div className="absolute bottom-2 left-1/2 transform -translate-x-1/2 z-10">
            <div className="bg-white/90 backdrop-blur-sm rounded-full shadow-lg px-3 py-1.5 flex items-center space-x-2">
              {segmentedImages.map((img, index) => {
                const isEditing = segmentedImageEditingStates?.[index] || false;
                const isActive = index === (activeSegmentedIndex ?? currentImageIndex);
                return (
                  <button
                    key={img.id || index}
                    onClick={() => onSwitchImage?.(index)}
                    className={`relative w-8 h-8 rounded-full overflow-hidden transition-all ${
                      isEditing
                        ? 'ring-[3px] ring-green-500 ring-offset-1'
                        : isActive
                          ? 'ring-2 ring-blue-500 ring-offset-1'
                          : 'border-2 border-transparent hover:border-gray-300'
                    }`}
                    title={`Image ${index + 1}${isEditing ? ' (Editing)' : ''}`}
                  >
                    {img.originalImage?.dataUrl ? (
                      <img
                        src={img.originalImage.dataUrl}
                        alt={`Segmented ${index + 1}`}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full bg-gray-200 flex items-center justify-center text-xs">
                        {index + 1}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Auto-Layers button - only show for 'analyze' path images (not grab) */}
        {currentImage && currentImage.segments &&
         segmentedImages?.[activeSegmentedIndex]?.source !== 'grab' && (
          <div className="absolute top-2 right-2">
            <div className="bg-white rounded-lg shadow-[0px_10px_30px_rgba(0,0,0,0.15)] p-2 flex flex-col items-center space-y-2">
              <button
                className={`text-blue-500 hover:text-blue-700 font-medium flex items-center justify-center w-full ${
                  isProcessing || traceProgress?.isGenerating ? 'opacity-50 cursor-not-allowed' : ''
                }`}
                onClick={handleAutoLayersClick}
                disabled={isProcessing || traceProgress?.isGenerating}
              >
                {isProcessing || traceProgress?.isGenerating ? (
                  <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mr-2"></div>
                ) : (
                  <LiaFileExportSolid className="mr-1" size={20} />
                )}
                <span>
                  {isProcessing ? 'Processing...' :
                   traceProgress?.isGenerating ?
                     `Tracing ${traceProgress.completed}/${traceProgress.total}...` :
                     'Auto-Layers'}
                </span>
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }
);

export default React.memo(SegmentSection);
