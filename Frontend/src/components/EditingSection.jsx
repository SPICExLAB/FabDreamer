import React, {
  useState,
  useCallback,
  useEffect,
  useRef,
  forwardRef,
  useMemo,
  useImperativeHandle,
  lazy,
  Suspense,
} from 'react';
import { Stage, Layer, Transformer, Image as KonvaImage } from 'react-konva';
import useImage from 'use-image';
import SegmentedEntityWrapper from './SegmentedEntityWrapper';
import OutFrame from './EditingSection/OutFrame';
import { updateLayerState } from './EditingSection/layerUtils';

// Ghost segment for see-through mode — renders a non-interactive, semi-transparent image
const GhostSegment = React.memo(({ segment }) => {
  const [image] = useImage(segment.styledSvg || segment.svgUrl);
  if (!image) return null;

  const cropConfig = segment.crop ? {
    x: segment.crop.x,
    y: segment.crop.y,
    width: segment.crop.width,
    height: segment.crop.height,
  } : undefined;

  return (
    <KonvaImage
      image={image}
      x={segment.x || 0}
      y={segment.y || 0}
      width={segment.width}
      height={segment.height}
      scaleX={segment.scaleX || 1}
      scaleY={segment.scaleY || 1}
      rotation={segment.rotation || 0}
      crop={cropConfig}
      opacity={0.25}
      listening={false}
    />
  );
});

const SegmentEditingSection = lazy(() =>
  import('./EditingSection/SegmentEditingSection')
);
const LayerToolBar = lazy(() => import('./EditingSection/LayerToolBar'));

const MIN_STROKE_WIDTH = 20;

// Helper to check if clicked point is on a transparent pixel of an image
const isClickOnTransparentPixel = (shape, pointerPos) => {
  // Only check for Image nodes
  if (shape.getClassName() !== 'Image') {
    return false;
  }

  const image = shape.image();
  if (!image) return false;

  // Get the position relative to the shape
  const transform = shape.getAbsoluteTransform().copy().invert();
  const localPos = transform.point(pointerPos);

  // Account for crop if any
  const crop = shape.crop() || { x: 0, y: 0 };
  const pixelX = Math.floor(localPos.x + crop.x);
  const pixelY = Math.floor(localPos.y + crop.y);

  // Check bounds
  if (pixelX < 0 || pixelY < 0 || pixelX >= image.width || pixelY >= image.height) {
    return true; // Out of bounds = transparent
  }

  // Create temp canvas to read pixel data
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);

  try {
    const pixelData = ctx.getImageData(pixelX, pixelY, 1, 1).data;
    const alpha = pixelData[3];
    return alpha < 10; // Threshold for "transparent" (0-255)
  } catch (e) {
    // CORS issue - fall back to bounding box
    return false;
  }
};

