import React from 'react';
import { useLayerManager } from '../LayerManager';
import { FiEye, FiEyeOff } from 'react-icons/fi';

/**
 * Slicing overlay for 3D view in fabrication mode
 * Shows layer visibility controls on the right side
 */
const SlicingOverlay = () => {
  const { layers, setLayers, fabLayers, setFabLayers, uiMode, visibleLayerRange, setVisibleLayerRange } = useLayerManager();

  const isFabMode = uiMode === 'fabrication';
  const effectiveLayers = (isFabMode && fabLayers) ? fabLayers : layers;
  const effectiveSetLayers = (isFabMode && fabLayers) ? setFabLayers : setLayers;

  const toggleLayerVisibility = (layerId) => {
    effectiveSetLayers((prevLayers) =>
      prevLayers.map((layer) =>
        layer.id === layerId ? { ...layer, isVisible: !layer.isVisible } : layer
      )
    );
  };

  if (effectiveLayers.length === 0) return null;

  return (
    <div className="absolute right-4 top-1/2 -translate-y-1/2 flex flex-col items-center gap-1 bg-white/90 rounded-lg p-2 shadow-lg">
      <span className="text-xs font-medium text-gray-500 mb-1">Layers</span>

      <div className="flex flex-col gap-1">
        {effectiveLayers.map((layer, index) => (
          <div
            key={layer.id}
            className={`
              flex items-center gap-2 px-2 py-1 rounded cursor-pointer
              transition-all duration-200
              ${layer.isVisible ? 'bg-blue-100' : 'bg-gray-100'}
            `}
            onClick={() => toggleLayerVisibility(layer.id)}
            title={layer.name}
          >
            <span className="text-xs font-medium truncate max-w-[80px]">{layer.name || `L${index + 1}`}</span>
            {layer.isVisible ? (
              <FiEye size={14} className="text-blue-500" />
            ) : (
              <FiEyeOff size={14} className="text-gray-400" />
            )}
          </div>
        ))}
      </div>

      {/* Range slider for layer range (future enhancement) */}
      {effectiveLayers.length > 2 && (
        <div className="mt-2 pt-2 border-t border-gray-200 w-full">
          <input
            type="range"
            min={0}
            max={effectiveLayers.length - 1}
            value={visibleLayerRange[1]}
            onChange={(e) => {
              const val = parseInt(e.target.value);
              setVisibleLayerRange([0, val]);
              // Slider up (high value) = all visible.
              // Slider down (low value) = hide top layers first.
              // hiddenFromTop = (max - val), so index < hiddenFromTop is hidden.
              effectiveSetLayers((prevLayers) => {
                const hiddenFromTop = prevLayers.length - 1 - val;
                return prevLayers.map((layer, index) => ({
                  ...layer,
                  isVisible: index >= hiddenFromTop,
                }));
              });
            }}
            className="w-full h-1 bg-gray-200 rounded-lg appearance-none cursor-pointer"
            style={{ writingMode: 'bt-lr', transform: 'rotate(-90deg)', width: 60, marginTop: 30, marginBottom: 30 }}
          />
        </div>
      )}
    </div>
  );
};

export default SlicingOverlay;
