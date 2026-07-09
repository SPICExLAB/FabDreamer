import React, { useState, useRef, useEffect, useCallback } from 'react';
import { FiSend, FiCpu, FiActivity, FiTool, FiAlertTriangle, FiCheckCircle, FiZap, FiLoader, FiChevronDown, FiChevronRight, FiCheck, FiX, FiEdit3, FiRotateCcw, FiEye } from 'react-icons/fi';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useFabricationAgent } from '../../hooks/useFabricationAgent';
import { useLayerManager } from '../LayerManager';
import { API_BASE_URL } from '../../config';

// Parse text for clickable references like [Layer X] and [part:name]
const parseClickableRefs = (text, onLayerClick, onPartClick) => {
  if (!text) return text;

  // Pattern for [Layer X] and [part:name]
  const refPattern = /\[Layer\s*(\d+)\]|\[part:([^\]]+)\]/gi;

  const parts = [];
  let lastIndex = 0;
  let match;

  while ((match = refPattern.exec(text)) !== null) {
    // Add text before match
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    // Add clickable reference
    if (match[1]) {
      // Layer reference
      const layerNum = match[1];
      parts.push(
        <button
          key={`layer-${match.index}`}
          onClick={() => onLayerClick && onLayerClick(layerNum)}
          className="inline-flex items-center px-1.5 py-0.5 bg-blue-100 hover:bg-blue-200 text-blue-700 rounded text-xs font-medium transition-colors cursor-pointer mx-0.5"
          title="Click to view layer"
        >
          Layer {layerNum}
        </button>
      );
    } else if (match[2]) {
      // Part reference
      const fullPartId = match[2];
      let displayName = fullPartId;

      const nameMatch = fullPartId.match(/segment-\d+-\d+-\d+-(.+?)(?:-edit|$)/);
      if (nameMatch && nameMatch[1]) {
        displayName = nameMatch[1];
      }

      if (displayName.length > 20 && displayName.includes('-')) {
         displayName = displayName.substring(0, 15) + '...';
      }

      parts.push(
        <button
          key={`part-${match.index}`}
          onClick={() => onPartClick && onPartClick(fullPartId)}
          className="inline-flex items-center px-1.5 py-0.5 bg-amber-100 hover:bg-amber-200 text-amber-700 rounded text-xs font-medium transition-colors cursor-pointer mx-0.5"
          title={fullPartId}
        >
          {displayName}
        </button>
      );
    }

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? parts : text;
};

// Custom text renderer that makes references clickable
const ClickableText = ({ children, onLayerClick, onPartClick }) => {
  if (typeof children === 'string') {
    return <>{parseClickableRefs(children, onLayerClick, onPartClick)}</>;
  }

  if (Array.isArray(children)) {
    return (
      <>
        {children.map((child, idx) => (
          <ClickableText key={idx} onLayerClick={onLayerClick} onPartClick={onPartClick}>
            {child}
          </ClickableText>
        ))}
      </>
    );
  }

  return children;
};

// --- COMPONENTS ---

const StatusHeader = ({ isProcessing, activeTool }) => (
  <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-white">
    <div className="flex items-center gap-2">
      <div className={`w-2 h-2 rounded-full ${isProcessing ? 'bg-amber-500 animate-pulse' : 'bg-emerald-500'}`} />
      <h2 className="text-sm font-semibold text-gray-800">
        Fabrication Agent
      </h2>
      <span className="text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">
        Gemini 2.5 Flash
      </span>
    </div>
    <div className="flex items-center gap-2 text-[10px] text-gray-400">
      <FiActivity size={12} className={isProcessing ? 'text-amber-500 animate-pulse' : ''} />
      <span>
        {activeTool ? `Running: ${activeTool}` : isProcessing ? 'Processing...' : 'Ready'}
      </span>
    </div>
  </div>
);

