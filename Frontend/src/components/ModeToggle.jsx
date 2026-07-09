import React from 'react';
import { useLayerManager } from './LayerManager';
import { TbEdit, TbCut } from 'react-icons/tb';

/**
 * Mode toggle between Stage 2 (Creative Editing) and Stage 3 (Fabrication Preparing)
 */
const ModeToggle = () => {
  const { uiMode, setUiMode, layers } = useLayerManager();

  const hasLayers = layers.length > 0;

  return (
    <div className="flex items-center gap-2 p-1">
      <button
        onClick={() => hasLayers && setUiMode('editing')}
        disabled={!hasLayers}
        className={`
          flex items-center gap-2 px-4 py-2 rounded-md font-medium text-sm
          transition-all duration-200
          ${!hasLayers
            ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
            : uiMode === 'editing'
              ? 'bg-blue-500 text-white shadow-md'
              : 'bg-white text-gray-600 hover:bg-gray-50'
          }
        `}
      >
        <TbEdit size={18} />
        Creative Editing
      </button>
      <button
        onClick={() => hasLayers && setUiMode('fabrication')}
        disabled={!hasLayers}
        className={`
          flex items-center gap-2 px-4 py-2 rounded-md font-medium text-sm
          transition-all duration-200
          ${!hasLayers
            ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
            : uiMode === 'fabrication'
              ? 'bg-indigo-500 text-white shadow-md'
              : 'bg-white text-gray-600 hover:bg-gray-50'
          }
        `}
      >
        <TbCut size={18} />
        Fabrication Preparing
      </button>
    </div>
  );
};

export default ModeToggle;
