import { useState, useCallback, useEffect, useRef } from 'react';
import { API_BASE_URL } from '../config';
import { generateTracesForSegments } from '../utils/generateTrace';

// Conversation states
export const STATES = {
  IDLE: 'IDLE',
  GENERATING_IMAGE: 'GENERATING_IMAGE',
  IMAGE_READY: 'IMAGE_READY',
  ANALYZING_LAYERS: 'ANALYZING_LAYERS',
  LAYERS_READY: 'LAYERS_READY',
  PROCESSING_SEGMENTS: 'PROCESSING_SEGMENTS',
  SEGMENTS_READY: 'SEGMENTS_READY',
  EDITING_MODE: 'EDITING_MODE',
};

// Message types
export const MESSAGE_TYPES = {
  TEXT: 'text',
  THINKING: 'thinking',
  IMAGE: 'image',
  LAYERS: 'layers',
  SEGMENTS: 'segments',
  ERROR: 'error',
};

export function useConversation() {
  const [messages, setMessages] = useState([]);
  const [state, setState] = useState(STATES.IDLE);
  const [currentSession, setCurrentSession] = useState(null);
  const [currentImage, setCurrentImage] = useState(null);
  const [currentLayers, setCurrentLayers] = useState(null);
  const [processedSegments, setProcessedSegments] = useState(null);
  const [segmentedImages, setSegmentedImages] = useState([]); // All segmented images
  const [activeSegmentedIndex, setActiveSegmentedIndex] = useState(0);
  const tracedSegmentIdsRef = useRef(new Set()); // Track which segmented images have traces generated
  const [traceProgress, setTraceProgress] = useState({ total: 0, completed: 0, isGenerating: false });
  const [lastPrompt, setLastPrompt] = useState(null); // Track last prompt for retry
  const [modifyLayerMode, setModifyLayerMode] = useState(false); // Track if we're modifying layers
  const [grabElementMode, setGrabElementMode] = useState(false); // Track if we're grabbing specific elements
  const [grabMoreMode, setGrabMoreMode] = useState(false); // Track if we're grabbing more from rest image
  const [subSegmentMode, setSubSegmentMode] = useState(null); // Track segment being sub-segmented (holds segment object)
  const [subSegmentResult, setSubSegmentResult] = useState(null); // Result from sub-segment operation (for Demo.jsx to handle)
  const [processingSubSegmentId, setProcessingSubSegmentId] = useState(null); // Track which segment is being processed (for freeze UI)
  const [processingRepairId, setProcessingRepairId] = useState(null); // Track which segment is being repaired
  const [repairResult, setRepairResult] = useState(null); // Result from repair operation (for Demo.jsx)
  const [pendingUpload, setPendingUpload] = useState(null); // Image waiting to be cropped
  const activeImageMessageIdRef = useRef(null); // Track which IMAGE message the user is currently interacting with

  // Generate trace SVGs for new segmented images (runs in background)
  useEffect(() => {
    segmentedImages.forEach((segImg) => {
      // Skip if already traced
      if (tracedSegmentIdsRef.current.has(segImg.id)) return;

      // Mark as being traced
      tracedSegmentIdsRef.current.add(segImg.id);

      // Collect all elements that need tracing
      const elementsToTrace = [];
      segImg.layers?.forEach((layer) => {
        layer.elements?.forEach((elem) => {
          if (elem.extracted && !elem.svg_trace) {
            elementsToTrace.push({
              id: `${segImg.id}-${layer.layer}-${elem.name}`,
              layerNum: layer.layer,
              elemName: elem.name,
              pngDataUrl: `data:image/png;base64,${elem.extracted}`,
            });
          }
        });
      });

      if (elementsToTrace.length === 0) return;

      console.log(`[useConversation] Generating traces for ${elementsToTrace.length} elements in ${segImg.id}`);

      // Set progress: starting
      let completedCount = 0;
      setTraceProgress({ total: elementsToTrace.length, completed: 0, isGenerating: true });

      // Generate traces in background
      generateTracesForSegments(elementsToTrace, (elemId, svgTrace, pathCount) => {
        // Parse element ID to find layer and element
        const [, , layerNum, elemName] = elemId.match(/^(.+)-(\d+)-(.+)$/) || [];
        if (!layerNum || !elemName) return;

        console.log(`[useConversation] Trace ready for ${elemName} (${pathCount} paths)`);

        // Update progress
        completedCount++;
        const isComplete = completedCount >= elementsToTrace.length;
        setTraceProgress({
          total: elementsToTrace.length,
          completed: completedCount,
          isGenerating: !isComplete
        });

        // Update the element with svg_trace
        setSegmentedImages((prev) => {
          return prev.map((si) => {
            if (si.id !== segImg.id) return si;

            return {
              ...si,
              layers: si.layers.map((layer) => {
                if (layer.layer !== parseInt(layerNum)) return layer;

                return {
                  ...layer,
                  elements: layer.elements.map((elem) => {
                    if (elem.name !== elemName) return elem;
                    return { ...elem, svg_trace: svgTrace };
                  }),
                };
              }),
            };
          });
        });
      });
    });
  }, [segmentedImages]);

  // Add a message to the conversation
  const addMessage = useCallback((role, type, data) => {
    const message = {
      id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      role, // 'user' or 'ai'
      type,
      data,
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, message]);
    return message;
  }, []);

  // Update the last AI message (for streaming/thinking updates)
  const updateLastAIMessage = useCallback((type, data) => {
    setMessages((prev) => {
      const lastIndex = prev.length - 1;
      if (lastIndex >= 0 && prev[lastIndex].role === 'ai') {
        const updated = [...prev];
        updated[lastIndex] = { ...updated[lastIndex], type, data };
        return updated;
      }
      return prev;
    });
  }, []);

  // Generate multiple images from prompt
  // Note: User message should be added by the caller (handleUserInput) to avoid duplicates
  const generateImage = useCallback(async (prompt) => {
    setState(STATES.GENERATING_IMAGE);
    setLastPrompt(prompt); // Store for retry
    addMessage('ai', MESSAGE_TYPES.THINKING, {
      steps: ['Generating 3 image options...'],
      currentStep: 0
    });

    try {
      const response = await fetch(`${API_BASE_URL}/generate-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();

      // Backend returns array of images with data URL prefix
      // Each image can have its own analysis
      const images = (data.images || []).map((img) => {
        const dataUrl = img.startsWith('data:')
          ? img
          : `data:image/png;base64,${img}`;
        const base64 = img.startsWith('data:')
          ? img.split(',')[1]
          : img;
        return { base64, dataUrl, isLoading: false, analysis: null };
      });

      if (images.length === 0) {
        throw new Error('No images generated');
      }

      setState(STATES.IMAGE_READY);

      updateLastAIMessage(MESSAGE_TYPES.IMAGE, {
        images, // Array of {base64, dataUrl}
        prompt,
        selectedIndex: null, // No image selected yet
      });

      return { success: true, images };
    } catch (error) {
      console.error('Image generation failed:', error);
      setState(STATES.IDLE);
      updateLastAIMessage(MESSAGE_TYPES.ERROR, {
        message: 'Failed to generate images. Please try again.',
      });
      return { success: false, error };
    }
  }, [addMessage, updateLastAIMessage]);

  // Select one of the generated images
  // Analysis is stored per-image, so switching doesn't lose data
  // Updates state based on the selected image's status (analysis/segments/editing)
  // If the selected image is in the editing pool, switches editing mode to it
  const selectImage = useCallback((imageData, prompt, messageId = null, imageIndex = null) => {
    setCurrentImage({ base64: imageData.base64, dataUrl: imageData.dataUrl, prompt });

    // Track selected index for SegmentSection sync
    let selectedIdx = null;
    let selectedImageHasSegments = false;

    // Update the message to show selected state
    setMessages((prev) => {
      // Find the message by ID or use the last AI IMAGE message
      const msgIndex = messageId
        ? prev.findIndex(m => m.id === messageId)
        : prev.length - 1;

      if (msgIndex >= 0 && prev[msgIndex].role === 'ai' && prev[msgIndex].type === MESSAGE_TYPES.IMAGE) {
        const updated = [...prev];
        const resolvedMsgId = updated[msgIndex].id;
        activeImageMessageIdRef.current = resolvedMsgId;
        const images = updated[msgIndex].data.images;
        // Use the passed index if available, otherwise search by dataUrl
        const newSelectedIndex = imageIndex !== null
          ? imageIndex
          : images.findIndex(img => img.dataUrl === imageData.dataUrl);
        const selectedImage = newSelectedIndex >= 0 ? images[newSelectedIndex] : null;

        selectedIdx = newSelectedIndex;
        selectedImageHasSegments = !!selectedImage?.segments;

        // Check if ANY image is currently in editing mode
        const anyImageInEditingMode = images.some(img => img.isInEditingMode);

        // Check if the clicked image is already in the segmentedImages pool
        // (only images that have been explicitly added via "Start Editing" are in the pool)
        const clickedImageInPool = segmentedImages.some(
          seg => seg.sourceMessageId === resolvedMsgId && seg.sourceImageIndex === newSelectedIndex
        );

        // Update images - only switch editing mode if clicked image is ALREADY in pool
        const updatedImages = images.map((img, idx) => {
          if (anyImageInEditingMode && clickedImageInPool) {
            // Switch editing mode to the clicked image (which is in the pool)
            // Check if THIS image (at idx) is in the pool
            const thisImageInPool = segmentedImages.some(
              seg => seg.sourceMessageId === resolvedMsgId && seg.sourceImageIndex === idx
            );
            return {
              ...img,
              isInEditingMode: idx === newSelectedIndex && thisImageInPool,
            };
          }
          return img;
        });

        updated[msgIndex] = {
          ...updated[msgIndex],
          data: {
            ...updated[msgIndex].data,
            images: updatedImages,
            selectedIndex: newSelectedIndex,
            isAnalyzing: false,
          }
        };

        // Update global state based on selected image's status
        if (selectedImage) {
          // Update session if the image has one
          if (selectedImage.analysis?.sessionId) {
            setCurrentSession(selectedImage.analysis.sessionId);
            setCurrentLayers(selectedImage.analysis.layers);
          }

          // Set segments if available (for this selected image), or clear if not
          if (selectedImage.segments) {
            setProcessedSegments({
              session_id: selectedImage.segments.sessionId,
              layers: selectedImage.segments.layers,
              rest_image: selectedImage.segments.restImage,
            });
          } else {
            // Clear processedSegments when switching to an image without segments
            setProcessedSegments(null);
          }

          // Update state based on image status (including in-flight operations)
          if (anyImageInEditingMode) {
            setState(STATES.EDITING_MODE);
          } else if (selectedImage.isProcessing || selectedImage.isStreaming) {
            setState(STATES.PROCESSING_SEGMENTS);
          } else if (selectedImage.isAnalyzing) {
            setState(STATES.ANALYZING_LAYERS);
          } else if (selectedImage.segments) {
            setState(STATES.SEGMENTS_READY);
          } else if (selectedImage.analysis) {
            setState(STATES.LAYERS_READY);
          } else {
            setState(STATES.IMAGE_READY);
          }
        }

        return updated;
      }
      return prev;
    });

    // Sync SegmentSection: if clicked image is in the pool, select it there too
    // We need resolvedMsgId from the setMessages closure — use messageId as best-effort
    if (selectedIdx !== null && selectedImageHasSegments && messageId) {
      const segIdx = segmentedImages.findIndex(
        seg => seg.sourceMessageId === messageId && seg.sourceImageIndex === selectedIdx
      );
      if (segIdx >= 0) {
        setActiveSegmentedIndex(segIdx);
      }
    }
  }, [segmentedImages]);

  // Regenerate all images in place (clears selection and all analysis)
  // Regenerate images - only regenerates images WITHOUT segments (preserves segmented ones)
  const regenerateAllImages = useCallback(async (messageId, prompt) => {
    // Find which images need regeneration (no segments)
    let indicesToRegenerate = [];
    let currentImages = [];

    setMessages((prev) => {
      const msgIndex = prev.findIndex(m => m.id === messageId);
      if (msgIndex >= 0 && prev[msgIndex].type === MESSAGE_TYPES.IMAGE) {
        currentImages = prev[msgIndex].data.images;
        indicesToRegenerate = currentImages
          .map((img, idx) => (!img.segments ? idx : -1))
          .filter(idx => idx !== -1);
      }
      return prev;
    });

    // If all images have segments, nothing to regenerate
    if (indicesToRegenerate.length === 0) {
      console.log('All images have segments, nothing to regenerate');
      return { success: false, message: 'All images have segments' };
    }

    setState(STATES.GENERATING_IMAGE);

    // Mark only images without segments as loading
    setMessages((prev) => {
      const msgIndex = prev.findIndex(m => m.id === messageId);
      if (msgIndex >= 0 && prev[msgIndex].type === MESSAGE_TYPES.IMAGE) {
        const updated = [...prev];
        const loadingImages = updated[msgIndex].data.images.map((img, idx) => {
          if (indicesToRegenerate.includes(idx)) {
            return { ...img, isLoading: true, analysis: null };
          }
          return img; // Preserve images with segments
        });
        updated[msgIndex] = {
          ...updated[msgIndex],
          data: {
            ...updated[msgIndex].data,
            images: loadingImages,
            selectedIndex: null,
            isAnalyzing: false,
            analysisError: null,
          }
        };
        return updated;
      }
      return prev;
    });

    try {
      const response = await fetch(`${API_BASE_URL}/generate-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      const generatedImages = (data.images || []).map((img) => {
        const dataUrl = img.startsWith('data:') ? img : `data:image/png;base64,${img}`;
        const base64 = img.startsWith('data:') ? img.split(',')[1] : img;
        return { base64, dataUrl, isLoading: false, analysis: null };
      });

      if (generatedImages.length === 0) throw new Error('No images generated');

      setState(STATES.IMAGE_READY);

      // Replace only the images that needed regeneration
      setMessages((prev) => {
        const msgIndex = prev.findIndex(m => m.id === messageId);
        if (msgIndex >= 0) {
          const updated = [...prev];
          const newImages = [...updated[msgIndex].data.images];
          let genIdx = 0;
          indicesToRegenerate.forEach((targetIdx) => {
            if (genIdx < generatedImages.length) {
              newImages[targetIdx] = generatedImages[genIdx];
              genIdx++;
            }
          });
          updated[msgIndex] = {
            ...updated[msgIndex],
            data: {
              ...updated[msgIndex].data,
              images: newImages,
              selectedIndex: null,
            }
          };
          return updated;
        }
        return prev;
      });

      return { success: true, images: generatedImages };
    } catch (error) {
      console.error('Regenerate images failed:', error);
      setState(STATES.IMAGE_READY);

      // Remove loading state on error
      setMessages((prev) => {
        const msgIndex = prev.findIndex(m => m.id === messageId);
        if (msgIndex >= 0 && prev[msgIndex].type === MESSAGE_TYPES.IMAGE) {
          const updated = [...prev];
          const images = updated[msgIndex].data.images.map(img => ({
            ...img,
            isLoading: false,
          }));
          updated[msgIndex] = {
            ...updated[msgIndex],
            data: { ...updated[msgIndex].data, images }
          };
          return updated;
        }
        return prev;
      });

      return { success: false, error };
    }
  }, []);

  // Regenerate a single image at a specific index
  const regenerateSingleImage = useCallback(async (messageId, imageIndex, prompt) => {
    // Mark the specific image as loading
    setMessages((prev) => {
      const msgIndex = prev.findIndex(m => m.id === messageId);
      if (msgIndex >= 0 && prev[msgIndex].type === MESSAGE_TYPES.IMAGE) {
        const updated = [...prev];
        const newImages = [...updated[msgIndex].data.images];
        newImages[imageIndex] = { ...newImages[imageIndex], isLoading: true };
        updated[msgIndex] = {
          ...updated[msgIndex],
          data: { ...updated[msgIndex].data, images: newImages }
        };
        return updated;
      }
      return prev;
    });

    try {
      // Generate a single new image
      const response = await fetch(`${API_BASE_URL}/generate-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      const newImages = (data.images || []).map((img) => {
        const dataUrl = img.startsWith('data:') ? img : `data:image/png;base64,${img}`;
        const base64 = img.startsWith('data:') ? img.split(',')[1] : img;
        return { base64, dataUrl, isLoading: false };
      });

      if (newImages.length === 0) throw new Error('No image generated');

      // Update just that one image slot
      setMessages((prev) => {
        const msgIndex = prev.findIndex(m => m.id === messageId);
        if (msgIndex >= 0 && prev[msgIndex].type === MESSAGE_TYPES.IMAGE) {
          const updated = [...prev];
          const updatedImages = [...updated[msgIndex].data.images];
          updatedImages[imageIndex] = newImages[0]; // Take first generated image

          // Clear selection and analysis if the regenerated image was selected
          const wasSelected = updated[msgIndex].data.selectedIndex === imageIndex;

          updated[msgIndex] = {
            ...updated[msgIndex],
            data: {
              ...updated[msgIndex].data,
              images: updatedImages,
              selectedIndex: wasSelected ? null : updated[msgIndex].data.selectedIndex,
              analysis: wasSelected ? null : updated[msgIndex].data.analysis,
            }
          };
          return updated;
        }
        return prev;
      });

      return { success: true };
    } catch (error) {
      console.error('Single image regeneration failed:', error);
      // Remove loading state on error
      setMessages((prev) => {
        const msgIndex = prev.findIndex(m => m.id === messageId);
        if (msgIndex >= 0 && prev[msgIndex].type === MESSAGE_TYPES.IMAGE) {
          const updated = [...prev];
          const newImages = [...updated[msgIndex].data.images];
          newImages[imageIndex] = { ...newImages[imageIndex], isLoading: false };
          updated[msgIndex] = {
            ...updated[msgIndex],
            data: { ...updated[msgIndex].data, images: newImages }
          };
          return updated;
        }
        return prev;
      });
      return { success: false, error };
    }
  }, []);

  // Update a single image with multi-turn editing (Gemini 3 thoughtSignature)
  const updateImage = useCallback(async (messageId, imageIndex, updatePrompt) => {
    console.log('[updateImage] Updating image:', { messageId, imageIndex, updatePrompt });

    // Mark the specific image as updating
    setMessages((prev) => {
      const msgIndex = prev.findIndex(m => m.id === messageId);
      if (msgIndex >= 0 && prev[msgIndex].type === MESSAGE_TYPES.IMAGE) {
        const updated = [...prev];
        const newImages = [...updated[msgIndex].data.images];
        newImages[imageIndex] = {
          ...newImages[imageIndex],
          isUpdating: true,
          updateRequest: updatePrompt
        };
        updated[msgIndex] = {
          ...updated[msgIndex],
          data: { ...updated[msgIndex].data, images: newImages }
        };
        return updated;
      }
      return prev;
    });

    try {
      // Get the current image data
      const imageMsg = messages.find(m => m.id === messageId);
      if (!imageMsg || imageMsg.type !== MESSAGE_TYPES.IMAGE) {
        throw new Error('Image message not found');
      }
      const currentImage = imageMsg.data.images[imageIndex];
      const originalPrompt = imageMsg.data.prompt;

      // Styled versions are now separate images, so just use the current image's base64
      const imageBase64 = currentImage.base64;

      // Call the update endpoint with current image and change request
      const response = await fetch(`${API_BASE_URL}/update-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base64_image: imageBase64,
          original_prompt: originalPrompt,
          update_prompt: updatePrompt,
          is_uploaded: !!currentImage.isUploaded,
          // Include update history for multi-turn context
          update_history: currentImage.updateHistory || [],
        }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();

      // Compute new image data outside setMessages for reuse
      const newDataUrl = data.image.startsWith('data:')
        ? data.image
        : `data:image/png;base64,${data.image}`;
      const newBase64 = data.image.startsWith('data:')
        ? data.image.split(',')[1]
        : data.image;

      // Update the image with the new version
      setMessages((prev) => {
        const msgIndex = prev.findIndex(m => m.id === messageId);
        if (msgIndex >= 0 && prev[msgIndex].type === MESSAGE_TYPES.IMAGE) {
          const updated = [...prev];
          const updatedImages = [...updated[msgIndex].data.images];

          // Get current image's update history
          const currentImg = updatedImages[imageIndex];

          // Clear updating state on original image
          updatedImages[imageIndex] = {
            ...currentImg,
            isUpdating: false,
            updateRequest: null,
          };

          // Append new version as a new image in the array
          const newVersion = {
            base64: newBase64,
            dataUrl: newDataUrl,
            isLoading: false,
            isUpdating: false,
            analysis: null,
            segments: null,
            isUploaded: currentImg.isUploaded || false,
            isInEditingMode: false,
            updateHistory: [...(currentImg.updateHistory || []), updatePrompt],
            styledDataUrl: null,
            styledBase64: null,
            isStylizing: false,
            useStyled: false,
          };
          updatedImages.push(newVersion);

          // Auto-select the new version
          updated[msgIndex] = {
            ...updated[msgIndex],
            data: {
              ...updated[msgIndex].data,
              images: updatedImages,
              selectedIndex: updatedImages.length - 1,
            }
          };
          return updated;
        }
        return prev;
      });

      // Update currentImage to the new version so subsequent analyze/grab targets it
      setCurrentImage({ base64: newBase64, dataUrl: newDataUrl, prompt: originalPrompt });

      return { success: true };
    } catch (error) {
      console.error('Image update failed:', error);
      // Remove updating state on error
      setMessages((prev) => {
        const msgIndex = prev.findIndex(m => m.id === messageId);
        if (msgIndex >= 0 && prev[msgIndex].type === MESSAGE_TYPES.IMAGE) {
          const updated = [...prev];
          const newImages = [...updated[msgIndex].data.images];
          newImages[imageIndex] = {
            ...newImages[imageIndex],
            isUpdating: false,
            updateRequest: null
          };
          updated[msgIndex] = {
            ...updated[msgIndex],
            data: { ...updated[msgIndex].data, images: newImages }
          };
          return updated;
        }
        return prev;
      });
      return { success: false, error };
    }
  }, [messages]);

  // Handle uploaded image
  // Handle initial image upload - triggers crop overlay
  const handleImageUpload = useCallback((base64Image) => {
    const dataUrl = base64Image.startsWith('data:')
      ? base64Image
      : `data:image/png;base64,${base64Image}`;

    // Set pending upload to trigger crop overlay
    setPendingUpload(dataUrl);
  }, []);

  // Cancel crop and discard pending upload
  const cancelCrop = useCallback(() => {
    setPendingUpload(null);
  }, []);

  // Handle cropped image - add to conversation as single image
  const handleCroppedImage = useCallback((croppedDataUrl) => {
    // Clear pending upload
    setPendingUpload(null);

    const base64 = croppedDataUrl.split(',')[1];

    setCurrentImage({ base64, dataUrl: croppedDataUrl, prompt: 'Uploaded image' });
    setState(STATES.IMAGE_READY);

    // Add user message showing they uploaded
    addMessage('user', MESSAGE_TYPES.IMAGE, {
      imageUrl: croppedDataUrl,
      text: 'Uploaded an image',
    });

    // Add AI message with single image (not 3 like generation)
    // The image will have Analyze Layers, Grab Element, and Stylize buttons
    const aiMsg = addMessage('ai', MESSAGE_TYPES.IMAGE, {
      images: [
        {
          base64,
          dataUrl: croppedDataUrl,
          isLoading: false,
          analysis: null,
          segments: null,
          isUploaded: true, // Mark as uploaded (not AI-generated)
          // Stylization state
          styledDataUrl: null,
          styledBase64: null,
          isStylizing: false,
          useStyled: false,
        }
      ],
      prompt: 'Uploaded image',
      selectedIndex: 0, // Auto-select the single image
      isAnalyzing: false,
    });
    activeImageMessageIdRef.current = aiMsg.id;
  }, [addMessage]);

  // Stylize uploaded image for laser cutting
  // Transforms photo into flat illustration style using Gemini 3 Pro
  const stylizeImage = useCallback(async () => {
    if (!currentImage) return { success: false };

    // Find the message with the selected image — prefer activeImageMessageIdRef
    const imageMsg = activeImageMessageIdRef.current
      ? messages.find(m => m.id === activeImageMessageIdRef.current)
      : messages.find(m => m.role === 'ai' && m.type === MESSAGE_TYPES.IMAGE && m.data.selectedIndex !== null);

    if (!imageMsg) return { success: false };

    const selectedIdx = imageMsg.data.selectedIndex;
    const selectedImg = imageMsg.data.images[selectedIdx];

    // Only stylize uploaded images
    if (!selectedImg?.isUploaded) {
      console.log('Stylization only available for uploaded images');
      return { success: false };
    }

    // Mark as stylizing
    setMessages((prev) => {
      const msgIndex = prev.findIndex(m => m.id === imageMsg.id);
      if (msgIndex >= 0) {
        const updated = [...prev];
        const images = [...updated[msgIndex].data.images];
        images[selectedIdx] = {
          ...images[selectedIdx],
          isStylizing: true,
        };
        updated[msgIndex] = {
          ...updated[msgIndex],
          data: { ...updated[msgIndex].data, images }
        };
        return updated;
      }
      return prev;
    });

    try {
      const response = await fetch(`${API_BASE_URL}/stylize-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64_image: currentImage.base64 }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      const styledDataUrl = data.styled_image.startsWith('data:')
        ? data.styled_image
        : `data:image/png;base64,${data.styled_image}`;
      const styledBase64 = data.styled_image.startsWith('data:')
        ? data.styled_image.split(',')[1]
        : data.styled_image;

      // Clear stylizing state on original, append styled as new version
      setMessages((prev) => {
        const msgIndex = prev.findIndex(m => m.id === imageMsg.id);
        if (msgIndex >= 0) {
          const updated = [...prev];
          const images = [...updated[msgIndex].data.images];

          // Clear stylizing state on original
          images[selectedIdx] = {
            ...images[selectedIdx],
            isStylizing: false,
          };

          // Append styled as new version
          const styledVersion = {
            base64: styledBase64,
            dataUrl: styledDataUrl,
            isLoading: false,
            isUpdating: false,
            analysis: null,
            segments: null,
            isUploaded: true,
            isInEditingMode: false,
            updateHistory: [],
            styledDataUrl: null,
            styledBase64: null,
            isStylizing: false,
            useStyled: false,
          };
          images.push(styledVersion);

          // Auto-select new version
          updated[msgIndex] = {
            ...updated[msgIndex],
            data: {
              ...updated[msgIndex].data,
              images,
              selectedIndex: images.length - 1,
            }
          };
          return updated;
        }
        return prev;
      });

      // Update currentImage to use styled version
      setCurrentImage({
        base64: styledBase64,
        dataUrl: styledDataUrl,
        prompt: 'Uploaded image (styled)',
      });

      return { success: true };
    } catch (error) {
      console.error('Stylization failed:', error);

      // Clear stylizing state on error
      setMessages((prev) => {
        const msgIndex = prev.findIndex(m => m.id === imageMsg.id);
        if (msgIndex >= 0) {
          const updated = [...prev];
          const images = [...updated[msgIndex].data.images];
          images[selectedIdx] = {
            ...images[selectedIdx],
            isStylizing: false,
          };
          updated[msgIndex] = {
            ...updated[msgIndex],
            data: { ...updated[msgIndex].data, images }
          };
          return updated;
        }
        return prev;
      });

      return { success: false, error };
    }
  }, [currentImage, messages]);

  // Analyze layers - stores analysis on the specific selected image
  // Captures base64 and imageIndex at call time so concurrent analyses target the correct image
  const analyzeLayers = useCallback(async (messageId = null, imageIndex = null) => {
    if (!currentImage) return { success: false };

    // Resolve the target message ID once — stable across async gaps
    const resolvedMsgId = messageId || activeImageMessageIdRef.current;
    const capturedBase64 = currentImage.base64;

    // Resolve imageIndex from message if not provided
    if (imageIndex === null) {
      const targetMsg = messages.find(m => m.id === resolvedMsgId);
      imageIndex = targetMsg?.data?.selectedIndex ?? null;
    }
    const capturedImageIndex = imageIndex;

    setState(STATES.ANALYZING_LAYERS);

    // Mark per-image isAnalyzing + message-level flag
    setMessages((prev) => {
      const msgIndex = resolvedMsgId
        ? prev.findIndex(m => m.id === resolvedMsgId)
        : prev.findIndex(m => m.role === 'ai' && m.type === MESSAGE_TYPES.IMAGE && m.data.selectedIndex !== null);

      if (msgIndex >= 0) {
        const updated = [...prev];
        const newImages = [...updated[msgIndex].data.images];
        if (capturedImageIndex !== null && newImages[capturedImageIndex]) {
          newImages[capturedImageIndex] = {
            ...newImages[capturedImageIndex],
            isAnalyzing: true,
          };
        }
        updated[msgIndex] = {
          ...updated[msgIndex],
          data: {
            ...updated[msgIndex].data,
            images: newImages,
            isAnalyzing: true,
            analysisError: null,
          }
        };
        return updated;
      }
      return prev;
    });

    try {
      const response = await fetch(`${API_BASE_URL}/analyze-layers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64_image: capturedBase64 }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();

      // Store analysis on the specific image (per-image analysis)
      setMessages((prev) => {
        const msgIndex = resolvedMsgId
          ? prev.findIndex(m => m.id === resolvedMsgId)
          : prev.findIndex(m => m.role === 'ai' && m.type === MESSAGE_TYPES.IMAGE && m.data.selectedIndex !== null);

        if (msgIndex >= 0) {
          const updated = [...prev];
          const newImages = [...updated[msgIndex].data.images];

          // Store analysis on the captured image index
          if (capturedImageIndex !== null && newImages[capturedImageIndex]) {
            newImages[capturedImageIndex] = {
              ...newImages[capturedImageIndex],
              isAnalyzing: false,
              analysis: {
                sessionId: data.session_id,
                layers: data.layers,
                humanized: data.humanized,
              },
            };
          }

          // Only update global state if this image is still selected
          const currentSelectedIndex = updated[msgIndex].data.selectedIndex;
          if (currentSelectedIndex === capturedImageIndex) {
            setCurrentSession(data.session_id);
            setCurrentLayers(data.layers);
            setState(STATES.LAYERS_READY);
          }

          // Message-level isAnalyzing: true only if any image is still analyzing
          const anyStillAnalyzing = newImages.some((img, idx) =>
            idx !== capturedImageIndex && img.isAnalyzing
          );

          updated[msgIndex] = {
            ...updated[msgIndex],
            data: {
              ...updated[msgIndex].data,
              images: newImages,
              isAnalyzing: anyStillAnalyzing,
            }
          };
          return updated;
        }
        return prev;
      });

      return { success: true, layers: data.layers };
    } catch (error) {
      console.error('Layer analysis failed:', error);

      // Update message with error
      setMessages((prev) => {
        const msgIndex = resolvedMsgId
          ? prev.findIndex(m => m.id === resolvedMsgId)
          : prev.findIndex(m => m.role === 'ai' && m.type === MESSAGE_TYPES.IMAGE && m.data.selectedIndex !== null);

        if (msgIndex >= 0) {
          const updated = [...prev];
          const newImages = [...updated[msgIndex].data.images];

          if (capturedImageIndex !== null && newImages[capturedImageIndex]) {
            newImages[capturedImageIndex] = {
              ...newImages[capturedImageIndex],
              isAnalyzing: false,
            };
          }

          // Only reset global state if this image is still selected
          const currentSelectedIndex = updated[msgIndex].data.selectedIndex;
          if (currentSelectedIndex === capturedImageIndex) {
            setState(STATES.IMAGE_READY);
          }

          const anyStillAnalyzing = newImages.some((img, idx) =>
            idx !== capturedImageIndex && img.isAnalyzing
          );

          updated[msgIndex] = {
            ...updated[msgIndex],
            data: {
              ...updated[msgIndex].data,
              images: newImages,
              isAnalyzing: anyStillAnalyzing,
              analysisError: 'Failed to analyze layers. Please try again.',
            }
          };
          return updated;
        }
        return prev;
      });

      return { success: false, error };
    }
  }, [currentImage, messages]);

  // Update layers (user modification)
  const updateLayers = useCallback(async (modifiedLayers, reanalyze = false) => {
    if (!currentSession) return { success: false };

    setState(STATES.ANALYZING_LAYERS);
    addMessage('ai', MESSAGE_TYPES.THINKING, {
      steps: ['Updating layer structure...'],
      currentStep: 0,
    });

    try {
      const response = await fetch(`${API_BASE_URL}/update-layers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: currentSession,
          layers: modifiedLayers,
          reanalyze,
        }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      setCurrentLayers(data.layers);
      setState(STATES.LAYERS_READY);

      updateLastAIMessage(MESSAGE_TYPES.LAYERS, {
        sessionId: data.session_id,
        layers: data.layers,
        actions: ['proceed', 'modify'],
      });

      return { success: true, layers: data.layers };
    } catch (error) {
      console.error('Layer update failed:', error);
      setState(STATES.LAYERS_READY);
      updateLastAIMessage(MESSAGE_TYPES.ERROR, {
        message: 'Failed to update layers. Please try again.',
      });
      return { success: false, error };
    }
  }, [currentSession, addMessage, updateLastAIMessage]);

  // Process segments with streaming - elements appear as they're extracted
  // Accepts optional (messageId, imageIndex) to target a specific image for concurrent safety
  const processSegments = useCallback(async (messageId = null, imageIndex = null) => {
    console.log('[processSegments] Starting streaming...', { currentSession, hasCurrentImage: !!currentImage });
    if (!currentImage) {
      console.log('[processSegments] Early return - missing image');
      return { success: false };
    }

    // Find the message with the selected image — prefer activeImageMessageIdRef
    let resolvedMsgId = messageId || activeImageMessageIdRef.current;
    const imageMsg = resolvedMsgId
      ? messages.find(m => m.id === resolvedMsgId)
      : messages.find(m => m.role === 'ai' && m.type === MESSAGE_TYPES.IMAGE && m.data.selectedIndex !== null);

    if (!imageMsg) {
      console.log('[processSegments] Early return - no imageMsg found');
      return { success: false };
    }

    resolvedMsgId = imageMsg.id;
    const selectedIdx = imageIndex !== null ? imageIndex : imageMsg.data.selectedIndex;

    // Read session from per-image analysis (not global currentSession)
    const targetImg = imageMsg.data.images?.[selectedIdx];
    const capturedSession = targetImg?.analysis?.sessionId || currentSession;
    if (!capturedSession) {
      console.log('[processSegments] Early return - no session found');
      return { success: false };
    }

    // Mark the selected image as processing with streaming state
    setMessages((prev) => {
      const msgIndex = prev.findIndex(m => m.id === resolvedMsgId);
      if (msgIndex >= 0) {
        const updated = [...prev];
        const images = [...updated[msgIndex].data.images];
        images[selectedIdx] = {
          ...images[selectedIdx],
          isProcessing: true,
          isStreaming: true,
          streamingElements: [],  // Elements will be added here as they arrive
          streamingStatus: 'Initializing...',
          processingSource: 'analyze',
        };
        updated[msgIndex] = {
          ...updated[msgIndex],
          data: { ...updated[msgIndex].data, images }
        };
        return updated;
      }
      return prev;
    });

    setState(STATES.PROCESSING_SEGMENTS);

    return new Promise((resolve) => {
      // Accumulator for streaming elements (avoids React batching issues)
      const elementsAccumulator = [];

      // Use fetch with streaming for SSE (POST request)
      fetch(`${API_BASE_URL}/process-layers-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: capturedSession }),
      }).then(response => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        const processStream = async () => {
          while (true) {
            const { done, value } = await reader.read();

            if (value) {
              buffer += decoder.decode(value, { stream: true });

              // SSE events are separated by double newlines
              // Split by \n\n to get complete events
              const events = buffer.split('\n\n');
              buffer = events.pop() || '';  // Keep incomplete event in buffer

              for (const eventBlock of events) {
                if (!eventBlock.trim()) continue;

                const lines = eventBlock.split('\n');
                let eventType = null;
                let eventData = null;

                for (const line of lines) {
                  if (line.startsWith('event: ')) {
                    eventType = line.slice(7).trim();
                  } else if (line.startsWith('data: ')) {
                    try {
                      eventData = JSON.parse(line.slice(6));
                    } catch (e) {
                      console.error('Failed to parse SSE data:', e, line);
                    }
                  }
                }

                if (eventType && eventData) {
                  handleStreamEvent(eventType, eventData, resolvedMsgId, selectedIdx);
                }
              }
            }

            if (done) {
              console.log('[SSE] Stream ended (done=true)');
              // If we haven't resolved yet and stream ended, something went wrong
              break;
            }
          }
        };

        processStream().then(() => {
          console.log('[SSE] Stream processing finished');
        }).catch(error => {
          console.error('Stream processing error:', error);
          handleStreamError(resolvedMsgId, selectedIdx, error);
          resolve({ success: false, error });
        });

      }).catch(error => {
        console.error('Fetch error:', error);
        handleStreamError(resolvedMsgId, selectedIdx, error);
        resolve({ success: false, error });
      });

      // Helper to handle stream events
      const handleStreamEvent = (type, data, msgId, imgIdx) => {
        console.log(`[SSE] Event type="${type}"`);

        setMessages((prev) => {
          const msgIndex = prev.findIndex(m => m.id === msgId);
          if (msgIndex < 0) return prev;

          const updated = [...prev];
          const images = [...updated[msgIndex].data.images];
          // IMPORTANT: Read current image state fresh each time
          const currentImg = { ...images[imgIdx] };

          switch (type) {
            case 'start':
              console.log(`[Stream] START: ${data.total_layers} layers, ${data.total_elements} elements`);
              // Clear the accumulator on start
              elementsAccumulator.length = 0;
              images[imgIdx] = {
                ...currentImg,
                streamingStatus: `Processing ${data.total_elements} elements...`,
                totalElements: data.total_elements,
                totalLayers: data.total_layers,
                streamingElements: [],
              };
              break;

            case 'detecting':
              console.log(`[Stream] DETECTING L${data.layer}: ${data.element_count} elements`);
              images[imgIdx] = {
                ...currentImg,
                streamingStatus: `Layer ${data.layer}: Detecting ${data.element_count} elements...`,
              };
              break;

            case 'element':
              // Add element to accumulator - deduplicate by name+layer
              const elemKey = `${data.layer}-${data.name}`;
              const alreadyExists = elementsAccumulator.some(e => `${e.layer}-${e.name}` === elemKey);
              if (!alreadyExists) {
                const newElement = {
                  name: data.name,
                  extracted: data.extracted,
                  mask: data.mask,
                  svg: data.svg,
                  box_2d: data.box_2d,
                  layer: data.layer,
                };
                elementsAccumulator.push(newElement);
                console.log(`[Stream] L${data.layer} +${data.name} (${elementsAccumulator.length} total)`);
              }
              // Use the accumulator as source of truth
              images[imgIdx] = {
                ...currentImg,
                streamingElements: [...elementsAccumulator],
                streamingStatus: `Extracted: ${data.name}`,
              };
              break;

            case 'inpainting':
              console.log(`[Stream] INPAINTING L${data.layer}`);
              images[imgIdx] = {
                ...currentImg,
                streamingStatus: `Layer ${data.layer}: Preparing next layer...`,
              };
              break;

            case 'complete':
              console.log(`[Stream] COMPLETE: ${elementsAccumulator.length} total elements`);
              // Finalize - convert streaming elements to proper segments structure
              // Use accumulator as source of truth
              const layersMap = {};
              for (const elem of elementsAccumulator) {
                const layerNum = elem.layer || 1;
                if (!layersMap[layerNum]) {
                  layersMap[layerNum] = { layer: layerNum, elements: [] };
                }
                layersMap[layerNum].elements.push({
                  name: elem.name,
                  extracted: elem.extracted,
                  mask: elem.mask,
                  svg: elem.svg,
                  box_2d: elem.box_2d,
                });
              }
              const layers = Object.values(layersMap).sort((a, b) => a.layer - b.layer);

              images[imgIdx] = {
                ...currentImg,
                isProcessing: false,
                isStreaming: false,
                streamingElements: null,
                streamingStatus: null,
                segments: {
                  source: 'analyze',
                  sessionId: data.session_id,
                  layers: layers,
                  restImage: data.rest_image,
                },
              };

              // Only update global state if this image is still selected
              if (updated[msgIndex].data.selectedIndex === imgIdx) {
                setProcessedSegments({
                  session_id: data.session_id,
                  layers: layers,
                  rest_image: data.rest_image,
                });
                setState(STATES.SEGMENTS_READY);
              }
              resolve({ success: true, segments: data });
              break;

            case 'error':
              images[imgIdx] = {
                ...currentImg,
                isProcessing: false,
                isStreaming: false,
                segmentsError: data.message || 'Processing failed',
              };
              // Only update global state if this image is still selected
              if (updated[msgIndex].data.selectedIndex === imgIdx) {
                setState(STATES.LAYERS_READY);
              }
              resolve({ success: false, error: data.message });
              break;

            default:
              console.warn(`[SSE] Unknown event type: "${type}"`);
              break;
          }

          updated[msgIndex] = {
            ...updated[msgIndex],
            data: { ...updated[msgIndex].data, images }
          };
          return updated;
        });
      };

      // Helper to handle errors
      const handleStreamError = (msgId, imgIdx, error) => {
        setMessages((prev) => {
          const msgIndex = prev.findIndex(m => m.id === msgId);
          if (msgIndex < 0) return prev;

          const updated = [...prev];
          const images = [...updated[msgIndex].data.images];
          images[imgIdx] = {
            ...images[imgIdx],
            isProcessing: false,
            isStreaming: false,
            segmentsError: error.message || 'Processing failed',
          };
          updated[msgIndex] = {
            ...updated[msgIndex],
            data: { ...updated[msgIndex].data, images }
          };

          // Only update global state if this image is still selected
          if (updated[msgIndex].data.selectedIndex === imgIdx) {
            setState(STATES.LAYERS_READY);
          }

          return updated;
        });
      };
    });
  }, [currentSession, currentImage, messages]);

  // Fallback non-streaming process (kept for reference)
  const processSegmentsLegacy = useCallback(async () => {
    if (!currentSession || !currentImage) return { success: false };

    const imageMsg = activeImageMessageIdRef.current
      ? messages.find(m => m.id === activeImageMessageIdRef.current)
      : messages.find(m => m.role === 'ai' && m.type === MESSAGE_TYPES.IMAGE && m.data.selectedIndex !== null);
    if (!imageMsg) return { success: false };

    const messageId = imageMsg.id;
    const selectedIdx = imageMsg.data.selectedIndex;

    setMessages((prev) => {
      const msgIndex = prev.findIndex(m => m.id === messageId);
      if (msgIndex >= 0) {
        const updated = [...prev];
        const images = [...updated[msgIndex].data.images];
        images[selectedIdx] = {
          ...images[selectedIdx],
          isProcessing: true,
          processingSource: 'analyze',
        };
        updated[msgIndex] = { ...updated[msgIndex], data: { ...updated[msgIndex].data, images } };
        return updated;
      }
      return prev;
    });

    setState(STATES.PROCESSING_SEGMENTS);

    try {
      const response = await fetch(`${API_BASE_URL}/process-layers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: currentSession }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      setProcessedSegments(data);
      setState(STATES.SEGMENTS_READY);

      setMessages((prev) => {
        const msgIndex = prev.findIndex(m => m.id === messageId);
        if (msgIndex >= 0) {
          const updated = [...prev];
          const images = [...updated[msgIndex].data.images];
          images[selectedIdx] = {
            ...images[selectedIdx],
            isProcessing: false,
            segments: {
              source: 'analyze',
              sessionId: data.session_id,
              layers: data.layers,
              restImage: data.rest_image,
            },
          };
          updated[msgIndex] = { ...updated[msgIndex], data: { ...updated[msgIndex].data, images } };
          return updated;
        }
        return prev;
      });

      return { success: true, segments: data };
    } catch (error) {
      console.error('Segment processing failed:', error);
      setState(STATES.LAYERS_READY);

      // Clear processing state on error
      setMessages((prev) => {
        const msgIndex = prev.findIndex(m => m.id === imageMsg.id);
        if (msgIndex >= 0) {
          const updated = [...prev];
          const selectedIdx = updated[msgIndex].data.selectedIndex;
          const images = [...updated[msgIndex].data.images];
          images[selectedIdx] = {
            ...images[selectedIdx],
            isProcessing: false,
            segmentsError: 'Failed to process segments. Please try again.',
          };
          updated[msgIndex] = {
            ...updated[msgIndex],
            data: { ...updated[msgIndex].data, images }
          };
          return updated;
        }
        return prev;
      });

      return { success: false, error };
    }
  }, [currentSession, currentImage, messages]);

  // Start editing mode - marks the selected image as in editing mode
  // Does NOT create a new message - status text is shown in the segment container
  // Also adds the image to segmentedImages and syncs SegmentSection
  const startEditing = useCallback((messageId = null) => {
    setState(STATES.EDITING_MODE);

    // Find the selected image and its data from messages
    // We need to read from the current messages state
    setMessages((prev) => {
      // Find the message with the selected image
      const msgIndex = messageId
        ? prev.findIndex(m => m.id === messageId)
        : activeImageMessageIdRef.current
          ? prev.findIndex(m => m.id === activeImageMessageIdRef.current)
          : prev.findIndex(m => m.role === 'ai' && m.type === MESSAGE_TYPES.IMAGE && m.data.selectedIndex !== null);

      if (msgIndex >= 0) {
        const updated = [...prev];
        const selectedIdx = updated[msgIndex].data.selectedIndex;
        const foundMessageId = updated[msgIndex].id;
        const images = [...updated[msgIndex].data.images];

        // Get the selected image data
        if (selectedIdx !== null && images[selectedIdx]) {
          const selectedImageData = images[selectedIdx];

          // Clear isInEditingMode on ALL images, then set it only on the selected one
          for (let i = 0; i < images.length; i++) {
            images[i] = {
              ...images[i],
              isInEditingMode: i === selectedIdx,
            };
          }

          // Add to segmentedImages if it has segments
          if (selectedImageData.segments) {
            // Use functional update to ensure we check against latest state
            setSegmentedImages((prevSegmented) => {
              const alreadyExists = prevSegmented.some(
                seg => seg.sourceMessageId === foundMessageId && seg.sourceImageIndex === selectedIdx
              );

              if (!alreadyExists) {
                // Create the segmented image entry
                const segmentedImage = {
                  id: `seg-${Date.now()}`,
                  sessionId: selectedImageData.segments.sessionId,
                  originalImage: {
                    dataUrl: selectedImageData.dataUrl,
                    base64: selectedImageData.base64,
                  },
                  layers: selectedImageData.segments.layers,
                  restImage: selectedImageData.segments.restImage,
                  sourceMessageId: foundMessageId,
                  sourceImageIndex: selectedIdx,
                  source: selectedImageData.segments.source, // 'analyze' or 'grab'
                };
                // Set as active (the new index will be prevSegmented.length)
                setActiveSegmentedIndex(prevSegmented.length);
                return [...prevSegmented, segmentedImage];
              } else {
                // Already exists, just select it
                const segIdx = prevSegmented.findIndex(
                  seg => seg.sourceMessageId === foundMessageId && seg.sourceImageIndex === selectedIdx
                );
                if (segIdx >= 0) {
                  setActiveSegmentedIndex(segIdx);
                }
                return prevSegmented;
              }
            });
          }
        }

        updated[msgIndex] = {
          ...updated[msgIndex],
          data: { ...updated[msgIndex].data, images }
        };
        return updated;
      }
      return prev;
    });
  }, []);

  // Redo segmentation - re-runs entire segmentation with REDO prompt for extra careful detection
  // Uses /redo-full-stream endpoint which has extra verification steps in the prompt
  const redoSegmentation = useCallback(async () => {
    if (!currentSession || !currentImage) return { success: false };

    console.log(`[redoSegmentation] Starting full redo for session ${currentSession}`);

    // Find the image message by checking which pool entry is active
    const activePoolEntry = segmentedImages[activeSegmentedIndex];
    const imageMsg = activePoolEntry?.sourceMessageId
      ? messages.find(m => m.id === activePoolEntry.sourceMessageId)
      : messages.find(m => m.role === 'ai' && m.type === MESSAGE_TYPES.IMAGE);
    if (!imageMsg) {
      console.warn('[redoSegmentation] No image message found');
      return { success: false, error: 'No image found' };
    }

    const selectedIdx = imageMsg.data.selectedIndex ?? 0;

    // Check if this image is already in the editing pool (before redo)
    const isImageInEditingPool = segmentedImages.some(seg => seg.sourceMessageId === imageMsg.id && seg.sourceImageIndex === selectedIdx);

    // Set streaming state (full redo from layer 1)
    setMessages((prev) => {
      return prev.map(msg => {
        if (msg.id !== imageMsg.id) return msg;
        const images = [...msg.data.images];
        images[selectedIdx] = {
          ...images[selectedIdx],
          isRedoing: true,
          redoFromLayer: 1,  // Full redo = from layer 1
          redoStatus: 'Starting full redo with careful detection...',
          redoElements: [],
          segments: null,  // Clear existing segments for full redo
        };
        return { ...msg, data: { ...msg.data, images } };
      });
    });

    try {
      // Use /process-layers-stream with is_redo=true for REDO prompt
      const response = await fetch(`${API_BASE_URL}/process-layers-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: currentSession,
          is_redo: true  // Triggers REDO_BATCH_DETECTION_PROMPT for careful detection
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let allLayers = [];
      let newRestImage = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('event:')) {
            continue; // Event type line
          }
          if (line.startsWith('data:')) {
            try {
              const data = JSON.parse(line.slice(5).trim());

              switch (data.type) {
                case 'start':
                  console.log('[redoSegmentation] Full redo started:', data);
                  setMessages((prev) => {
                    return prev.map(msg => {
                      if (msg.id !== imageMsg.id) return msg;
                      const images = [...msg.data.images];
                      images[selectedIdx] = {
                        ...images[selectedIdx],
                        redoStatus: `Redoing ${data.total_layers || '?'} layers with careful detection...`,
                      };
                      return { ...msg, data: { ...msg.data, images } };
                    });
                  });
                  break;

                case 'detecting':
                  console.log(`[redoSegmentation] Detecting layer ${data.layer}:`, data.element_count, 'elements');
                  setMessages((prev) => {
                    return prev.map(msg => {
                      if (msg.id !== imageMsg.id) return msg;
                      const images = [...msg.data.images];
                      images[selectedIdx] = {
                        ...images[selectedIdx],
                        redoStatus: `Layer ${data.layer}: Detecting ${data.element_count} elements (REDO)...`,
                      };
                      return { ...msg, data: { ...msg.data, images } };
                    });
                  });
                  break;

                case 'element':
                  console.log(`[redoSegmentation] Element extracted: L${data.layer} ${data.name}`);
                  // Add element to appropriate layer
                  const layerIdx = allLayers.findIndex(l => l.layer === data.layer);
                  if (layerIdx >= 0) {
                    allLayers[layerIdx].elements.push({
                      name: data.name,
                      extracted: data.extracted,
                      mask: data.mask,
                      svg: data.svg,
                      box_2d: data.box_2d
                    });
                  } else {
                    allLayers.push({
                      layer: data.layer,
                      elements: [{
                        name: data.name,
                        extracted: data.extracted,
                        mask: data.mask,
                        svg: data.svg,
                        box_2d: data.box_2d
                      }]
                    });
                  }
                  // Sort layers by layer number
                  allLayers.sort((a, b) => a.layer - b.layer);

                  // Update redo elements for animation
                  const currentElements = JSON.parse(JSON.stringify(allLayers));
                  setMessages((prev) => {
                    return prev.map(msg => {
                      if (msg.id !== imageMsg.id) return msg;
                      const images = [...msg.data.images];
                      images[selectedIdx] = {
                        ...images[selectedIdx],
                        redoStatus: `Layer ${data.layer}: Extracted ${data.name}`,
                        redoElements: currentElements,
                      };
                      return { ...msg, data: { ...msg.data, images } };
                    });
                  });
                  break;

                case 'inpainting':
                  console.log(`[redoSegmentation] Inpainting layer ${data.layer}`);
                  setMessages((prev) => {
                    return prev.map(msg => {
                      if (msg.id !== imageMsg.id) return msg;
                      const images = [...msg.data.images];
                      images[selectedIdx] = {
                        ...images[selectedIdx],
                        redoStatus: `Layer ${data.layer}: Inpainting...`,
                      };
                      return { ...msg, data: { ...msg.data, images } };
                    });
                  });
                  break;

                case 'complete':
                  console.log('[redoSegmentation] Full redo complete:', allLayers.length, 'layers');
                  newRestImage = data.rest_image;
                  break;

                case 'error':
                  console.error('[redoSegmentation] Error event:', data.message);
                  throw new Error(data.message);
              }
            } catch (parseErr) {
              console.warn('[redoSegmentation] Parse error:', parseErr);
            }
          }
        }
      }

      // Update final state with all layers
      const finalSegments = {
        layers: allLayers,
        rest_image: newRestImage,
        source: 'analyze'
      };

      setMessages((prev) => {
        return prev.map(msg => {
          if (msg.id !== imageMsg.id) return msg;
          const images = [...msg.data.images];
          images[selectedIdx] = {
            ...images[selectedIdx],
            segments: finalSegments,
            isRedoing: false,
            redoFromLayer: null,
            redoStatus: null,
            redoElements: null,
            // Only set editing mode if image was already in the editing pool
            isInEditingMode: isImageInEditingPool,
          };
          return { ...msg, data: { ...msg.data, images } };
        });
      });

      // Update processedSegments and segmentedImages pool
      setProcessedSegments(finalSegments);
      setSegmentedImages((prev) => {
        return prev.map(seg => {
          if (seg.sourceMessageId === imageMsg.id && seg.sourceImageIndex === selectedIdx) {
            return {
              ...seg,
              layers: allLayers,
              restImage: newRestImage || seg.restImage
            };
          }
          return seg;
        });
      });

      console.log(`[redoSegmentation] Success: ${allLayers.length} layers`);
      return { success: true, layers: allLayers, rest_image: newRestImage };

    } catch (err) {
      console.error('[redoSegmentation] Error:', err);

      // Clear redo state on error
      setMessages((prev) => {
        return prev.map(msg => {
          if (msg.id !== imageMsg.id) return msg;
          const images = [...msg.data.images];
          images[selectedIdx] = {
            ...images[selectedIdx],
            isRedoing: false,
            redoFromLayer: null,
            redoStatus: null,
            redoElements: null,
          };
          return { ...msg, data: { ...msg.data, images } };
        });
      });

      return { success: false, error: err.message };
    }
  }, [currentSession, currentImage, messages, segmentedImages, activeSegmentedIndex, setMessages, setProcessedSegments, setSegmentedImages]);

  // Redo segmentation from a specific layer (streaming)
  // This re-processes that layer and all layers below (higher layer numbers)
  const redoFromLayer = useCallback(async (fromLayer, onlyThisLayer = false) => {
    if (!currentSession) {
      console.warn('[redoFromLayer] No active session');
      return { success: false, error: 'No active session' };
    }

    const mode = onlyThisLayer ? 'single layer' : `from layer ${fromLayer}`;
    console.log(`[redoFromLayer] Starting redo ${mode} for session ${currentSession}`);

    // Find the image message by checking which pool entry is active
    const activePoolEntry = segmentedImages[activeSegmentedIndex];
    const imageMsg = activePoolEntry?.sourceMessageId
      ? messages.find(m => m.id === activePoolEntry.sourceMessageId)
      : messages.find(m => m.role === 'ai' && m.type === MESSAGE_TYPES.IMAGE);
    if (!imageMsg) {
      console.warn('[redoFromLayer] No image message found');
      return { success: false, error: 'No image found' };
    }

    const selectedIdx = imageMsg.data.selectedIndex ?? 0;
    const selectedImage = imageMsg.data.images[selectedIdx];

    if (!selectedImage?.segments) {
      console.warn('[redoFromLayer] No segments on selected image');
      return { success: false, error: 'No segments to redo' };
    }

    // Set redo streaming state on the image
    // Note: We use isRedoing instead of isStreaming to keep existing segments visible
    setMessages((prev) => {
      return prev.map(msg => {
        if (msg.id !== imageMsg.id) return msg;
        const images = [...msg.data.images];
        images[selectedIdx] = {
          ...images[selectedIdx],
          isRedoing: true,  // Different from isStreaming - keeps existing segments visible
          redoFromLayer: fromLayer,
          redoStatus: onlyThisLayer ? `Redoing layer ${fromLayer}...` : `Redoing from layer ${fromLayer}...`,
          redoElements: [],  // Elements extracted so far during redo
        };
        return { ...msg, data: { ...msg.data, images } };
      });
    });

    try {
      const response = await fetch(`${API_BASE_URL}/redo-from-layer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: currentSession,
          from_layer: fromLayer,
          only_this_layer: onlyThisLayer
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let redoLayers = [];
      let newRestImage = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              console.log('[redoFromLayer] Event:', data.type, data);

              switch (data.type) {
                case 'redo_start':
                  setMessages((prev) => {
                    return prev.map(msg => {
                      if (msg.id !== imageMsg.id) return msg;
                      const images = [...msg.data.images];
                      images[selectedIdx] = {
                        ...images[selectedIdx],
                        redoStatus: data.message || `Redoing ${data.total_layers} layers...`,
                      };
                      return { ...msg, data: { ...msg.data, images } };
                    });
                  });
                  break;

                case 'detecting':
                  setMessages((prev) => {
                    return prev.map(msg => {
                      if (msg.id !== imageMsg.id) return msg;
                      const images = [...msg.data.images];
                      images[selectedIdx] = {
                        ...images[selectedIdx],
                        redoStatus: `Layer ${data.layer}: Detecting ${data.element_count} elements...`,
                      };
                      return { ...msg, data: { ...msg.data, images } };
                    });
                  });
                  break;

                case 'element':
                  // Add element to the appropriate layer in redoLayers
                  let layerIdx = redoLayers.findIndex(l => l.layer === data.layer);
                  if (layerIdx === -1) {
                    redoLayers.push({ layer: data.layer, elements: [] });
                    layerIdx = redoLayers.length - 1;
                  }
                  redoLayers[layerIdx].elements.push({
                    name: data.name,
                    extracted: data.extracted,
                    mask: data.mask,
                    svg: data.svg,
                    box_2d: data.box_2d
                  });

                  // Update redo status and elements for real-time display
                  setMessages((prev) => {
                    return prev.map(msg => {
                      if (msg.id !== imageMsg.id) return msg;
                      const images = [...msg.data.images];
                      // Deep copy redoLayers for state update
                      const currentRedoElements = JSON.parse(JSON.stringify(redoLayers));
                      images[selectedIdx] = {
                        ...images[selectedIdx],
                        redoStatus: `Layer ${data.layer}: Extracted ${data.name}`,
                        redoElements: currentRedoElements,  // Update in real-time for animation
                      };
                      return { ...msg, data: { ...msg.data, images } };
                    });
                  });
                  break;

                case 'inpainting':
                  setMessages((prev) => {
                    return prev.map(msg => {
                      if (msg.id !== imageMsg.id) return msg;
                      const images = [...msg.data.images];
                      images[selectedIdx] = {
                        ...images[selectedIdx],
                        redoStatus: `Layer ${data.layer}: Inpainting...`,
                      };
                      return { ...msg, data: { ...msg.data, images } };
                    });
                  });
                  break;

                case 'layer_warning':
                  console.warn('[redoFromLayer] Warning:', data.message);
                  break;

                case 'redo_complete':
                  redoLayers = data.layers;
                  newRestImage = data.rest_image;
                  console.log('[redoFromLayer] Redo complete:', redoLayers.length, 'layers');
                  break;

                case 'error':
                  console.error('[redoFromLayer] Error:', data.message);
                  throw new Error(data.message);
              }
            } catch (parseErr) {
              console.warn('[redoFromLayer] Parse error:', parseErr);
            }
          }
        }
      }

      // Merge redo results with existing segments
      const existingSegments = selectedImage.segments;
      const existingLayers = existingSegments?.layers || [];

      // For single-layer redo: keep layers before AND after, only replace the target layer
      // For cascade redo: keep layers before, replace all from fromLayer onward
      const keptBefore = existingLayers.filter(l => l.layer < fromLayer);
      const keptAfter = onlyThisLayer
        ? existingLayers.filter(l => l.layer > fromLayer)
        : [];

      // Combine with redo results
      const mergedLayers = [...keptBefore, ...redoLayers, ...keptAfter].sort((a, b) => a.layer - b.layer);

      const updatedSegments = {
        ...existingSegments,
        layers: mergedLayers,
        restImage: onlyThisLayer ? existingSegments?.restImage : (newRestImage || existingSegments?.restImage),
        source: existingSegments?.source || 'analyze'
      };

      // Update the image with new segments and clear redo state
      setMessages((prev) => {
        return prev.map(msg => {
          if (msg.id !== imageMsg.id) return msg;
          const images = [...msg.data.images];
          images[selectedIdx] = {
            ...images[selectedIdx],
            segments: updatedSegments,
            // Clear redo state
            isRedoing: false,
            redoFromLayer: null,
            redoStatus: null,
            redoElements: null,
          };
          return { ...msg, data: { ...msg.data, images } };
        });
      });

      // Also update processedSegments global state
      setProcessedSegments(updatedSegments);

      // Update segmentedImages pool if this image is in editing mode
      setSegmentedImages((prev) => {
        return prev.map(seg => {
          if (seg.sourceMessageId === imageMsg.id && seg.sourceImageIndex === selectedIdx) {
            // Clear traced flag so svg_trace generation re-runs for new redo elements
            tracedSegmentIdsRef.current.delete(seg.id);
            return {
              ...seg,
              layers: mergedLayers,
              restImage: onlyThisLayer ? seg.restImage : (newRestImage || seg.restImage)
            };
          }
          return seg;
        });
      });

      console.log(`[redoFromLayer] Success: ${mergedLayers.length} total layers after redo`);

      return { success: true, layers: mergedLayers, rest_image: newRestImage };

    } catch (err) {
      console.error('[redoFromLayer] Error:', err);

      // Clear redo state on error
      setMessages((prev) => {
        return prev.map(msg => {
          if (msg.id !== imageMsg.id) return msg;
          const images = [...msg.data.images];
          images[selectedIdx] = {
            ...images[selectedIdx],
            isRedoing: false,
            redoFromLayer: null,
            redoStatus: null,
            redoElements: null,
          };
          return { ...msg, data: { ...msg.data, images } };
        });
      });

      return { success: false, error: err.message };
    }
  }, [currentSession, messages, segmentedImages, activeSegmentedIndex, setMessages, setProcessedSegments, setSegmentedImages]);

  // Exit editing mode - clears isInEditingMode on all images
  const exitEditingMode = useCallback(() => {
    setState(STATES.SEGMENTS_READY);

    // Clear isInEditingMode on all images
    setMessages((prev) => {
      return prev.map(msg => {
        if (msg.role === 'ai' && msg.type === MESSAGE_TYPES.IMAGE) {
          const images = msg.data.images.map(img => ({
            ...img,
            isInEditingMode: false,
          }));
          return {
            ...msg,
            data: { ...msg.data, images }
          };
        }
        return msg;
      });
    });
  }, []);

  // Delete a grabbed element from the segments
  // If isLastElement is true, removes the entire image from the pool
  const deleteGrabbedElement = useCallback((imageIndex, elementName, isLastElement) => {
    console.log('[deleteGrabbedElement]', { imageIndex, elementName, isLastElement });

    // Derive sourceMessageId from the pool entry that matches this imageIndex
    const poolEntry = segmentedImages.find(seg => seg.sourceImageIndex === imageIndex);
    const sourceMsgId = poolEntry?.sourceMessageId;

    // Find the image message by sourceMessageId (fall back to first IMAGE message)
    const imageMsg = sourceMsgId
      ? messages.find(m => m.id === sourceMsgId)
      : messages.find(m => m.role === 'ai' && m.type === MESSAGE_TYPES.IMAGE);
    if (!imageMsg) return;

    if (isLastElement) {
      // Check if this is the last image in the pool (pool will be empty after removal)
      const willPoolBeEmpty = segmentedImages.filter(seg => !(seg.sourceMessageId === imageMsg.id && seg.sourceImageIndex === imageIndex)).length === 0;

      // Remove the entire image from the segmented pool
      setSegmentedImages((prev) => {
        const newPool = prev.filter(seg => !(seg.sourceMessageId === imageMsg.id && seg.sourceImageIndex === imageIndex));
        // If there are remaining images, switch to the first one
        if (newPool.length > 0) {
          setActiveSegmentedIndex(0);
        }
        return newPool;
      });

      // Clear segments AND analysis on the source image
      // (analysis contains sessionId from grab which makes hasAnalysis=true)
      setMessages((prev) => {
        return prev.map(msg => {
          if (msg.id === imageMsg.id) {
            const images = msg.data.images.map((img, idx) => {
              if (idx === imageIndex) {
                return {
                  ...img,
                  segments: null,
                  analysis: null,  // Clear analysis so buttons reappear
                  isInEditingMode: false,
                  grabNotFound: false,  // Clear any grab not found state
                  grabNotFoundDescription: null,
                };
              }
              return img;
            });
            return {
              ...msg,
              data: { ...msg.data, images }
            };
          }
          return msg;
        });
      });

      // Clear processedSegments if this was the current image
      setProcessedSegments(null);

      // Exit editing mode if the pool is now empty
      if (willPoolBeEmpty) {
        // Also clear session state so the image is truly "fresh"
        setCurrentSession(null);
        setCurrentLayers(null);
        setState(STATES.IMAGE_READY);
      }
    } else {
      // Remove just the element from the segments
      setMessages((prev) => {
        return prev.map(msg => {
          if (msg.id === imageMsg.id) {
            const images = msg.data.images.map((img, idx) => {
              if (idx === imageIndex && img.segments) {
                // Filter out the element from each layer
                const newLayers = img.segments.layers.map(layer => ({
                  ...layer,
                  elements: layer.elements.filter(elem => elem.name !== elementName)
                })).filter(layer => layer.elements.length > 0); // Remove empty layers

                return {
                  ...img,
                  segments: {
                    ...img.segments,
                    layers: newLayers,
                  }
                };
              }
              return img;
            });
            return {
              ...msg,
              data: { ...msg.data, images }
            };
          }
          return msg;
        });
      });

      // Also update segmentedImages pool
      setSegmentedImages((prev) => {
        return prev.map(seg => {
          if (seg.sourceMessageId === imageMsg.id && seg.sourceImageIndex === imageIndex) {
            const newLayers = seg.layers.map(layer => ({
              ...layer,
              elements: layer.elements.filter(elem => elem.name !== elementName)
            })).filter(layer => layer.elements.length > 0);

            return {
              ...seg,
              layers: newLayers,
            };
          }
          return seg;
        });
      });

      // Update processedSegments if this is the current image
      setProcessedSegments((prev) => {
        if (!prev) return prev;
        const newLayers = prev.layers.map(layer => ({
          ...layer,
          elements: layer.elements.filter(elem => elem.name !== elementName)
        })).filter(layer => layer.elements.length > 0);
        return { ...prev, layers: newLayers };
      });
    }
  }, [messages, segmentedImages]);

  // Start modify layer mode
  const startModifyLayerMode = useCallback(() => {
    setModifyLayerMode(true);
  }, []);

  // Cancel modify layer mode
  const cancelModifyLayerMode = useCallback(() => {
    setModifyLayerMode(false);
  }, []);

  // Start grab element mode
  const startGrabElementMode = useCallback(() => {
    setGrabElementMode(true);
    setGrabMoreMode(false);
    setModifyLayerMode(false); // Cancel modify mode if active
  }, []);

  // Start grab more mode (grab from rest image)
  const startGrabMoreMode = useCallback(() => {
    setGrabMoreMode(true);
    setGrabElementMode(true); // Use same input handling
    setModifyLayerMode(false);
  }, []);

  // Cancel grab element mode
  const cancelGrabElementMode = useCallback(() => {
    setGrabElementMode(false);
    setGrabMoreMode(false);
  }, []);

  // Start sub-segment mode (break a segment into smaller parts)
  const startSubSegmentMode = useCallback((segment) => {
    setSubSegmentMode(segment);
    setModifyLayerMode(false);
    setGrabElementMode(false);
    setGrabMoreMode(false);
  }, []);

  // Cancel sub-segment mode
  const cancelSubSegmentMode = useCallback(() => {
    setSubSegmentMode(null);
  }, []);

  // Submit sub-segment request
  // Takes the segment PNG and prompt, runs segmentation, returns new sub-segments
  // Uses same pipeline as grab-elements
  const submitSubSegment = useCallback(async (prompt) => {
    if (!subSegmentMode) return { success: false, error: 'No segment selected' };

    const segment = subSegmentMode;
    setSubSegmentMode(null);  // Clear mode immediately
    setProcessingSubSegmentId(segment.id);  // Set processing state for freeze UI

    // Simple working indicator (spinning circle in chat)
    const workingId = Date.now();
    addMessage('ai', MESSAGE_TYPES.THINKING, {
      steps: [`Extracting "${prompt}"...`],
      currentStep: 0,
      id: workingId,
      isSubSegment: true,  // Flag for styling
    });

    try {
      // Get segment PNG data (extract from styledSvg which is a data URL)
      const segmentPng = segment.styledSvg || segment.svgUrl;
      if (!segmentPng) {
        throw new Error('No PNG data for segment');
      }

      // Extract base64 from data URL
      const base64Match = segmentPng.match(/data:image\/[^;]+;base64,(.+)/);
      const base64Data = base64Match ? base64Match[1] : segmentPng;

      // Call backend API (uses grab-elements style pipeline)
      const response = await fetch(`${API_BASE_URL}/sub-segment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: base64Data,
          prompt: prompt,
          segment_id: segment.id,
          transform: {
            x: segment.originalX || segment.x,
            y: segment.originalY || segment.y,
            width: segment.originalWidth || segment.width,
            height: segment.originalHeight || segment.height,
            rotation: segment.rotation || 0,
            scaleX: segment.scaleX || 1,
            scaleY: segment.scaleY || 1,
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      const result = await response.json();

      // Remove working indicator
      setMessages((prev) => prev.filter((m) => m.data?.id !== workingId));

      // Check for error
      if (result.error || !result.sub_segments || result.sub_segments.length === 0) {
        setProcessingSubSegmentId(null);  // Clear processing state
        const errorMsg = result.error || 'Could not find distinct parts.';
        addMessage('assistant', MESSAGE_TYPES.TEXT, { text: errorMsg, isSubSegment: true });
        return { success: false, error: errorMsg };
      }

      // Clear processing state
      setProcessingSubSegmentId(null);

      // Success - show done message (result appears in EditingSection)
      const partCount = result.sub_segments.length + (result.rest_segment ? 1 : 0);
      addMessage('assistant', MESSAGE_TYPES.TEXT, {
        text: `✓ Extracted ${partCount} part(s)${result.rest_segment ? ' (including rest)' : ''}`,
        isSubSegment: true,  // Flag for styling
      });

      // Set result for Demo.jsx to handle (updating layers)
      const successResult = {
        success: true,
        originalSegment: segment,
        originalSegmentId: segment.id,
        subSegments: result.sub_segments,
        restSegment: result.rest_segment,  // Include rest segment (inpainted remainder)
        parsedQuery: result.parsed_query,
      };
      setSubSegmentResult(successResult);
      return successResult;
    } catch (error) {
      console.error('[useConversation] Sub-segment failed:', error);

      // Clear processing state
      setProcessingSubSegmentId(null);

      // Remove working indicator
      setMessages((prev) => prev.filter((m) => m.data?.id !== workingId));

      addMessage('assistant', MESSAGE_TYPES.ERROR, {
        text: `Failed: ${error.message}`,
        isSubSegment: true,  // Flag for styling
      });

      return { success: false, error: error.message };
    }
  }, [subSegmentMode, addMessage]);

  // Submit repair request — clean up noisy segment edges using Gemini
  const submitRepair = useCallback(async (segment) => {
    if (!segment) return;

    setProcessingRepairId(segment.id);

    // Show thinking indicator in chat
    const workingId = Date.now();
    addMessage('ai', MESSAGE_TYPES.THINKING, {
      steps: ['Repairing segment edges...'],
      currentStep: 0,
      id: workingId,
    });

    try {
      // Get segment PNG data
      const segmentPng = segment.styledSvg || segment.svgUrl;
      if (!segmentPng) throw new Error('No PNG data for segment');

      const base64Match = segmentPng.match(/data:image\/[^;]+;base64,(.+)/);
      const segmentBase64 = base64Match ? base64Match[1] : segmentPng;

      // Get original scene image from segmentedImages
      const activeSegImage = segmentedImages[activeSegmentedIndex];
      if (!activeSegImage?.originalImage?.base64) {
        throw new Error('Original scene image not available');
      }
      const originalBase64 = activeSegImage.originalImage.base64;

      // Call backend
      const response = await fetch(`${API_BASE_URL}/repair-segment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: segmentBase64,
          original_image: originalBase64,
          segment_id: segment.id,
          element_name: segment.name || segment.segmentId || '',
        }),
      });

      if (!response.ok) throw new Error(`API error: ${response.status}`);

      const result = await response.json();

      // Remove working indicator
      setMessages((prev) => prev.filter((m) => m.data?.id !== workingId));

      if (!result.success) {
        setProcessingRepairId(null);
        addMessage('assistant', MESSAGE_TYPES.TEXT, {
          text: 'Repair failed — try again or adjust the segment manually.',
        });
        return;
      }

      setProcessingRepairId(null);

      addMessage('assistant', MESSAGE_TYPES.TEXT, {
        text: '✓ Segment repaired — edges cleaned up.',
      });

      // Set result for Demo.jsx to handle
      setRepairResult({
        segmentId: segment.id,
        repairedImage: result.repaired_image,
        svg: result.svg,
        mask: result.mask,
        box_2d: result.box_2d,
        success: true,
      });

    } catch (error) {
      console.error('[useConversation] Repair failed:', error);
      setProcessingRepairId(null);
      setMessages((prev) => prev.filter((m) => m.data?.id !== workingId));
      addMessage('assistant', MESSAGE_TYPES.ERROR, {
        text: `Repair failed: ${error.message}`,
      });
    }
  }, [segmentedImages, activeSegmentedIndex, addMessage]);

  // Submit grab element request
  const submitGrabElements = useCallback(async (elementDescription) => {
    if (!currentImage) return { success: false };

    const isGrabMore = grabMoreMode;
    const wasInEditingMode = state === STATES.EDITING_MODE;
    setGrabElementMode(false);
    setGrabMoreMode(false);
    // Don't change state if already in editing mode - just process in background
    if (!wasInEditingMode) {
      setState(STATES.PROCESSING_SEGMENTS);
    }

    // Generate session_id for progress tracking
    const trackingSessionId = `grab-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Find the message with the selected image — prefer activeImageMessageIdRef
    const imageMsg = activeImageMessageIdRef.current
      ? messages.find(m => m.id === activeImageMessageIdRef.current)
      : messages.find(m => m.role === 'ai' && m.type === MESSAGE_TYPES.IMAGE && m.data.selectedIndex !== null);

    // Get existing segments if grab more mode
    let existingElements = [];
    let imageToUse = currentImage.base64;

    if (isGrabMore && imageMsg) {
      const selectedIdx = imageMsg.data.selectedIndex;
      const selectedImg = imageMsg.data.images[selectedIdx];
      if (selectedImg?.segments?.source === 'grab' && selectedImg.segments.restImage) {
        // Use rest image for grab more
        imageToUse = selectedImg.segments.restImage;
        // Keep existing elements to merge
        existingElements = selectedImg.segments.layers[0]?.elements || [];
      }
    }

    if (imageMsg) {
      // Mark selected image as processing with the tracking session_id
      setMessages((prev) => {
        const msgIndex = prev.findIndex(m => m.id === imageMsg.id);
        if (msgIndex >= 0) {
          const updated = [...prev];
          const selectedIdx = updated[msgIndex].data.selectedIndex;
          const images = [...updated[msgIndex].data.images];
          images[selectedIdx] = {
            ...images[selectedIdx],
            isProcessing: true,
            grabDescription: elementDescription, // Store what we're grabbing for UI display
            grabNotFound: false, // Clear any previous "not found" state
            grabNotFoundDescription: null,
            // Store tracking session for progress polling
            analysis: {
              ...images[selectedIdx].analysis,
              sessionId: trackingSessionId,
            },
          };
          updated[msgIndex] = {
            ...updated[msgIndex],
            data: { ...updated[msgIndex].data, images }
          };
          return updated;
        }
        return prev;
      });
    }

    try {
      const response = await fetch(`${API_BASE_URL}/grab-elements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base64_image: imageToUse,
          element_description: elementDescription,
          session_id: trackingSessionId,
        }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();

      // Check if backend returned an error (e.g., "No matching elements found")
      if (data.error) {
        console.log('Grab elements returned error:', data.error);
        // Preserve editing mode if we were already in it
        if (!wasInEditingMode) {
          setState(STATES.IMAGE_READY);
        }

        // Use parsed_query from backend (e.g., "duck" from "get a duck")
        const parsedQuery = data.parsed_query || elementDescription;

        // Show error in the UI - mark as not processing with a "not found" error
        if (imageMsg) {
          setMessages((prev) => {
            const msgIndex = prev.findIndex(m => m.id === imageMsg.id);
            if (msgIndex >= 0) {
              const updated = [...prev];
              const selectedIdx = updated[msgIndex].data.selectedIndex;
              const images = [...updated[msgIndex].data.images];
              images[selectedIdx] = {
                ...images[selectedIdx],
                isProcessing: false,
                grabNotFound: true,
                grabNotFoundDescription: parsedQuery,
              };
              updated[msgIndex] = {
                ...updated[msgIndex],
                data: { ...updated[msgIndex].data, images }
              };
              return updated;
            }
            return prev;
          });
        }

        return { success: false, error: data.error, notFound: true };
      }

      setCurrentSession(data.session_id);

      // Merge elements if grab more mode
      const mergedElements = [...existingElements, ...data.elements];
      console.log(`[grab] Merged ${existingElements.length} existing + ${data.elements.length} new = ${mergedElements.length} elements`);
      mergedElements.forEach((elem, i) => {
        console.log(`[grab] mergedElements[${i}]: name=${elem.name}, svg=${elem.svg ? elem.svg.length + ' chars' : 'MISSING'}, svg_trace=${elem.svg_trace ? 'yes' : 'no'}`);
      });

      // Create merged data with proper layers structure for convertSegmentsToImage
      const mergedData = {
        session_id: data.session_id,
        layers: [{ layer: 1, elements: mergedElements }],
        rest_image: data.rest_image,
      };

      setProcessedSegments(mergedData);
      // Preserve editing mode if we were already in it
      if (!wasInEditingMode) {
        setState(STATES.SEGMENTS_READY);
      }

      // Update the image message with segments (not processing anymore)
      if (imageMsg) {
        const selectedIdx = imageMsg.data.selectedIndex;

        setMessages((prev) => {
          const msgIndex = prev.findIndex(m => m.id === imageMsg.id);
          if (msgIndex >= 0) {
            const updated = [...prev];
            const images = [...updated[msgIndex].data.images];
            images[selectedIdx] = {
              ...images[selectedIdx],
              isProcessing: false,
              analysis: {
                ...images[selectedIdx].analysis,
                sessionId: data.session_id,
              },
              segments: {
                source: 'grab',
                sessionId: data.session_id,
                layers: [{ layer: 1, elements: mergedElements }],
                restImage: data.rest_image,
              },
            };
            updated[msgIndex] = {
              ...updated[msgIndex],
              data: { ...updated[msgIndex].data, images }
            };
            return updated;
          }
          return prev;
        });

        // Update segmentedImages pool — update existing or add new entry
        setSegmentedImages((prevSegmented) => {
          const existingIdx = prevSegmented.findIndex(
            seg => seg.sourceMessageId === imageMsg.id && seg.sourceImageIndex === selectedIdx
          );

          if (existingIdx >= 0) {
            // Update the existing entry with new merged data
            const updatedPool = [...prevSegmented];
            // Clear traced flag so trace effect re-runs for new elements
            tracedSegmentIdsRef.current.delete(updatedPool[existingIdx].id);
            updatedPool[existingIdx] = {
              ...updatedPool[existingIdx],
              sessionId: data.session_id,
              layers: [{ layer: 1, elements: mergedElements }],
              restImage: data.rest_image,
            };
            return updatedPool;
          }

          // Image not yet in pool (e.g. grabbed while already in editing mode)
          // — add it so the sync effect in Demo.jsx picks up the new segments
          const newEntry = {
            id: `seg-${Date.now()}`,
            sessionId: data.session_id,
            originalImage: {
              dataUrl: currentImage.dataUrl,
              base64: currentImage.base64,
            },
            layers: [{ layer: 1, elements: mergedElements }],
            restImage: data.rest_image,
            sourceMessageId: imageMsg.id,
            sourceImageIndex: selectedIdx,
            source: 'grab',
          };
          setActiveSegmentedIndex(prevSegmented.length);
          return [...prevSegmented, newEntry];
        });
      }

      return { success: true, segments: mergedData };
    } catch (error) {
      console.error('Grab elements failed:', error);
      // Preserve editing mode if we were already in it
      if (!wasInEditingMode) {
        setState(STATES.IMAGE_READY);
      }

      // Clear processing state on error
      if (imageMsg) {
        setMessages((prev) => {
          const msgIndex = prev.findIndex(m => m.id === imageMsg.id);
          if (msgIndex >= 0) {
            const updated = [...prev];
            const selectedIdx = updated[msgIndex].data.selectedIndex;
            const images = [...updated[msgIndex].data.images];
            images[selectedIdx] = {
              ...images[selectedIdx],
              isProcessing: false,
              segmentsError: 'Failed to grab elements. Please try again.',
            };
            updated[msgIndex] = {
              ...updated[msgIndex],
              data: { ...updated[msgIndex].data, images }
            };
            return updated;
          }
          return prev;
        });
      }

      return { success: false, error };
    }
  }, [currentImage, messages, grabMoreMode, state]);

  // Submit layer modification
  const submitLayerModification = useCallback(async (modificationText) => {
    if (!currentSession || !currentLayers) return { success: false };

    setModifyLayerMode(false);

    // Find the message with the selected image — prefer activeImageMessageIdRef
    const imageMsg = activeImageMessageIdRef.current
      ? messages.find(m => m.id === activeImageMessageIdRef.current)
      : messages.find(m => m.role === 'ai' && m.type === MESSAGE_TYPES.IMAGE && m.data.selectedIndex !== null);

    if (!imageMsg) return { success: false };

    // Show updating status with user's request
    setMessages((prev) => {
      const msgIndex = prev.findIndex(m => m.id === imageMsg.id);
      if (msgIndex >= 0) {
        const updated = [...prev];
        const selectedIdx = updated[msgIndex].data.selectedIndex;
        const images = [...updated[msgIndex].data.images];
        images[selectedIdx] = {
          ...images[selectedIdx],
          isModifyingLayers: true,
          layerModificationRequest: modificationText,
        };
        updated[msgIndex] = {
          ...updated[msgIndex],
          data: { ...updated[msgIndex].data, images }
        };
        return updated;
      }
      return prev;
    });

    try {
      // Call the update-layers API with modification request
      // The backend should interpret the natural language and update layers
      const response = await fetch(`${API_BASE_URL}/update-layers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: currentSession,
          modification_request: modificationText,
          current_layers: currentLayers,
          reanalyze: true,  // Re-analyze with the modification context
        }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();

      // Update the analysis with new layers AND session
      setCurrentLayers(data.layers);
      // CRITICAL: Update currentSession so processSegments uses the correct session
      if (data.session_id) {
        setCurrentSession(data.session_id);
      }

      // Update message with new analysis and CLEAR segments (user modified layers)
      setMessages((prev) => {
        const msgIndex = prev.findIndex(m => m.id === imageMsg.id);
        if (msgIndex >= 0) {
          const updated = [...prev];
          const selectedIdx = updated[msgIndex].data.selectedIndex;
          const images = [...updated[msgIndex].data.images];
          const wasInEditingMode = images[selectedIdx]?.isInEditingMode || false;

          images[selectedIdx] = {
            ...images[selectedIdx],
            analysis: {
              ...images[selectedIdx].analysis,  // Preserve sessionId
              sessionId: data.session_id || images[selectedIdx].analysis?.sessionId,
              layers: data.layers,
              humanized: data.humanized,  // Include humanized descriptions
            },
            // Clear segments since layers were modified
            segments: null,
            isProcessing: false,
            isModifyingLayers: false,
            layerModificationRequest: null,
            isInEditingMode: false,  // Exit editing mode since segments cleared
          };
          updated[msgIndex] = {
            ...updated[msgIndex],
            data: { ...updated[msgIndex].data, images }
          };

          // If this image was in editing mode, exit editing mode
          if (wasInEditingMode) {
            setState(STATES.LAYERS_READY);
          }

          return updated;
        }
        return prev;
      });

      // Reset state to layers ready (segments cleared)
      setState(STATES.LAYERS_READY);
      setProcessedSegments(null);

      return { success: true, layers: data.layers };
    } catch (error) {
      console.error('Layer modification failed:', error);

      // Clear updating status on error
      setMessages((prev) => {
        const msgIndex = prev.findIndex(m => m.id === imageMsg.id);
        if (msgIndex >= 0) {
          const updated = [...prev];
          const selectedIdx = updated[msgIndex].data.selectedIndex;
          const images = [...updated[msgIndex].data.images];
          images[selectedIdx] = {
            ...images[selectedIdx],
            isModifyingLayers: false,
            layerModificationRequest: null,
            analysisError: 'Failed to update layers. Please try again.',
          };
          updated[msgIndex] = {
            ...updated[msgIndex],
            data: { ...updated[msgIndex].data, images }
          };
          return updated;
        }
        return prev;
      });

      return { success: false, error };
    }
  }, [currentSession, currentLayers, messages]);

  // Handle user text input (for modifications)
  const handleUserInput = useCallback(async (text) => {
    // If in sub-segment mode, submit as sub-segment request
    if (subSegmentMode) {
      await submitSubSegment(text);
      return;
    }

    // If in grab element mode, submit as grab element request
    if (grabElementMode) {
      await submitGrabElements(text);
      return;
    }

    // If in modify layer mode, submit as layer modification
    // Don't add user message - it's already shown in the updating UI
    if (modifyLayerMode) {
      await submitLayerModification(text);
      return;
    }

    addMessage('user', MESSAGE_TYPES.TEXT, { text });

    // Simple keyword detection for actions
    const lowerText = text.toLowerCase();

    if (state === STATES.LAYERS_READY) {
      if (lowerText.includes('proceed') || lowerText.includes('ok') ||
          lowerText.includes('yes') || lowerText.includes('looks good')) {
        await processSegments();
        return;
      }
    }

    if (state === STATES.IMAGE_READY) {
      if (lowerText.includes('analyze') || lowerText.includes('segment')) {
        await analyzeLayers();
        return;
      }
    }

    // Default: treat as image generation prompt
    if (state === STATES.IDLE || state === STATES.EDITING_MODE) {
      await generateImage(text);
    }
  }, [state, modifyLayerMode, grabElementMode, subSegmentMode, addMessage, generateImage, analyzeLayers, processSegments, submitLayerModification, submitGrabElements, submitSubSegment]);

  // Switch active segmented image in SegmentSection
  // Also syncs the editing mode state with conversation panel
  const switchSegmentedImage = useCallback((index) => {
    if (index >= 0 && index < segmentedImages.length) {
      setActiveSegmentedIndex(index);

      // Sync with conversation panel: set isInEditingMode on the source image
      const segImage = segmentedImages[index];
      activeImageMessageIdRef.current = segImage.sourceMessageId;
      if (segImage.sourceImageIndex !== undefined) {
        setMessages((prev) => {
          return prev.map(msg => {
            if (msg.role === 'ai' && msg.type === MESSAGE_TYPES.IMAGE) {
              // Only set editing mode on the message that owns this pool entry
              const isSourceMsg = msg.id === segImage.sourceMessageId;
              const images = msg.data.images.map((img, imgIdx) => ({
                ...img,
                // Set editing mode on the selected image in the source message, clear on all others
                isInEditingMode: isSourceMsg && imgIdx === segImage.sourceImageIndex && img.segments,
              }));
              // Also update selectedIndex on the source message
              return {
                ...msg,
                data: {
                  ...msg.data,
                  images,
                  ...(isSourceMsg ? { selectedIndex: segImage.sourceImageIndex } : {}),
                }
              };
            }
            return msg;
          });
        });

        // Update current image to the selected one
        const imageMsg = messages.find(m => m.id === segImage.sourceMessageId);
        if (imageMsg) {
          const sourceImg = imageMsg.data.images[segImage.sourceImageIndex];
          if (sourceImg) {
            setCurrentImage({
              base64: sourceImg.base64,
              dataUrl: sourceImg.dataUrl,
              prompt: imageMsg.data.prompt,
            });
            if (sourceImg.analysis?.sessionId) {
              setCurrentSession(sourceImg.analysis.sessionId);
            }
            if (sourceImg.segments) {
              setProcessedSegments({
                session_id: sourceImg.segments.sessionId,
                layers: sourceImg.segments.layers,
                rest_image: sourceImg.segments.restImage,
              });
            }
          }
        }
      }
    }
  }, [segmentedImages, messages]);

  // Get the editing state for each segmented image by checking source images
  const getSegmentedImageEditingStates = useCallback(() => {
    return segmentedImages.map(segImg => {
      // Find the correct source message for each pool entry
      const sourceMsg = messages.find(m => m.id === segImg.sourceMessageId);
      if (!sourceMsg) return false;
      const sourceIdx = segImg.sourceImageIndex;
      const sourceImage = sourceIdx !== undefined ? sourceMsg.data.images[sourceIdx] : null;
      return sourceImage?.isInEditingMode || false;
    });
  }, [messages, segmentedImages]);

  // DEV: Load test data for UI testing without running full pipeline
  // Creates THREE test images for different test scenarios:
  // - Image 1: Has layer analysis → test "Proceed to Segmentation"
  //            Uses V1 pipeline: SAM2 + hybrid (diff-mask for complex objects)
  // - Image 2: Has analysis only → test "Proceed to Segmentation"
  // - Image 3: Clean/raw → test "Analyze Layers" / "Grab Element"
  const loadTestData = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/test-data`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();

      // Set current image
      setCurrentImage({
        base64: data.original_image.split(',')[1],
        dataUrl: data.original_image,
        prompt: 'Test image'
      });
      setCurrentSession(data.session_id);
      setCurrentLayers(data.analysis_layers || []);

      // Build segments data from backend processed layers (if available)
      // NOTE: Two different structures needed:
      // - processedSegments uses rest_image (snake_case) for convertSegmentsToImage
      // - message segments uses restImage (camelCase) for NestedSegments in ChatMessage
      const hasProcessedLayers = data.layers && data.layers.length > 0;

      // For convertSegmentsToImage (snake_case)
      const processedSegmentsData = hasProcessedLayers ? {
        layers: data.layers,
        rest_image: data.rest_image || null,  // snake_case
        source: 'analyze'
      } : null;

      // For NestedSegments in ChatMessage (camelCase)
      const messageSegmentsData = hasProcessedLayers ? {
        layers: data.layers,
        restImage: data.rest_image || null,  // camelCase
        source: 'analyze'
      } : null;

      // Create image message with THREE images for different test scenarios
      const testMsg = addMessage('ai', MESSAGE_TYPES.IMAGE, {
        images: [
          {
            // === TEST SCENARIO 1: Fully Segmented ===
            // Has layer analysis AND segments
            // Shows layer chips with REDO buttons for testing
            // Tests: Redo from layer UI
            base64: data.original_image.split(',')[1],
            dataUrl: data.original_image,
            isLoading: false,
            analysis: {
              sessionId: data.session_id,
              layers: data.analysis_layers || [],
              humanized: data.humanized
            },
            segments: messageSegmentsData,  // camelCase for NestedSegments
            isInEditingMode: false,
          },
          {
            // === TEST SCENARIO 2: Layer Analysis Only ===
            // Has layer analysis, no segments yet
            // Click this → shows "Proceed to Segmentation" button
            // Tests: V1 pipeline (SAM2 + hybrid diff-mask)
            base64: data.original_image.split(',')[1],
            dataUrl: `${data.original_image}#scenario2-analyze`,
            isLoading: false,
            analysis: {
              sessionId: data.session_id,
              layers: data.analysis_layers || [],
              humanized: data.humanized
            },
            segments: null,
            isInEditingMode: false,
          },
          data.secondary_session ? {
            // === TEST SCENARIO 3: Noisy Segmented (Repair Testing) ===
            // Different image with noisy segments for testing repair feature
            base64: data.secondary_session.original_image.split(',')[1],
            dataUrl: data.secondary_session.original_image,
            isLoading: false,
            analysis: {
              sessionId: data.secondary_session.session_id,
              layers: data.secondary_session.analysis_layers || [],
              humanized: data.secondary_session.humanized,
            },
            segments: {
              layers: data.secondary_session.layers,
              restImage: data.secondary_session.rest_image || null,
              source: 'analyze',
            },
            isInEditingMode: false,
          } : {
            // === TEST SCENARIO 3: Clean Image (fallback) ===
            // No analysis, no segments
            base64: data.original_image.split(',')[1],
            dataUrl: `${data.original_image}#scenario3-clean`,
            isLoading: false,
            analysis: null,
            segments: null,
            isInEditingMode: false,
          }
        ],
        prompt: 'Test: 1=Segmented (redo), 2=Analyzed, 3=Noisy (repair)',
        selectedIndex: 0,
        isAnalyzing: false,
      });
      activeImageMessageIdRef.current = testMsg.id;

      // Image 1 has segments, so set state to SEGMENTS_READY
      if (hasProcessedLayers) {
        setProcessedSegments(processedSegmentsData);  // snake_case for convertSegmentsToImage
        setState(STATES.SEGMENTS_READY);
      } else {
        setProcessedSegments(null);
        setState(STATES.LAYERS_READY);
      }

      // Note: We DON'T populate segmentedImages here anymore
      // They will be added when user clicks "Start Editing" on each image
      // This matches the new flow that prevents the flash bug
      setSegmentedImages([]);
      setActiveSegmentedIndex(0);

      return { success: true };
    } catch (error) {
      console.error('Failed to load test data:', error);
      addMessage('ai', MESSAGE_TYPES.ERROR, {
        message: 'Failed to load test data. Make sure backend is running and test data exists.',
      });
      return { success: false, error };
    }
  }, [addMessage]);

  return {
    // State
    messages,
    state,
    currentSession,
    currentImage,
    currentLayers,
    processedSegments,
    segmentedImages,
    activeSegmentedIndex,
    traceProgress,  // { total, completed, isGenerating } for trace SVG generation
    lastPrompt,
    modifyLayerMode,
    grabElementMode,
    pendingUpload, // Image waiting to be cropped
    activeImageMessageId: activeImageMessageIdRef.current, // Which IMAGE message user is interacting with

    // Actions
    generateImage,
    selectImage,
    regenerateAllImages,
    regenerateSingleImage,
    updateImage,
    handleImageUpload,
    cancelCrop,
    handleCroppedImage,
    stylizeImage,
    analyzeLayers,
    updateLayers,
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
    grabMoreMode,
    subSegmentMode,
    startSubSegmentMode,
    cancelSubSegmentMode,
    subSegmentResult,
    processingSubSegmentId,
    clearSubSegmentResult: () => setSubSegmentResult(null),
    submitRepair,
    processingRepairId,
    repairResult,
    clearRepairResult: () => setRepairResult(null),
    redoGrab: submitGrabElements,  // Re-run grab with same or new description
    handleUserInput,
    switchSegmentedImage,
    getSegmentedImageEditingStates,
    addMessage,
    loadTestData,  // DEV: Load pre-generated test data

    // State checks
    isGenerating: state === STATES.GENERATING_IMAGE,
    isAnalyzing: state === STATES.ANALYZING_LAYERS,
    isProcessing: state === STATES.PROCESSING_SEGMENTS,
    isEditing: state === STATES.EDITING_MODE,
    hasSegments: segmentedImages.length > 0,
    isCropping: pendingUpload !== null, // Show crop overlay
  };
}
