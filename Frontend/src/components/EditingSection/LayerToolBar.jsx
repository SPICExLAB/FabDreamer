import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  IoMdUndo,
  IoMdRedo,
  IoMdQrScanner,
  IoMdSquareOutline,
  IoIosRadioButtonOff,
  IoMdEye,
} from 'react-icons/io';

const LayerToolBar = ({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onFrameToggle,
  onShapeChange,
  currentShape,
  isFrameActive,
  scaleIndicator,
  seeThrough = false,
  onSeeThroughToggle,
}) => {
  const [isSubToolbarOpen, setIsSubToolbarOpen] = useState(false);
  const toolbarRef = useRef(null);

  const handleFrameToggle = () => {
    onFrameToggle(!isFrameActive);
  };

  const handleShapeChange = (shape) => {
    onShapeChange(shape);
  };

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (toolbarRef.current && !toolbarRef.current.contains(event.target)) {
        setIsSubToolbarOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  return (
    <div ref={toolbarRef} className="absolute top-4 right-4 z-10">
      <div className="bg-white rounded-lg shadow-[0px_10px_30px_rgba(0,0,0,0.15)] p-2 flex flex-col items-center space-y-2">
        <button
          onClick={onUndo}
          className={`p-1.5 rounded transition-colors ${
            canUndo
              ? 'hover:bg-gray-100 text-black'
              : 'text-gray-300 cursor-not-allowed'
          }`}
          disabled={!canUndo}
          title={canUndo ? 'Undo last action (Cmd+Z)' : 'Nothing to undo'}
        >
          <IoMdUndo size={20} />
        </button>
        <button
          onClick={onRedo}
          className={`p-1.5 rounded transition-colors ${
            canRedo
              ? 'hover:bg-gray-100 text-black'
              : 'text-gray-300 cursor-not-allowed'
          }`}
          disabled={!canRedo}
          title={canRedo ? 'Redo last action (Cmd+Shift+Z)' : 'Nothing to redo'}
        >
          <IoMdRedo size={20} />
        </button>
        <button
          onClick={handleFrameToggle}
          onMouseEnter={() => setIsSubToolbarOpen(true)}
          className={`p-1.5 rounded transition-colors ${
            isFrameActive ? 'text-black bg-gray-100' : 'text-gray-400 hover:text-black'
          }`}
          title={isFrameActive ? 'Frame active - click to remove frame' : 'Add cutting frame around layer'}
        >
          <IoMdQrScanner size={20} />
        </button>
        <button
          onClick={onSeeThroughToggle}
          className={`p-1.5 rounded transition-colors ${
            seeThrough ? 'text-blue-600 bg-blue-100' : 'text-gray-400 hover:text-black'
          }`}
          title={seeThrough ? 'Hide layers below (see-through off)' : 'Show layers below (see-through on)'}
        >
          <IoMdEye size={20} />
        </button>
        <div className="text-xs font-bold text-gray-500" title="Current zoom level">
          {scaleIndicator}
        </div>
      </div>
      <AnimatePresence>
        {isSubToolbarOpen && (
          <motion.div
            className="bg-white rounded-lg shadow-[0px_10px_30px_rgba(0,0,0,0.15)] p-2 mt-2 flex flex-col items-center space-y-2"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
            onMouseEnter={() => setIsSubToolbarOpen(true)}
            onMouseLeave={() => setIsSubToolbarOpen(false)}
          >
            <button
              onClick={() => handleShapeChange('squareOutline')}
              className={`p-1.5 rounded transition-colors ${
                currentShape === 'squareOutline'
                  ? 'bg-blue-100 text-blue-600'
                  : 'hover:bg-gray-100'
              }`}
              title="Rectangle frame shape"
            >
              <IoMdSquareOutline size={16} />
            </button>
            <button
              onClick={() => handleShapeChange('circleOutline')}
              className={`p-1.5 rounded transition-colors ${
                currentShape === 'circleOutline'
                  ? 'bg-blue-100 text-blue-600'
                  : 'hover:bg-gray-100'
              }`}
              title="Circle frame shape"
            >
              <IoIosRadioButtonOff size={16} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default LayerToolBar;
