import React from 'react';
import { useLayerManager } from '../LayerManager';

/**
 * Compact physical property bar for fabrication mode
 * Top-center: "Mat 12"×12"" toggle + Scale slider
 * Per-layer material is controlled via chat with the AI
 */
const PhysicalPropertyBar = () => {
  const {
    fabricationScale,
    setFabricationScale,
    fabricationGap,
    setFabricationGap,
    showBoardReference,
    setShowBoardReference,
  } = useLayerManager();

  return (
    <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-3 px-3 py-1.5 bg-white/95 rounded-lg shadow-lg backdrop-blur-sm z-10">
      {/* Board reference toggle */}
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium text-gray-600 whitespace-nowrap">Mat 12"×12"</span>
        <button
          onClick={() => setShowBoardReference(!showBoardReference)}
          className={`
            px-2 py-0.5 text-xs font-medium rounded-md transition-colors
            ${showBoardReference
              ? 'bg-blue-500 text-white'
              : 'bg-gray-200 text-gray-600 hover:bg-gray-300'
            }
          `}
        >
          {showBoardReference ? 'On' : 'Off'}
        </button>
      </div>

      {/* Divider */}
      <div className="w-px h-4 bg-gray-300" />

      {/* Scale slider */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-gray-600">Scale</span>
        <input
          type="range"
          min={0.2}
          max={3}
          step={0.05}
          value={fabricationScale}
          onChange={(e) => setFabricationScale(parseFloat(e.target.value))}
          className="w-20 h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-500"
        />
        <span className="text-xs font-medium text-gray-700 w-10 text-right">
          {fabricationScale.toFixed(2)}x
        </span>
      </div>

      {/* Divider */}
      <div className="w-px h-4 bg-gray-300" />

      {/* Gap slider */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-gray-600">Gap</span>
        <input
          type="range"
          min={0}
          max={0.5}
          step={0.05}
          value={fabricationGap}
          onChange={(e) => setFabricationGap(parseFloat(e.target.value))}
          className="w-20 h-1.5 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-500"
        />
        <span className="text-xs font-medium text-gray-700 w-10 text-right">
          {fabricationGap.toFixed(2)}
        </span>
      </div>
    </div>
  );
};

export default PhysicalPropertyBar;
