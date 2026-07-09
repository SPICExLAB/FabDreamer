import React, { useEffect, useRef } from 'react';
import { Stage, Layer, Image as KonvaImage } from 'react-konva';

const LayerPreview = ({ layerPreview, size }) => {
  const imageRef = useRef(null);

  useEffect(() => {
    if (layerPreview) {
      const img = new window.Image();
      img.src = layerPreview.png;
      img.onload = () => {
        // Component may have unmounted (or re-rendered) before the image loaded
        if (!imageRef.current) return;

        const aspectRatio = img.width / img.height;
        let scaledWidth, scaledHeight;

        if (img.width > img.height) {
          scaledWidth = size;
          scaledHeight = size / aspectRatio;
        } else {
          scaledHeight = size;
          scaledWidth = size * aspectRatio;
        }

        imageRef.current.image(img);
        imageRef.current.width(scaledWidth);
        imageRef.current.height(scaledHeight);
        imageRef.current.getLayer()?.batchDraw();
      };
      img.onerror = (error) => {
        console.error('Error loading LayerPreview image:', error);
      };
    }
  }, [layerPreview, size]);

  return (
    <Stage width={size} height={size}>
      <Layer>
        <KonvaImage ref={imageRef} />
      </Layer>
    </Stage>
  );
};

export default React.memo(LayerPreview);
