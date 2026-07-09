import React, { useCallback, useEffect, useRef } from 'react';
import { FaAngleUp, FaAngleDown, FaCopy } from 'react-icons/fa6';
import { TbBorderOuter, TbLine, TbLineDashed, TbX } from 'react-icons/tb';
import { DEFAULT_BORDER_PERCENT, MIN_BORDER_PERCENT, MAX_BORDER_PERCENT } from '../../utils/svgPathOffset.js';

const SegmentEditingSection = ({
  selectedSegment,
  layers,
  activeLayer,
  setLayers,
  setSelectedSegment,
  addOperation,
  onRepairSegment,
  onSubSegment,
}) => {
  const [canMoveUp, setCanMoveUp] = React.useState(false);
  const [canMoveDown, setCanMoveDown] = React.useState(false);
  const lastOperationRef = useRef(null);

  useEffect(() => {
    if (selectedSegment && activeLayer) {
      const currentLayer = layers.find((layer) => layer.id === activeLayer);
      if (currentLayer) {
        const segmentIndex = currentLayer.segments.findIndex(
          (seg) => seg.id === selectedSegment.id
        );
        setCanMoveUp(segmentIndex > 0);
        setCanMoveDown(segmentIndex < currentLayer.segments.length - 1);
      }
    }
  }, [selectedSegment, activeLayer, layers]);

  useEffect(() => {
    if (lastOperationRef.current) {
      addOperation(lastOperationRef.current);
      lastOperationRef.current = null;
    }
  }, [addOperation, layers]);

  const handleMoveUp = useCallback(() => {
    if (!canMoveUp) return;
    setLayers((prevLayers) => {
      const updatedLayers = prevLayers.map((layer) => {
        if (layer.id === activeLayer) {
          const segmentIndex = layer.segments.findIndex(
            (seg) => seg.id === selectedSegment.id
          );
          if (segmentIndex > 0) {
            const newSegments = [...layer.segments];
            [newSegments[segmentIndex - 1], newSegments[segmentIndex]] = [
              newSegments[segmentIndex],
              newSegments[segmentIndex - 1],
            ];
            return { ...layer, segments: newSegments };
          }
        }
        return layer;
      });

      lastOperationRef.current = {
        undo: () => setLayers(prevLayers),
        redo: () => setLayers(updatedLayers),
      };

      return updatedLayers;
    });
  }, [activeLayer, selectedSegment, setLayers, canMoveUp]);

  const handleMoveDown = useCallback(() => {
    if (!canMoveDown) return;
    setLayers((prevLayers) => {
      const updatedLayers = prevLayers.map((layer) => {
        if (layer.id === activeLayer) {
          const segmentIndex = layer.segments.findIndex(
            (seg) => seg.id === selectedSegment.id
          );
          if (segmentIndex < layer.segments.length - 1) {
            const newSegments = [...layer.segments];
            [newSegments[segmentIndex], newSegments[segmentIndex + 1]] = [
              newSegments[segmentIndex + 1],
              newSegments[segmentIndex],
            ];
            return { ...layer, segments: newSegments };
          }
        }
        return layer;
      });

      lastOperationRef.current = {
        undo: () => setLayers(prevLayers),
        redo: () => setLayers(updatedLayers),
      };

      return updatedLayers;
    });
  }, [activeLayer, selectedSegment, setLayers, canMoveDown]);

  const handleCopy = useCallback(() => {
    setLayers((prevLayers) => {
      const updatedLayers = prevLayers.map((layer) => {
        if (layer.id === activeLayer) {
          const newSegment = {
            ...selectedSegment,
            id: `${selectedSegment.id}-copy-${Date.now()}`,
          };
          return {
            ...layer,
            segments: [...layer.segments, newSegment],
          };
        }
        return layer;
      });

      lastOperationRef.current = {
        undo: () => setLayers(prevLayers),
        redo: () => setLayers(updatedLayers),
      };

      return updatedLayers;
    });
  }, [activeLayer, selectedSegment, setLayers]);

  const handleDelete = useCallback(() => {
    setLayers((prevLayers) => {
      const updatedLayers = prevLayers.map((layer) => {
        if (layer.id === activeLayer) {
          const updatedSegments = layer.segments.filter(
            (seg) => seg.id !== selectedSegment.id
          );
          return { ...layer, segments: updatedSegments };
        }
        return layer;
      });

      lastOperationRef.current = {
        undo: () => {
          setLayers(prevLayers);
          setSelectedSegment(selectedSegment);
        },
        redo: () => {
          setLayers(updatedLayers);
          setSelectedSegment(null);
        },
      };

      return updatedLayers;
    });

    setSelectedSegment(null);
  }, [selectedSegment, setLayers, activeLayer, setSelectedSegment]);

  const handleMakeFrame = useCallback(() => {
    if (!selectedSegment) return;

    setLayers((prevLayers) => {
      const updatedLayers = prevLayers.map((layer) => {
        if (layer.id === activeLayer) {
          const isCurrentlyFrame = selectedSegment.isFrame || false;
          const updatedSegments = layer.segments.map((seg) => {
            if (seg.id === selectedSegment.id) {
              if (isCurrentlyFrame) {
                // Turn off frame mode
                return { ...seg, isFrame: false, borderPercent: 0 };
              } else {
                // Turn on frame mode with default border percentage
                return { ...seg, isFrame: true, borderPercent: DEFAULT_BORDER_PERCENT };
              }
            }
            return seg;
          });
          // Reorder: frames at bottom (index 0), content on top
          const frameSegs = updatedSegments.filter(s => s.isFrame);
          const nonFrameSegs = updatedSegments.filter(s => !s.isFrame);
          const reorderedSegments = [...frameSegs, ...nonFrameSegs];
          // When a segment becomes a frame, disable the outer frame
          // When turning off segment frame, don't re-enable outer frame (user can do manually)
          const newIsFrameActive = isCurrentlyFrame ? layer.isFrameActive : false;
          return { ...layer, segments: reorderedSegments, isFrameActive: newIsFrameActive };
        }
        return layer;
      });

      lastOperationRef.current = {
        undo: () => setLayers(prevLayers),
        redo: () => setLayers(updatedLayers),
      };

      // Update selected segment to reflect new state
      const newSelectedSegment = updatedLayers
        .find((l) => l.id === activeLayer)
        ?.segments.find((s) => s.id === selectedSegment.id);
      if (newSelectedSegment) {
        setSelectedSegment(newSelectedSegment);
      }

      return updatedLayers;
    });
  }, [selectedSegment, setLayers, activeLayer, setSelectedSegment]);

  // Handle frame border percentage slider change
  const handleBorderPercentChange = useCallback((e) => {
    if (!selectedSegment || !selectedSegment.isFrame) return;

    const newPercent = parseFloat(e.target.value);

    setLayers((prevLayers) => {
      const updatedLayers = prevLayers.map((layer) => {
        if (layer.id === activeLayer) {
          const updatedSegments = layer.segments.map((seg) => {
            if (seg.id === selectedSegment.id) {
              return { ...seg, borderPercent: newPercent };
            }
            return seg;
          });
          return { ...layer, segments: updatedSegments };
        }
        return layer;
      });

      // Update selected segment to reflect new border percentage
      const newSelectedSegment = updatedLayers
        .find((l) => l.id === activeLayer)
        ?.segments.find((s) => s.id === selectedSegment.id);
      if (newSelectedSegment) {
        setSelectedSegment(newSelectedSegment);
      }

      return updatedLayers;
    });
  }, [selectedSegment, setLayers, activeLayer, setSelectedSegment]);

  // Handle engrave style toggle (outline vs traced)
  const handleToggleEngraveStyle = useCallback(() => {
    if (!selectedSegment || selectedSegment.isFrame) return;

    const currentStyle = selectedSegment.engraveStyle || 'traced';
    const newStyle = currentStyle === 'traced' ? 'outline' : 'traced';

    setLayers((prevLayers) => {
      const updatedLayers = prevLayers.map((layer) => {
        if (layer.id === activeLayer) {
          const updatedSegments = layer.segments.map((seg) => {
            if (seg.id === selectedSegment.id) {
              return { ...seg, engraveStyle: newStyle };
            }
            return seg;
          });
          return { ...layer, segments: updatedSegments };
        }
        return layer;
      });

      lastOperationRef.current = {
        undo: () => setLayers(prevLayers),
        redo: () => setLayers(updatedLayers),
      };

      // Update selected segment
      const newSelectedSegment = updatedLayers
        .find((l) => l.id === activeLayer)
        ?.segments.find((s) => s.id === selectedSegment.id);
      if (newSelectedSegment) {
        setSelectedSegment(newSelectedSegment);
      }

      return updatedLayers;
    });
  }, [selectedSegment, setLayers, activeLayer, setSelectedSegment]);

  if (!selectedSegment) return null;

  return (
    <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 bg-white rounded-full shadow-[0px_10px_30px_rgba(0,0,0,0.15)] px-4 py-2 flex items-center space-x-1 z-10">
      {/* ===== APPEARANCE GROUP ===== */}
      <div className="flex items-center space-x-1 pr-3 border-r border-gray-200">
        <span className="text-xs text-gray-400 mr-1">Appearance</span>
        {/* Frame mode: show border slider */}
        {selectedSegment.isFrame ? (
          <div className="flex items-center space-x-2">
            <input
              type="range"
              min={MIN_BORDER_PERCENT}
              max={MAX_BORDER_PERCENT}
              step="1"
              value={selectedSegment.borderPercent || DEFAULT_BORDER_PERCENT}
              onChange={handleBorderPercentChange}
              className="w-24 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-500"
              title="Adjust frame border thickness"
            />
            <span className="text-xs text-gray-500 w-8">{Math.round(selectedSegment.borderPercent || DEFAULT_BORDER_PERCENT)}%</span>
          </div>
        ) : (
          /* Non-frame: show engrave style toggle */
          <button
            onClick={handleToggleEngraveStyle}
            className={`p-1.5 rounded transition-colors ${
              (selectedSegment.engraveStyle || 'traced') === 'traced'
                ? 'bg-amber-500 text-white'
                : 'bg-gray-100 text-black'
            }`}
            title={
              (selectedSegment.engraveStyle || 'traced') === 'traced'
                ? 'Traced details (click for outline only)'
                : 'Outline only (click for traced details)'
            }
          >
            {(selectedSegment.engraveStyle || 'traced') === 'traced' ? (
              <TbLine size={18} />
            ) : (
              <TbLineDashed size={18} />
            )}
          </button>
        )}
        {/* Frame toggle button */}
        <button
          onClick={handleMakeFrame}
          className={`p-1.5 rounded transition-colors ${
            selectedSegment.isFrame
              ? 'bg-blue-500 text-white'
              : 'hover:bg-gray-100 text-black'
          }`}
          title={selectedSegment.isFrame ? 'Remove frame effect' : 'Make frame (border only)'}
        >
          <TbBorderOuter size={18} />
        </button>
      </div>

      {/* ===== EDIT GROUP ===== (hidden for frame segments) */}
      {!selectedSegment.isFrame && (
        <div className="flex items-center space-x-1 px-3 border-r border-gray-200">
          <span className="text-xs text-gray-400 mr-1">Edit</span>
          {/* Repair button - clean up noisy segmentation */}
          <button
            className={`p-1.5 rounded transition-colors ${
              onRepairSegment
                ? 'hover:bg-gray-100 text-black'
                : 'text-gray-300 cursor-not-allowed'
            }`}
            onClick={() => onRepairSegment?.(selectedSegment)}
            disabled={!onRepairSegment}
            title="Repair noisy edges"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
            </svg>
          </button>
          {/* Sub-segment button - break segment into smaller parts */}
          <button
            className={`p-1.5 rounded transition-colors ${
              onSubSegment
                ? 'hover:bg-gray-100 text-black'
                : 'text-gray-300 cursor-not-allowed'
            }`}
            onClick={() => onSubSegment?.(selectedSegment)}
            disabled={!onSubSegment}
            title="Break into smaller parts"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="14" width="7" height="7" rx="1" />
            </svg>
          </button>
        </div>
      )}

      {/* ===== ARRANGE GROUP ===== */}
      <div className="flex items-center space-x-1 pl-2">
        <span className="text-xs text-gray-400 mr-1">Arrange</span>
        <button
          onClick={handleMoveUp}
          className={`p-1.5 rounded ${
            canMoveUp
              ? 'hover:bg-gray-100 text-black'
              : 'text-gray-300 cursor-not-allowed'
          }`}
          disabled={!canMoveUp}
          title="Move back (lower z-order)"
        >
          <FaAngleDown size={18} />
        </button>
        <button
          onClick={handleMoveDown}
          className={`p-1.5 rounded ${
            canMoveDown
              ? 'hover:bg-gray-100 text-black'
              : 'text-gray-300 cursor-not-allowed'
          }`}
          disabled={!canMoveDown}
          title="Move front (higher z-order)"
        >
          <FaAngleUp size={18} />
        </button>
        <button
          onClick={handleDelete}
          className="p-1.5 hover:bg-red-50 rounded text-red-500"
          title="Delete segment"
        >
          <TbX size={18} />
        </button>
      </div>
    </div>
  );
};

export default SegmentEditingSection;
