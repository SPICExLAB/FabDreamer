import React, { useState } from 'react';
import { FaEye, FaEyeSlash, FaTrash, FaCopy } from 'react-icons/fa';
import LayerPreview from './LayerPreview';

const LayerSet = ({
  layer,
  isActive,
  onToggleVisibility,
  onDelete,
  onSelect,
  onNameChange,
  onDuplicate,
  layerPreview,
  isOnlyLayer,
  thumbnailSize = 40, // Default 40px
  compactMode = false, // Compact mode: only thumbnail with visibility on hover
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editedName, setEditedName] = useState(layer.name);
  const [isHovered, setIsHovered] = useState(false);
  const [showSvgPreview, setShowSvgPreview] = useState(true); // Toggle between SVG and PNG preview

  const handleDoubleClick = () => {
    setIsEditing(true);
  };

  const handleNameChange = (e) => {
    setEditedName(e.target.value);
  };

  const handleNameBlur = () => {
    setIsEditing(false);
    onNameChange(layer.id, editedName);
  };

  // Compact mode: thumbnail with PNG/SVG toggle on click, no visibility button
  if (compactMode) {
    // Create combined SVG preview: red outlines + black trace lines
    // Reuses the original composed SVG structure (preserving <clipPath>, transforms, etc.)
    // and injects CSS to override fills/strokes for cut-line visualization.
    const createCombinedSvgPreview = () => {
      if (!layerPreview?.svg) return null;

      try {
        const viewBoxMatch = layerPreview.svg.match(/viewBox="([^"]*)"/);
        const viewBox = viewBoxMatch ? viewBoxMatch[1] : '0 0 1024 1024';
        const vbParts = viewBox.split(' ').map(Number);
        const vbWidth = vbParts[2] || 1024;
        const vbHeight = vbParts[3] || 1024;

        // Extract inner content of the outline SVG (strip XML declaration + <svg> wrapper)
        const outlineRaw = layerPreview.svg
          .replace(/<\?xml[^?]*\?>\s*/, '')
          .replace(/<svg[^>]*>/, '')
          .replace(/<\/svg>\s*$/, '');

        // Extract inner content of the trace SVG
        let traceRaw = '';
        if (layerPreview.svg_trace) {
          traceRaw = layerPreview.svg_trace
            .replace(/<\?xml[^?]*\?>\s*/, '')
            .replace(/<svg[^>]*>/, '')
            .replace(/<\/svg>\s*$/, '');
        }

        // Separate <defs> (clipPath etc.) from renderable content.
        // Defs must be outside styled groups so CSS doesn't break clipPaths
        // (e.g. .cut-lines path { fill: none } would destroy clip masks).
        const extractDefs = (inner) => {
          const defsMatch = inner.match(/<defs>[\s\S]*?<\/defs>/g);
          if (!defsMatch) return { defs: '', content: inner };
          let content = inner;
          for (const d of defsMatch) content = content.replace(d, '');
          return { defs: defsMatch.join('\n'), content };
        };
        const outline = extractDefs(outlineRaw);
        const trace = extractDefs(traceRaw);
        const allDefs = [outline.defs, trace.defs].filter(Boolean).join('\n');

        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">
  <style>
    .cut-lines path { fill: none !important; stroke: #cc0000; stroke-width: 2; }
    .trace-lines path { fill: none !important; stroke: #000000; stroke-width: 1; }
  </style>
  ${allDefs}
  <rect x="0" y="0" width="${vbWidth}" height="${vbHeight}" fill="white"/>
  <g class="trace-lines">${trace.content}</g>
  <g class="cut-lines">${outline.content}</g>
</svg>`;
      } catch (e) {
        console.error('Error creating SVG preview:', e);
        return null;
      }
    };

    const combinedSvg = createCombinedSvgPreview();
    const svgDataUrl = combinedSvg
      ? `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(combinedSvg)))}`
      : null;

    return (
      <div
        className={`relative cursor-pointer rounded-lg overflow-hidden ${
          isActive ? '' : ''
        } ${!layer.isVisible ? 'opacity-40' : ''}`}
        style={{ width: '100%' }}
        onClick={(e) => {
          // Toggle SVG preview on click, select on double-click
          if (e.detail === 1) {
            // Single click: toggle preview mode if SVG available
            if (svgDataUrl) {
              setShowSvgPreview(!showSvgPreview);
            }
          }
          onSelect();
        }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* Container for both PNG and SVG - same size, centered */}
        <div
          className="w-full aspect-square border border-gray-200 rounded-lg overflow-hidden bg-white flex items-center justify-center"
        >
          {showSvgPreview && svgDataUrl ? (
            // SVG preview (shows cut/engrave lines)
            <img
              src={svgDataUrl}
              alt={layer.name}
              className="max-w-full max-h-full object-contain"
            />
          ) : (
            // PNG preview (colored) - centered
            <div className="flex items-center justify-center w-full h-full">
              {layerPreview?.png ? (
                <img
                  src={layerPreview.png}
                  alt={layer.name}
                  className="max-w-full max-h-full object-contain"
                />
              ) : (
                <span className="text-gray-400 text-xs">No preview</span>
              )}
            </div>
          )}
        </div>
        {/* Preview mode indicator */}
        {isHovered && svgDataUrl && (
          <div className="absolute bottom-8 left-0 right-0 text-center">
            <span className="text-xs bg-black/60 text-white px-2 py-0.5 rounded">
              {showSvgPreview ? 'SVG' : 'PNG'} - Click to toggle
            </span>
          </div>
        )}
        {/* Layer name below thumbnail */}
        <div className="text-xs text-center mt-1 truncate px-1">{layer.name}</div>
      </div>
    );
  }

  // Normal mode: full layer row with all controls
  return (
    <div
      className={`flex items-center p-2 mb-2 cursor-pointer rounded ${
        isActive ? 'bg-blue-100' : 'hover:bg-gray-100'
      }`}
      onClick={onSelect}
    >
      <button
        className="mr-2 focus:outline-none hover:text-blue-600 transition-colors"
        onClick={(e) => {
          e.stopPropagation();
          onToggleVisibility(layer.id);
        }}
        title={layer.isVisible ? 'Hide layer in 3D preview' : 'Show layer in 3D preview'}
      >
        {layer.isVisible ? (
          <FaEye className="text-black" />
        ) : (
          <FaEyeSlash className="text-gray-400" />
        )}
      </button>
      <div className="mr-2 p-0.5 border border-black rounded flex items-center justify-center">
        <div style={{ width: thumbnailSize, height: thumbnailSize }} className="overflow-hidden">
          <LayerPreview layerPreview={layerPreview} size={thumbnailSize} />
        </div>
      </div>
      {isEditing ? (
        <input
          className="flex-1 bg-transparent border-b border-gray-300 focus:outline-none"
          value={editedName}
          onChange={handleNameChange}
          onBlur={handleNameBlur}
          autoFocus
        />
      ) : (
        <div className="flex-1 truncate" onDoubleClick={handleDoubleClick}>
          {layer.name}
        </div>
      )}
      <button
        className="ml-2 focus:outline-none text-black hover:text-blue-600 transition-colors"
        onClick={(e) => {
          e.stopPropagation();
          onDuplicate(layer.id);
        }}
        title="Duplicate this layer"
      >
        <FaCopy size={12} />
      </button>
      <button
        className={`ml-2 focus:outline-none transition-colors ${
          isOnlyLayer
            ? 'text-gray-300 cursor-not-allowed'
            : 'text-black hover:text-red-600'
        }`}
        onClick={(e) => {
          e.stopPropagation();
          if (!isOnlyLayer) onDelete(layer.id);
        }}
        disabled={isOnlyLayer}
        title={isOnlyLayer ? 'Cannot delete the only layer' : 'Delete this layer'}
      >
        <FaTrash size={12} />
      </button>
    </div>
  );
};

export default React.memo(LayerSet);
