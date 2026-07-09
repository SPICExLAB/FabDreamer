import React from 'react';
import { IoMdUndo, IoMdRedo } from 'react-icons/io';

const UndoRedoBar = ({ canUndo, canRedo, onUndo, onRedo }) => {
  return (
    <div className="absolute bottom-4 right-4 bg-white rounded-full shadow-[0px_10px_30px_rgba(0,0,0,0.15)] px-4 py-2 flex items-center space-x-2 z-5">
      <button
        onClick={onUndo}
        className={`p-1 rounded ${
          canUndo
            ? 'hover:bg-gray-100 text-black'
            : 'text-gray-300 cursor-not-allowed'
        }`}
        disabled={!canUndo}
      >
        <IoMdUndo size={20} />
      </button>
      <button
        onClick={onRedo}
        className={`p-1 rounded ${
          canRedo
            ? 'hover:bg-gray-100 text-black'
            : 'text-gray-300 cursor-not-allowed'
        }`}
        disabled={!canRedo}
      >
        <IoMdRedo size={20} />
      </button>
    </div>
  );
};

export default UndoRedoBar;
