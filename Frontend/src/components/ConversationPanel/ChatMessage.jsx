import React from 'react';
import { MESSAGE_TYPES } from '../../hooks/useConversation';
import { API_BASE_URL } from '../../config';

// Thinking indicator with animated steps
const ThinkingIndicator = ({ steps, currentStep }) => {
  return (
    <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
      {steps.map((step, index) => (
        <div
          key={index}
          className={`flex items-center space-x-2 py-1 ${
            index <= currentStep ? 'text-gray-700' : 'text-gray-400'
          }`}
        >
          {index < currentStep ? (
            <span className="text-green-500">&#10003;</span>
          ) : index === currentStep ? (
            <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          ) : (
            <span className="w-4 h-4" />
          )}
          <span className="text-sm">{step}</span>
        </div>
      ))}
    </div>
  );
};

// Refresh icon SVG component (for regenerate all)
const RefreshAllIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    className="h-5 w-5"
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={2}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
    />
  </svg>
);

// Single refresh icon (for per-image regenerate)
const RefreshOneIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    className="h-4 w-4"
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={2}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M4 4v5h.582m0 0a8.001 8.001 0 0115.356 2M4.582 9H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
    />
  </svg>
);

// Loading spinner for image slots
const ImageLoadingSpinner = () => (
  <div className="absolute inset-0 bg-gray-200 flex items-center justify-center">
    <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
  </div>
);

// Format layers - use humanized data from Gemini if available, otherwise fallback
const formatLayerDescription = (layer, humanizedLayers) => {
  const layerNum = layer.layer || 1;

  // Try to find humanized description from Gemini
  if (humanizedLayers && humanizedLayers.length > 0) {
    const humanized = humanizedLayers.find(h => h.layer === layerNum);
    if (humanized) {
      return {
        name: humanized.name || `Layer ${layerNum}`,
        description: humanized.description || ''
      };
    }
  }

  // Fallback to basic formatting if no humanized data
  const layerName = layerNum === 1 ? 'Front layer' :
                    layerNum === 2 ? 'Middle layer' :
                    `Back layer`;

  if (!layer.elements || layer.elements.length === 0) {
    return { name: layerName, description: 'No elements' };
  }

  // Simple element list as fallback
  const elements = layer.elements.map(e => e.name).join(', ');
  return { name: layerName, description: elements };
};

// Nested analysis panel (collapsible) - PURPLE theme for layer analysis
const NestedAnalysis = ({ analysis, isAnalyzing, isModifyingLayers, layerModificationRequest, error, onAction, hasSegments, isProcessing, isRedoing }) => {
  if (isAnalyzing) {
    return (
      <div className="mt-3 p-3 bg-purple-50 rounded-lg border border-purple-200 animate-fadeIn">
        <div className="flex items-center space-x-2 text-gray-600">
          <div className="w-4 h-4 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm">Analyzing layers...</span>
        </div>
      </div>
    );
  }

  if (isModifyingLayers) {
    return (
      <div className="mt-3 p-3 bg-purple-50 rounded-lg border border-purple-200 animate-fadeIn">
        <div className="flex items-center space-x-2 text-gray-600 mb-2">
          <div className="w-4 h-4 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm">Updating layers...</span>
        </div>
        {layerModificationRequest && (
          <p className="text-xs text-gray-500 italic">"{layerModificationRequest}"</p>
        )}
      </div>
    );
  }

  if (error) {
    return (
      <div className="mt-3 p-3 bg-red-50 rounded-lg border border-red-200 animate-fadeIn">
        <p className="text-sm text-red-600">{error}</p>
        <button
          onClick={() => onAction('analyze')}
          className="mt-2 text-sm text-red-600 hover:text-red-800 underline"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!analysis) return null;

  return (
    <div className="mt-3 p-3 bg-purple-50 rounded-lg border border-purple-200 animate-fadeIn">
      <p className="text-sm font-medium text-gray-700 mb-2">
        Layer Structure ({analysis.layers.length} layers detected)
      </p>
      <div className="space-y-2">
        {analysis.layers.map((layer, index) => {
          const formatted = formatLayerDescription(layer, analysis.humanized);
          return (
            <div key={index} className="text-sm">
              <span className="font-medium text-gray-700">{formatted.name}:</span>{' '}
              <span className="text-gray-600">{formatted.description}</span>
            </div>
          );
        })}
      </div>
      {/* Action buttons - Proceed (blue for segmentation), Modify (purple for layers) */}
      {/* Hide during redo since segmentation is in progress */}
      {!isProcessing && !isRedoing && (
        <div className="flex gap-2 mt-3">
          {!hasSegments && (
            <button
              onClick={() => onAction('proceed')}
              className="px-3 py-2 bg-blue-500 text-white text-sm rounded-lg hover:bg-blue-600 transition-colors"
            >
              Proceed to Segmentation
            </button>
          )}
          <button
            onClick={() => onAction('modifyLayers')}
            className="px-3 py-2 bg-purple-500 text-white text-sm rounded-lg hover:bg-purple-600 transition-colors"
          >
            Modify Layers
          </button>
        </div>
      )}
    </div>
  );
};

// Redo icon
const RedoIcon = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    className="h-4 w-4"
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={2}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
    />
  </svg>
);

// Redo from here icon (refresh + down arrow)
const RedoFromHereIcon = ({ className = "h-3 w-3" }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    className={className}
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={2}
  >
    {/* Refresh arrow */}
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9"
    />
    {/* Down arrow */}
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M12 16v5m0 0l-3-3m3 3l3-3"
    />
  </svg>
);

