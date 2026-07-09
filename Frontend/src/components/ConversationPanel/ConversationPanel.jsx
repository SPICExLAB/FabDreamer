import React, { useRef, useEffect, useCallback, useState } from 'react';
import ChatMessage from './ChatMessage';
import ChatInput from './ChatInput';
import { STATES } from '../../hooks/useConversation';

// Expand icon component
// Collapsed: arrow up (click to expand)
// Expanded: arrow down (click to collapse)
const ExpandIcon = ({ isExpanded }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    className="h-4 w-4"
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={2}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d={isExpanded
        ? "M19 9l-7 7-7-7"  // Arrow down when expanded (click to collapse)
        : "M5 15l7-7 7 7"   // Arrow up when collapsed (click to expand)
      }
    />
  </svg>
);

const ConversationPanel = ({
  messages,
  state,
  modifyLayerMode,
  onCancelModifyMode,
  grabElementMode,
  grabMoreMode,
  onCancelGrabMode,
  subSegmentMode,
  onCancelSubSegmentMode,
  onSendMessage,
  onImageUpload,
  onAction,
  onSelectImage,
  onRegenerateSingle,
  onRegenerateAll,
  onUpdateImage,
  onHoverSegment,
  segmentedImages,
  onDeleteElement,
  onRedoFromLayer,
  onRedoSingleLayer,
  onRedoGrab,
  activeImageMessageId,
  isCompact,
  expandedHeight,
  className,
  style,
}) => {
  const messagesContainerRef = useRef(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const prevMessageCountRef = useRef(0);
  const prevActiveMessageIdRef = useRef(null);

  // Auto-scroll to bottom only when new messages are added (not on updates to existing messages)
  useEffect(() => {
    if (messagesContainerRef.current && messages.length > prevMessageCountRef.current) {
      messagesContainerRef.current.scrollTo({
        top: messagesContainerRef.current.scrollHeight,
        behavior: 'smooth'
      });
    }
    prevMessageCountRef.current = messages.length;
  }, [messages]);

  // Scroll to the active image message when switching pool thumbnails
  useEffect(() => {
    if (activeImageMessageId && activeImageMessageId !== prevActiveMessageIdRef.current) {
      prevActiveMessageIdRef.current = activeImageMessageId;
      const container = messagesContainerRef.current;
      if (!container) return;
      const el = container.querySelector(`[data-message-id="${activeImageMessageId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }, [activeImageMessageId]);

  // Handle action buttons from messages
  const handleAction = useCallback((action) => {
    onAction?.(action);
  }, [onAction]);

  // Determine if input should be disabled
  const isInputDisabled = [
    STATES.GENERATING_IMAGE,
    STATES.ANALYZING_LAYERS,
    STATES.PROCESSING_SEGMENTS,
  ].includes(state);

  // Get placeholder text based on state
  const getPlaceholder = () => {
    switch (state) {
      case STATES.GENERATING_IMAGE:
        return 'Generating image...';
      case STATES.ANALYZING_LAYERS:
        return 'Analyzing layers...';
      case STATES.PROCESSING_SEGMENTS:
        return 'Processing segments...';
      case STATES.IMAGE_READY:
        return 'Type to modify, or click Analyze Layers...';
      case STATES.LAYERS_READY:
        return 'Type to modify layers, or click Proceed...';
      case STATES.SEGMENTS_READY:
        return 'Click Start Editing to continue...';
      default:
        return 'Create something you want...';
    }
  };

  // Welcome message for empty state
  const renderWelcome = () => {
    if (messages.length > 0) return null;

    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-6">
        <h2 className="text-lg font-semibold text-gray-800 mb-2">
          Welcome to FabDreamer
        </h2>
        <p className="text-sm text-gray-500 max-w-[250px]">
          Describe what you want to create, or upload an image to get started.
        </p>
        <div className="mt-6 space-y-2 text-xs text-gray-400">
          <p>Try:</p>
          <p className="italic">"A cute duck in a pond with lily pads"</p>
          <p className="italic">"A forest scene with layered trees"</p>
        </div>
      </div>
    );
  };

  // Calculate expanded style - overlay the segment section
  const expandedStyle = isCompact && isExpanded ? {
    ...style,
    height: expandedHeight || style?.height,
    position: 'absolute',
    bottom: 0,
    left: 0,
    zIndex: 50,
  } : style;

  return (
    <div
      className={`flex flex-col bg-gray-50 rounded-lg overflow-hidden border border-black ${className || ''} ${
        isCompact && isExpanded
          ? 'shadow-[0px_-10px_40px_rgba(0,0,0,0.25)]'  // Stronger shadow when expanded
          : 'shadow-[0px_10px_30px_rgba(0,0,0,0.15)]'
      }`}
      style={expandedStyle}
    >
      {/* Expand button - only show in compact mode */}
      {isCompact && (
        <div className="flex-shrink-0 px-2 pt-2 pb-1 bg-gray-50">
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-200 rounded-full transition-colors"
            title={isExpanded ? 'Collapse chat' : 'Expand chat'}
          >
            <ExpandIcon isExpanded={isExpanded} />
          </button>
        </div>
      )}

      {/* Messages area - grows to fill available space */}
      {/* scrollbar-gutter: stable reserves space for scrollbar to prevent content shift */}
      <div
        ref={messagesContainerRef}
        className="flex-1 min-h-0 overflow-y-auto px-4 py-4"
        style={{ scrollbarGutter: 'stable' }}
      >
        {renderWelcome()}

        {messages.map((message) => (
          <div key={message.id} data-message-id={message.id}>
          <ChatMessage
            message={message}
            onAction={handleAction}
            onSelectImage={onSelectImage}
            onRegenerateSingle={onRegenerateSingle}
            onRegenerateAll={onRegenerateAll}
            onUpdateImage={onUpdateImage}
            onHoverSegment={onHoverSegment}
            segmentedImages={segmentedImages}
            onDeleteElement={onDeleteElement}
            onRedoFromLayer={onRedoFromLayer}
            onRedoSingleLayer={onRedoSingleLayer}
            onRedoGrab={onRedoGrab}
          />
          </div>
        ))}
      </div>

      {/* Input area - fixed at bottom */}
      <div className="flex-shrink-0 p-4 bg-white border-t border-gray-100">
        <ChatInput
          onSendMessage={onSendMessage}
          onImageUpload={onImageUpload}
          disabled={isInputDisabled}
          placeholder={getPlaceholder()}
          modifyLayerMode={modifyLayerMode}
          onCancelModifyMode={onCancelModifyMode}
          grabElementMode={grabElementMode}
          grabMoreMode={grabMoreMode}
          onCancelGrabMode={onCancelGrabMode}
          subSegmentMode={subSegmentMode}
          onCancelSubSegmentMode={onCancelSubSegmentMode}
        />
      </div>
    </div>
  );
};

export default ConversationPanel;
