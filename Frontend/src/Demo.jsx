import React, { useState, useEffect, useRef, useCallback } from 'react';
import SegmentSection from './components/SegmentSection';
import EditingSection from './components/EditingSection';
import LayerSection from './components/LayerSection';
import FinalPreviewSection from './components/FinalPreviewSection';
import DraggedEntity from './components/DraggedEntity';
import { ConversationPanel } from './components/ConversationPanel';
import ImageCropOverlay from './components/ImageCropOverlay';
import PipelineSteps from './components/PipelineSteps';
import FabricationPanel from './components/FabricationPanel';
import { DragDropContext } from '@hello-pangea/dnd';
import { LayerManager, useLayerManager } from './components/LayerManager';
import { useConversation, STATES } from './hooks/useConversation';
import { generateTraceForSegment } from './utils/generateTrace';

// Sanitize names for use in Konva node IDs (spaces break findOne('#id') selector)
const sanitizeForId = (name) => name.replace(/\s+/g, '-');

const loadImage = (src) => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
};

const Demo = () => {
  // Layout and sizing
  const [sizes, setSizes] = useState({ 
    width: 0, 
    height: 0,
    square: 0,
    editingWidth: 0,
    leftColumnWidth: 0,
    rightColumnWidth: 0,
    totalHeight: 0,
    contentWidth: 0,
  });

  // Segmented images for the segment panel
  const [images, setImages] = useState([]);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);

  // Drag management
  const [draggedEntity, setDraggedEntity] = useState(null);

  // Highlighted segment for fabrication agent clicks
  const [highlightedSegment, setHighlightedSegment] = useState(null);

  // Draw bridge mode (from fabrication chat → 3D view)
  const [drawBridgeMode, setDrawBridgeMode] = useState(null);
  const bridgeDrawnCallbackRef = useRef(null);

  // Refs
  const appRef = useRef(null);
  const editingSectionRef = useRef(null);
  const segmentSectionRef = useRef(null);

  // Layer manager context
  const {
    layers,
    setLayers,
    layerPreviews,
    visibleLayers,
    activeLayer,
    setActiveLayer,
    addLayer,
    deleteLayer,
    setEditingSize,
    reorderLayers,
    uiMode,
    setUiMode,
    fabricationScale,
    exportForFabrication,
    fabLayers,
    setFabLayers,
    fabLayerPreviews,
  } = useLayerManager();

  // Conversation hook
  const conversation = useConversation();
  const {
    messages,
    state,
    currentImage,
    processedSegments,
    segmentedImages,
    activeSegmentedIndex,
    traceProgress,
    lastPrompt,
    modifyLayerMode,
    grabElementMode,
    grabMoreMode,
    subSegmentMode,
    startSubSegmentMode,
    cancelSubSegmentMode,
    subSegmentResult,
    processingSubSegmentId,
    clearSubSegmentResult,
    submitRepair,
    processingRepairId,
    repairResult,
    clearRepairResult,
    pendingUpload,
    isCropping,
    generateImage,
    selectImage,
    regenerateSingleImage,
    regenerateAllImages,
    updateImage,
    handleImageUpload,
    cancelCrop,
    handleCroppedImage,
    analyzeLayers,
    processSegments,
    redoSegmentation,
    redoFromLayer,
    startEditing,
    exitEditingMode,
    deleteGrabbedElement,
    startModifyLayerMode,
    cancelModifyLayerMode,
    startGrabElementMode,
    startGrabMoreMode,
    cancelGrabElementMode,
    redoGrab,
    handleUserInput,
    switchSegmentedImage,
    getSegmentedImageEditingStates,
    loadTestData,
  } = conversation;

  // DEV test flow (Ctrl+Shift+T): chains load → editing → auto layers → fabrication.
  // Steps: 'enterEditing' → 'autoLayers' → 'enterFabrication' → null (done)
  const [testFlowStep, setTestFlowStep] = useState(null);

  // DEV: Ctrl+T to load test data; Ctrl+Shift+T to load and jump straight to Step 3
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.ctrlKey && (e.key === 't' || e.key === 'T')) {
        e.preventDefault();
        if (e.shiftKey) {
          console.log('Loading test data (direct to Step 3)...');
          setTestFlowStep('enterEditing');
        } else {
          console.log('Loading test data...');
          setTestFlowStep(null);
        }
        loadTestData();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [loadTestData]);

  // Determine if we're in editing mode (split layout)
  // Only split when user explicitly clicks "Start Editing", not just when segments exist
  const isEditingMode = state === STATES.EDITING_MODE;

  // Check if in fabrication mode (Stage 3)
  const isFabricationMode = uiMode === 'fabrication' && isEditingMode;

  // Exit editing mode when SegmentSection has no images
  useEffect(() => {
    if (isEditingMode && images.length === 0) {
      console.log('SegmentSection empty, exiting editing mode');
      exitEditingMode();
    }
  }, [isEditingMode, images.length, exitEditingMode]);

  // Handle sub-segment result - replace original segment with new sub-segments + rest segment
  useEffect(() => {
    if (!subSegmentResult || !subSegmentResult.success) return;

    const { originalSegment, subSegments, restSegment } = subSegmentResult;

    // Find the layer containing the original segment
    setLayers((prevLayers) => {
      return prevLayers.map((layer) => {
        // Check if this layer contains the original segment
        const segmentIndex = layer.segments.findIndex(
          (seg) => seg.id === originalSegment.id
        );

        if (segmentIndex === -1) return layer;

        // Found the layer! Replace the segment with sub-segments + rest
        const newSegments = [...layer.segments];
        newSegments.splice(segmentIndex, 1); // Remove original

        // Get parent's crop (defines what part of 1024x1024 image is displayed)
        const parentCrop = originalSegment.crop || {
          x: originalSegment.originalX || 0,
          y: originalSegment.originalY || 0,
          width: originalSegment.originalWidth || 1024,
          height: originalSegment.originalHeight || 1024
        };

        // Calculate scale from 1024 coords to display coords
        // Display size = width * scaleX (the actual rendered size)
        // parentCrop.width = size in 1024 coords that gets scaled to display
        const displayWidth = originalSegment.width * (originalSegment.scaleX || 1);
        const displayHeight = originalSegment.height * (originalSegment.scaleY || 1);
        const scaleToDisplayX = displayWidth / parentCrop.width;
        const scaleToDisplayY = displayHeight / parentCrop.height;

        // Debug: log original segment properties
        console.log('[Demo] Sub-segment parent:', {
          width: originalSegment.width,
          height: originalSegment.height,
          scaleX: originalSegment.scaleX,
          scaleY: originalSegment.scaleY,
          originalWidth: originalSegment.originalWidth,
          originalHeight: originalSegment.originalHeight,
          crop: originalSegment.crop,
          parentCrop,
          displayWidth, displayHeight,
          scaleToDisplayX, scaleToDisplayY,
        });

        // Add each sub-segment, converting positions from 0-1000 relative to input PNG
        subSegments.forEach((subSeg, idx) => {
          const [yMin, xMin, yMax, xMax] = subSeg.box_2d;

          // Convert from 0-1000 to 1024 coords
          const subX1024 = (xMin / 1000) * 1024;
          const subY1024 = (yMin / 1000) * 1024;
          const subW1024 = ((xMax - xMin) / 1000) * 1024;
          const subH1024 = ((yMax - yMin) / 1000) * 1024;

          // Position relative to parent's crop origin, scaled to display
          const relX = (subX1024 - parentCrop.x) * scaleToDisplayX;
          const relY = (subY1024 - parentCrop.y) * scaleToDisplayY;
          const subWidth = subW1024 * scaleToDisplayX;
          const subHeight = subH1024 * scaleToDisplayY;

          // Debug: log sub-segment calculations
          console.log(`[Demo] Sub-segment ${idx} (${subSeg.name}):`, {
            box_2d: subSeg.box_2d,
            subX1024, subY1024, subW1024, subH1024,
            relX, relY, subWidth, subHeight,
            finalX: originalSegment.x + relX,
            finalY: originalSegment.y + relY,
          });

          const newSegment = {
            id: `${originalSegment.id}_sub_${idx}`,
            name: subSeg.name,
            // Position: offset from original segment's position
            x: originalSegment.x + relX,
            y: originalSegment.y + relY,
            // Use same pattern as original segments: width=crop.width, then scale
            width: subW1024,
            height: subH1024,
            // Original position in 1024 coords (required for SVG transform calculations)
            originalX: subX1024,
            originalY: subY1024,
            originalWidth: subW1024,
            originalHeight: subH1024,
            // Crop config to extract element from full 1024x1024 image
            crop: { x: subX1024, y: subY1024, width: subW1024, height: subH1024 },
            // Apply same scale as parent to match visual size
            rotation: originalSegment.rotation || 0,
            scaleX: scaleToDisplayX,
            scaleY: scaleToDisplayY,
            // Image data (validate svg is not empty)
            svgUrl: `data:image/png;base64,${subSeg.extracted}`,
            styledSvg: `data:image/png;base64,${subSeg.extracted}`,
            svg: subSeg.svg && subSeg.svg.startsWith('<') ? subSeg.svg : '',
            svg_trace: null,  // Needs trace generation
            mask: subSeg.mask,
            // Inherit style from parent
            engraveStyle: originalSegment.engraveStyle || 'traced',
            currentStyle: 'original',
            needsTrace: true,  // Flag for trace generation
          };

          newSegments.push(newSegment);
        });

        // Add rest segment FIRST (lowest layer - behind apples)
        // The rest PNG is 1024x1024 with content at the SAME position as original segment
        // So we inherit position/size/crop directly from the original segment
        if (restSegment) {
          const restSeg = {
            id: `${originalSegment.id}_rest`,
            name: restSegment.name || 'rest',
            // Same position as original segment (rest replaces original in-place)
            x: originalSegment.x,
            y: originalSegment.y,
            width: originalSegment.width,
            height: originalSegment.height,
            // Inherit original position in 1024 coords (same as parent)
            originalX: originalSegment.originalX,
            originalY: originalSegment.originalY,
            originalWidth: originalSegment.originalWidth,
            originalHeight: originalSegment.originalHeight,
            // Inherit crop from parent (same bounding box in 1024x1024 image)
            crop: originalSegment.crop,
            // Inherit transforms from parent
            rotation: originalSegment.rotation || 0,
            scaleX: originalSegment.scaleX || 1,
            scaleY: originalSegment.scaleY || 1,
            // Image data (validate svg is not empty)
            svgUrl: `data:image/png;base64,${restSegment.extracted}`,
            styledSvg: `data:image/png;base64,${restSegment.extracted}`,
            svg: restSegment.svg && restSegment.svg.startsWith('<') ? restSegment.svg : '',
            svg_trace: null,  // Needs trace generation
            mask: restSegment.mask,
            // Inherit style from parent
            engraveStyle: originalSegment.engraveStyle || 'traced',
            needsTrace: true,  // Flag for trace generation
            currentStyle: 'original',
          };

          // Use unshift to add at beginning (lowest layer = first in array = rendered behind others)
          newSegments.unshift(restSeg);
        }

        const totalNew = subSegments.length + (restSegment ? 1 : 0);
        console.log(`[Demo] Sub-segment: replaced ${originalSegment.name || originalSegment.id} with ${totalNew} segments (${subSegments.length} sub + ${restSegment ? '1 rest at bottom' : 'no rest'})`);

        return {
          ...layer,
          segments: newSegments,
        };
      });
    });

    // Clear the result after handling
    clearSubSegmentResult();
  }, [subSegmentResult, setLayers, clearSubSegmentResult]);

  // Handle repair result — swap segment PNG/SVG with repaired version + update box
  useEffect(() => {
    if (!repairResult || !repairResult.success) return;
    const { segmentId, repairedImage, svg, box_2d } = repairResult;

    setLayers((prev) => prev.map((layer) => ({
      ...layer,
      segments: layer.segments.map((seg) => {
        if (seg.id !== segmentId) return seg;
        const dataUrl = `data:image/png;base64,${repairedImage}`;

        // Recompute crop/position from new box_2d if provided
        // box_2d is [y_min, x_min, y_max, x_max] normalized 0-1000 in 1024x1024 space
        let updatedFields = {};
        if (box_2d && box_2d.length === 4) {
          const [yMin, xMin, yMax, xMax] = box_2d;
          const newOrigX = (xMin / 1000) * 1024;
          const newOrigY = (yMin / 1000) * 1024;
          const newOrigW = ((xMax - xMin) / 1000) * 1024;
          const newOrigH = ((yMax - yMin) / 1000) * 1024;

          // Compensate canvas position so segment doesn't visually jump
          const deltaOrigX = newOrigX - (seg.originalX || 0);
          const deltaOrigY = newOrigY - (seg.originalY || 0);

          updatedFields = {
            originalX: newOrigX,
            originalY: newOrigY,
            originalWidth: newOrigW,
            originalHeight: newOrigH,
            width: newOrigW,
            height: newOrigH,
            crop: { x: newOrigX, y: newOrigY, width: newOrigW, height: newOrigH },
            x: (seg.x || 0) + deltaOrigX,
            y: (seg.y || 0) + deltaOrigY,
          };

          console.log('[Demo] Repair: updated box', {
            old: { x: seg.originalX, y: seg.originalY, w: seg.originalWidth, h: seg.originalHeight },
            new: updatedFields,
          });
        }

        return {
          ...seg,
          ...updatedFields,
          svgUrl: dataUrl,
          styledSvg: dataUrl,
          svg: svg,           // New clean outline SVG
          svg_trace: null,     // Clear — triggers regen
          needsTrace: true,    // Existing Web Worker picks this up
        };
      }),
    })));
    clearRepairResult();
  }, [repairResult, setLayers, clearRepairResult]);

  // Update app size
  useEffect(() => {
    const updateSizes = () => {
      if (appRef.current) {
        const vh = window.innerHeight;
        const vw = window.innerWidth;
        const pipelineBarHeight = 48; // h-12 top bar with title + pipeline steps
        const contentPadding = 32; // p-4 = 16px top + 16px bottom
        const availableHeight = vh - pipelineBarHeight - contentPadding;
        const availableWidth = Math.min(vw - 32, 2400);

        // editingWidth === availableHeight → SQUARE editing section
        const editingWidth = availableHeight;
        const squareSize = availableHeight / 2;
        const columnWidth = squareSize;
        const rightColumnWidth = availableWidth - columnWidth - editingWidth - 32;

        setSizes({
          square: squareSize,
          editingWidth: editingWidth,
          leftColumnWidth: columnWidth,
          rightColumnWidth: rightColumnWidth,
          totalHeight: availableHeight,
          contentWidth: availableWidth,
        });
      }
    };

    window.addEventListener('resize', updateSizes);
    updateSizes();
    return () => window.removeEventListener('resize', updateSizes);
  }, []);

  useEffect(() => {
    setEditingSize(sizes.editingWidth, sizes.totalHeight);
  }, [sizes.editingWidth, sizes.totalHeight, setEditingSize]);

  // Convert processed segments to the format used by SegmentSection
  // Note: Extracted images are full 1024x1024 with element at original position + transparency
  // We use Konva's crop feature to display only the bounding box region
  // MUST be defined before handleConversationAction which uses it
  const convertSegmentsToImage = useCallback(async (segmentsData) => {
    try {
      const segments = [];
      let layerIndex = 0;
      let elementIndex = 0;  // Global element counter for unique IDs
      const timestamp = Date.now();  // Single timestamp for this batch

      for (const layer of segmentsData.layers) {
        for (const elem of layer.elements) {
          const extractedUrl = `data:image/png;base64,${elem.extracted}`;
          const [y_min, x_min, y_max, x_max] = elem.box_2d || [0, 0, 1000, 1000];

          // Convert 0-1000 normalized coords to pixels
          const x = (x_min / 1000) * 1024;
          const y = (y_min / 1000) * 1024;
          const width = ((x_max - x_min) / 1000) * 1024;
          const height = ((y_max - y_min) / 1000) * 1024;

          // Position at bounding box coords, use crop to extract the element from full image
          // Use timestamp + layerIndex + elementIndex for guaranteed unique IDs
          segments.push({
            id: `segment-${timestamp}-${layerIndex}-${elementIndex}-${sanitizeForId(elem.name)}`,
            name: elem.name,
            segmentId: elem.name,
            svgUrl: extractedUrl,
            svg: elem.svg,  // SVG outline for 3D geometry
            svg_trace: elem.svg_trace,  // Generated client-side for engraving
            x,  // Position at bbox location
            y,
            width,  // Display at bbox size
            height,
            originalX: x,
            originalY: y,
            originalWidth: width,
            originalHeight: height,
            // Crop config to extract element from full 1024x1024 image
            crop: { x, y, width, height },
            rotation: 0,
            originalLayerIndex: layerIndex,
            currentStyle: 'original',
            styles: {
              original: extractedUrl,
            },
          });
          elementIndex++;  // Increment for next element
        }
        layerIndex++;
      }

      // Load rest image
      let restImage = null;
      if (segmentsData.rest_image) {
        const restUrl = `data:image/png;base64,${segmentsData.rest_image}`;
        restImage = await loadImage(restUrl);
      }

      return {
        id: `img-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
        raw: conversation.currentImage?.base64,
        segments,
        restImage,
        originalWidth: 1024,
        originalHeight: 1024,
      };
    } catch (error) {
      console.error('Error converting segments:', error);
      return null;
    }
  }, [conversation.currentImage]);

  // Handle action buttons from conversation
  const handleConversationAction = useCallback(async (action) => {
    switch (action) {
      case 'analyze':
        await analyzeLayers();
        break;
      case 'proceed':
        await processSegments();
        break;
      case 'startEditing': {
        // Read segments from message directly (avoids stale processedSegments closure)
        const activeId = conversation.activeImageMessageId;
        const activeMsg = activeId
          ? conversation.messages.find(m => m.id === activeId)
          : conversation.messages.find(m => m.role === 'ai' && m.type === 'image' && m.data.selectedIndex !== null);

        if (activeMsg) {
          const selectedIdx = activeMsg.data.selectedIndex;
          const selectedImg = activeMsg.data.images?.[selectedIdx];

          if (selectedImg?.segments) {
            const segData = {
              layers: selectedImg.segments.layers,
              rest_image: selectedImg.segments.restImage,
            };
            const newImage = await convertSegmentsToImage(segData);
            if (newImage) {
              setImages((prev) => {
                // Dedup: check if already in pool for this message+image
                const existingIdx = prev.findIndex(img =>
                  img.sourceMessageId === activeMsg.id && img.sourceImageIndex === selectedIdx
                );
                if (existingIdx >= 0) {
                  setCurrentImageIndex(existingIdx);
                  return prev;
                }
                const appended = [...prev, {
                  ...newImage,
                  sourceMessageId: activeMsg.id,
                  sourceImageIndex: selectedIdx,
                }];
                setCurrentImageIndex(appended.length - 1);
                return appended;
              });
            }
          }
        }
        // Auto-add a layer if this is the first time entering editing mode (no layers exist)
        if (layers.length === 0) {
          const firstLayer = {
            id: Date.now(),
            name: 'Layer 1',
            isVisible: true,
            segments: [],
            frameStrokeWidth: 20,
            isFrameActive: true,
            frameShape: 'squareOutline',
          };
          addLayer(firstLayer);
        }
        // Now switch to editing mode after data is prepared
        startEditing();
        break;
      }
      case 'retry':
        // Regenerate images with the last prompt
        if (lastPrompt) {
          await generateImage(lastPrompt);
        }
        break;
      case 'modifyLayers':
        // User wants to modify layers via text
        startModifyLayerMode();
        break;
      case 'grabElement':
        // User wants to grab specific elements
        startGrabElementMode();
        break;
      case 'grabMore':
        // User wants to grab more elements from the rest image
        startGrabMoreMode();
        break;
      case 'redo':
        // Full redo = re-run entire segmentation from scratch
        // Behavior should be like initial segmentation:
        // 1. Exit editing mode
        // 2. Clear segment pool
        // 3. Show streaming in chat panel
        // 4. User clicks "Start Editing" when complete
        console.log('[Demo] Full redo - exiting editing mode');

        // Clear SegmentSection state
        setImages([]);
        setCurrentImageIndex(0);

        // Exit editing mode (this also clears segmentedImages pool)
        exitEditingMode();

        // Now run the redo segmentation
        // The streaming will be shown in chat panel via isRedoing state
        const redoResult = await redoSegmentation();
        if (redoResult.success) {
          console.log('[Demo] Full redo complete, user can click Start Editing');
        }
        break;
      default:
        console.log('Unknown action:', action);
    }
  }, [analyzeLayers, processSegments, redoSegmentation, startEditing, exitEditingMode, lastPrompt, generateImage, startModifyLayerMode, startGrabElementMode, startGrabMoreMode, layers, addLayer, convertSegmentsToImage, conversation.messages, conversation.activeImageMessageId]);

  // Handle redo from a specific layer - re-segment that layer and all layers below (higher layer numbers)
  // Note: Gemini API has inherent randomness, so each redo may produce different results
  const handleRedoFromLayer = useCallback(async (layerNum) => {
    console.log('Redo from layer:', layerNum);

    const result = await redoFromLayer(layerNum);

    if (result.success) {
      console.log(`Redo successful: ${result.layers?.length || 0} layers after redo`);

      // Sync images state with new redo data
      if (result.layers) {
        const redoSegmentsData = {
          layers: result.layers,
          rest_image: result.rest_image,
        };
        const newImage = await convertSegmentsToImage(redoSegmentsData);
        if (newImage) {
          setImages(prev => {
            const updated = [...prev];
            updated[currentImageIndex] = {
              ...updated[currentImageIndex],
              segments: newImage.segments,
              restImage: newImage.restImage,
            };
            return updated;
          });
          console.log('[Demo] Updated images after redo from layer', layerNum);
        }
      }
    } else {
      console.error('Redo failed:', result.error);
      alert(`Redo failed: ${result.error || 'Unknown error'}`);
    }
  }, [redoFromLayer, convertSegmentsToImage, currentImageIndex]);

  // Handle redo of a single layer only (no cascade to subsequent layers)
  const handleRedoSingleLayer = useCallback(async (layerNum) => {
    console.log('Redo single layer:', layerNum);

    const result = await redoFromLayer(layerNum, true);

    if (result.success) {
      console.log(`Single layer redo successful: ${result.layers?.length || 0} layers`);

      if (result.layers) {
        const redoSegmentsData = {
          layers: result.layers,
          rest_image: result.rest_image,
        };
        const newImage = await convertSegmentsToImage(redoSegmentsData);
        if (newImage) {
          setImages(prev => {
            const updated = [...prev];
            updated[currentImageIndex] = {
              ...updated[currentImageIndex],
              segments: newImage.segments,
              restImage: newImage.restImage,
            };
            return updated;
          });
          console.log('[Demo] Updated images after single layer redo', layerNum);
        }
      }
    } else {
      console.error('Single layer redo failed:', result.error);
      alert(`Redo failed: ${result.error || 'Unknown error'}`);
    }
  }, [redoFromLayer, convertSegmentsToImage, currentImageIndex]);

  // Sync segmentedImages pool changes to displayed images (for Grab More and Redo)
  // When the active segmented image's layers change, append only the NEW elements
  useEffect(() => {
    const activeSegImage = segmentedImages[activeSegmentedIndex];
    if (!activeSegImage || !isEditingMode || images.length === 0) return;

    const displayedImage = images[currentImageIndex];
    if (!displayedImage?.segments) return;

    const allPoolElements = activeSegImage.layers.flatMap(l => l.elements);
    const poolElementCount = allPoolElements.length;
    const displayedElementCount = displayedImage.segments.length;

    // If pool has more elements, append only the new ones (existing segments stay untouched)
    if (poolElementCount > displayedElementCount) {
      console.log(`[sync] Appending ${poolElementCount - displayedElementCount} new element(s) to display`);

      // New elements are at the end of the merged array (mergedElements = [...old, ...new])
      const newElements = allPoolElements.slice(displayedElementCount);
      newElements.forEach((elem, i) => {
        console.log(`[sync] New element[${i}]: name=${elem.name}, svg=${elem.svg ? elem.svg.length + ' chars' : 'MISSING'}, extracted=${elem.extracted ? 'yes' : 'MISSING'}, box_2d=${JSON.stringify(elem.box_2d)}`);
      });
      const timestamp = Date.now();

      const convertAndAppend = async () => {
        // Convert only the new elements to display format
        const newSegments = newElements.map((elem, idx) => {
          const extractedUrl = `data:image/png;base64,${elem.extracted}`;
          const [y_min, x_min, y_max, x_max] = elem.box_2d || [0, 0, 1000, 1000];
          const x = (x_min / 1000) * 1024;
          const y = (y_min / 1000) * 1024;
          const width = ((x_max - x_min) / 1000) * 1024;
          const height = ((y_max - y_min) / 1000) * 1024;

          return {
            id: `segment-${timestamp}-0-${displayedElementCount + idx}-${sanitizeForId(elem.name)}`,
            name: elem.name,
            segmentId: elem.name,
            svgUrl: extractedUrl,
            svg: elem.svg,
            svg_trace: elem.svg_trace,
            x,
            y,
            width,
            height,
            originalX: x,
            originalY: y,
            originalWidth: width,
            originalHeight: height,
            crop: { x, y, width, height },
            rotation: 0,
            originalLayerIndex: 0,
            currentStyle: 'original',
            styles: { original: extractedUrl },
          };
        });

        // Load updated rest image (element was removed from it)
        let restImage = displayedImage.restImage;
        if (activeSegImage.restImage) {
          try {
            const restUrl = `data:image/png;base64,${activeSegImage.restImage}`;
            restImage = await loadImage(restUrl);
          } catch (e) {
            console.warn('[sync] Failed to load updated rest image:', e);
          }
        }

        setImages(prev => {
          const updated = [...prev];
          updated[currentImageIndex] = {
            ...updated[currentImageIndex],
            segments: [...updated[currentImageIndex].segments, ...newSegments],
            restImage,
          };
          return updated;
        });
      };
      convertAndAppend();
    }
  }, [segmentedImages, activeSegmentedIndex, isEditingMode, images, currentImageIndex]);

  // Sync svg_trace updates from segmentedImages to displayed image segments
  // This runs when trace generation completes in background
  useEffect(() => {
    const activeSegImage = segmentedImages[activeSegmentedIndex];
    if (!activeSegImage || !isEditingMode || images.length === 0) return;

    const displayedImage = images[currentImageIndex];
    if (!displayedImage?.segments) return;

    // Check if any element in pool has svg_trace that display doesn't have
    let needsUpdate = false;
    const elemTraceMap = new Map();

    activeSegImage.layers?.forEach((layer) => {
      layer.elements?.forEach((elem) => {
        if (elem.svg_trace) {
          elemTraceMap.set(elem.name, elem.svg_trace);
        }
      });
    });

    displayedImage.segments.forEach((seg) => {
      if (!seg.svg_trace && elemTraceMap.has(seg.segmentId)) {
        needsUpdate = true;
      }
    });

    if (needsUpdate) {
      console.log('[Demo] Syncing svg_trace updates to displayed segments');
      setImages((prev) => {
        const updated = [...prev];
        updated[currentImageIndex] = {
          ...updated[currentImageIndex],
          segments: updated[currentImageIndex].segments.map((seg) => {
            const trace = elemTraceMap.get(seg.segmentId);
            if (trace && !seg.svg_trace) {
              return { ...seg, svg_trace: trace };
            }
            return seg;
          }),
        };
        return updated;
      });
    }

    // Also sync traces into editing-layer segment copies. Normal drag is gated
    // on trace readiness, but Auto Layers (and the dev test flow) copy segments
    // into layers before traces finish — without this, those copies would never
    // receive their engrave paths.
    const layersNeedUpdate = layers.some((layer) =>
      layer.segments?.some(
        (seg) => !seg.isFrame && !seg.svg_trace && elemTraceMap.has(seg.segmentId)
      )
    );
    if (layersNeedUpdate) {
      console.log('[Demo] Syncing svg_trace updates to layer segments');
      setLayers((prevLayers) =>
        prevLayers.map((layer) => ({
          ...layer,
          segments: layer.segments.map((seg) => {
            const trace = elemTraceMap.get(seg.segmentId);
            return !seg.isFrame && trace && !seg.svg_trace
              ? { ...seg, svg_trace: trace }
              : seg;
          }),
        }))
      );
    }
  }, [segmentedImages, activeSegmentedIndex, isEditingMode, images, currentImageIndex, layers, setLayers]);

  // Generate traces for segments with needsTrace flag (sub-segments from sub_segment operation)
  // Runs in background and updates layers when complete
  useEffect(() => {
    // Collect all segments that need tracing across all layers
    const segmentsToTrace = [];

    layers.forEach((layer) => {
      layer.segments?.forEach((seg) => {
        if (seg.needsTrace && seg.styledSvg && !seg.svg_trace) {
          segmentsToTrace.push({
            layerId: layer.id,
            segmentId: seg.id,
            pngDataUrl: seg.styledSvg, // styledSvg is already a data URL
          });
        }
      });
    });

    if (segmentsToTrace.length === 0) return;

    console.log(`[Demo] Generating traces for ${segmentsToTrace.length} sub-segments`);

    // Generate traces in parallel
    segmentsToTrace.forEach(async ({ layerId, segmentId, pngDataUrl }) => {
      try {
        const result = await generateTraceForSegment(pngDataUrl, segmentId);
        console.log(`[Demo] Trace generated for ${segmentId} (${result.pathCount} paths)`);

        // Update the segment with svg_trace and clear needsTrace
        setLayers((prevLayers) =>
          prevLayers.map((layer) => {
            if (layer.id !== layerId) return layer;

            return {
              ...layer,
              segments: layer.segments.map((seg) => {
                if (seg.id !== segmentId) return seg;
                return {
                  ...seg,
                  svg_trace: result.svgTrace,
                  needsTrace: false,
                };
              }),
            };
          })
        );
      } catch (error) {
        console.warn(`[Demo] Trace generation failed for ${segmentId}:`, error);
        // Mark as done even on failure to prevent infinite retries
        setLayers((prevLayers) =>
          prevLayers.map((layer) => {
            if (layer.id !== layerId) return layer;

            return {
              ...layer,
              segments: layer.segments.map((seg) => {
                if (seg.id !== segmentId) return seg;
                return { ...seg, needsTrace: false };
              }),
            };
          })
        );
      }
    });
  }, [layers, setLayers]);

  // Handle entity drag end
  const handleDraggedEntityDragEnd = useCallback(
    async (segment, pos) => {
      const editingSectionRect = editingSectionRef.current?.getBoundingClientRect();
      if (!editingSectionRect) return;

      const isInEditingSection =
        pos.x >= editingSectionRect.left &&
        pos.x <= editingSectionRect.right &&
        pos.y >= editingSectionRect.top &&
        pos.y <= editingSectionRect.bottom;

      if (isInEditingSection) {
        const originalImage = images[currentImageIndex];
        if (!originalImage) return;

        const scaleX = sizes.editingWidth / originalImage.originalWidth;
        const scaleY = sizes.totalHeight / originalImage.originalHeight;

        const newSegment = {
          ...segment,
          id: `${segment.id}-edit-${Date.now()}`,
          x: segment.originalX * scaleX,
          y: segment.originalY * scaleY,
          width: segment.originalWidth,
          height: segment.originalHeight,
          scaleX: scaleX,
          scaleY: scaleY,
          crop: segment.crop,  // Preserve crop config for full-size images
          rotation: 0,
          styledSvg: segment.styles['original'],
          styles: {},
        };

        setLayers((prevLayers) => {
          const updatedLayers = prevLayers.map((layer) =>
            layer.id === activeLayer
              ? {
                  ...layer,
                  segments: [...layer.segments, newSegment],
                  frameStrokeWidth: layer.frameStrokeWidth || 20,
                  isFrameActive: layer.isFrameActive !== undefined ? layer.isFrameActive : true,
                  frameShape: layer.frameShape || 'squareOutline',
                }
              : layer
          );
          return updatedLayers;
        });
      }
      setDraggedEntity(null);
    },
    [images, currentImageIndex, sizes, activeLayer, setLayers]
  );

  // Handle auto layers
  // Creates editing layers from segmented elements, ordering back-to-front for proper 3D rendering
  const handleAutoLayers = useCallback(async () => {
    const currentImage = images[currentImageIndex];
    if (!currentImage || !currentImage.segments) return;

    // Group segments by their layer index
    const segmentGroups = currentImage.segments.reduce((groups, segment) => {
      const index = segment.originalLayerIndex;
      if (!groups[index]) groups[index] = [];
      groups[index].push(segment);
      return groups;
    }, {});

    const scaleX = sizes.editingWidth / currentImage.originalWidth;
    const scaleY = sizes.totalHeight / currentImage.originalHeight;

    // Get layer indices and sort in DESCENDING order (back to front)
    // L2 (back/clouds) should be rendered first, then L1 (front/lilypad)
    // This ensures proper 3D layering: back layers at the bottom, front layers on top
    const layerIndices = Object.keys(segmentGroups)
      .map(Number)
      .sort((a, b) => b - a); // Descending: [2, 1, 0] -> renders back layer first

    for (const layerIndex of layerIndices) {
      const segments = segmentGroups[layerIndex];
      const updatedSegments = segments.map((segment) => ({
        ...segment,
        id: `${segment.id}-edit-${Date.now()}`,
        x: segment.originalX * scaleX,
        y: segment.originalY * scaleY,
        width: segment.originalWidth,
        height: segment.originalHeight,
        scaleX,
        scaleY,
        crop: segment.crop,  // Preserve crop config for full-size images
        rotation: 0,
        styledSvg: segment.styles['original'],
        styles: {},
      }));

      // Use 1-based layer numbering to match segment layer numbers (L1, L2, etc.)
      const layerNum = layerIndex + 1;
      const newLayer = {
        id: `auto-layer-${Date.now()}-${layerIndex}`,
        name: `Layer ${layerNum}`,
        isVisible: true,
        segments: updatedSegments,
        frameStrokeWidth: 20,
        isFrameActive: true,
        frameShape: 'squareOutline',
      };

      addLayer(newLayer);
      setActiveLayer(newLayer.id);
    }
  }, [images, currentImageIndex, sizes, addLayer, setActiveLayer]);

  // DEV test flow step 1: segments loaded → enter editing mode (same path as the button)
  useEffect(() => {
    if (testFlowStep !== 'enterEditing' || state !== STATES.SEGMENTS_READY) return;
    setTestFlowStep('autoLayers');
    handleConversationAction('startEditing');
  }, [testFlowStep, state, handleConversationAction]);

  // DEV test flow step 2: editing mode ready with segments in pool → auto-build layers
  useEffect(() => {
    if (testFlowStep !== 'autoLayers' || state !== STATES.EDITING_MODE) return;
    const img = images[currentImageIndex];
    if (!img?.segments?.length || sizes.editingWidth <= 0) return;
    setTestFlowStep('enterFabrication');
    handleAutoLayers();
  }, [testFlowStep, state, images, currentImageIndex, sizes.editingWidth, handleAutoLayers]);

  // DEV test flow step 3: layers populated and previews composed → switch to fabrication (Step 3)
  useEffect(() => {
    if (testFlowStep !== 'enterFabrication') return;
    const populated = layers.filter((l) => l.segments.length > 0);
    if (populated.length === 0) return;
    // Drop the empty starter layer that the startEditing action auto-creates
    if (populated.length !== layers.length) {
      setLayers(populated);
      return;
    }
    // Wait until every layer has a composed preview before bridging to Stage 3
    if (!layers.every((l) => layerPreviews[l.id]?.svg)) return;
    setTestFlowStep(null);
    console.log('[TestFlow] Entering fabrication mode with', layers.length, 'layers');
    setUiMode('fabrication');
  }, [testFlowStep, layers, layerPreviews, setLayers, setUiMode]);

  // Layer reorder handler
  const onLayerSetDragEnd = (result) => {
    if (!result.destination) return;
    const items = Array.from(layers);
    const [reorderedItem] = items.splice(result.source.index, 1);
    items.splice(result.destination.index, 0, reorderedItem);
    reorderLayers(items);
  };

  // Render left column based on mode
  const renderLeftColumn = () => {
    if (!isEditingMode) {
      // Full chat mode - conversation takes full left column
      return (
        <ConversationPanel
          messages={messages}
          state={state}
          modifyLayerMode={modifyLayerMode}
          onCancelModifyMode={cancelModifyLayerMode}
          grabElementMode={grabElementMode}
          grabMoreMode={grabMoreMode}
          onCancelGrabMode={cancelGrabElementMode}
          subSegmentMode={subSegmentMode}
          onCancelSubSegmentMode={cancelSubSegmentMode}
          onSendMessage={handleUserInput}
          onImageUpload={handleImageUpload}
          onAction={handleConversationAction}
          onSelectImage={selectImage}
          onRegenerateSingle={regenerateSingleImage}
          onRegenerateAll={regenerateAllImages}
          onUpdateImage={updateImage}
          segmentedImages={segmentedImages}
          onDeleteElement={deleteGrabbedElement}
          onRedoFromLayer={handleRedoFromLayer}
          onRedoSingleLayer={handleRedoSingleLayer}
          onRedoGrab={redoGrab}
          isCompact={false}
          style={{ width: sizes.leftColumnWidth, height: sizes.totalHeight }}
        />
      );
    }

    // Split mode - segment section on top, chat fills remaining space
    const chatHeight = sizes.totalHeight - sizes.square - 16; // 16px for gap
    return (
      <>
        <SegmentSection
          className="bg-white flex-shrink-0"
          style={{ width: sizes.square, height: sizes.square }}
          ref={segmentSectionRef}
          isSegmenting={false}
          images={images}
          setImages={setImages}
          currentImageIndex={currentImageIndex}
          currentImage={images[currentImageIndex]}
          draggedEntity={draggedEntity}
          setDraggedEntity={setDraggedEntity}
          containerSize={{ width: sizes.square, height: sizes.square }}
          onAutoLayers={handleAutoLayers}
          traceProgress={traceProgress}
          segmentedImages={segmentedImages}
          segmentedImageEditingStates={getSegmentedImageEditingStates()}
          activeSegmentedIndex={activeSegmentedIndex}
          onSwitchImage={async (index) => {
            switchSegmentedImage(index);

            // Find the matching images entry by source identity, not array index
            const segImg = segmentedImages[index];
            if (!segImg) return;

            const matchIdx = images.findIndex(
              (img) => img.sourceMessageId === segImg.sourceMessageId
                    && img.sourceImageIndex === segImg.sourceImageIndex
            );

            if (matchIdx >= 0) {
              // Already in images pool — just switch to it
              setCurrentImageIndex(matchIdx);
            } else {
              // Not in images pool yet — create from segmented image data
              const segData = {
                layers: segImg.layers,
                rest_image: segImg.restImage,
              };
              const newImage = await convertSegmentsToImage(segData);
              if (newImage) {
                setImages((prev) => {
                  // Double-check it wasn't added while we awaited
                  const existingIdx = prev.findIndex(
                    (img) => img.sourceMessageId === segImg.sourceMessageId
                          && img.sourceImageIndex === segImg.sourceImageIndex
                  );
                  if (existingIdx >= 0) {
                    setCurrentImageIndex(existingIdx);
                    return prev;
                  }
                  const appended = [...prev, {
                    ...newImage,
                    sourceMessageId: segImg.sourceMessageId,
                    sourceImageIndex: segImg.sourceImageIndex,
                  }];
                  setCurrentImageIndex(appended.length - 1);
                  return appended;
                });
              }
            }
          }}
        />
        <ConversationPanel
          messages={messages}
          state={state}
          modifyLayerMode={modifyLayerMode}
          onCancelModifyMode={cancelModifyLayerMode}
          grabElementMode={grabElementMode}
          grabMoreMode={grabMoreMode}
          onCancelGrabMode={cancelGrabElementMode}
          subSegmentMode={subSegmentMode}
          onCancelSubSegmentMode={cancelSubSegmentMode}
          onSendMessage={handleUserInput}
          onImageUpload={handleImageUpload}
          onAction={handleConversationAction}
          onSelectImage={selectImage}
          onRegenerateSingle={regenerateSingleImage}
          onRegenerateAll={regenerateAllImages}
          onUpdateImage={updateImage}
          segmentedImages={segmentedImages}
          onDeleteElement={deleteGrabbedElement}
          onRedoFromLayer={handleRedoFromLayer}
          onRedoSingleLayer={handleRedoSingleLayer}
          onRedoGrab={redoGrab}
          activeImageMessageId={conversation.activeImageMessageId}
          isCompact={true}
          expandedHeight={sizes.totalHeight}
          style={{ width: sizes.square, height: chatHeight }}
        />
      </>
    );
  };


  // Layer thumbnail size - fixed at 40px for editing mode
  const layerThumbSize = 40;

  return (
    <div
      ref={appRef}
      className="flex flex-col h-screen bg-white overflow-hidden"
    >
      {/* Top bar: title centered over left column, pipeline steps centered over editing section */}
      <div className="h-12 flex items-center px-4 relative z-50">
        <PipelineSteps
          isEditingMode={isEditingMode}
          hasConversationContent={messages.length > 0}
          leftColumnWidth={sizes.leftColumnWidth}
          editingWidth={sizes.editingWidth}
        />
      </div>

      <div className="flex-1 flex items-center justify-center p-4 overflow-hidden">
        {/* Sliding container - all elements in a row, slide left for fabrication mode */}
        <div
          className="flex items-stretch gap-4 transition-transform duration-500 ease-in-out relative"
          style={{
            height: sizes.totalHeight,
            transform: isFabricationMode
              ? `translateX(-${sizes.leftColumnWidth + 16}px)`
              : 'translateX(0)',
          }}
        >
          {/* Column 1: Chat/Segment (x) - hidden in fabrication mode via slide */}
          <div
            className={`flex flex-col relative flex-shrink-0 ${isEditingMode ? 'gap-4' : ''}`}
            style={{
              width: sizes.leftColumnWidth,
              height: '100%',
            }}
          >
            {renderLeftColumn()}
          </div>

          {/* Column 2: Editing Section / 3D View (2x) - content swaps with opacity */}
          <div
            className="flex-shrink-0 relative"
            style={{
              width: sizes.editingWidth,
              height: '100%',
            }}
          >
            {/* Stage 1 overlay - dims editing section before editing mode */}
            {!isEditingMode && (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-white/60 rounded-lg backdrop-blur-[1px]">
                <div className="text-center text-gray-400 px-8">
                  <div className="text-4xl mb-2">✨</div>
                  <p className="text-sm">Complete segmentation to start editing</p>
                </div>
              </div>
            )}

            {/* Editing Section - fades out in fabrication mode */}
            <div
              className={`absolute inset-0 transition-opacity duration-500 ${
                isFabricationMode ? 'opacity-0 pointer-events-none z-0' : 'opacity-100 z-10'
              } ${!isEditingMode ? 'opacity-40' : ''}`}
            >
              <EditingSection
                className="bg-gray-300 editing-section"
                style={{ width: sizes.editingWidth, height: '100%' }}
                ref={editingSectionRef}
                activeLayer={activeLayer}
                images={images}
                setImages={setImages}
                layers={layers}
                setLayers={setLayers}
                editingSectionSize={{
                  width: sizes.editingWidth,
                  height: sizes.totalHeight,
                }}
                onRepairSegment={submitRepair}
                onSubSegment={startSubSegmentMode}
                processingRepairId={processingRepairId}
              />
            </div>

            {/* 3D View - fades in in fabrication mode */}
            <div
              className={`absolute inset-0 transition-opacity duration-500 ${
                isFabricationMode ? 'opacity-100 z-10' : 'opacity-0 pointer-events-none z-0'
              }`}
            >
              <FinalPreviewSection
                className="bg-gray-200 rounded-lg overflow-hidden shadow-lg"
                rightColumnWidth={sizes.editingWidth}
                totalHeight={sizes.totalHeight}
                visibleLayers={visibleLayers}
                layerPreviews={isFabricationMode ? (fabLayerPreviews || layerPreviews) : layerPreviews}
                activeLayerId={activeLayer ? activeLayer.id : null}
                isFabricationMode={isFabricationMode}
                highlightedSegment={highlightedSegment}
                drawBridgeMode={drawBridgeMode}
                onBridgeDrawn={(...args) => {
                  if (bridgeDrawnCallbackRef.current) {
                    bridgeDrawnCallbackRef.current(...args);
                  }
                }}
              />
            </div>
          </div>

          {/* Column 3: LayerSection (rest) - content changes based on mode */}
          <div
            className="flex flex-col flex-shrink-0 relative"
            style={{ width: sizes.rightColumnWidth, height: '100%' }}
          >
            {/* Stage 1 overlay - dims layer section before editing mode */}
            {!isEditingMode && (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-white/60 rounded-lg backdrop-blur-[1px]">
                <div className="text-center text-gray-400 px-4">
                  <div className="text-3xl mb-2">📦</div>
                  <p className="text-xs">Layers & Preview</p>
                </div>
              </div>
            )}

            {isFabricationMode ? (
              // Fabrication mode: full height LayerSection with compact mode
              <div className="h-full bg-white rounded-lg shadow-[0px_10px_30px_rgba(0,0,0,0.15)] overflow-hidden">
                <DragDropContext onDragEnd={onLayerSetDragEnd}>
                  <div className="h-full p-4">
                    <LayerSection
                      style={{ width: sizes.rightColumnWidth - 32 }}
                      layers={fabLayers || layers}
                      setLayers={fabLayers ? setFabLayers : setLayers}
                      setActiveLayer={setActiveLayer}
                      activeLayer={activeLayer}
                      showAddButton={false}
                      layerPreviews={fabLayerPreviews || layerPreviews}
                      deleteLayer={deleteLayer}
                      addLayer={addLayer}
                      thumbnailSize={Math.round((sizes.rightColumnWidth - 64) * 0.8)}
                      showExportButton={true}
                      compactMode={true}
                    />
                  </div>
                </DragDropContext>
              </div>
            ) : (
              // Editing mode: LayerSection on top, 3D preview on bottom
              // 3D preview is always square (width = rightColumnWidth), layer section scrolls above it
              <div className={`flex flex-col h-full ${!isEditingMode ? 'opacity-40' : ''}`}>
                <div className="flex-1 min-h-0 overflow-visible">
                  <div className="h-full bg-white rounded-lg shadow-[0px_10px_30px_rgba(0,0,0,0.15)] overflow-visible mb-4">
                    <DragDropContext onDragEnd={onLayerSetDragEnd}>
                      <div className="p-4 overflow-y-auto" style={{ maxHeight: `calc(100% - 8px)` }}>
                        <LayerSection
                          style={{ width: sizes.rightColumnWidth }}
                          layers={layers}
                          setLayers={setLayers}
                          setActiveLayer={setActiveLayer}
                          activeLayer={activeLayer}
                          showAddButton={images.length > 0 || isEditingMode}
                          layerPreviews={layerPreviews}
                          deleteLayer={deleteLayer}
                          addLayer={addLayer}
                          thumbnailSize={layerThumbSize}
                        />
                      </div>
                    </DragDropContext>
                  </div>
                </div>

                <div
                  className="flex-shrink-0"
                  style={{
                    width: sizes.rightColumnWidth,
                    height: sizes.rightColumnWidth,
                    position: 'relative',
                    zIndex: 30,
                  }}
                >
                  <FinalPreviewSection
                    className="bg-white rounded-lg overflow-hidden relative"
                    rightColumnWidth={sizes.rightColumnWidth}
                    totalHeight={sizes.totalHeight}
                    visibleLayers={visibleLayers}
                    layerPreviews={layerPreviews}
                    activeLayerId={activeLayer ? activeLayer.id : null}
                    highlightedSegment={highlightedSegment}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Column 4: TODOs Panel (x) - absolutely positioned, slides in with the container */}
          <div
            className={`absolute top-0 transition-opacity duration-500 ${
              isFabricationMode ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}
            style={{
              width: sizes.leftColumnWidth,
              height: '100%',
              left: sizes.leftColumnWidth + sizes.editingWidth + sizes.rightColumnWidth + 48, // After all 3 columns + gaps
            }}
          >
            <FabricationPanel
              style={{ width: '100%', height: '100%' }}
              layerData={{ layers: fabLayers || layers, fabrication: { scale: fabricationScale }, canvasSize: { width: sizes.editingWidth, height: sizes.totalHeight } }}
              setLayerData={fabLayers ? setFabLayers : setLayers}
              isFabricationMode={isFabricationMode}
              onHighlightLayer={(layerId) => {
                const layer = layers.find(l => l.id === layerId);
                if (layer) setActiveLayer(layer);
              }}
              onHighlightPart={(layerId, segmentId) => {
                const layer = layers.find(l => l.id === layerId);
                if (layer) {
                  setActiveLayer(layer);
                  setHighlightedSegment({ layerId, segmentId });
                  setTimeout(() => setHighlightedSegment(null), 3000);
                }
              }}
              onDrawBridgeModeChange={(mode, callback) => {
                setDrawBridgeMode(mode);
                bridgeDrawnCallbackRef.current = callback;
              }}
            />
          </div>
        </div>
      </div>

      {draggedEntity && (
        <DraggedEntity
          entity={draggedEntity}
          onDragEnd={handleDraggedEntityDragEnd}
        />
      )}

      {/* Image crop overlay - shown when user uploads an image */}
      {isCropping && pendingUpload && (
        <ImageCropOverlay
          imageDataUrl={pendingUpload}
          onConfirm={handleCroppedImage}
          onCancel={cancelCrop}
        />
      )}
    </div>
  );
};

const WrappedDemo = () => (
  <LayerManager>
    <Demo />
  </LayerManager>
);

export default WrappedDemo;