// Combined tool card - shows call and result together
const ToolCard = ({ tool, args, status, result }) => {
  const isExecuting = status === 'executing';
  const hasResult = result !== null && result !== undefined;

  const isSuccess = hasResult && result?.success !== false;
  const hasFloatingParts = result?.floating_parts && result.floating_parts.length > 0;

  const cardBg = isExecuting
    ? 'bg-amber-50 border-amber-200'
    : isSuccess
      ? 'bg-emerald-50 border-emerald-200'
      : 'bg-red-50 border-red-200';

  const iconColor = isExecuting
    ? 'text-amber-600'
    : isSuccess
      ? 'text-emerald-600'
      : 'text-red-600';

  return (
    <div className={`my-1.5 mx-4 p-2.5 border rounded-lg transition-colors duration-300 ${cardBg}`}>
      <div className="flex items-center gap-2 text-xs">
        {isExecuting ? (
          <FiLoader className="animate-spin text-amber-600" size={12} />
        ) : (
          <FiCheckCircle className={iconColor} size={12} />
        )}
        <span className={`font-semibold ${iconColor}`}>{tool}</span>

        {isExecuting ? (
          <span className="text-amber-500 text-[10px] italic">executing...</span>
        ) : result?.message ? (
          <span className="text-gray-500 text-[10px] italic">{result.message}</span>
        ) : null}
      </div>

      {hasFloatingParts && (
        <div className="mt-2 space-y-1">
          {result.floating_parts.map((part, pIdx) => (
            <div key={pIdx} className="flex items-center gap-2 text-xs text-amber-700 bg-amber-100 px-2 py-1 rounded">
              <FiAlertTriangle size={10} />
              <span className="font-medium truncate flex-1">{part.part_name || part.part_id}</span>
              <span className="text-[10px] text-amber-500 flex-shrink-0">
                ({Math.round(part.distance)}px away)
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// --- Analysis Results Card ---
const AnalysisResultsCard = ({ analysisResults, onQuickFix, onDrawBridge, onIgnore, onUnignore, onUndo, onConfirmFix, onRejectFix, onPartClick, disabled }) => {
  if (!analysisResults || analysisResults.length === 0) return null;

  const hasAnyIssues = analysisResults.some(lr => lr.issues.length > 0);

  return (
    <div className="mx-4 my-3 space-y-2">
      <div className="flex items-center gap-1.5 text-xs text-gray-500 mb-1">
        <FiTool size={12} />
        <span className="font-medium uppercase tracking-wider text-[10px]">Analysis Results</span>
      </div>

      {analysisResults.map((layerResult) => {
        // Check if any issue in this layer has been fixed (for undo button)
        const hasFixedIssue = layerResult.issues.some(i => i.status === 'fixed');
        const pendingCount = layerResult.issues.filter(i => i.status === 'pending' || i.status === 'fixing' || i.status === 'previewing').length;

        return (
          <div
            key={layerResult.layerId}
            className="border border-gray-200 rounded-lg overflow-hidden"
          >
            {/* Layer header with undo button */}
            <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 border-b border-gray-100">
              <span className="text-xs font-semibold text-gray-700">{layerResult.layerName}</span>
              {layerResult.issues.length === 0 ? (
                <span className="text-[10px] text-emerald-600 flex items-center gap-1">
                  <FiCheck size={10} /> No issues
                </span>
              ) : (
                <span className="text-[10px] text-amber-600">
                  {pendingCount} issue{pendingCount !== 1 ? 's' : ''}
                </span>
              )}
              {/* Undo button — top-right of layer card */}
              {hasFixedIssue && (
                <button
                  onClick={() => {
                    const fixedIssue = layerResult.issues.find(i => i.status === 'fixed');
                    if (fixedIssue) onUndo && onUndo(fixedIssue.partId);
                  }}
                  disabled={disabled}
                  className="ml-auto flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Undo bridge fix — revert to original"
                >
                  <FiRotateCcw size={10} />
                  Undo
                </button>
              )}
            </div>

            {/* Issues */}
            {layerResult.issues.length > 0 && (
              <div className="divide-y divide-gray-50">
                {layerResult.issues.map((issue, issueIdx) => {
                  const isFixed = issue.status === 'fixed';
                  const isIgnored = issue.status === 'ignored';
                  const isFixing = issue.status === 'fixing';
                  const isPending = issue.status === 'pending';
                  const isPreviewing = issue.status === 'previewing';

                  // Extract display name from part ID
                  let displayName = issue.partName;
                  const nameMatch = displayName.match(/segment-\d+-\d+-\d+-(.+?)(?:-edit|$)/);
                  if (nameMatch && nameMatch[1]) {
                    displayName = nameMatch[1].replace(/-/g, ' ');
                  }

                  return (
                    <div
                      key={`${issue.partId}-${issue.type || issueIdx}`}
                      className={`px-3 py-2 ${isFixed ? 'opacity-50' : ''}`}
                    >
                      <div className="flex items-center gap-2 mb-1.5">
                        {isFixed ? (
                          <FiCheck size={12} className="text-emerald-500 flex-shrink-0" />
                        ) : isPreviewing ? (
                          <FiEye size={12} className="text-blue-500 flex-shrink-0" />
                        ) : isFixing ? (
                          <FiLoader size={12} className="text-amber-500 animate-spin flex-shrink-0" />
                        ) : (
                          <FiAlertTriangle size={12} className="text-amber-500 flex-shrink-0" />
                        )}
                        <span className={`text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ${
                          issue.type === 'floating' ? 'bg-amber-50 text-amber-600' :
                          issue.type === 'thin' ? 'bg-red-50 text-red-600' :
                          'bg-gray-50 text-gray-500'
                        }`}>
                          {issue.type === 'floating' ? 'Floating' :
                           issue.type === 'thin' ? 'Thin' : issue.type}
                        </span>
                        {/* Chevron to re-expand ignored issues */}
                        {isIgnored && (
                          <button
                            onClick={() => onUnignore && onUnignore(issue.partId)}
                            className="flex-shrink-0 text-gray-400 hover:text-gray-600 transition-colors"
                            title="Show actions again"
                          >
                            <FiChevronRight size={12} />
                          </button>
                        )}
                        {issue.type === 'thin' ? (
                          <button
                            className="text-xs font-medium text-gray-700 hover:text-red-600 truncate text-left transition-colors"
                            onClick={() => onPartClick && onPartClick(issue.partId)}
                            title={issue.partId}
                          >
                            {displayName}
                          </button>
                        ) : (
                          <button
                            className="text-xs font-medium text-gray-700 hover:text-blue-600 truncate text-left transition-colors"
                            onClick={() => onPartClick && onPartClick(issue.partId)}
                            title={issue.partId}
                          >
                            {displayName}
                          </button>
                        )}
                        <span className="text-[10px] text-gray-400 flex-shrink-0 ml-auto">
                          {issue.type === 'floating' && issue.distance > 0 ? `${Math.round(issue.distance)}px away` : ''}
                        </span>
                      </div>

                      {/* Action buttons — visible for pending, hidden for ignored (collapsed) */}
                      {isPending && !isFixing && issue.type === 'floating' && (
                        <div className="flex gap-1.5 ml-5">
                          <button
                            onClick={() => onQuickFix(issue.partId, issue.partName)}
                            disabled={disabled}
                            className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium bg-blue-50 hover:bg-blue-100 text-blue-700 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            title="Auto-bridge to nearest anchor"
                          >
                            <FiZap size={10} />
                            Quick Fix
                          </button>
                          <button
                            onClick={() => onDrawBridge(issue.partId)}
                            disabled={disabled}
                            className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium bg-violet-50 hover:bg-violet-100 text-violet-700 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            title="Draw bridge manually on 3D view"
                          >
                            <FiEdit3 size={10} />
                            Draw
                          </button>
                          <button
                            onClick={() => onIgnore(issue.partId)}
                            disabled={disabled}
                            className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium bg-gray-50 hover:bg-gray-100 text-gray-500 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            title="Acknowledge and skip"
                          >
                            <FiX size={10} />
                            Ignore
                          </button>
                        </div>
                      )}

                      {/* Thin area info — width estimate + hint, no Quick Fix/Draw */}
                      {isPending && !isFixing && issue.type === 'thin' && (
                        <div className="ml-5 space-y-1">
                          <div className="text-[10px] text-red-600">
                            ~{issue.estimatedWidth ?? '?'}mm {issue.minWidth ? `(min ${issue.minWidth}mm)` : ''}
                          </div>
                          <div className="text-[10px] text-gray-400 italic">
                            Go back to scale up the element, or scale up the board here
                          </div>
                          <div className="flex gap-1.5">
                            <button
                              onClick={() => onIgnore(issue.partId)}
                              disabled={disabled}
                              className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium bg-gray-50 hover:bg-gray-100 text-gray-500 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                              title="Acknowledge and skip"
                            >
                              <FiX size={10} />
                              Ignore
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Preview mode — Accept / Reject buttons */}
                      {isPreviewing && (
                        <div className="flex gap-1.5 ml-5">
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 self-center mr-1">
                            Previewing
                          </span>
                          <button
                            onClick={() => onConfirmFix && onConfirmFix(issue.partId)}
                            disabled={disabled}
                            className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium bg-emerald-50 hover:bg-emerald-100 text-emerald-700 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            title="Accept fix and apply"
                          >
                            <FiCheck size={10} />
                            Accept
                          </button>
                          <button
                            onClick={() => onRejectFix && onRejectFix(issue.partId)}
                            disabled={disabled}
                            className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium bg-red-50 hover:bg-red-100 text-red-700 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            title="Reject fix and discard"
                          >
                            <FiX size={10} />
                            Reject
                          </button>
                        </div>
                      )}

                      {/* Status badge for fixed items */}
                      {isFixed && (
                        <div className="ml-5">
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-600">
                            Bridged
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {!hasAnyIssues && (
        <div className="text-center py-2">
          <span className="text-xs text-emerald-600 flex items-center justify-center gap-1">
            <FiCheckCircle size={12} />
            All layers look good for cutting!
          </span>
        </div>
      )}
    </div>
  );
};

// Collapsible reasoning/thinking block - cleaner style without background
const ThinkingBlock = ({ content, isStreaming = false }) => {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <div className="mx-4 my-2">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600 transition-colors mb-1 select-none"
      >
        {isExpanded ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
        <span className="font-medium uppercase tracking-wider text-[10px]">Reasoning</span>
        {isStreaming && (
          <span className="inline-flex ml-1">
            <span className="w-1 h-1 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="w-1 h-1 bg-gray-400 rounded-full animate-bounce ml-0.5" style={{ animationDelay: '150ms' }} />
            <span className="w-1 h-1 bg-gray-400 rounded-full animate-bounce ml-0.5" style={{ animationDelay: '300ms' }} />
          </span>
        )}
      </button>

      {isExpanded && (
        <div className="pl-3 border-l-2 border-gray-100 ml-1.5 animate-fadeIn">
          <div className="text-xs text-gray-500 leading-relaxed">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                p: ({node, ...props}) => <p className="mb-1 last:mb-0" {...props} />,
                ul: ({node, ...props}) => <ul className="list-disc pl-4 mb-1" {...props} />,
                ol: ({node, ...props}) => <ol className="list-decimal pl-4 mb-1" {...props} />,
                li: ({node, ...props}) => <li className="mb-0.5" {...props} />,
                code: ({node, inline, className, children, ...props}) => (
                  <code className={`${inline ? 'bg-gray-100 px-1 py-0.5 rounded text-[10px]' : 'block bg-gray-100 p-2 rounded text-[10px] overflow-x-auto'}`} {...props}>
                    {children}
                  </code>
                ),
              }}
            >
              {content}
            </ReactMarkdown>
            {isStreaming && (
              <span className="inline-block w-0.5 h-3 bg-gray-300 ml-0.5 animate-pulse" />
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// Final response block - agent's answer (not reasoning)
const ResponseBlock = ({ content, isStreaming = false, onLayerClick, onPartClick }) => {
  // Create markdown components with clickable text support
  const createTextComponent = (Component, className) => {
    return ({ node, children, ...props }) => (
      <Component className={className} {...props}>
        <ClickableText onLayerClick={onLayerClick} onPartClick={onPartClick}>
          {children}
        </ClickableText>
      </Component>
    );
  };

  return (
    <div className="mx-4 my-4">
      <div className="flex items-center gap-1.5 text-xs text-blue-600 mb-1 select-none">
        <FiCpu size={12} />
        <span className="font-medium uppercase tracking-wider text-[10px]">Response</span>
      </div>

      <div className="pl-3 border-l-2 border-blue-100 ml-1.5 animate-fadeIn">
        <div className="text-sm text-gray-800 leading-relaxed">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              p: createTextComponent('p', 'mb-2 last:mb-0'),
              h1: createTextComponent('h1', 'text-lg font-bold mb-2 mt-3 first:mt-0'),
              h2: createTextComponent('h2', 'text-base font-bold mb-2 mt-3 first:mt-0'),
              h3: createTextComponent('h3', 'text-sm font-bold mb-1 mt-2 first:mt-0'),
              li: createTextComponent('li', 'mb-1'),
              ul: ({node, ...props}) => <ul className="list-disc pl-4 mb-2" {...props} />,
              ol: ({node, ...props}) => <ol className="list-decimal pl-4 mb-2" {...props} />,
              blockquote: ({node, ...props}) => <blockquote className="border-l-2 border-gray-300 pl-3 italic text-gray-600 my-2" {...props} />,
              code: ({node, inline, className, children, ...props}) => (
                <code className={`${inline ? 'bg-gray-100 px-1 py-0.5 rounded text-xs font-mono' : 'block bg-gray-100 p-2 rounded text-xs font-mono overflow-x-auto my-2'}`} {...props}>
                  {children}
                </code>
              ),
              a: ({node, ...props}) => <a className="text-blue-600 hover:underline" {...props} />,
              strong: ({node, children, ...props}) => (
                <strong className="font-semibold text-gray-900" {...props}>
                  <ClickableText onLayerClick={onLayerClick} onPartClick={onPartClick}>
                    {children}
                  </ClickableText>
                </strong>
              ),
            }}
          >
            {content}
          </ReactMarkdown>
          {isStreaming && (
            <span className="inline-block w-0.5 h-4 bg-blue-500 ml-0.5 animate-pulse" />
          )}
        </div>
      </div>
    </div>
  );
};

// Render a stream event
const StreamEvent = ({ event, onLayerClick, onPartClick }) => {
  switch (event.type) {
    case 'reasoning':
      return <ThinkingBlock content={event.content} isStreaming={false} />;
    case 'streaming_reasoning':
      return <ThinkingBlock content={event.content} isStreaming={true} />;
    case 'response':
      return <ResponseBlock content={event.content} isStreaming={false} onLayerClick={onLayerClick} onPartClick={onPartClick} />;
    case 'streaming_response':
      return <ResponseBlock content={event.content} isStreaming={true} onLayerClick={onLayerClick} onPartClick={onPartClick} />;
    case 'tool':
      return <ToolCard tool={event.tool} args={event.args} status={event.status} result={event.result} />;
    default:
      return null;
  }
};

const MessageBubble = ({ message, onLayerClick, onPartClick }) => {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';

  if (isSystem) {
    return (
      <div className="mx-4 my-2 text-xs text-gray-500 flex items-center gap-2">
        <FiZap size={12} />
        <span>{message.content}</span>
      </div>
    );
  }

  if (isUser) {
    return (
      <div className="flex justify-end px-4 py-2">
        <div className="max-w-[85%] rounded-xl p-3 text-sm bg-blue-500 text-white rounded-br-sm shadow-sm">
          <div className="whitespace-pre-wrap leading-relaxed">
            {message.content}
          </div>
        </div>
      </div>
    );
  }

  // Agent message (History) - use ResponseBlock for consistent rendering
  return (
    <div className="space-y-1">
      {message.content && (
        <ResponseBlock
          content={message.content}
          isStreaming={false}
          onLayerClick={onLayerClick}
          onPartClick={onPartClick}
        />
      )}

      {/* Tool Cards */}
      {message.toolCalls && message.toolCalls.map((tc, idx) => {
        const result = message.toolResults?.[idx]?.result;
        return (
          <ToolCard
            key={idx}
            tool={tc.tool}
            args={tc.args}
            status="complete"
            result={result}
          />
        );
      })}
    </div>
  );
};

const FabricationChat = ({ layerData, setLayerData, isFabricationMode, onHighlightLayer, onHighlightPart, onDrawBridgeModeChange }) => {
  const { changedLayerIds, clearChangedLayerIds, analysisResults, setAnalysisResults, pendingFix, setPendingFix, fabricationScale } = useLayerManager();
  const {
    messages,
    isProcessing,
    activeTool,
    sendMessage,
    autoAnalyze,
    streamEvents,
    handleQuickFix,
    handleIgnore,
    handleUnignore,
    handleDrawBridge,
    handleUndoBridge,
    drawBridgeMode,
    setDrawBridgeMode,
    handleBridgeDrawn,
    confirmFix,
    rejectFix,
  } = useFabricationAgent(layerData, setLayerData, onHighlightPart, analysisResults, setAnalysisResults, pendingFix, setPendingFix);
  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef(null);
  const prevScaleRef = useRef(fabricationScale);
  const scaleDebounceRef = useRef(null);
  const layerDataRef = useRef(layerData);
  layerDataRef.current = layerData; // always latest
  const prevPendingFixRef = useRef(pendingFix);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamEvents, analysisResults]);

  // Cascading re-validation after bridge fix: run thin detection on the affected
  // layer via the direct endpoint (not the AI agent) to verify the bridge width.
  // Triggered when pendingFix transitions from non-null to null (fix confirmed).
  useEffect(() => {
    const prev = prevPendingFixRef.current;
    prevPendingFixRef.current = pendingFix;

    // Detect pendingFix going from non-null → null (fix was just confirmed)
    if (prev && !pendingFix && isFabricationMode) {
      const fixedLayerId = prev.layerId;
      // Small delay to let fabLayers state propagate before reading layerDataRef
      setTimeout(async () => {
        try {
          const resp = await fetch(`${API_BASE_URL}/detect-thin-areas`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ layer_data: layerDataRef.current }),
          });
          if (!resp.ok) return;
          const data = await resp.json();

          // Merge thin results for the fixed layer only
          setAnalysisResults(prevResults => {
            if (!prevResults) return prevResults;
            return prevResults.map(lr => {
              if (String(lr.layerId) !== String(fixedLayerId)) return lr;
              const match = (data.per_layer || []).find(
                pl => String(pl.layer_id) === String(fixedLayerId)
              );
              if (!match || !match.thin_areas_detail?.length) {
                // No thin issues on bridge — just clear stale thin
                return { ...lr, issues: lr.issues.filter(i => i.type !== 'thin') };
              }
              // Aggregate per segment
              const thinByPart = {};
              for (const ta of match.thin_areas_detail) {
                const pid = ta.part_id;
                if (!thinByPart[pid]) {
                  thinByPart[pid] = { ...ta };
                } else {
                  if ((ta.estimated_width_mm || 999) < (thinByPart[pid].estimated_width_mm || 999)) {
                    thinByPart[pid].estimated_width_mm = ta.estimated_width_mm;
                  }
                  if (ta.severity === 'error') thinByPart[pid].severity = 'error';
                }
              }
              const thinIssues = Object.values(thinByPart).map(ta => ({
                type: 'thin',
                partId: ta.part_id,
                partName: ta.part_name || ta.part_id,
                severity: ta.severity || 'warning',
                estimatedWidth: ta.estimated_width_mm,
                minWidth: match.min_width_mm || 1.0,
                status: 'pending',
              }));
              const nonThin = lr.issues.filter(i => i.type !== 'thin');
              return { ...lr, issues: [...nonThin, ...thinIssues] };
            });
          });
        } catch (err) {
          console.warn('Cascading thin detection error:', err);
        }
      }, 500);
    }
  }, [pendingFix, isFabricationMode, setAnalysisResults]);

  // Auto-analyze when entering fabrication mode with changed layers.
  // Skip if analysisResults already exist AND no layers changed (re-entry with no edits).
  useEffect(() => {
    if (!isFabricationMode || isProcessing) return;

    if (changedLayerIds?.length > 0) {
      // Layers changed — re-analyze
      autoAnalyze();
      clearChangedLayerIds();
    } else if (!analysisResults) {
      // First entry (no previous results) — analyze all
      autoAnalyze();
    }
    // If analysisResults exist and no layers changed → skip (keep previous state)
  }, [isFabricationMode, changedLayerIds, isProcessing, autoAnalyze, clearChangedLayerIds, analysisResults]);

  // Re-run thin detection (only) when fabrication scale changes.
  // Calls a direct geometry endpoint — no AI agent, instant response.
  // Debounced because the slider fires rapidly.
  useEffect(() => {
    if (!isFabricationMode) return;
    if (prevScaleRef.current === fabricationScale) return;
    prevScaleRef.current = fabricationScale;

    // Clear stale thin issues immediately (visual feedback)
    setAnalysisResults(prev => {
      if (!prev) return prev;
      return prev.map(lr => ({
        ...lr,
        issues: lr.issues.filter(issue => issue.type !== 'thin'),
      }));
    });

    // Debounce the actual API call
    if (scaleDebounceRef.current) clearTimeout(scaleDebounceRef.current);
    scaleDebounceRef.current = setTimeout(async () => {
      scaleDebounceRef.current = null;
      try {
        const resp = await fetch(`${API_BASE_URL}/detect-thin-areas`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ layer_data: layerDataRef.current }),
        });
        if (!resp.ok) return;
        const data = await resp.json();

        // Merge thin results into existing analysisResults
        setAnalysisResults(prev => {
          if (!prev) return prev;
          return prev.map(lr => {
            const match = (data.per_layer || []).find(
              pl => String(pl.layer_id) === String(lr.layerId)
            );
            if (!match || !match.thin_areas_detail?.length) return lr;

            // Aggregate thin areas per segment (one issue per part)
            const thinByPart = {};
            for (const ta of match.thin_areas_detail) {
              const pid = ta.part_id;
              if (!thinByPart[pid]) {
                thinByPart[pid] = { ...ta };
              } else {
                if ((ta.estimated_width_mm || 999) < (thinByPart[pid].estimated_width_mm || 999)) {
                  thinByPart[pid].estimated_width_mm = ta.estimated_width_mm;
                }
                if (ta.severity === 'error') thinByPart[pid].severity = 'error';
              }
            }
            const thinIssues = Object.values(thinByPart).map(ta => ({
              type: 'thin',
              partId: ta.part_id,
              partName: ta.part_name || ta.part_id,
              severity: ta.severity || 'warning',
              estimatedWidth: ta.estimated_width_mm,
              minWidth: match.min_width_mm || 1.0,
              status: 'pending',
            }));

            // Remove old thin issues, add fresh ones
            const nonThin = lr.issues.filter(i => i.type !== 'thin');
            return { ...lr, issues: [...nonThin, ...thinIssues] };
          });
        });
      } catch (err) {
        console.warn('Thin detection error:', err);
      }
    }, 600);

    return () => {
      if (scaleDebounceRef.current) clearTimeout(scaleDebounceRef.current);
    };
  }, [fabricationScale, isFabricationMode, setAnalysisResults]);

  // Propagate draw bridge mode changes to parent
  useEffect(() => {
    if (onDrawBridgeModeChange) {
      onDrawBridgeModeChange(drawBridgeMode, handleBridgeDrawn);
    }
  }, [drawBridgeMode, handleBridgeDrawn, onDrawBridgeModeChange]);

  const handleSend = () => {
    if (!inputValue.trim() || isProcessing) return;
    sendMessage(inputValue);
    setInputValue('');
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Handle layer click - find layer by number and highlight it
  const handleLayerClick = useCallback((layerNum) => {
    console.log('Layer clicked:', layerNum);
    const layers = layerData?.layers || [];
    const layerIndex = parseInt(layerNum, 10) - 1; // Convert to 0-based index

    if (layerIndex >= 0 && layerIndex < layers.length) {
      const layer = layers[layerIndex];
      if (onHighlightLayer) {
        onHighlightLayer(layer.id);
      }
    }
  }, [layerData, onHighlightLayer]);

  // Handle part click - find part by ID or name and highlight it
  const handlePartClick = useCallback((partIdOrName) => {
    console.log('Part clicked:', partIdOrName);
    const layers = layerData?.layers || [];
    const search = partIdOrName.toLowerCase();

    // Search for the part across all layers — try ID match first, then name
    for (const layer of layers) {
      for (const segment of layer.segments || []) {
        // Exact ID match
        if (segment.id === partIdOrName) {
          onHighlightPart?.(layer.id, segment.id);
          return;
        }
      }
    }

    // Fallback: partial name match
    for (const layer of layers) {
      for (const segment of layer.segments || []) {
        const segmentName = (segment.name || segment.id || '').toLowerCase();
        if (segmentName.includes(search) || search.includes(segmentName)) {
          onHighlightPart?.(layer.id, segment.id);
          return;
        }
      }
    }

    console.log('Part not found:', partIdOrName);
  }, [layerData, onHighlightPart]);

  // Analysis card action handlers — wrap to include layerId
  const handleQuickFixAction = useCallback((layerId) => (partId, partName) => {
    handleQuickFix(layerId, partId, partName);
  }, [handleQuickFix]);

  const handleIgnoreAction = useCallback((layerId) => (partId) => {
    handleIgnore(layerId, partId);
  }, [handleIgnore]);

  const handleDrawBridgeAction = useCallback((layerId) => (partId) => {
    handleDrawBridge(layerId, partId);
  }, [handleDrawBridge]);

  return (
    <div className="flex flex-col h-full bg-gray-50 rounded-lg overflow-hidden">
      {/* Header */}
      <StatusHeader isProcessing={isProcessing} activeTool={activeTool} />

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto bg-white">
        <div className="py-3">
          {/* Render messages, hiding the last one if it's currently being shown via streamEvents */}
          {messages.map((msg, idx) => {
            const isLast = idx === messages.length - 1;
            // If this is the last message AND it's from the model AND we have stream events,
            // hide it because streamEvents is showing it (prevents double render)
            if (isLast && msg.role === 'model' && streamEvents.length > 0) {
              return null;
            }
            return <MessageBubble key={msg.id} message={msg} onLayerClick={handleLayerClick} onPartClick={handlePartClick} />;
          })}

          {/* Stream events */}
          {streamEvents.map((event) => (
            <StreamEvent key={event.id} event={event} onLayerClick={handleLayerClick} onPartClick={handlePartClick} />
          ))}

          {/* Analysis Results Card — shown after analysis completes */}
          {analysisResults && !isProcessing && (
            <AnalysisResultsCard
              analysisResults={analysisResults}
              onQuickFix={(partId, partName) => {
                // Find the layerId for this partId
                const lr = analysisResults.find(lr => lr.issues.some(i => i.partId === partId));
                if (lr) handleQuickFix(lr.layerId, partId, partName);
              }}
              onDrawBridge={(partId) => {
                const lr = analysisResults.find(lr => lr.issues.some(i => i.partId === partId));
                if (lr) handleDrawBridge(lr.layerId, partId);
              }}
              onIgnore={(partId) => {
                const lr = analysisResults.find(lr => lr.issues.some(i => i.partId === partId));
                if (lr) handleIgnore(lr.layerId, partId);
              }}
              onUnignore={(partId) => {
                const lr = analysisResults.find(lr => lr.issues.some(i => i.partId === partId));
                if (lr) handleUnignore(lr.layerId, partId);
              }}
              onUndo={(partId) => {
                const lr = analysisResults.find(lr => lr.issues.some(i => i.partId === partId));
                if (lr) handleUndoBridge(lr.layerId, partId);
              }}
              onConfirmFix={() => confirmFix()}
              onRejectFix={() => rejectFix()}
              onPartClick={handlePartClick}
              disabled={isProcessing}
            />
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Draw Bridge Mode Banner */}
      {drawBridgeMode && (
        <div className="px-4 py-2 bg-violet-50 border-t border-violet-200 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-violet-700">
            <FiEdit3 size={12} />
            <span className="font-medium">Draw Bridge Mode</span>
            <span className="text-violet-500">Right-click drag on 3D view to draw</span>
          </div>
          <button
            onClick={() => setDrawBridgeMode(null)}
            className="text-xs text-violet-500 hover:text-violet-700 px-2 py-0.5 rounded hover:bg-violet-100 transition-colors"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Input Area */}
      <div className="flex-shrink-0 p-3 bg-white border-t border-gray-200">
        <div className="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-100 transition-all">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder={isProcessing ? "Agent is thinking..." : "Ask about your design..."}
            disabled={isProcessing}
            className="flex-1 bg-transparent border-none focus:outline-none text-sm text-gray-700 placeholder-gray-400"
            autoFocus
          />
          <button
            onClick={handleSend}
            disabled={!inputValue.trim() || isProcessing}
            className="p-1.5 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 text-white rounded-lg transition-colors disabled:cursor-not-allowed"
          >
            <FiSend size={14} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default FabricationChat;
