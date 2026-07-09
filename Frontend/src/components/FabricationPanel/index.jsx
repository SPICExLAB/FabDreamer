import React from 'react';
import FabricationChat from './FabricationChat';

/**
 * Right panel for Stage 3 (Fabrication Preparing)
 * Now dedicated entirely to the Fabrication Agent interface
 * Uses light theme to match the rest of the app
 */
const FabricationPanel = ({ style, layerData, setLayerData, isFabricationMode, onHighlightLayer, onHighlightPart, onDrawBridgeModeChange }) => {
  return (
    <div
      className="flex flex-col bg-white rounded-lg border border-gray-200 shadow-[0px_10px_30px_rgba(0,0,0,0.1)] overflow-hidden"
      style={style}
    >
      <FabricationChat
        layerData={layerData}
        setLayerData={setLayerData}
        isFabricationMode={isFabricationMode}
        onHighlightLayer={onHighlightLayer}
        onHighlightPart={onHighlightPart}
        onDrawBridgeModeChange={onDrawBridgeModeChange}
      />
    </div>
  );
};

export default FabricationPanel;