// Nested segments panel (inside image card, below analysis)
// Now supports streaming: elements appear one by one as they're extracted
// Also supports redo mode: keeps layers < redoFromLayer static, updates layers >= redoFromLayer
const NestedSegments = ({ segments, isProcessing, error, originalImage, onAction, onHoverSegment, isInEditingMode, sessionId, isStreaming, streamingElements, streamingStatus, totalElements, onRedoFromLayer, onRedoSingleLayer, isRedoing, redoFromLayer, redoStatus, redoElements }) => {
  const [hoveredSegment, setHoveredSegment] = React.useState(null);

  // Preview size (scaled down from 1024)
  const PREVIEW_SIZE = 200;

  // Helper to get extracted image URL (used in both streaming and normal mode)
  const getExtractedUrl = (elem) => {
    if (!elem.extracted) return null;
    return elem.extracted.startsWith('data:')
      ? elem.extracted
      : `data:image/png;base64,${elem.extracted}`;
  };

  // Helper to get element position style
  const getElementStyle = (elem) => {
    if (!elem.box_2d || elem.box_2d.length !== 4) {
      // Fallback: center the element if no box_2d
      return {
        position: 'absolute',
        left: '25%',
        top: '25%',
        width: '50%',
        height: '50%',
      };
    }
    const [y_min, x_min, y_max, x_max] = elem.box_2d;
    const left = (x_min / 1000) * PREVIEW_SIZE;
    const top = (y_min / 1000) * PREVIEW_SIZE;
    const width = Math.max(((x_max - x_min) / 1000) * PREVIEW_SIZE, 10); // min 10px
    const height = Math.max(((y_max - y_min) / 1000) * PREVIEW_SIZE, 10); // min 10px
    return {
      position: 'absolute',
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`,
    };
  };

  // STREAMING MODE: Show elements as they arrive with name tags
  if (isStreaming || (isProcessing && streamingElements)) {
    const elements = streamingElements || [];
    const progress = totalElements > 0 ? Math.round((elements.length / totalElements) * 100) : 0;

    return (
      <div className="mt-3 p-3 bg-blue-50 rounded-lg border border-blue-200 animate-fadeIn">
        {/* Status header */}
        <div className="flex items-center justify-between text-gray-600 mb-2">
          <div className="flex items-center space-x-2">
            <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm font-medium">{streamingStatus || 'Processing...'}</span>
          </div>
          <span className="text-xs text-blue-600 font-medium">
            {elements.length}/{totalElements || '?'} elements
          </span>
        </div>

        {/* Preview container with streaming elements */}
        <div
          className="relative inline-block rounded-lg shadow-md bg-gray-100 mx-auto"
          style={{ width: PREVIEW_SIZE, height: PREVIEW_SIZE, overflow: 'visible' }}
        >
          {/* Background image - slightly dimmed but NOT grayscale so extracted elements show properly */}
          {originalImage && (
            <img
              src={originalImage}
              alt="Original"
              className="absolute inset-0 w-full h-full object-cover"
              style={{ opacity: 0.3 }}
            />
          )}

          {/* Streaming elements appearing one by one - render on top of gray bg */}
          {/* Extracted images are already 1024x1024 canvases with element at correct position */}
          {/* So use inset-0 to fill container, just like final view */}
          {[...elements].reverse().map((elem, reverseIdx) => {
            const extractedUrl = getExtractedUrl(elem);
            if (!extractedUrl) return null;

            return (
              <img
                key={`${elem.name}-${reverseIdx}`}
                src={extractedUrl}
                alt={elem.name}
                className="absolute inset-0 pointer-events-none animate-fadeIn"
                style={{
                  width: PREVIEW_SIZE,
                  height: PREVIEW_SIZE,
                  zIndex: reverseIdx + 1,
                }}
              />
            );
          })}

          {/* Loading spinner overlay - lower z-index so elements show on top */}
          <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
            <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin opacity-30" />
          </div>
        </div>

        {/* Layer-grouped element name tags (L1, L2, etc.) - bordered containers like completed view */}
        <div className="mt-2 space-y-1.5">
          {(() => {
            // Group elements by layer
            const byLayer = {};
            elements.forEach(elem => {
              const layer = elem.layer || 1;
              if (!byLayer[layer]) byLayer[layer] = [];
              byLayer[layer].push(elem);
            });
            return Object.entries(byLayer).sort(([a], [b]) => Number(a) - Number(b)).map(([layerNum, layerElems]) => (
              <div key={`layer-${layerNum}`} className="flex items-center gap-1 p-1.5 bg-white border border-gray-200 rounded-lg">
                <span className="text-xs font-semibold text-gray-600 w-6 flex-shrink-0">L{layerNum}</span>
                <div className="flex-1 flex items-center gap-1 flex-wrap">
                  {layerElems.map((elem, idx) => (
                    <span
                      key={`tag-${elem.name}-${idx}`}
                      className="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs rounded animate-fadeIn"
                    >
                      {elem.name}
                    </span>
                  ))}
                </div>
              </div>
            ));
          })()}
        </div>

        {/* Progress bar */}
        <div className="w-full h-1.5 bg-blue-200 rounded-full overflow-hidden mt-2">
          <div
            className="h-full bg-blue-500 rounded-full transition-all duration-300 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    );
  }

  // REDO MODE: Show existing segments for layers < redoFromLayer, redo progress for layers >= redoFromLayer
  // For FULL redo (redoFromLayer === 1), segments may be null - show streaming progress
  if (isRedoing) {
    const existingLayers = segments?.layers || [];
    const redoLayersData = redoElements || [];

    // Split layers: keep layers below redoFromLayer, show redo progress for layers >= redoFromLayer
    const keptLayers = existingLayers.filter(l => l.layer < redoFromLayer);
    const redoingLayerNums = existingLayers
      .filter(l => l.layer >= redoFromLayer)
      .map(l => l.layer);

    // Combine kept layers with redo elements
    const displayLayers = [...keptLayers, ...redoLayersData].sort((a, b) => a.layer - b.layer);

    // Parse the current layer being processed from redoStatus
    // Format: "Layer 6: Detecting..." or "Layer 7: Extracted cloud-upper-left"
    const currentLayerMatch = redoStatus?.match(/Layer (\d+):/);
    const currentProcessingLayer = currentLayerMatch ? parseInt(currentLayerMatch[1]) : redoFromLayer;

    // Flatten all redo elements for image preview
    const allRedoElements = redoLayersData.flatMap(layer =>
      layer.elements.map(elem => ({ ...elem, layer: layer.layer }))
    );

    // Group elements by layer for display
    const elementsByLayer = displayLayers.map(layer => {
      const isBeingRedone = layer.layer >= redoFromLayer;
      const isCurrentlyProcessing = layer.layer === currentProcessingLayer;
      const isCompleted = isBeingRedone && layer.layer < currentProcessingLayer;

      return {
        layerNum: layer.layer,
        elements: layer.elements.map(elem => ({ ...elem, layer: layer.layer })),
        isBeingRedone,
        isCurrentlyProcessing,
        isCompleted,
      };
    });

    return (
      <div className="mt-3 p-3 bg-green-50 rounded-lg border border-green-200 animate-fadeIn">
        {/* Status header with progress */}
        <div className="flex items-center justify-between text-gray-600 mb-2">
          <div className="flex items-center space-x-2">
            <div className="w-4 h-4 border-2 border-green-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm font-medium">
              {redoStatus || `Redoing from layer ${redoFromLayer}...`}
            </span>
          </div>
        </div>

        {/* Image preview with elements popping up */}
        {originalImage && (
          <div
            className="relative inline-block rounded-lg shadow-md bg-gray-100 mx-auto"
            style={{ width: PREVIEW_SIZE, height: PREVIEW_SIZE, overflow: 'visible' }}
          >
            {/* Background image - slightly dimmed */}
            <img
              src={originalImage}
              alt="Original"
              className="absolute inset-0 w-full h-full object-cover"
              style={{ opacity: 0.3 }}
            />
            {/* Extracted elements from redo - same approach as streaming mode */}
            {/* Extracted images are already 1024x1024 canvases with element at correct position */}
            {/* Use inset-0 to fill container, transparency handles positioning */}
            {[...allRedoElements].reverse().map((elem, reverseIdx) => {
              const extractedUrl = getExtractedUrl(elem);
              if (!extractedUrl) return null;
              return (
                <img
                  key={`redo-${elem.name}-${reverseIdx}`}
                  src={extractedUrl}
                  alt={elem.name}
                  className="absolute inset-0 pointer-events-none animate-fadeIn"
                  style={{
                    width: PREVIEW_SIZE,
                    height: PREVIEW_SIZE,
                    zIndex: reverseIdx + 1,
                  }}
                />
              );
            })}
            {/* Loading spinner overlay */}
            <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
              <div className="w-8 h-8 border-4 border-green-500 border-t-transparent rounded-full animate-spin opacity-30" />
            </div>
          </div>
        )}

        {/* Layer rows - kept layers static, redo layers with status */}
        <div className="mt-2 space-y-1.5">
          {elementsByLayer.map((layer) => (
            <div
              key={layer.layerNum}
              className={`flex items-center gap-1 p-1.5 rounded-lg group ${
                layer.isCurrentlyProcessing
                  ? 'bg-yellow-50 border border-yellow-300'  // Currently processing - yellow
                  : layer.isCompleted
                    ? 'bg-green-100 border border-green-300'  // Completed redo - green
                    : layer.isBeingRedone
                      ? 'bg-gray-50 border border-gray-200 opacity-50'  // Waiting to redo - faded
                      : 'bg-white border border-gray-200'  // Kept layers - normal
              }`}
            >
              {/* Layer label */}
              <span className={`text-xs font-semibold w-6 flex-shrink-0 ${
                layer.isCurrentlyProcessing ? 'text-yellow-600'
                  : layer.isCompleted ? 'text-green-600'
                    : layer.isBeingRedone ? 'text-gray-400'
                      : 'text-gray-600'
              }`}>
                L{layer.layerNum}
              </span>
              {/* Element chips */}
              <div className="flex-1 flex items-center gap-1 flex-wrap">
                {layer.elements.map((elem, idx) => (
                  <span
                    key={`${elem.name}-${idx}`}
                    className={`text-xs px-2 py-0.5 rounded ${
                      layer.isCurrentlyProcessing
                        ? 'bg-yellow-100 text-yellow-700 animate-fadeIn'
                        : layer.isCompleted
                          ? 'bg-green-200 text-green-700'
                          : layer.isBeingRedone
                            ? 'bg-gray-100 text-gray-500'
                            : 'bg-gray-100 text-gray-700'
                    }`}
                  >
                    {elem.name}
                  </span>
                ))}
                {/* Show spinner for layer currently being processed with no elements yet */}
                {layer.isCurrentlyProcessing && layer.elements.length === 0 && (
                  <div className="flex items-center space-x-1 text-yellow-600">
                    <div className="w-3 h-3 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin" />
                    <span className="text-xs">Processing...</span>
                  </div>
                )}
              </div>
              {/* Status badge */}
              {layer.isCurrentlyProcessing && (
                <span className="flex-shrink-0 px-1.5 py-0.5 bg-yellow-200 text-yellow-700 text-xs rounded">
                  redoing
                </span>
              )}
              {layer.isCompleted && (
                <span className="flex-shrink-0 px-1.5 py-0.5 bg-green-200 text-green-700 text-xs rounded">
                  ✓ done
                </span>
              )}
            </div>
          ))}
          {/* Show placeholder rows for layers that haven't started yet */}
          {redoingLayerNums
            .filter(layerNum => !displayLayers.find(l => l.layer === layerNum))
            .map(layerNum => (
              <div
                key={`pending-${layerNum}`}
                className="flex items-center gap-1 p-1.5 bg-gray-50 border border-gray-200 rounded-lg opacity-50"
              >
                <span className="text-xs font-semibold text-gray-400 w-6 flex-shrink-0">L{layerNum}</span>
                <div className="flex-1 flex items-center gap-1 text-gray-400">
                  <span className="text-xs">Waiting...</span>
                </div>
              </div>
            ))}
        </div>
      </div>
    );
  }

  // Legacy polling mode (fallback)
  if (isProcessing && !isStreaming) {
    return (
      <div className="mt-3 p-3 bg-blue-50 rounded-lg border border-blue-200 animate-fadeIn">
        <div className="flex items-center justify-between text-gray-600 mb-2">
          <div className="flex items-center space-x-2">
            <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm font-medium">Processing segments...</span>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mt-3 p-3 bg-red-50 rounded-lg border border-red-200 animate-fadeIn">
        <p className="text-sm text-red-600">{error}</p>
        <button
          onClick={() => onAction('proceed')}
          className="mt-2 text-sm text-red-600 hover:text-red-800 underline"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!segments) return null;

  const allElements = segments.layers.flatMap((layer) =>
    layer.elements.map((elem) => ({
      ...elem,
      layerNum: layer.layer,
    }))
  );

  // Get box_2d hitbox style (invisible overlay for hover detection)
  const getHitboxStyle = (elem) => {
    if (!elem.box_2d) return null;

    const [y_min, x_min, y_max, x_max] = elem.box_2d;
    const left = (x_min / 1000) * PREVIEW_SIZE;
    const top = (y_min / 1000) * PREVIEW_SIZE;
    const width = ((x_max - x_min) / 1000) * PREVIEW_SIZE;
    const height = ((y_max - y_min) / 1000) * PREVIEW_SIZE;

    return {
      position: 'absolute',
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`,
      cursor: 'pointer',
    };
  };

  const handleHover = (name) => {
    setHoveredSegment(name);
    onHoverSegment?.(name);
  };

  const handleHoverEnd = () => {
    setHoveredSegment(null);
    onHoverSegment?.(null);
  };

  const restImageUrl = segments.restImage
    ? (segments.restImage.startsWith('data:') ? segments.restImage : `data:image/png;base64,${segments.restImage}`)
    : originalImage;

  // Group elements by layer for organized display
  const elementsByLayer = segments.layers.map((layer) => ({
    layerNum: layer.layer,
    elements: layer.elements,
  }));

  return (
    <div className="mt-3 p-3 bg-blue-50 rounded-lg border border-blue-200 animate-fadeIn">
      <p className="text-sm font-medium text-gray-700 mb-2">
        Segmentation Complete ({allElements.length} elements)
      </p>

      {/* Interactive preview with positioned elements */}
      <div
        className="relative inline-block rounded-lg shadow-md overflow-hidden bg-gray-100 mx-auto"
        style={{ width: PREVIEW_SIZE, height: PREVIEW_SIZE }}
      >
        {/* Background - semi-transparent for analyze path (colored, not gray) */}
        {restImageUrl && (
          <img
            src={restImageUrl}
            alt="Background"
            className="absolute inset-0 w-full h-full object-cover"
            style={{ opacity: 0.5 }}
          />
        )}

        {/* Extracted elements - render in REVERSE order so layer 1 (front) is rendered LAST = on top visually */}
        {/* DOM rendering order matters: later elements naturally stack on top of earlier ones */}
        {[...allElements].reverse().map((elem, reverseIdx) => {
          const originalIndex = allElements.length - 1 - reverseIdx;
          const extractedUrl = getExtractedUrl(elem);
          const isHovered = hoveredSegment === elem.name;

          if (!extractedUrl) return null;

          return (
            <img
              key={`img-${originalIndex}`}
              src={extractedUrl}
              alt={elem.name}
              className="absolute inset-0 pointer-events-none transition-all duration-150"
              style={{
                width: PREVIEW_SIZE,
                height: PREVIEW_SIZE,
                transform: isHovered ? 'scale(1.05)' : 'scale(1)',
                transformOrigin: 'center center',
                zIndex: isHovered ? allElements.length + 10 : reverseIdx + 1,
                filter: isHovered ? 'drop-shadow(0 4px 12px rgba(0,0,0,0.4))' : 'none',
              }}
            />
          );
        })}

        {/* Invisible hitboxes for hover detection - positioned at box_2d */}
        {allElements.map((elem, index) => {
          const hitboxStyle = getHitboxStyle(elem);
          if (!hitboxStyle) return null;

          return (
            <div
              key={`hitbox-${index}`}
              style={{ ...hitboxStyle, zIndex: 100 }}
              onMouseEnter={() => handleHover(elem.name)}
              onMouseLeave={handleHoverEnd}
            />
          );
        })}
      </div>

      {/* Element chips - grouped by layer, each layer on its own line with redo button */}
      <div className="mt-3 space-y-1.5">
        {elementsByLayer.map((layer) => (
          <div key={layer.layerNum} className="flex items-center gap-1 p-1.5 bg-white border border-gray-200 rounded-lg group">
            {/* Layer label */}
            <span className="text-xs font-semibold text-gray-600 w-6 flex-shrink-0">L{layer.layerNum}</span>
            {/* Element chips */}
            <div className="flex-1 flex items-center gap-1 flex-wrap">
              {layer.elements.map((elem, index) => (
                <span
                  key={index}
                  className={`text-xs px-2 py-0.5 rounded cursor-pointer transition-colors ${
                    hoveredSegment === elem.name
                      ? 'bg-blue-500 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-blue-100'
                  }`}
                  onMouseEnter={() => handleHover(elem.name)}
                  onMouseLeave={handleHoverEnd}
                >
                  {elem.name}
                </span>
              ))}
            </div>
            {/* Redo this layer only button */}
            <button
              onClick={() => onRedoSingleLayer?.(layer.layerNum)}
              className="flex-shrink-0 p-1 text-gray-400 hover:text-orange-500 hover:bg-orange-50 rounded transition-colors opacity-0 group-hover:opacity-100"
              title={`Redo Layer ${layer.layerNum} only`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h4.586M20 20v-5h-4.586M4.929 9A8 8 0 0119.07 9M19.071 15A8 8 0 014.93 15" />
              </svg>
            </button>
            {/* Redo from here button (cascade) */}
            <button
              onClick={() => onRedoFromLayer?.(layer.layerNum)}
              className="flex-shrink-0 p-1 text-gray-400 hover:text-blue-500 hover:bg-blue-50 rounded transition-colors opacity-0 group-hover:opacity-100"
              title={`Redo from Layer ${layer.layerNum} - Re-segment this layer and all layers below`}
            >
              <RedoFromHereIcon className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>

      {/* Action buttons and status */}
      <div className="mt-3 flex items-center gap-2">
        {/* Redo button - always visible */}
        <button
          onClick={() => onAction('redo')}
          className="px-3 py-2 bg-gray-200 text-gray-700 text-sm rounded-lg hover:bg-gray-300 transition-colors flex items-center space-x-1"
          title="Redo segmentation"
        >
          <RedoIcon />
          <span>Redo</span>
        </button>

        {/* Start Editing button (GREEN) - hidden when in editing mode */}
        {!isInEditingMode && (
          <button
            onClick={() => onAction('startEditing')}
            className="px-3 py-2 bg-green-500 text-white text-sm rounded-lg hover:bg-green-600 transition-colors flex items-center space-x-2"
          >
            <span>Start Editing</span>
            <span>&rarr;</span>
          </button>
        )}

        {/* Editing mode indicator (GREEN) */}
        {isInEditingMode && (
          <span className="text-sm text-green-600 flex items-center gap-1">
            <span>✏️</span>
            <span>In Editing Mode</span>
          </span>
        )}
      </div>

      {/* Status text when in editing mode */}
      {isInEditingMode && (
        <p className="mt-2 text-sm text-gray-600 italic">
          Drag elements from the segment panel to the editing canvas.
        </p>
      )}
    </div>
  );
};

// Nested grabbed segments panel (blue container - for grab element flow, no layer analysis)
const NestedGrabbedSegments = ({ segments, isProcessing, error, originalImage, onAction, onHoverSegment, isInEditingMode, sessionId, grabDescription, grabNotFound, grabNotFoundDescription, onDeleteElement, onRedoGrab }) => {
  const [hoveredSegment, setHoveredSegment] = React.useState(null);

  const PREVIEW_SIZE = 200;

  // Not found state - Gemini couldn't find the requested element (initial grab, no segments yet)
  if (grabNotFound && !segments) {
    return (
      <div className="mt-3 p-3 bg-yellow-50 rounded-lg border border-yellow-200 animate-fadeIn">
        <p className="text-sm font-medium text-yellow-800 mb-2">
          Element Not Found
        </p>
        <p className="text-sm text-yellow-700">
          Couldn't find "{grabNotFoundDescription}" in the image. Try describing the element differently or selecting a different part of the image.
        </p>
        <button
          onClick={() => onAction('grabElement')}
          className="mt-3 px-3 py-2 bg-blue-500 text-white text-sm rounded-lg hover:bg-blue-600 transition-colors"
        >
          Try Again
        </button>
      </div>
    );
  }

  // Not found during grab more - show warning but still display existing segments
  const showGrabMoreNotFound = grabNotFound && segments;

  // Initial grab (no segments yet) - show gray image with loading spinner
  if (isProcessing && !segments) {
    return (
      <div className="mt-3 p-3 bg-blue-50 rounded-lg border border-blue-200 animate-fadeIn">
        <p className="text-sm font-medium text-gray-700 mb-2">
          Grabbing Elements...
        </p>
        {/* Gray image with loading spinner overlay */}
        <div
          className="relative inline-block rounded-lg shadow-md overflow-hidden bg-gray-100 mx-auto"
          style={{ width: PREVIEW_SIZE, height: PREVIEW_SIZE }}
        >
          {originalImage && (
            <img
              src={originalImage}
              alt="Processing"
              className="absolute inset-0 w-full h-full object-cover"
              style={{ filter: 'grayscale(1) opacity(0.5)' }}
            />
          )}
          {/* Centered loading spinner */}
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        </div>
        {/* Show what's being grabbed */}
        {grabDescription && (
          <p className="text-sm text-blue-600 text-center mt-2 italic">
            Segmenting "{grabDescription}"...
          </p>
        )}
      </div>
    );
  }

  if (error) {
    return (
      <div className="mt-3 p-3 bg-red-50 rounded-lg border border-red-200 animate-fadeIn">
        <p className="text-sm text-red-600">{error}</p>
        <button
          onClick={() => onAction('grabElement')}
          className="mt-2 text-sm text-red-600 hover:text-red-800 underline"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!segments) return null;

  // Grabbed elements are in a single layer
  const allElements = segments.layers.flatMap((layer) =>
    layer.elements.map((elem) => ({ ...elem }))
  );

  const getHitboxStyle = (elem) => {
    if (!elem.box_2d) return null;
    const [y_min, x_min, y_max, x_max] = elem.box_2d;
    return {
      position: 'absolute',
      left: `${(x_min / 1000) * PREVIEW_SIZE}px`,
      top: `${(y_min / 1000) * PREVIEW_SIZE}px`,
      width: `${((x_max - x_min) / 1000) * PREVIEW_SIZE}px`,
      height: `${((y_max - y_min) / 1000) * PREVIEW_SIZE}px`,
      cursor: 'pointer',
    };
  };

  const getExtractedUrl = (elem) => {
    if (!elem.extracted) return null;
    return elem.extracted.startsWith('data:')
      ? elem.extracted
      : `data:image/png;base64,${elem.extracted}`;
  };

  const handleHover = (name) => {
    setHoveredSegment(name);
    onHoverSegment?.(name);
  };

  const handleHoverEnd = () => {
    setHoveredSegment(null);
    onHoverSegment?.(null);
  };

  const restImageUrl = segments.restImage
    ? (segments.restImage.startsWith('data:') ? segments.restImage : `data:image/png;base64,${segments.restImage}`)
    : originalImage;

  return (
    <div className="mt-3 p-3 bg-blue-50 rounded-lg border border-blue-200 animate-fadeIn">
      <p className="text-sm font-medium text-gray-700 mb-2">
        Grabbed Elements ({allElements.length})
      </p>

      {/* Interactive preview */}
      <div
        className="relative inline-block rounded-lg shadow-md overflow-hidden bg-gray-100 mx-auto"
        style={{ width: PREVIEW_SIZE, height: PREVIEW_SIZE }}
      >
        {/* Rest image shown in grayscale for visual clarity */}
        {restImageUrl && (
          <img
            src={restImageUrl}
            alt="Background"
            className="absolute inset-0 w-full h-full object-cover"
            style={{ filter: 'grayscale(1) opacity(0.6)' }}
          />
        )}

        {/* Loading spinner overlay on rest image during Grab More */}
        {isProcessing && (
          <div className="absolute inset-0 flex items-center justify-center z-50">
            <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {/* Render in REVERSE order so layer 1 (front) is rendered LAST = on top visually */}
        {[...allElements].reverse().map((elem, reverseIdx) => {
          const extractedUrl = getExtractedUrl(elem);
          const isHovered = hoveredSegment === elem.name;
          if (!extractedUrl) return null;

          return (
            <img
              key={`img-${reverseIdx}`}
              src={extractedUrl}
              alt={elem.name}
              className="absolute inset-0 pointer-events-none transition-all duration-150"
              style={{
                width: PREVIEW_SIZE,
                height: PREVIEW_SIZE,
                transform: isHovered ? 'scale(1.05)' : 'scale(1)',
                transformOrigin: 'center center',
                zIndex: isHovered ? allElements.length + 10 : reverseIdx + 1,
                filter: isHovered ? 'drop-shadow(0 4px 12px rgba(0,0,0,0.4))' : 'none',
              }}
            />
          );
        })}

        {allElements.map((elem, index) => {
          const hitboxStyle = getHitboxStyle(elem);
          if (!hitboxStyle) return null;
          return (
            <div
              key={`hitbox-${index}`}
              style={{ ...hitboxStyle, zIndex: 100 }}
              onMouseEnter={() => handleHover(elem.name)}
              onMouseLeave={handleHoverEnd}
            />
          );
        })}
      </div>

      {/* Element chips with delete on hover */}
      <div className="mt-3 flex flex-wrap gap-1">
        {allElements.map((elem, index) => (
          <span
            key={index}
            className={`group relative text-xs px-2 py-1 pr-6 rounded cursor-pointer transition-colors ${
              hoveredSegment === elem.name
                ? 'bg-blue-500 text-white'
                : 'bg-gray-200 text-gray-700 hover:bg-blue-100'
            }`}
            onMouseEnter={() => handleHover(elem.name)}
            onMouseLeave={handleHoverEnd}
          >
            {elem.name}
            {/* Delete icon - appears on hover */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDeleteElement?.(elem.name, allElements.length === 1);
              }}
              className={`absolute right-1 top-1/2 -translate-y-1/2 w-4 h-4 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity ${
                hoveredSegment === elem.name
                  ? 'bg-blue-600 hover:bg-blue-700 text-white'
                  : 'bg-gray-300 hover:bg-red-400 text-gray-600 hover:text-white'
              }`}
              title="Remove element"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </span>
        ))}
      </div>

      {/* Show what's being grabbed during grab more */}
      {isProcessing && grabDescription && (
        <p className="text-sm text-blue-600 text-center mt-2 italic">
          Segmenting "{grabDescription}"...
        </p>
      )}

      {/* Warning for grab more not found */}
      {showGrabMoreNotFound && (
        <div className="mt-2 p-2 bg-yellow-50 rounded-lg border border-yellow-200">
          <p className="text-sm text-yellow-700">
            Couldn't find "{grabNotFoundDescription}" in the remaining image. Try a different description.
          </p>
        </div>
      )}

      {/* Action buttons */}
      <div className="mt-3 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          {/* Redo Grab button - re-run grab with same description */}
          {grabDescription && !isProcessing && (
            <button
              onClick={() => onRedoGrab?.(grabDescription)}
              className="px-3 py-2 text-sm rounded-lg flex items-center space-x-1 transition-colors bg-orange-500 text-white hover:bg-orange-600"
              title={`Redo grab: "${grabDescription}"`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h4.586M20 20v-5h-4.586M4.929 9A8 8 0 0119.07 9M19.071 15A8 8 0 014.93 15" />
              </svg>
              <span>Redo</span>
            </button>
          )}

          {/* Grab More button - disabled during processing */}
          <button
            onClick={() => onAction('grabMore')}
            disabled={isProcessing}
            className={`px-3 py-2 text-sm rounded-lg flex items-center space-x-1 transition-colors ${
              isProcessing
                ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                : 'bg-blue-500 text-white hover:bg-blue-600'
            }`}
          >
            <span>+ Grab More</span>
          </button>

          {/* Start Editing button (GREEN) - hidden when in editing mode or processing */}
          {!isInEditingMode && !isProcessing && (
            <button
              onClick={() => onAction('startEditing')}
              className="px-3 py-2 bg-green-500 text-white text-sm rounded-lg hover:bg-green-600 transition-colors flex items-center space-x-2"
            >
              <span>Start Editing</span>
              <span>&rarr;</span>
            </button>
          )}

          {/* Editing mode indicator (GREEN for editing) */}
          {isInEditingMode && !isProcessing && (
            <span className="text-sm text-green-600 flex items-center gap-1">
              <span>✏️</span>
              <span>In Editing Mode</span>
            </span>
          )}
        </div>

      </div>

      {isInEditingMode && !isProcessing && (
        <p className="mt-2 text-sm text-gray-600 italic">
          Drag elements from the segment panel to the editing canvas.
        </p>
      )}
    </div>
  );
};

// Image preview with 3-image selection layout, nested analysis, and nested segments
const ImagePreview = ({
  images,
  prompt,
  selectedIndex,
  isAnalyzing,
  isModifyingLayers,
  layerModificationRequest,
  analysisError,
  messageId,
  onAction,
  onSelectImage,
  onRegenerateSingle,
  onRegenerateAll,
  onUpdateImage,
  onHoverSegment,
  segmentedImages,
  onDeleteElement,
  onRedoFromLayer,
  onRedoSingleLayer,
  onRedoGrab,
}) => {
  // State for per-image update input
  const [editingImageIndex, setEditingImageIndex] = React.useState(null);
  const [updatePrompt, setUpdatePrompt] = React.useState('');
  const updateInputRef = React.useRef(null);

  // Focus input when editing starts
  React.useEffect(() => {
    if (editingImageIndex !== null && updateInputRef.current) {
      updateInputRef.current.focus();
    }
  }, [editingImageIndex]);

  const handleUpdateSubmit = (index) => {
    if (updatePrompt.trim() && onUpdateImage) {
      onUpdateImage(messageId, index, updatePrompt.trim());
      setEditingImageIndex(null);
      setUpdatePrompt('');
    }
  };

  const handleUpdateKeyDown = (e, index) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleUpdateSubmit(index);
    } else if (e.key === 'Escape') {
      setEditingImageIndex(null);
      setUpdatePrompt('');
    }
  };

  // Check if image is "clean" (no analysis, no grab, no update history)
  const isCleanImage = (img) => {
    return !img.analysis && !img.segments && !img.updateHistory?.length;
  };
  // Check if an image (by index) is in the segmented pool
  const isInPool = (index) => {
    if (!segmentedImages || segmentedImages.length === 0) return false;
    return segmentedImages.some(seg => seg.sourceMessageId === messageId && seg.sourceImageIndex === index);
  };

  const hasSelection = selectedIndex !== null && selectedIndex !== undefined;
  // Get analysis and segments from the selected image (per-image data)
  const selectedImage = hasSelection ? images[selectedIndex] : null;
  const analysis = selectedImage?.analysis || null;
  const segments = selectedImage?.segments || null;
  const isProcessing = selectedImage?.isProcessing || false;
  const isImageAnalyzing = selectedImage?.isAnalyzing || false;
  const segmentsError = selectedImage?.segmentsError || null;
  const hasAnalysis = analysis || isImageAnalyzing;
  const hasSegments = segments || isProcessing;

  return (
    <div className="w-full space-y-3">
      {/* Header: Prompt centered, refresh-all icon on right */}
      <div className="flex items-center justify-between">
        <div className="flex-1" />
        {prompt && (
          <p className="text-sm text-gray-600 italic text-center flex-1">"{prompt}"</p>
        )}
        <div className="flex-1 flex justify-end">
          {/* Only show regenerate if there are clean images */}
          {images?.some(isCleanImage) && (
            <button
              onClick={() => onRegenerateAll(messageId, prompt)}
              className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-full transition-colors"
              title="Regenerate clean images (without analysis/grab/updates)"
            >
              <RefreshAllIcon />
            </button>
          )}
        </div>
      </div>

      {/* Three images side by side with per-image refresh */}
      <div className={`flex w-full ${
        images.length <= 3 ? 'gap-3 justify-center' : 'gap-2 overflow-x-auto pb-1'
      }`}>
        {images && images.map((img, index) => (
          <div key={index} className={`relative group flex-shrink-0 ${
            images.length <= 3 ? 'flex-1 max-w-[200px]' : 'w-[140px]'
          }`}>
            {/* Image container */}
            <div
              onClick={() => !img.isLoading && !img.isStylizing && onSelectImage(img, prompt, messageId, index)}
              className={`relative cursor-pointer rounded-lg overflow-hidden transition-all ${
                img.isLoading || img.isStylizing ? 'cursor-wait' : ''
              } ${
                isInPool(index)
                  ? 'ring-[3px] ring-green-500 ring-offset-2'  // Green = image's segments are in pool
                  : selectedIndex === index
                    ? 'ring-[3px] ring-blue-500 ring-offset-2'  // Blue = selected, not in pool yet
                    : 'hover:ring-2 hover:ring-gray-300 hover:ring-offset-1'
              }`}
            >
              <img
                src={img.dataUrl}
                alt={`Option ${index + 1}`}
                className={`w-full aspect-square object-cover transition-opacity ${
                  img.isLoading || img.isStylizing ? 'opacity-30' : ''
                }`}
              />
              {img.isLoading && <ImageLoadingSpinner />}
              {/* Stylizing spinner */}
              {img.isStylizing && (
                <div className="absolute inset-0 bg-gray-200/80 flex flex-col items-center justify-center">
                  <div className="w-8 h-8 border-2 border-orange-500 border-t-transparent rounded-full animate-spin" />
                  <span className="text-xs text-gray-600 mt-1">Stylizing...</span>
                </div>
              )}
              {/* Editing mode overlay - gray overlay with centered icon */}
              {img.isInEditingMode && !img.isLoading && !img.isStylizing && (
                <div className="absolute inset-0 bg-black/40 flex items-center justify-center" title="In editing mode">
                  <div className="bg-green-500 text-white rounded-full w-10 h-10 flex items-center justify-center text-lg shadow-lg">
                    ✏️
                  </div>
                </div>
              )}
            </div>

            {/* Per-image Update tag - yellow, shows input on click */}
            {!img.isLoading && !img.isUpdating && editingImageIndex !== index && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setEditingImageIndex(index);
                  setUpdatePrompt('');
                }}
                className="absolute bottom-1 left-1/2 transform -translate-x-1/2 px-2 py-0.5 bg-yellow-400 hover:bg-yellow-500 text-yellow-900 text-[10px] font-medium rounded-full opacity-0 group-hover:opacity-100 transition-all shadow-sm"
                title="Update this image (creates a new version)"
              >
                Update
              </button>
            )}
            {/* Updating spinner */}
            {img.isUpdating && (
              <div className="absolute inset-0 bg-yellow-100/80 flex flex-col items-center justify-center rounded-lg">
                <div className="w-8 h-8 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin" />
                <span className="text-xs text-yellow-700 mt-1">Updating...</span>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Update input field - shown below images when editing */}
      {editingImageIndex !== null && (
        <div className="flex gap-2 items-center bg-yellow-50 p-2 rounded-lg border border-yellow-200">
          <span className="text-xs text-yellow-700 whitespace-nowrap">Update image {editingImageIndex + 1}:</span>
          <input
            ref={updateInputRef}
            type="text"
            value={updatePrompt}
            onChange={(e) => setUpdatePrompt(e.target.value)}
            onKeyDown={(e) => handleUpdateKeyDown(e, editingImageIndex)}
            placeholder="Describe changes (e.g., 'make the duck bigger')"
            className="flex-1 px-2 py-1 text-sm border border-yellow-300 rounded focus:outline-none focus:ring-2 focus:ring-yellow-400"
          />
          <button
            onClick={() => handleUpdateSubmit(editingImageIndex)}
            disabled={!updatePrompt.trim()}
            className="px-3 py-1 bg-yellow-500 text-white text-sm rounded hover:bg-yellow-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Apply
          </button>
          <button
            onClick={() => {
              setEditingImageIndex(null);
              setUpdatePrompt('');
            }}
            className="px-2 py-1 text-gray-500 hover:text-gray-700 text-sm"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Analyze/Grab buttons - only show when no analysis AND no segments (from either source) */}
      {hasSelection && !hasAnalysis && !hasSegments && (
        <div className="flex flex-col items-center gap-2 pt-2">
          {/* Main action buttons */}
          <div className="flex justify-center gap-2">
            <button
              onClick={() => onAction('analyze')}
              className="px-3 py-2 bg-purple-500 text-white text-sm rounded-lg hover:bg-purple-600 transition-colors"
            >
              Analyze Layers
            </button>
            <button
              onClick={() => onAction('grabElement')}
              className="px-3 py-2 bg-blue-500 text-white text-sm rounded-lg hover:bg-blue-600 transition-colors"
            >
              Grab Element
            </button>
          </div>
        </div>
      )}

      {/* Nested analysis - only show for analyze path (not grab) */}
      {/* Check analysis?.layers to ensure real analysis data, not just sessionId from grab */}
      {hasSelection && (analysis?.layers || isImageAnalyzing) && segments?.source !== 'grab' && (
        <NestedAnalysis
          analysis={analysis}
          isAnalyzing={isImageAnalyzing}
          isModifyingLayers={isModifyingLayers}
          layerModificationRequest={layerModificationRequest}
          error={analysisError}
          onAction={onAction}
          hasSegments={hasSegments && segments?.source === 'analyze'}
          isProcessing={isProcessing}
          isRedoing={selectedImage?.isRedoing}
        />
      )}

      {/* Nested segments (green) - only for analyze path */}
      {/* Show when: segments from analyze OR processing/streaming from analyze path */}
      {hasSelection && (hasSegments || selectedImage?.isStreaming || selectedImage?.isRedoing) && (segments?.source === 'analyze' || selectedImage?.processingSource === 'analyze' || selectedImage?.isStreaming || selectedImage?.isRedoing) && (
        <NestedSegments
          segments={segments}
          isProcessing={isProcessing}
          error={segmentsError}
          originalImage={selectedImage?.dataUrl}
          onAction={onAction}
          onHoverSegment={onHoverSegment}
          isInEditingMode={selectedImage?.isInEditingMode || false}
          sessionId={selectedImage?.analysis?.sessionId}
          isStreaming={selectedImage?.isStreaming}
          streamingElements={selectedImage?.streamingElements}
          streamingStatus={selectedImage?.streamingStatus}
          totalElements={selectedImage?.totalElements}
          onRedoFromLayer={onRedoFromLayer}
          onRedoSingleLayer={onRedoSingleLayer}
          isRedoing={selectedImage?.isRedoing}
          redoFromLayer={selectedImage?.redoFromLayer}
          redoStatus={selectedImage?.redoStatus}
          redoElements={selectedImage?.redoElements}
        />
      )}

      {/* Nested grabbed segments (blue) - only for grab path */}
      {/* Show when: completed grab (source='grab') OR processing without real analysis (grab in progress) OR grabNotFound */}
      {hasSelection && (hasSegments || isProcessing || selectedImage?.grabNotFound) && (segments?.source === 'grab' || (isProcessing && !analysis?.layers) || selectedImage?.grabNotFound) && (
        <NestedGrabbedSegments
          segments={segments}
          isProcessing={isProcessing}
          error={segmentsError}
          originalImage={selectedImage?.dataUrl}
          onAction={onAction}
          onHoverSegment={onHoverSegment}
          isInEditingMode={selectedImage?.isInEditingMode || false}
          sessionId={selectedImage?.analysis?.sessionId}
          grabDescription={selectedImage?.grabDescription}
          grabNotFound={selectedImage?.grabNotFound}
          grabNotFoundDescription={selectedImage?.grabNotFoundDescription}
          onDeleteElement={(elemName, isLastElement) => onDeleteElement?.(selectedIndex, elemName, isLastElement)}
          onRedoGrab={onRedoGrab}
        />
      )}

      {!hasSelection && (
        <p className="text-xs text-gray-400 text-center">Click an image to select it</p>
      )}
    </div>
  );
};

// Layer analysis display
const LayerAnalysisCard = ({ layers, actions, onAction }) => {
  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-700">
        I found {layers.length} layers based on physical depth:
      </p>
      <div className="bg-gray-50 rounded-lg p-3 border border-gray-200 space-y-3">
        {layers.map((layer, index) => (
          <div key={index} className="border-b border-gray-200 last:border-b-0 pb-2 last:pb-0">
            <div className="font-medium text-sm text-gray-800">
              Layer {layer.layer} {layer.description && `- ${layer.description}`}
            </div>
            <ul className="mt-1 ml-4 text-sm text-gray-600">
              {layer.elements.map((elem, elemIndex) => (
                <li key={elemIndex} className="list-disc">
                  {elem.name}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <p className="text-sm text-gray-600">
        Does this look right? You can modify the layers or proceed to segmentation.
      </p>
      {actions && actions.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {actions.includes('proceed') && (
            <button
              onClick={() => onAction('proceed')}
              className="px-3 py-2 bg-blue-500 text-white text-sm rounded-lg hover:bg-blue-600 transition-colors"
            >
              Proceed to Segmentation
            </button>
          )}
          {actions.includes('modify') && (
            <button
              onClick={() => onAction('modifyLayers')}
              className="px-3 py-2 bg-purple-500 text-white text-sm rounded-lg hover:bg-purple-600 transition-colors"
            >
              Modify Layers
            </button>
          )}
        </div>
      )}
    </div>
  );
};

// Segments preview with extracted elements and hover scaling
const SegmentsPreview = ({ layers, originalImage, restImage, onAction, onHoverSegment }) => {
  const [hoveredSegment, setHoveredSegment] = React.useState(null);

  // Preview size (scaled down from 1024)
  const PREVIEW_SIZE = 250;

  const allElements = layers.flatMap((layer) =>
    layer.elements.map((elem) => ({
      ...elem,
      layerNum: layer.layer,
    }))
  );

  // Get box_2d hitbox style (invisible overlay for hover detection)
  const getHitboxStyle = (elem) => {
    if (!elem.box_2d) return null;

    const [y_min, x_min, y_max, x_max] = elem.box_2d;
    const left = (x_min / 1000) * PREVIEW_SIZE;
    const top = (y_min / 1000) * PREVIEW_SIZE;
    const width = ((x_max - x_min) / 1000) * PREVIEW_SIZE;
    const height = ((y_max - y_min) / 1000) * PREVIEW_SIZE;

    return {
      position: 'absolute',
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`,
      cursor: 'pointer',
    };
  };

  // Get extracted image URL
  const getExtractedUrl = (elem) => {
    if (!elem.extracted) return null;
    return elem.extracted.startsWith('data:')
      ? elem.extracted
      : `data:image/png;base64,${elem.extracted}`;
  };

  // Shared hover handlers for bidirectional hover
  const handleHover = (name) => {
    setHoveredSegment(name);
    onHoverSegment?.(name);
  };

  const handleHoverEnd = () => {
    setHoveredSegment(null);
    onHoverSegment?.(null);
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-700">
        Segmentation complete! Hover to preview segments:
      </p>

      {/* Interactive preview with positioned elements */}
      <div
        className="relative inline-block rounded-lg shadow-md overflow-hidden bg-gray-100"
        style={{ width: PREVIEW_SIZE, height: PREVIEW_SIZE }}
      >
        {/* Background: rest image (inpainted) or original */}
        {(restImage || originalImage) && (
          <img
            src={restImage || originalImage}
            alt="Background"
            className="absolute inset-0 w-full h-full object-cover"
          />
        )}

        {/* Extracted elements - render in REVERSE order so layer 1 (front) is rendered LAST = on top visually */}
        {[...allElements].reverse().map((elem, reverseIdx) => {
          const extractedUrl = getExtractedUrl(elem);
          const isHovered = hoveredSegment === elem.name;

          if (!extractedUrl) return null;

          return (
            <img
              key={`img-${reverseIdx}`}
              src={extractedUrl}
              alt={elem.name}
              className="absolute inset-0 pointer-events-none transition-all duration-150"
              style={{
                width: PREVIEW_SIZE,
                height: PREVIEW_SIZE,
                transform: isHovered ? 'scale(1.05)' : 'scale(1)',
                transformOrigin: 'center center',
                zIndex: isHovered ? allElements.length + 10 : reverseIdx + 1,
                filter: isHovered ? 'drop-shadow(0 4px 12px rgba(0,0,0,0.4))' : 'none',
              }}
            />
          );
        })}

        {/* Invisible hitboxes for hover detection */}
        {allElements.map((elem, index) => {
          const hitboxStyle = getHitboxStyle(elem);
          if (!hitboxStyle) return null;

          return (
            <div
              key={`hitbox-${index}`}
              style={{ ...hitboxStyle, zIndex: 100 }}
              onMouseEnter={() => handleHover(elem.name)}
              onMouseLeave={handleHoverEnd}
            />
          );
        })}
      </div>

      {/* Element chips - bidirectional hover with image elements */}
      <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
        <p className="text-xs text-gray-500 mb-2">Detected elements ({allElements.length}):</p>
        <div className="flex flex-wrap gap-1">
          {allElements.map((elem, index) => (
            <span
              key={index}
              className={`text-xs px-2 py-1 rounded cursor-pointer transition-colors ${
                hoveredSegment === elem.name
                  ? 'bg-blue-500 text-white'
                  : 'bg-gray-200 text-gray-700 hover:bg-blue-100'
              }`}
              onMouseEnter={() => handleHover(elem.name)}
              onMouseLeave={handleHoverEnd}
            >
              L{elem.layerNum}: {elem.name}
            </span>
          ))}
        </div>
      </div>

      <p className="text-sm text-gray-600">
        Click "Start Editing" to drag segments to the canvas.
      </p>

      <button
        onClick={() => onAction('startEditing')}
        className="px-4 py-2 bg-green-500 text-white text-sm rounded-lg hover:bg-green-600 transition-colors flex items-center space-x-2"
      >
        <span>Start Editing</span>
        <span>&rarr;</span>
      </button>
    </div>
  );
};

// Error message
const ErrorMessage = ({ message }) => {
  return (
    <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 text-sm">
      {message}
    </div>
  );
};

// Text message
const TextMessage = ({ text }) => {
  return <p className="text-sm text-gray-700">{text}</p>;
};

// Main ChatMessage component
const ChatMessage = ({ message, onAction, onHoverSegment, onSelectImage, onRegenerateSingle, onRegenerateAll, onUpdateImage, segmentedImages, onDeleteElement, onRedoFromLayer, onRedoSingleLayer, onRedoGrab }) => {
  const { id, role, type, data } = message;
  const isUser = role === 'user';

  const renderContent = () => {
    switch (type) {
      case MESSAGE_TYPES.TEXT:
        return <TextMessage text={data.text} />;

      case MESSAGE_TYPES.THINKING:
        return <ThinkingIndicator steps={data.steps} currentStep={data.currentStep} />;

      case MESSAGE_TYPES.IMAGE:
        if (isUser) {
          return (
            <div className="space-y-1">
              <p className="text-sm">{data.text || 'Uploaded an image'}</p>
              {data.imageUrl && (
                <img
                  src={data.imageUrl}
                  alt="Uploaded"
                  className="max-w-[100px] rounded-lg"
                />
              )}
            </div>
          );
        }
        // Get isModifyingLayers/layerModificationRequest from the selected image (per-image state)
        const selectedImg = data.selectedIndex !== null && data.selectedIndex !== undefined
          ? data.images[data.selectedIndex]
          : null;
        return (
          <ImagePreview
            images={data.images}
            prompt={data.prompt}
            selectedIndex={data.selectedIndex}
            isAnalyzing={data.isAnalyzing}
            isModifyingLayers={selectedImg?.isModifyingLayers || false}
            layerModificationRequest={selectedImg?.layerModificationRequest || null}
            analysisError={selectedImg?.analysisError || data.analysisError}
            messageId={id}
            onAction={onAction}
            onSelectImage={onSelectImage}
            onRegenerateSingle={onRegenerateSingle}
            onRegenerateAll={onRegenerateAll}
            onUpdateImage={onUpdateImage}
            onHoverSegment={onHoverSegment}
            segmentedImages={segmentedImages}
            onDeleteElement={onDeleteElement}
            onRedoFromLayer={onRedoFromLayer}
            onRedoSingleLayer={onRedoSingleLayer}
            onRedoGrab={onRedoGrab}
          />
        );

      case MESSAGE_TYPES.LAYERS:
        return (
          <LayerAnalysisCard
            layers={data.layers}
            actions={data.actions}
            onAction={onAction}
          />
        );

      // SEGMENTS is now nested inside IMAGE card, but keep for backward compatibility
      case MESSAGE_TYPES.SEGMENTS:
        return (
          <SegmentsPreview
            layers={data.layers}
            originalImage={data.originalImage}
            restImage={data.restImage}
            onAction={onAction}
            onHoverSegment={onHoverSegment}
          />
        );

      case MESSAGE_TYPES.ERROR:
        return <ErrorMessage message={data.message} />;

      default:
        return <p className="text-sm text-gray-500">Unknown message type</p>;
    }
  };

  // AI image messages should be full width for 3-image layout
  const isAIImageMessage = !isUser && type === MESSAGE_TYPES.IMAGE;

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3`}>
      <div
        className={`rounded-lg p-3 ${
          isAIImageMessage
            ? 'w-full bg-white border border-gray-200 shadow-sm'
            : isUser
              ? 'max-w-[85%] bg-blue-500 text-white'
              : data?.isSubSegment
                ? 'max-w-[85%] bg-teal-50 border border-teal-200 shadow-sm'
                : 'max-w-[85%] bg-white border border-gray-200 shadow-sm'
        }`}
      >
        {renderContent()}
      </div>
    </div>
  );
};

export default ChatMessage;
