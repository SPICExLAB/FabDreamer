import React, { useMemo } from 'react';
import ThreeDView from './ThreeDView';

const FinalPreview = React.memo(
  ({ visibleLayers, layerPreviews, woodTextureUrl, activeLayerId, isFabricationMode = false, highlightedSegment = null, drawBridgeMode = null, onBridgeDrawn = null }) => {
    //const threeDViewRef = useRef(null);

    const memoizedThreeDView = useMemo(
      () => (
        <ThreeDView
          layers={visibleLayers}
          layerPreviews={layerPreviews}
          woodTextureUrl={woodTextureUrl}
          activeLayerId={activeLayerId}
          isFabricationMode={isFabricationMode}
          highlightedSegment={highlightedSegment}
          drawBridgeMode={drawBridgeMode}
          onBridgeDrawn={onBridgeDrawn}
        />
      ),
      [visibleLayers, layerPreviews, woodTextureUrl, activeLayerId, isFabricationMode, highlightedSegment, drawBridgeMode, onBridgeDrawn]
    );

    return memoizedThreeDView;
  }
);

export default FinalPreview;