const EditingSection = forwardRef(
  (
    {
      className,
      style,
      activeLayer,
      images,
      setImages,
      layers,
      setLayers,
      editingSectionSize,
      onRepairSegment,
      onSubSegment,
      processingRepairId,  // ID of segment currently being repaired (for freeze UI)
    },
    ref
  ) => {
    const [selectedSegments, setSelectedSegments] = useState([]); // Array for multi-select
    const [operations, setOperations] = useState([]);
    const [currentOperationIndex, setCurrentOperationIndex] = useState(-1);
    const [isFrameSelected, setIsFrameSelected] = useState(false);
    const [scaleIndicator, setScaleIndicator] = useState('3%');
    const [isLoading, setIsLoading] = useState(false);
    const [seeThrough, setSeeThrough] = useState(false);

    // For backward compatibility - single selected segment (first one or null)
    const selectedSegment = selectedSegments.length === 1 ? selectedSegments[0] : null;
    const setSelectedSegment = useCallback((seg) => {
      setSelectedSegments(seg ? [seg] : []);
    }, []);

    // Determine if we should show single-segment toolbar
    // Hide when: multiple selected, or the single selected is being processed
    const showSingleSegmentToolbar = selectedSegments.length === 1 &&
      selectedSegments[0]?.id !== processingRepairId;

    const canUndo = currentOperationIndex > -1;
    const canRedo = currentOperationIndex < operations.length - 1;

    const containerRef = useRef(null);
    const stageRef = useRef(null);
    const transformerRef = useRef(null);
    const toolbarRef = useRef(null);
    const frameRef = useRef(null);
    const clipboardRef = useRef(null); // Segment clipboard for Cmd+C/V

    // Keyboard shortcuts: Cmd+C (copy), Cmd+V (paste), Backspace/Delete
    useEffect(() => {
      const handleKeyDown = (e) => {
        // Skip if typing in an input
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        const isMeta = e.metaKey || e.ctrlKey;

        // Cmd+C — copy selected segment(s) to clipboard
        if (isMeta && e.key === 'c' && selectedSegments.length > 0) {
          e.preventDefault();
          clipboardRef.current = {
            segments: selectedSegments.map((seg) => ({ ...seg })),
            sourceLayerId: activeLayer,
          };
          return;
        }

        // Cmd+V — paste from clipboard into active layer
        if (isMeta && e.key === 'v' && clipboardRef.current?.segments?.length > 0) {
          e.preventDefault();
          const targetLayerId = activeLayer;
          if (!targetLayerId) return;

          const isSameLayer = clipboardRef.current.sourceLayerId === targetLayerId;
          const offset = isSameLayer ? 20 : 0;

          setLayers((prev) => {
            const newLayers = prev.map((layer) => {
              if (layer.id !== targetLayerId) return layer;
              const pasted = clipboardRef.current.segments.map((seg) => ({
                ...seg,
                id: `${seg.id}-paste-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                x: (seg.x || 0) + offset,
                y: (seg.y || 0) + offset,
              }));
              const frameSegs = pasted.filter(s => s.isFrame);
              const nonFrameSegs = pasted.filter(s => !s.isFrame);
              // If pasting a frame segment, auto-disable the default frame
              const disableDefaultFrame = frameSegs.length > 0 && layer.isFrameActive;
              return {
                ...layer,
                segments: [...frameSegs, ...layer.segments, ...nonFrameSegs],
                isFrameActive: disableDefaultFrame ? false : layer.isFrameActive,
              };
            });
            return newLayers;
          });
          return;
        }

        // Backspace / Delete — remove selected segment(s)
        if ((e.key === 'Backspace' || e.key === 'Delete') && selectedSegments.length > 0) {
          e.preventDefault();
          const idsToDelete = new Set(selectedSegments.map((s) => s.id));
          setLayers((prev) =>
            prev.map((layer) => ({
              ...layer,
              segments: layer.segments.filter((seg) => !idsToDelete.has(seg.id)),
            }))
          );
          setSelectedSegments([]);
          return;
        }
      };

      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }, [selectedSegments, activeLayer, setLayers]);

    useImperativeHandle(ref, () => ({
      getStageRef: () => stageRef.current,
      getBoundingClientRect: () => containerRef.current.getBoundingClientRect(),
    }));

    const memoizedLayers = useMemo(() => layers, [layers]);
    const activeLayerData = useMemo(
      () => memoizedLayers.find((layer) => layer.id === activeLayer),
      [memoizedLayers, activeLayer]
    );
    const { isFrameActive, frameShape } = activeLayerData || {};

    const addOperation = useCallback(
      (operation) => {
        setOperations((prevOperations) => [
          ...prevOperations.slice(0, currentOperationIndex + 1),
          operation,
        ]);
        setCurrentOperationIndex((prevIndex) => prevIndex + 1);
      },
      [currentOperationIndex]
    );

    const handleUndo = useCallback(() => {
      if (canUndo) {
        const prevOperation = operations[currentOperationIndex];
        prevOperation.undo();
        setCurrentOperationIndex((prevIndex) => prevIndex - 1);
      }
    }, [canUndo, operations, currentOperationIndex]);

    const handleRedo = useCallback(() => {
      if (canRedo) {
        const nextOperation = operations[currentOperationIndex + 1];
        nextOperation.redo();
        setCurrentOperationIndex((prevIndex) => prevIndex + 1);
      }
    }, [canRedo, operations, currentOperationIndex]);

    const handleDragStart = useCallback((segment) => {
      // Only change selection if dragged segment is not already selected
      // This preserves group selection when dragging
      setSelectedSegments((prev) => {
        const isAlreadySelected = prev.some(s => s.id === segment.id);
        if (isAlreadySelected) {
          return prev; // Keep existing selection
        }
        return [segment]; // Single select if not in group
      });
    }, []);

    const handleDragMove = useCallback(
      (e) => {
        const node = e.target;
        const segmentId = node.id();

        const newPosition = {
          x: node.x(),
          y: node.y(),
        };
        // Update selected segments if the dragged segment is in selection
        setSelectedSegments((prev) =>
          prev.map((seg) =>
            seg.id === segmentId ? { ...seg, ...newPosition } : seg
          )
        );
      },
      []
    );

    const handleDragEnd = useCallback(
      (e) => {
        const node = e.target;
        const segmentId = node.id();

        const finalPosition = {
          x: node.x(),
          y: node.y(),
          scaleX: node.scaleX(),
          scaleY: node.scaleY(),
          rotation: node.rotation(),
        };

        // Use functional update to avoid stale state with multi-select
        setLayers((prevLayers) => {
          const updatedLayers = updateLayerState(
            prevLayers,
            segmentId,
            finalPosition,
            activeLayer
          );

          // Add operation for undo/redo (capture both states)
          addOperation({
            undo: () => setLayers(prevLayers),
            redo: () => setLayers(updatedLayers),
          });

          return updatedLayers;
        });

        // Update selection state - works for both single and multi-select
        setSelectedSegments((prev) =>
          prev.map((seg) =>
            seg.id === segmentId ? { ...seg, ...finalPosition } : seg
          )
        );

        // Force stage update to ensure all changes are reflected
        stageRef.current.batchDraw();
      },
      [setLayers, activeLayer, addOperation]
    );

    const handleTransformEnd = useCallback(
      (e) => {
        const node = e.target;
        const segmentId = node.id();

        const updatedProps = {
          x: node.x(),
          y: node.y(),
          scaleX: node.scaleX(),
          scaleY: node.scaleY(),
          rotation: node.rotation(),
        };

        // Use functional update to avoid stale state with multi-select
        setLayers((prevLayers) => {
          const updatedLayers = updateLayerState(
            prevLayers,
            segmentId,
            updatedProps,
            activeLayer
          );

          // Add operation for undo/redo (capture both states)
          addOperation({
            undo: () => setLayers(prevLayers),
            redo: () => setLayers(updatedLayers),
          });

          return updatedLayers;
        });

        // Update selection state - works for both single and multi-select
        setSelectedSegments((prev) =>
          prev.map((seg) =>
            seg.id === segmentId ? { ...seg, ...updatedProps } : seg
          )
        );

        // Force stage update to ensure all changes are reflected
        stageRef.current?.batchDraw();
      },
      [setLayers, activeLayer, addOperation]
    );

    const handleFrameTransform = useCallback(
      (e) => {
        const { strokeWidth: newStrokeWidth } = e.target;
        const finalStrokeWidth = Math.max(MIN_STROKE_WIDTH, newStrokeWidth);
        setLayers((prevLayers) =>
          prevLayers.map((layer) =>
            layer.id === activeLayer
              ? { ...layer, frameStrokeWidth: finalStrokeWidth }
              : layer
          )
        );
      },
      [activeLayer, setLayers]
    );

    const handleFrameToggle = useCallback(
      (isActive) => {
        setLayers((prevLayers) =>
          prevLayers.map((layer) =>
            layer.id === activeLayer
              ? { ...layer, isFrameActive: isActive }
              : layer
          )
        );
      },
      [activeLayer, setLayers]
    );

    const handleShapeChange = useCallback(
      (shape) => {
        setLayers((prevLayers) =>
          prevLayers.map((layer) =>
            layer.id === activeLayer ? { ...layer, frameShape: shape } : layer
          )
        );
      },
      [activeLayer, setLayers]
    );

    const handleFrameSelect = useCallback(() => {
      setIsFrameSelected(true);
      setSelectedSegments([]);
    }, []);

    // Handle segment selection with shift support for multi-select
    const handleSegmentSelect = useCallback((segment, e) => {
      const isShiftKey = e?.evt?.shiftKey || e?.shiftKey || false;

      if (isShiftKey) {
        // Shift+click: toggle segment in selection
        setSelectedSegments(prev => {
          const isAlreadySelected = prev.some(s => s.id === segment.id);
          if (isAlreadySelected) {
            // Remove from selection
            return prev.filter(s => s.id !== segment.id);
          } else {
            // Add to selection
            return [...prev, segment];
          }
        });
      } else {
        // Regular click: single select
        setSelectedSegments([segment]);
      }
      setIsFrameSelected(false);
    }, []);

    const handleGlobalClick = useCallback(
      (e) => {
        if (stageRef.current) {
          const stage = stageRef.current;
          const container = stage.getContainer();
          const clickedInsideStage = container.contains(e.target);

          if (clickedInsideStage) {
            const pointerPosition = stage.getPointerPosition();

            // Get all shapes at the click position
            let shape = null;
            const allShapes = stage.getAllIntersections(pointerPosition);

            // First pass: check if ANY shape is a Transformer handle (highest priority)
            for (const s of allShapes) {
              if (s.getParent() === transformerRef.current) {
                shape = s;
                break;
              }
            }

            // Second pass: if not a Transformer handle, find topmost non-transparent segment
            // Iterate in reverse since getAllIntersections returns back-to-front order
            if (!shape) {
              for (let i = allShapes.length - 1; i >= 0; i--) {
                const s = allShapes[i];
                if (s.getParent() === transformerRef.current) continue;
                if (isClickOnTransparentPixel(s, pointerPosition)) continue;
                shape = s;
                break;
              }
            }

            const isClickOnSegmentTransformer =
              shape && shape.getParent() === transformerRef.current;
            const isClickOnSelectedSegment =
              selectedSegments.length > 0 && shape &&
              selectedSegments.some(s => s.id === shape.attrs?.id);
            const isClickOnFrameGroup =
              shape &&
              (shape === frameRef.current ||
                shape.getParent() === frameRef.current);

            if (isClickOnFrameGroup) {
              setIsFrameSelected(true);
              setSelectedSegments([]);
            } else if (isClickOnSegmentTransformer) {
              // Keep current selection when clicking on transformer handles
            } else if (isClickOnSelectedSegment && !e.shiftKey) {
              // Clicking on already-selected segment without shift - keep selection for drag
              // This allows dragging groups without breaking the selection
            } else if (shape && shape.attrs.id) {
              // Find the actual segment object from the layer's segments
              const clickedSegment = activeLayerData?.segments?.find(
                (seg) => seg.id === shape.attrs.id
              );
              if (clickedSegment) {
                // Pass event for shift key detection
                handleSegmentSelect(clickedSegment, e);
              }
            } else {
              // Clicked on empty space - clear selection (unless shift held)
              if (!e.shiftKey) {
                setSelectedSegments([]);
                setIsFrameSelected(false);
              }
            }
          } else {
            const isClickOnToolbar =
              toolbarRef.current && toolbarRef.current.contains(e.target);

            if (!isClickOnToolbar && !e.shiftKey) {
              setSelectedSegments([]);
              setIsFrameSelected(false);
            }
          }
        }
      },
      [selectedSegments, handleSegmentSelect, activeLayerData]
    );

    useEffect(() => {
      document.addEventListener('mousedown', handleGlobalClick);
      return () => document.removeEventListener('mousedown', handleGlobalClick);
    }, [handleGlobalClick]);

    // Sync selectedSegments with current layer data (e.g., after repair updates segment)
    // This keeps the selection references fresh so the Transformer effect re-runs.
    const activeLayerSegments = useMemo(() => {
      const layer = layers.find((l) => l.id === activeLayer);
      return layer?.segments || [];
    }, [layers, activeLayer]);

    useEffect(() => {
      if (selectedSegments.length === 0) return;

      let changed = false;
      const updated = selectedSegments.map((sel) => {
        const current = activeLayerSegments.find((s) => s.id === sel.id);
        if (current && current !== sel) {
          changed = true;
          return current;
        }
        // Segment no longer in layer (deleted) — drop from selection
        if (!current) {
          changed = true;
          return null;
        }
        return sel;
      }).filter(Boolean);

      if (changed) {
        setSelectedSegments(updated);
      }
    }, [activeLayerSegments]);

    // Update transformer nodes when selection changes (supports multi-select)
    // Also re-runs when activeLayerSegments changes to re-attach after node recreation (e.g., repair)
    useEffect(() => {
      if (selectedSegments.length > 0 && transformerRef.current && stageRef.current) {
        const selectedNodes = selectedSegments
          .map(seg => stageRef.current.findOne(`#${seg.id}`))
          .filter(Boolean);

        if (selectedNodes.length > 0) {
          transformerRef.current.nodes(selectedNodes);
          transformerRef.current.getLayer().batchDraw();
        } else {
          // Nodes not found yet (image still loading after repair) — retry shortly
          const timer = setTimeout(() => {
            if (!stageRef.current || !transformerRef.current) return;
            const retryNodes = selectedSegments
              .map(seg => stageRef.current.findOne(`#${seg.id}`))
              .filter(Boolean);
            if (retryNodes.length > 0) {
              transformerRef.current.nodes(retryNodes);
              transformerRef.current.getLayer().batchDraw();
            }
          }, 200);
          return () => clearTimeout(timer);
        }
      } else if (transformerRef.current) {
        transformerRef.current.nodes([]);
        transformerRef.current.getLayer()?.batchDraw();
      }
    }, [selectedSegments, activeLayerSegments]);

    const frameProps = useMemo(() => {
      if (!activeLayerData) return null;

      return {
        isFrameActive: activeLayerData.isFrameActive ?? true,
        currentShape: activeLayerData.frameShape ?? 'squareOutline',
        strokeWidth: activeLayerData.frameStrokeWidth ?? MIN_STROKE_WIDTH,
        editingSectionSize: editingSectionSize,
        onTransformEnd: handleFrameTransform,
        onSelect: handleFrameSelect,
        isSelected: isFrameSelected,
        onScaleChange: setScaleIndicator,
      };
    }, [
      activeLayerData,
      editingSectionSize,
      handleFrameTransform,
      handleFrameSelect,
      isFrameSelected,
    ]);

    // Ghost segments from layers below active layer (see-through mode)
    const ghostSegments = useMemo(() => {
      if (!seeThrough || !activeLayer) return [];
      const activeIdx = layers.findIndex((l) => l.id === activeLayer);
      if (activeIdx < 0) return [];
      // Layers after activeIdx are "below" (rendered behind in the stack)
      return layers
        .slice(activeIdx + 1)
        .filter((l) => l.isVisible)
        .flatMap((l) => l.segments.filter((s) => !s.isFrame));
    }, [seeThrough, layers, activeLayer]);

    const memoizedSegments = useMemo(() => {
      const activeLayerData = layers.find((layer) => layer.id === activeLayer);
      return activeLayerData
        ? activeLayerData.segments.map((segment) => {
            // Check if this segment is being processed (sub-segment request in flight)
            const isProcessing = processingRepairId === segment.id;
            // Check if segment is in the selection array
            const isSelected = selectedSegments.some(s => s.id === segment.id);

            return (
              <SegmentedEntityWrapper
                key={segment.id}
                entity={{
                  ...segment,
                  id: segment.id,
                  currentStyle: segment.currentStyle || 'original',
                }}
                images={images}
                scaleX={segment.scaleX}
                scaleY={segment.scaleY}
                isInEditingSection={true}
                onDragStart={isProcessing ? null : handleDragStart}
                onDragMove={isProcessing ? null : handleDragMove}
                onDragEnd={isProcessing ? null : handleDragEnd}
                onTransformEnd={isProcessing ? null : handleTransformEnd}
                isSelected={!isProcessing && isSelected}
                // NOTE: onClick removed - selection is handled by handleGlobalClick
                // to prevent double-firing (mousedown + click would toggle twice)
                onUnselect={() => setSelectedSegments([])}
                stageWidth={editingSectionSize.width}
                stageHeight={editingSectionSize.height}
                isSubSegmenting={isProcessing}
              />
            );
          })
        : [];
    }, [
      images,
      layers,
      activeLayer,
      selectedSegments,
      editingSectionSize,
      handleDragStart,
      handleDragMove,
      handleDragEnd,
      handleTransformEnd,
      processingRepairId,
    ]);

    return (
      <div
        className={`${className} editing-section relative rounded-lg`}
        style={{
          ...style,
          background: `
        linear-gradient(45deg, #f0f0f0 25%, transparent 25%),
        linear-gradient(-45deg, #f0f0f0 25%, transparent 25%),
        linear-gradient(45deg, transparent 75%, #f0f0f0 75%),
        linear-gradient(-45deg, transparent 75%, #f0f0f0 75%)
      `,
          backgroundSize: '40px 40px',
          backgroundPosition: '0 0, 0 20px, 20px -20px, -20px 0px',
          boxShadow: `
        inset 0 0 10px rgba(0,0,0,0.2),
        inset 0 0 20px rgba(0,0,0,0.1),
        inset 0 0 30px rgba(0,0,0,0.05)
      `,
        }}
        ref={containerRef}
      >
        <Stage
          ref={stageRef}
          width={editingSectionSize.width}
          height={editingSectionSize.height}
        >
          {/* Ghost layer: see-through segments from layers below */}
          {seeThrough && ghostSegments.length > 0 && (
            <Layer listening={false}>
              {ghostSegments.map((seg) => (
                <GhostSegment key={`ghost-${seg.id}`} segment={seg} />
              ))}
            </Layer>
          )}
          <Layer>
            {frameProps && <OutFrame ref={frameRef} {...frameProps} />}
          </Layer>
          <Layer>{memoizedSegments}</Layer>
          <Layer>
            <Transformer
              ref={transformerRef}
              boundBoxFunc={(oldBox, newBox) =>
                newBox.width < 5 || newBox.height < 5 ? oldBox : newBox
              }
              rotateEnabled={true}
              enabledAnchors={[
                'top-left',
                'top-right',
                'bottom-left',
                'bottom-right',
              ]}
              padding={8}
            />
          </Layer>
        </Stage>
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-50 z-10">
            <div className="animate-spin rounded-full h-32 w-32 border-t-2 border-b-2 border-white"></div>
          </div>
        )}
        {/* Spinner overlay for processing segment */}
        {processingRepairId && (() => {
          // Find the segment in the active layer
          const segment = activeLayerData?.segments?.find(s => s.id === processingRepairId);
          if (!segment) return null;

          // Calculate spinner position (center of segment)
          const segX = segment.x || 0;
          const segY = segment.y || 0;
          const segW = (segment.width || 100) * (segment.scaleX || 1);
          const segH = (segment.height || 100) * (segment.scaleY || 1);
          const centerX = segX + segW / 2;
          const centerY = segY + segH / 2;

          return (
            <div
              className="absolute pointer-events-none z-20"
              style={{
                left: centerX - 16,
                top: centerY - 16,
              }}
            >
              <div className="animate-spin rounded-full h-8 w-8 border-2 border-blue-500 border-t-transparent"></div>
            </div>
          );
        })()}
        <Suspense fallback={<div>Loading...</div>}>
          <div ref={toolbarRef}>
            {/* Show single-segment toolbar only when one segment selected and not sub-segmenting */}
            {showSingleSegmentToolbar && (
              <SegmentEditingSection
                selectedSegment={selectedSegment}
                layers={layers}
                activeLayer={activeLayer}
                setLayers={setLayers}
                setSelectedSegment={setSelectedSegment}
                addOperation={addOperation}
                onRepairSegment={onRepairSegment}
                onSubSegment={onSubSegment}
              />
            )}
            {/* Show group indicator when multiple segments selected */}
            {selectedSegments.length > 1 && (
              <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 bg-white rounded-full shadow-[0px_10px_30px_rgba(0,0,0,0.15)] px-4 py-2 flex items-center space-x-2 z-10">
                <span className="text-sm text-gray-600">
                  {selectedSegments.length} segments selected
                </span>
                <span className="text-xs text-gray-400">
                  (move, rotate, resize)
                </span>
              </div>
            )}
          </div>
          {layers.length > 0 && (
            <LayerToolBar
              canUndo={currentOperationIndex > -1}
              canRedo={currentOperationIndex < operations.length - 1}
              onUndo={handleUndo}
              onRedo={handleRedo}
              onFrameToggle={handleFrameToggle}
              onShapeChange={handleShapeChange}
              currentShape={frameShape}
              isFrameActive={isFrameActive}
              scaleIndicator={scaleIndicator}
              seeThrough={seeThrough}
              onSeeThroughToggle={() => setSeeThrough((v) => !v)}
            />
          )}
        </Suspense>
      </div>
    );
  }
);

const applyBoundaryConstraints = (boundaries, node, editingSectionSize) => {
  let newX = node.x();
  let newY = node.y();

  if (boundaries.x < 0) newX -= boundaries.x;
  if (boundaries.y < 0) newY -= boundaries.y;
  if (boundaries.x + boundaries.width > editingSectionSize.width) {
    newX -= boundaries.x + boundaries.width - editingSectionSize.width;
  }
  if (boundaries.y + boundaries.height > editingSectionSize.height) {
    newY -= boundaries.y + boundaries.height - editingSectionSize.height;
  }

  return { newX, newY };
};

export default React.memo(EditingSection);
