// EditingSection/layerUtils.js

export const updateLayerState = (layers, segmentId, newProps, activeLayer) => {
  return layers.map((layer) =>
    layer.id === activeLayer
      ? {
          ...layer,
          segments: layer.segments.map((seg) =>
            seg.id === segmentId ? { ...seg, ...newProps } : seg
          ),
        }
      : layer
  );
};
