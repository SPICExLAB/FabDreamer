import React, { useState, useRef, useCallback } from 'react';
import { FiSend, FiImage, FiX } from 'react-icons/fi';

const ChatInput = ({ onSendMessage, onImageUpload, disabled, placeholder, modifyLayerMode, onCancelModifyMode, grabElementMode, grabMoreMode, onCancelGrabMode, subSegmentMode, onCancelSubSegmentMode }) => {
  const [text, setText] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef(null);

  const handleSubmit = useCallback((e) => {
    e.preventDefault();
    if (text.trim() && !disabled) {
      onSendMessage(text.trim());
      setText('');
    }
  }, [text, disabled, onSendMessage]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  }, [handleSubmit]);

  const handleFileSelect = useCallback((file) => {
    if (file && file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const base64 = e.target.result;
        onImageUpload(base64);
      };
      reader.readAsDataURL(file);
    }
  }, [onImageUpload]);

  const handleFileInputChange = useCallback((e) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFileSelect(file);
    }
    // Reset input
    e.target.value = '';
  }, [handleFileSelect]);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const file = e.dataTransfer.files?.[0];
    if (file) {
      handleFileSelect(file);
    }
  }, [handleFileSelect]);

  return (
    <div
      className={`relative ${isDragging ? 'ring-2 ring-blue-400 ring-opacity-50' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Modify Layer Mode Tag (PURPLE for layer operations) */}
      {modifyLayerMode && (
        <div className="mb-2 flex items-center">
          <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-purple-100 text-purple-800">
            <span className="mr-1">Modify Layer</span>
            <button
              type="button"
              onClick={onCancelModifyMode}
              className="ml-1 hover:text-purple-900"
            >
              <FiX size={14} />
            </button>
          </span>
          <span className="ml-2 text-xs text-gray-500">
            Describe how to change the layers
          </span>
        </div>
      )}

      {/* Grab Element Mode Tag (BLUE for segmentation) - always show "Grab Element" */}
      {grabElementMode && (
        <div className="mb-2 flex items-center">
          <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
            <span className="mr-1">Grab Element</span>
            <button
              type="button"
              onClick={onCancelGrabMode}
              className="ml-1 hover:text-blue-900"
            >
              <FiX size={14} />
            </button>
          </span>
          <span className="ml-2 text-xs text-gray-500">
            {grabMoreMode
              ? 'Describe more elements to extract from the remaining image'
              : 'Describe what you want to extract (e.g., "the duck in the center")'}
          </span>
        </div>
      )}

      {/* Sub-segment Mode Tag (TEAL for editing breakdown) */}
      {subSegmentMode && (
        <div className="mb-2 flex items-center">
          <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-teal-100 text-teal-800">
            <span className="mr-1">Sub-segment</span>
            <button
              type="button"
              onClick={onCancelSubSegmentMode}
              className="ml-1 hover:text-teal-900"
            >
              <FiX size={14} />
            </button>
          </span>
          <span className="ml-2 text-xs text-gray-500">
            Describe what to extract (e.g., "get the apples from the tree")
          </span>
        </div>
      )}

      {/* Drag overlay */}
      {isDragging && (
        <div className="absolute inset-0 bg-blue-50 border-2 border-dashed border-blue-400 rounded-lg flex items-center justify-center z-10">
          <p className="text-blue-600 text-sm font-medium">Drop image here</p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="flex items-center space-x-2">
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleFileInputChange}
          className="hidden"
        />

        {/* Image upload button */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          className={`p-2.5 rounded-lg transition-colors ${
            disabled
              ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
          title="Upload image"
        >
          <FiImage size={20} />
        </button>

        {/* Text input */}
        <div className="flex-1 relative">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            placeholder={placeholder || 'Create something you want...'}
            rows={1}
            className={`w-full px-4 py-2.5 pr-12 border border-gray-200 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent text-sm ${
              disabled ? 'bg-gray-50 cursor-not-allowed' : 'bg-white'
            }`}
            style={{
              minHeight: '44px',
              maxHeight: '120px',
            }}
          />
        </div>

        {/* Send button */}
        <button
          type="submit"
          disabled={disabled || !text.trim()}
          className={`p-2.5 rounded-lg transition-colors ${
            disabled || !text.trim()
              ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
              : 'bg-blue-500 text-white hover:bg-blue-600'
          }`}
        >
          <FiSend size={20} />
        </button>
      </form>
    </div>
  );
};

export default ChatInput;
