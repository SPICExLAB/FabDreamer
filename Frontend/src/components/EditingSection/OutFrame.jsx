import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  forwardRef,
} from 'react';
import { Group, Shape, Transformer } from 'react-konva';

const MIN_STROKE_WIDTH = 20;
const EPSILON = 0.001;

const OutFrame = forwardRef(
  (
    {
      isFrameActive,
      currentShape,
      strokeWidth,
      editingSectionSize,
      onTransformEnd,
      onSelect,
      isSelected,
      onScaleChange,
    },
    ref
  ) => {
    const innerRef = useRef(null);
    const transformerRef = useRef(null);
    const [innerSize, setInnerSize] = useState({ width: 0, height: 0 });

    useEffect(() => {
      if (
        typeof editingSectionSize.width === 'number' &&
        typeof editingSectionSize.height === 'number' &&
        typeof strokeWidth === 'number'
      ) {
        const newWidth = Math.max(
          EPSILON,
          editingSectionSize.width - 2 * Math.max(strokeWidth, MIN_STROKE_WIDTH)
        );
        const newHeight = Math.max(
          EPSILON,
          editingSectionSize.height -
            2 * Math.max(strokeWidth, MIN_STROKE_WIDTH)
        );
        setInnerSize({ width: newWidth, height: newHeight });
      }
    }, [editingSectionSize, strokeWidth]);

    const renderFrame = useCallback(() => {
      if (!isFrameActive) return null;

      const outerProps = {
        width: editingSectionSize.width,
        height: editingSectionSize.height,
      };

      const innerProps = {
        x: (editingSectionSize.width - innerSize.width) / 2,
        y: (editingSectionSize.height - innerSize.height) / 2,
        width: Math.max(EPSILON, innerSize.width),
        height: Math.max(EPSILON, innerSize.height),
      };

      return (
        <>
          <Shape
            {...outerProps}
            sceneFunc={(context, shape) => {
              context.beginPath();
              if (currentShape.includes('square')) {
                context.rect(0, 0, shape.width(), shape.height());
              } else {
                context.ellipse(
                  shape.width() / 2,
                  shape.height() / 2,
                  shape.width() / 2,
                  shape.height() / 2,
                  0,
                  0,
                  2 * Math.PI
                );
              }
              context.fillStrokeShape(shape);
            }}
            hitFunc={(context, shape) => {
              // Ring-shaped hit region: outer minus inner
              const outerW = shape.width();
              const outerH = shape.height();
              const innerW = innerProps.width;
              const innerH = innerProps.height;
              const innerX = innerProps.x;
              const innerY = innerProps.y;

              context.beginPath();
              if (currentShape.includes('square')) {
                // Draw outer rectangle (clockwise)
                context.moveTo(0, 0);
                context.lineTo(outerW, 0);
                context.lineTo(outerW, outerH);
                context.lineTo(0, outerH);
                context.closePath();
                // Draw inner rectangle (counter-clockwise for hole)
                context.moveTo(innerX, innerY);
                context.lineTo(innerX, innerY + innerH);
                context.lineTo(innerX + innerW, innerY + innerH);
                context.lineTo(innerX + innerW, innerY);
                context.closePath();
              } else {
                // Draw outer ellipse
                context.ellipse(
                  outerW / 2,
                  outerH / 2,
                  outerW / 2,
                  outerH / 2,
                  0,
                  0,
                  2 * Math.PI
                );
                context.closePath();
                // Draw inner ellipse (for hole)
                context.moveTo(innerX + innerW, innerY + innerH / 2);
                context.ellipse(
                  innerX + innerW / 2,
                  innerY + innerH / 2,
                  innerW / 2,
                  innerH / 2,
                  0,
                  0,
                  2 * Math.PI,
                  true // counter-clockwise for hole
                );
                context.closePath();
              }
              context.fillStrokeShape(shape);
            }}
            fill="rgb(156, 163, 175)"

          />
          <Shape
            {...innerProps}
            ref={innerRef}
            listening={false}
            sceneFunc={(context, shape) => {
              context.beginPath();
              if (currentShape.includes('square')) {
                context.rect(0, 0, shape.width(), shape.height());
              } else {
                context.ellipse(
                  shape.width() / 2,
                  shape.height() / 2,
                  shape.width() / 2,
                  shape.height() / 2,
                  0,
                  0,
                  2 * Math.PI
                );
              }
              context.fillStrokeShape(shape);
            }}
            fill="white"
            globalCompositeOperation="destination-out"
          />
        </>
      );
    }, [isFrameActive, currentShape, editingSectionSize, innerSize]);

    useEffect(() => {
      const node = innerRef.current;
      if (node) {
        node.on('transform', () => {
          const scaleX = node.scaleX();
          const scaleY = node.scaleY();
          const newWidth = Math.max(EPSILON, innerSize.width * scaleX);
          const newHeight = Math.max(EPSILON, innerSize.height * scaleY);

          setInnerSize({ width: newWidth, height: newHeight });
          node.scaleX(1);
          node.scaleY(1);

          const newStrokeWidth = (editingSectionSize.width - newWidth) / 2;
          const scale = Math.min(
            100,
            Math.round((newStrokeWidth / editingSectionSize.width) * 200)
          );
          onScaleChange(`${scale}%`);
        });

        node.on('transformend', () => {
          const newStrokeWidth = Math.max(
            MIN_STROKE_WIDTH,
            (editingSectionSize.width - innerSize.width) / 2
          );
          onTransformEnd({ target: { strokeWidth: newStrokeWidth } });
        });
      }
      return () => {
        if (node) {
          node.off('transform');
          node.off('transformend');
        }
      };
    }, [onTransformEnd, editingSectionSize, innerSize, onScaleChange]);

    useEffect(() => {
      if (isSelected && innerRef.current && transformerRef.current) {
        transformerRef.current.nodes([innerRef.current]);
        transformerRef.current.getLayer().batchDraw();
      }
    }, [isSelected]);

    return (
      <Group ref={ref} onClick={onSelect}>
        {renderFrame()}
        <Transformer
          ref={transformerRef}
          boundBoxFunc={(oldBox, newBox) => {
            const maxSize = editingSectionSize.width - 2 * MIN_STROKE_WIDTH;
            const minSize = EPSILON;
            if (newBox.width > maxSize || newBox.height > maxSize) {
              return oldBox;
            }
            if (newBox.width < minSize || newBox.height < minSize) {
              return { ...oldBox, width: minSize, height: minSize };
            }
            return newBox;
          }}
          enabledAnchors={[
            'top-left',
            'top-right',
            'bottom-left',
            'bottom-right',
          ]}
          rotateEnabled={false}
          keepRatio={true}
          visible={isSelected}
        />
      </Group>
    );
  }
);

export default React.memo(OutFrame);
