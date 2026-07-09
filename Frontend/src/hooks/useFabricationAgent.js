import { useState, useCallback, useRef, useEffect } from 'react';
import { API_BASE_URL } from '../config';
import { unionPolygonPaths } from '../utils/svgPathOffset';
import { extractCombinedPathD } from '../utils/svgDom';
import { unionOverlappingSegments } from '../utils/frameUnion';

export const useFabricationAgent = (layerData, setLayerData, onHighlightCallback, analysisResults, setAnalysisResults, pendingFix, setPendingFix) => {
  const [messages, setMessages] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [activeTool, setActiveTool] = useState(null);
  const [highlights, setHighlights] = useState([]);

  // Stream events in order - persists after completion for display
  const [streamEvents, setStreamEvents] = useState([]);

  // Active draw-bridge mode (consumed by ThreeDView)
  const [drawBridgeMode, setDrawBridgeMode] = useState(null);

  // Re-analysis trigger after bridge confirm
  const needsReanalysisRef = useRef(false);

  // Layer snapshots before fixes — used for undo
  // Map<layerId, { segments: [...], frameDisabled, frameMergedSvgPath }>
  const layerSnapshotsRef = useRef({});

  // Refs to track accumulated data (avoids closure issues)
  const currentTextRef = useRef('');
  const allEventsRef = useRef([]);
  const allToolCallsRef = useRef([]);
  const allToolResultsRef = useRef([]);
  const hasHadToolCallsRef = useRef(false); // Track if any tools were called

  /**
   * Parse tool results to extract per-layer analysis data.
   * Handles: analyze_all_layers (per_layer with floating_parts_detail),
   *          find_floating_parts, analyze_layer_connectivity
   */
  const parseAnalysisResults = useCallback((toolResults, layers) => {
    const results = [];
    const layerList = layers || [];
    const seenLayerIds = new Set();

    // Helper to add/merge issues for a layer (floating + thin).
    // If the layer was already seen, merge new issues into the existing entry
    // (handles case where agent calls find_floating_parts + detect_thin_areas separately).
    const addLayerResult = (layerId, layerName, floatingParts, thinAreas, minWidthMm) => {
      const newIssues = [];
      for (const part of floatingParts) {
        newIssues.push({
          type: 'floating',
          partId: part.part_id,
          partName: part.part_name || part.part_id,
          distance: part.distance || 0,
          nearestAnchor: part.nearest_anchor || 'boundary',
          status: 'pending',
        });
      }
      // Aggregate thin areas per segment — one issue per part, worst severity/width
      const thinByPart = {};
      for (const ta of thinAreas) {
        const pid = ta.part_id;
        if (!thinByPart[pid]) {
          thinByPart[pid] = { ...ta, estimatedWidth: ta.estimated_width_mm };
        } else {
          // Keep worst (smallest) width and worst severity
          if ((ta.estimated_width_mm || 999) < (thinByPart[pid].estimatedWidth || 999)) {
            thinByPart[pid].estimatedWidth = ta.estimated_width_mm;
          }
          if (ta.severity === 'error') thinByPart[pid].severity = 'error';
        }
      }
      for (const pid of Object.keys(thinByPart)) {
        const ta = thinByPart[pid];
        newIssues.push({
          type: 'thin',
          partId: pid,
          partName: ta.part_name || pid,
          severity: ta.severity || 'warning',
          estimatedWidth: ta.estimatedWidth ?? ta.estimated_width_mm,
          minWidth: minWidthMm || 1.0,
          status: 'pending',
        });
      }

      if (seenLayerIds.has(String(layerId))) {
        // Merge into existing entry
        const existing = results.find(r => String(r.layerId) === String(layerId));
        if (existing && newIssues.length > 0) {
          const existingIds = new Set(existing.issues.map(i => `${i.type}:${i.partId}`));
          for (const issue of newIssues) {
            if (!existingIds.has(`${issue.type}:${issue.partId}`)) {
              existing.issues.push(issue);
            }
          }
        }
        return;
      }

      seenLayerIds.add(String(layerId));
      results.push({ layerId, layerName, issues: newIssues });
    };

    for (const tr of toolResults) {
      const result = tr.result;
      if (!result || result.error) continue;

      if (tr.tool === 'analyze_all_layers' && result.per_layer) {
        // analyze_all_layers returns per-layer summaries with floating_parts_detail + thin_areas_detail
        for (const lr of result.per_layer) {
          const layerId = lr.layer_id;
          const layerName = lr.layer_name || `Layer ${layerId}`;
          const floatingParts = lr.floating_parts_detail || [];
          const thinAreas = lr.thin_areas_detail || [];
          addLayerResult(layerId, layerName, floatingParts, thinAreas, lr.min_width_mm);
        }
      } else if (tr.tool === 'find_floating_parts' || tr.tool === 'analyze_layer_connectivity') {
        const layerId = result.layer_id;
        const layerMatch = layerList.find(l => String(l.id) === String(layerId));
        const layerName = layerMatch?.name || `Layer ${layerId}`;
        const floatingParts = result.floating_parts || [];
        addLayerResult(layerId, layerName, floatingParts, [], null);
      } else if (tr.tool === 'detect_thin_areas' && result.thin_areas?.length > 0) {
        const layerId = result.layer_id;
        const layerMatch = layerList.find(l => String(l.id) === String(layerId));
        const layerName = layerMatch?.name || `Layer ${layerId}`;
        addLayerResult(layerId, layerName, [], result.thin_areas, result.min_width_mm);
      }
    }

    // Include layers with no issues (from layerList)
    for (const layer of layerList) {
      if (!seenLayerIds.has(String(layer.id))) {
        results.push({
          layerId: layer.id,
          layerName: layer.name || `Layer ${layer.id}`,
          issues: [],
        });
      }
    }

    return results.length > 0 ? results : null;
  }, []);

  /**
   * Shared stream processor — reads an SSE response and updates state.
   * Returns { allTextContent, allSvgUpdates } on completion.
   */
  const processStream = useCallback(async (response) => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    let allHighlights = [];
    let allSvgUpdates = [];

    // Helper to update state from ref
    const syncState = () => {
      setStreamEvents([...allEventsRef.current]);
    };

    // Helper to add event
    const addEvent = (event) => {
      allEventsRef.current = [...allEventsRef.current, event];
      syncState();
      return allEventsRef.current.length - 1;
    };

    // Helper to update event at index
    const updateEvent = (index, updates) => {
      const events = allEventsRef.current;
      if (index >= 0 && index < events.length) {
        events[index] = { ...events[index], ...updates };
        allEventsRef.current = [...events];
        syncState();
      }
    };

    // Helper to update last streaming text event
    const updateStreamingText = (text) => {
      const events = allEventsRef.current;
      const lastEvent = events[events.length - 1];

      // Determine if this is reasoning (before tools) or response (after tools)
      const textType = hasHadToolCallsRef.current ? 'streaming_response' : 'streaming_reasoning';

      if (lastEvent && (lastEvent.type === 'streaming_reasoning' || lastEvent.type === 'streaming_response')) {
        events[events.length - 1] = { ...lastEvent, content: text, type: textType };
        allEventsRef.current = [...events];
        syncState();
      } else {
        addEvent({
          type: textType,
          content: text,
          id: `streaming-${Date.now()}`
        });
      }
    };

    // Helper to finalize streaming text to completed text
    const finalizeStreamingText = () => {
      if (currentTextRef.current.trim()) {
        const events = allEventsRef.current;
        const lastEvent = events[events.length - 1];
        if (lastEvent && (lastEvent.type === 'streaming_reasoning' || lastEvent.type === 'streaming_response')) {
          // Convert to finalized type
          const finalType = lastEvent.type === 'streaming_response' ? 'response' : 'reasoning';
          updateEvent(events.length - 1, {
            type: finalType,
            content: currentTextRef.current
          });
        }
        currentTextRef.current = '';
      }
    };

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events from buffer
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const event = JSON.parse(line.slice(6));

            switch (event.type) {
              case 'tool_call_start':
                // Finalize any accumulated text before tool calls (this is reasoning)
                finalizeStreamingText();
                hasHadToolCallsRef.current = true; // Mark that we've had tools
                setActiveTool(event.tool);
                break;

              case 'tool_call':
                // Create combined tool event (call + pending result)
                hasHadToolCallsRef.current = true;
                const toolEventId = event.tool_use_id || `tool-${Date.now()}-${Math.random()}`;
                addEvent({
                  type: 'tool',
                  id: toolEventId,
                  tool: event.tool,
                  args: event.args,
                  status: 'executing',
                  result: null
                });
                allToolCallsRef.current.push({ tool: event.tool, args: event.args });
                break;

              case 'tool_result':
                // Find the matching tool call event and update it with result
                const events = allEventsRef.current;
                let foundIndex = -1;

                // Find the first executing tool with matching name
                for (let i = 0; i < events.length; i++) {
                  if (events[i].type === 'tool' &&
                      events[i].tool === event.tool &&
                      events[i].status === 'executing') {
                    foundIndex = i;
                    break;
                  }
                }

                if (foundIndex >= 0) {
                  updateEvent(foundIndex, {
                    status: 'complete',
                    result: event.result
                  });
                }

                allToolResultsRef.current.push({ tool: event.tool, result: event.result });
                setActiveTool(null);
                break;

              case 'text':
                // Accumulate text and update streaming display
                currentTextRef.current += event.content;
                updateStreamingText(currentTextRef.current);
                break;

              case 'highlight':
                allHighlights.push(event);
                setHighlights(prev => [...prev, event]);
                if (onHighlightCallback && event.layer_id && event.part_id) {
                  onHighlightCallback(event.layer_id, event.part_id);
                }
                break;

              case 'done':
                allHighlights = event.highlights || allHighlights;
                allSvgUpdates = event.svg_updates || [];
                setHighlights(allHighlights);
                if (onHighlightCallback && allHighlights.length > 0) {
                  const first = allHighlights[0];
                  if (first.layer_id && first.part_id) {
                    onHighlightCallback(first.layer_id, first.part_id);
                  }
                }
                finalizeStreamingText();
                break;

              case 'error':
                throw new Error(event.message);

              default:
                break;
            }
          } catch (parseError) {
            if (parseError.message !== 'Unexpected end of JSON input') {
              console.warn('Failed to parse SSE event:', line, parseError);
            }
          }
        }
      }
    }

    // Final sync of events - convert any remaining streaming_text to text
    finalizeStreamingText();
    syncState();

    // Build combined text content for conversation history (API needs simple text)
    const allTextContent = allEventsRef.current
      .filter(e => e.type === 'reasoning' || e.type === 'response')
      .map(e => e.content)
      .join('\n\n');

    return { allTextContent, allSvgUpdates };
  }, [onHighlightCallback]);

  /**
   * Apply SVG updates (fixes) to layer data.
   */
  const applySvgUpdates = useCallback((allSvgUpdates) => {
    if (allSvgUpdates.length > 0 && setLayerData) {

      setLayerData(prevLayers => {

        // Snapshot layers that will be modified (for undo)
        const affectedLayerIds = new Set(allSvgUpdates.map(u => String(u.layer_id)));
        prevLayers.forEach(layer => {
          if (affectedLayerIds.has(String(layer.id)) && !layerSnapshotsRef.current[layer.id]) {
            layerSnapshotsRef.current[layer.id] = {
              segments: JSON.parse(JSON.stringify(layer.segments)),
              frameDisabled: layer.frameDisabled,
              frameMergedSvgPath: layer.frameMergedSvgPath,
            };
          }
        });

        return prevLayers.map(layer => {
          const layerUpdates = allSvgUpdates.filter(u => String(u.layer_id) === String(layer.id));

          if (layerUpdates.length === 0) return layer;

          // Categorize updates by type
          const segmentUpdates = layerUpdates.filter(u => u.type === 'segment_update');
          const boundaryUpdates = layerUpdates.filter(u => u.type === 'boundary_update');
          const addSegmentUpdates = layerUpdates.filter(u => u.type === 'add_segment');
          const newSegmentUpdates = layerUpdates.filter(u =>
            u.type !== 'segment_update' && u.type !== 'boundary_update' && u.type !== 'add_segment'
          );

          // Apply segment replacements (boolean union merges)
          let updatedSegments = layer.segments;
          if (segmentUpdates.length > 0) {
            // Find which segments are being absorbed (merged_into points to the absorber)
            const absorbedNames = {};
            segmentUpdates.forEach(u => {
              if (u.merged_into) {
                const absorbed = updatedSegments.find(s => String(s.id) === String(u.segment_id));
                if (absorbed) {
                  if (!absorbedNames[u.merged_into]) absorbedNames[u.merged_into] = [];
                  absorbedNames[u.merged_into].push(absorbed.name || absorbed.id);
                }
              }
            });

            updatedSegments = updatedSegments.map(seg => {
              const match = segmentUpdates.find(u => String(u.segment_id) === String(seg.id));
              if (match) {
                if (match.svg) {
                  // Rename if this segment absorbed others
                  const absorbed = absorbedNames[String(seg.id)];
                  const newName = absorbed
                    ? `Merged (${seg.name || seg.id} + ${absorbed.join(' + ')})`
                    : seg.name;
                  return {
                    ...seg,
                    name: newName,
                    svg: match.svg,
                    skipTransform: true,
                    skipClip: true,
                  };
                } else {
                  const mergedFromUpdate = match.merged_into
                    ? segmentUpdates.find(u => String(u.segment_id) === String(match.merged_into))
                    : null;
                  const mergedSvg = mergedFromUpdate?.svg || seg.svg || seg._bridgedSvg;
                  return {
                    ...seg,
                    svg: null,
                    _bridgedSvg: mergedSvg,
                    _originalSvg: seg._originalSvg || seg.svg,
                    skipTransform: true,
                    skipClip: true,
                  };
                }
              }
              return seg;
            });
          }

          // Apply boundary updates (frame merged into segment or modified path)
          let layerExtra = {};
          if (boundaryUpdates.length > 0) {
            const lastBoundary = boundaryUpdates[boundaryUpdates.length - 1];
            if (lastBoundary.disabled) {
              layerExtra.frameDisabled = true;
            } else {
              layerExtra.frameMergedSvgPath = lastBoundary.path;
            }
          }

          // Merge bridge results into frame-union segment (if present).
          if (segmentUpdates.length > 0) {
            const frameUnionSeg = updatedSegments.find(
              s => s.id && String(s.id).startsWith('frame-union-')
            );
            if (frameUnionSeg && frameUnionSeg.svg) {
              const frameUnionPathD = extractCombinedPathD(frameUnionSeg.svg);
              if (frameUnionPathD) {
                const bridgePaths = [];
                const bridgeSegIds = new Set();
                segmentUpdates.forEach(u => {
                  if (!u.svg) return;
                  const pathD = extractCombinedPathD(u.svg);
                  if (pathD) {
                    bridgePaths.push(pathD);
                    bridgeSegIds.add(String(u.segment_id));
                  }
                });

                if (bridgePaths.length > 0) {
                  const mergedPathD = unionPolygonPaths(frameUnionPathD, bridgePaths);
                  if (mergedPathD) {
                    updatedSegments = updatedSegments.map(seg => {
                      if (seg.id === frameUnionSeg.id) {
                        return {
                          ...seg,
                          svg: `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg"><path fill="rgb(156,163,175)" fill-rule="evenodd" d="${mergedPathD}"/></svg>`,
                        };
                      }
                      if (bridgeSegIds.has(String(seg.id))) {
                        return {
                          ...seg,
                          svg: null,
                          _bridgedSvg: seg.svg,
                          _originalSvg: seg._originalSvg || seg.svg,
                        };
                      }
                      return seg;
                    });
                  }
                }
              }
            }
          }

          // Add new fix segments (legacy add_bridge/add_tabs)
          if (newSegmentUpdates.length > 0) {
            const baseScaleX = layer?.segments?.[0]?.scaleX ?? 1;
            const baseScaleY = layer?.segments?.[0]?.scaleY ?? 1;

            const newSegments = newSegmentUpdates.map((update, idx) => ({
              id: `fix-${Date.now()}-${idx}`,
              name: `Fix: ${update.type}`,
              svg: update.svg,
              x: 0,
              y: 0,
              scaleX: baseScaleX,
              scaleY: baseScaleY,
              rotation: 0,
              isFrame: false,
              skipClip: true,
              engraveStyle: 'outline',
              originalX: 0,
              originalY: 0,
              originalWidth: 1024,
              originalHeight: 1024,
              crop: { x: 0, y: 0, width: 1024, height: 1024 }
            }));
            updatedSegments = [...updatedSegments, ...newSegments];
          }

          // Add new bridge segments (bridge_only mode)
          if (addSegmentUpdates.length > 0) {
            const newSegs = addSegmentUpdates.map(u => ({
              id: u.segment_id,
              name: 'Bridge',
              svg: u.svg,
              svg_trace: null,
              skipTransform: true,
              skipClip: true,
              isFrame: false,
              engraveStyle: 'outline',
              x: 0,
              y: 0,
              scaleX: (layer.segments?.[0]?.scaleX) || 1,
              scaleY: (layer.segments?.[0]?.scaleY) || 1,
              rotation: 0,
            }));
            updatedSegments = [...updatedSegments, ...newSegs];

            // Re-run union merge so bridge merges with element + frame
            // (eliminates internal cut lines where bridge overlaps)
            // frame-union-* segments are excluded from overlap candidates
            // so bridges won't create giant merged polygons
            const editW = layerData?.canvasSize?.width || 1024;
            const editH = layerData?.canvasSize?.height || 1024;
            const tempLayer = { ...layer, ...layerExtra, segments: updatedSegments };
            const merged = unionOverlappingSegments(tempLayer, editW, editH);
            return merged;
          }

          const updatedLayer = {
            ...layer,
            ...layerExtra,
            segments: updatedSegments
          };
          return updatedLayer;
        });
      });
    }
  }, [setLayerData]);

  /**
   * Common post-stream handler: applies SVG updates, adds model message to history,
   * and parses analysis results if present.
   */
  const finishStream = useCallback(({ allTextContent, allSvgUpdates }) => {
    // Check if there are successful bridge results to preview
    const toolResults = allToolResultsRef.current;
    const bridgeResults = toolResults.filter(
      tr => tr.tool === 'add_bridge' && tr.result?.success
    );

    if (bridgeResults.length > 0 && allSvgUpdates.length > 0) {
      // Hold for preview instead of applying immediately
      const firstBridge = bridgeResults[0];
      // Store bridge-only path for ghost preview (just the bridge rectangle, not the full merged shape)
      const bridgePath = firstBridge.result.bridge_path;
      setPendingFix({
        layerId: firstBridge.result.layer_id,
        partId: firstBridge.result.from_part,
        svgUpdates: allSvgUpdates,
        bridgePath, // SVG path d-attribute for just the bridge polygon
      });
      // Set issue status to 'previewing'
      setAnalysisResults(prev => {
        if (!prev) return prev;
        return prev.map(lr => {
          const updated = { ...lr };
          for (const br of bridgeResults) {
            if (String(br.result.layer_id) === String(lr.layerId)) {
              updated.issues = updated.issues.map(issue => {
                if (issue.partId === br.result.from_part) {
                  return { ...issue, status: 'previewing' };
                }
                return issue;
              });
            }
          }
          return updated;
        });
      });
    } else {
      // No bridge results — apply immediately as before
      applySvgUpdates(allSvgUpdates);
    }

    // Handle set_material results — update per-layer material in fabLayers
    const materialResults = toolResults.filter(
      tr => tr.tool === 'set_material' && tr.result?.success
    );
    if (materialResults.length > 0 && setLayerData) {
      setLayerData(prevLayers => prevLayers.map(layer => {
        const match = materialResults.find(
          tr => String(tr.result.layer_id) === String(layer.id)
        );
        if (!match) return layer;
        const r = match.result;
        return {
          ...layer,
          materialName: r.material_name,
          materialThickness: r.thickness_mm,
          minWidthMm: r.min_width_mm,
          materialAppearance: r.appearance,
        };
      }));

      // Clear stale thin analysis for affected layers (thresholds changed)
      const affectedLayerIds = new Set(materialResults.map(tr => String(tr.result.layer_id)));
      setAnalysisResults(prev => {
        if (!prev) return prev;
        return prev.map(lr => {
          if (!affectedLayerIds.has(String(lr.layerId))) return lr;
          return {
            ...lr,
            issues: lr.issues.filter(issue => issue.type !== 'thin'),
          };
        });
      });
    }

    // Parse analysis results from tool results
    const hasAnalysis = toolResults.some(tr =>
      tr.tool === 'find_floating_parts' || tr.tool === 'analyze_layer_connectivity' || tr.tool === 'analyze_all_layers' || tr.tool === 'detect_thin_areas'
    );
    if (hasAnalysis) {
      const layers = layerData?.layers || [];
      const parsed = parseAnalysisResults(toolResults, layers);
      if (parsed) {
        setAnalysisResults(parsed);
      }
    }

    // Add a simplified message to conversation history (for API context)
    if (allToolCallsRef.current.length > 0 || allTextContent.trim()) {
      setMessages(prev => [...prev, {
        id: Date.now().toString() + '_response',
        role: 'model',
        content: allTextContent.trim(),
        hasStreamedContent: true,
        timestamp: new Date().toISOString()
      }]);
    }
  }, [applySvgUpdates, layerData, parseAnalysisResults, setPendingFix, setLayerData, setAnalysisResults]);

  /**
   * Internal send (used by handleQuickFix to avoid circular dep).
   * We define sendMessage below, so handleQuickFix calls this ref.
   */
  const sendMessageRef = useRef(null);
  const sendMessageInternal = useCallback((text) => {
    if (sendMessageRef.current) {
      sendMessageRef.current(text);
    }
  }, []);

  /**
   * Quick Fix: send a bridge command for a specific floating part.
   */
  const handleQuickFix = useCallback((layerId, partId, partName) => {
    // Extract short display name from partName
    let displayName = partName || partId;
    const nameMatch = displayName.match(/segment-\d+-\d+-\d+-(.+?)(?:-edit|$)/);
    if (nameMatch && nameMatch[1]) {
      displayName = nameMatch[1].replace(/-/g, ' ');
    }
    // Technical message for the agent (includes part_id for tool call)
    const msg = `Add a bridge to fix the floating part "${displayName}" (part_id: ${partId}) on layer ${layerId}, connecting it to the nearest anchor. Do NOT call check_fabrication_ready — the user will confirm the fix first.`;
    // Show concise system-style message in chat (not the verbose technical one)
    setMessages(prev => [...prev, {
      id: Date.now().toString(),
      role: 'system',
      content: `Quick Fix: bridging "${displayName}"`,
      timestamp: new Date().toISOString()
    }]);
    // Update the issue status optimistically
    setAnalysisResults(prev => {
      if (!prev) return prev;
      return prev.map(lr => {
        if (String(lr.layerId) !== String(layerId)) return lr;
        return {
          ...lr,
          issues: lr.issues.map(issue =>
            issue.partId === partId ? { ...issue, status: 'fixing' } : issue
          ),
        };
      });
    });
    // Send through the normal chat flow but skip adding another user bubble
    // (we already added a system message above)
    sendMessageInternalSilent(msg);
  }, [setAnalysisResults, layerData]);

  /**
   * Ignore: mark an issue as acknowledged.
   */
  const handleIgnore = useCallback((layerId, partId) => {
    setAnalysisResults(prev => {
      if (!prev) return prev;
      return prev.map(lr => {
        if (String(lr.layerId) !== String(layerId)) return lr;
        return {
          ...lr,
          issues: lr.issues.map(issue =>
            issue.partId === partId ? { ...issue, status: 'ignored' } : issue
          ),
        };
      });
    });
  }, [setAnalysisResults]);

  /**
   * Unignore: set an ignored issue back to pending (re-expand buttons).
   */
  const handleUnignore = useCallback((layerId, partId) => {
    setAnalysisResults(prev => {
      if (!prev) return prev;
      return prev.map(lr => {
        if (String(lr.layerId) !== String(layerId)) return lr;
        return {
          ...lr,
          issues: lr.issues.map(issue =>
            issue.partId === partId ? { ...issue, status: 'pending' } : issue
          ),
        };
      });
    });
  }, [setAnalysisResults]);

  /**
   * Undo a bridge fix: restore the layer's segments to pre-fix state.
   */
  const handleUndoBridge = useCallback((layerId, partId) => {
    const snapshot = layerSnapshotsRef.current[layerId];
    if (!snapshot) {
      console.warn('[FabAgent] No snapshot found for layer', layerId);
      return;
    }

    // Restore layer segments from snapshot
    if (setLayerData) {
      setLayerData(prevLayers => prevLayers.map(layer => {
        if (String(layer.id) !== String(layerId)) return layer;
        return {
          ...layer,
          segments: JSON.parse(JSON.stringify(snapshot.segments)),
          frameDisabled: snapshot.frameDisabled,
          frameMergedSvgPath: snapshot.frameMergedSvgPath,
        };
      }));
    }

    // Clear snapshot so next fix re-snapshots
    delete layerSnapshotsRef.current[layerId];

    // Reset issue status back to pending
    setAnalysisResults(prev => {
      if (!prev) return prev;
      return prev.map(lr => {
        if (String(lr.layerId) !== String(layerId)) return lr;
        return {
          ...lr,
          issues: lr.issues.map(issue =>
            issue.partId === partId ? { ...issue, status: 'pending' } : issue
          ),
        };
      });
    });
  }, [setLayerData]);

  /**
   * Draw Bridge: activate draw mode in ThreeDView for manual bridge placement.
   */
  const handleDrawBridge = useCallback((layerId, partId) => {
    setDrawBridgeMode({ layerId, partId });
  }, []);

  /**
   * Called when user finishes drawing a bridge line in the 3D view.
   * Sends a bridge request with explicit from/to coordinates.
   */
  const handleBridgeDrawn = useCallback(async (layerId, partId, fromPoint, toPoint) => {
    setDrawBridgeMode(null);

    // Update analysis result status
    setAnalysisResults(prev => {
      if (!prev) return prev;
      return prev.map(lr => {
        if (String(lr.layerId) !== String(layerId)) return lr;
        return {
          ...lr,
          issues: lr.issues.map(issue =>
            issue.partId === partId ? { ...issue, status: 'fixing' } : issue
          ),
        };
      });
    });

    // Find the layer data
    const layer = layerData?.layers?.find(l => String(l.id) === String(layerId));

    setMessages(prev => [...prev, {
      id: Date.now().toString(),
      role: 'system',
      content: `Draw Bridge: placing user-drawn bridge`,
      timestamp: new Date().toISOString()
    }]);

    try {
      // Call direct bridge endpoint (bypasses agent for reliability)
      // Read from layerData (same source as agent)
      const canvasSize = layerData?.canvasSize || {};
      const fab = layerData?.fabrication || {};
      const editingWidth = canvasSize.width || 1024;
      const editingHeight = canvasSize.height || 1024;
      const fabScale = fab.scale || 1.0;
      const boardSizeMm = fab.canvasSizeMm || 304.8;

      const response = await fetch(`${API_BASE_URL}/add-bridge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          layer_data: layer,
          from_part_id: partId,
          to_part_id: 'auto',  // Backend resolves from to_point coordinates
          bridge_width_mm: 3.0,
          from_point: { x: fromPoint.x, y: fromPoint.y },
          to_point: { x: toPoint.x, y: toPoint.y },
          editing_width: editingWidth,
          editing_height: editingHeight,
          fabrication_scale: fabScale,
          board_size_mm: boardSizeMm,
        }),
      });

      if (!response.ok) {
        throw new Error(`API Error: ${response.status}`);
      }

      const result = await response.json();

      if (result.success) {
        // Bridge-only mode: add bridge as a new segment (no existing SVGs modified)
        const bridgeSegId = `bridge-${layerId}-${Date.now()}`;
        const toBoundary = result.to_part === 'boundary';
        const svgUpdates = [{
          type: 'add_segment',
          layer_id: layerId,
          segment_id: bridgeSegId,
          svg: result.bridge_svg,
          skipTransform: true,
          skipClip: true,
          toBoundary,
        }];

        setPendingFix({
          layerId,
          partId,
          svgUpdates,
          bridgePath: result.bridge_path,
          bridgeOnly: true,
        });

        // Set issue status to 'previewing'
        setAnalysisResults(prev => {
          if (!prev) return prev;
          return prev.map(lr => {
            if (String(lr.layerId) !== String(layerId)) return lr;
            return {
              ...lr,
              issues: lr.issues.map(iss =>
                iss.partId === partId ? { ...iss, status: 'previewing' } : iss
              ),
            };
          });
        });

        setMessages(prev => [...prev, {
          id: Date.now().toString() + '_bridge',
          role: 'model',
          content: `Bridge drawn! Preview is shown in the 3D view. Accept or reject the fix.`,
          timestamp: new Date().toISOString()
        }]);
      } else {
        throw new Error(result.error || 'Bridge generation failed');
      }

    } catch (error) {
      console.error('Bridge draw error:', error);
      setMessages(prev => [...prev, {
        id: Date.now().toString() + '_error',
        role: 'system',
        content: `Bridge error: ${error.message}`,
        isError: true,
        timestamp: new Date().toISOString()
      }]);
      // Revert status
      setAnalysisResults(prev => {
        if (!prev) return prev;
        return prev.map(lr => {
          if (String(lr.layerId) !== String(layerId)) return lr;
          return {
            ...lr,
            issues: lr.issues.map(issue =>
              issue.partId === partId ? { ...issue, status: 'pending' } : issue
            ),
          };
        });
      });
    } finally {
      setIsProcessing(false);
      setActiveTool(null);
      currentTextRef.current = '';
      allToolCallsRef.current = [];
      allToolResultsRef.current = [];
      hasHadToolCallsRef.current = false;
    }
  }, [layerData, analysisResults, setAnalysisResults, setPendingFix]);

  /**
   * Send a user message and stream the agent's response.
   */
  const sendMessage = useCallback(async (text) => {
    // Add user message
    const userMsg = {
      id: Date.now().toString(),
      role: 'user',
      content: text,
      timestamp: new Date().toISOString()
    };

    setMessages(prev => [...prev, userMsg]);
    setIsProcessing(true);
    setStreamEvents([]); // Clear previous stream events

    // Reset refs
    currentTextRef.current = '';
    allEventsRef.current = [];
    allToolCallsRef.current = [];
    allToolResultsRef.current = [];
    hasHadToolCallsRef.current = false;

    try {
      // Prepare conversation history for API (simplified - just text content)
      const history = messages.map(m => ({
        role: m.role === 'model' ? 'model' : 'user',
        content: m.content
      }));

      const response = await fetch(`${API_BASE_URL}/fabrication-agent/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          layer_data: layerData,
          conversation_history: history
        }),
      });

      if (!response.ok) {
        throw new Error(`API Error: ${response.status}`);
      }

      const result = await processStream(response);
      finishStream(result);

      // finishStream handles setting 'previewing' status for bridge results

    } catch (error) {
      console.error('Fabrication Agent Error:', error);
      setMessages(prev => [...prev, {
        id: Date.now().toString() + '_error',
        role: 'system',
        content: `Error: ${error.message}`,
        isError: true,
        timestamp: new Date().toISOString()
      }]);
      setStreamEvents([]);
    } finally {
      setIsProcessing(false);
      setActiveTool(null);
      currentTextRef.current = '';
      allToolCallsRef.current = [];
      allToolResultsRef.current = [];
      hasHadToolCallsRef.current = false;
    }
  }, [layerData, messages, processStream, finishStream]);

  /**
   * Send a message to the agent silently (no user bubble in chat).
   * Used by Quick Fix where we show a system message instead.
   */
  const sendMessageSilent = useCallback(async (text) => {
    setIsProcessing(true);
    setStreamEvents([]);

    // Reset refs
    currentTextRef.current = '';
    allEventsRef.current = [];
    allToolCallsRef.current = [];
    allToolResultsRef.current = [];
    hasHadToolCallsRef.current = false;

    try {
      const history = messages.map(m => ({
        role: m.role === 'model' ? 'model' : 'user',
        content: m.content
      }));

      const response = await fetch(`${API_BASE_URL}/fabrication-agent/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          layer_data: layerData,
          conversation_history: history
        }),
      });

      if (!response.ok) {
        throw new Error(`API Error: ${response.status}`);
      }

      const result = await processStream(response);
      finishStream(result);

    } catch (error) {
      console.error('Fabrication Agent Error:', error);
      setMessages(prev => [...prev, {
        id: Date.now().toString() + '_error',
        role: 'system',
        content: `Error: ${error.message}`,
        isError: true,
        timestamp: new Date().toISOString()
      }]);
      setStreamEvents([]);
    } finally {
      setIsProcessing(false);
      setActiveTool(null);
      currentTextRef.current = '';
      allToolCallsRef.current = [];
      allToolResultsRef.current = [];
      hasHadToolCallsRef.current = false;
    }
  }, [layerData, messages, processStream, finishStream]);

  // Keep sendMessageRef in sync
  sendMessageRef.current = sendMessage;

  // Ref for silent sends (Quick Fix)
  const sendMessageSilentRef = useRef(null);
  sendMessageSilentRef.current = sendMessageSilent;
  const sendMessageInternalSilent = useCallback((text) => {
    if (sendMessageSilentRef.current) {
      sendMessageSilentRef.current(text);
    }
  }, []);

  /**
   * Confirm the pending fix — apply SVG updates and mark as fixed.
   */
  const confirmFix = useCallback(() => {
    if (!pendingFix) return;
    applySvgUpdates(pendingFix.svgUpdates);

    // Find if any segment was merged into from_part (part-to-part bridge)
    const mergedSegId = pendingFix.svgUpdates.find(u => u.merged_into)?.segment_id;

    setAnalysisResults(prev => {
      if (!prev) return prev;
      return prev.map(lr => {
        if (String(lr.layerId) !== String(pendingFix.layerId)) return lr;
        return {
          ...lr,
          issues: lr.issues.map(issue => {
            // Mark the bridged part as fixed
            if (issue.partId === pendingFix.partId) {
              return { ...issue, status: 'fixed' };
            }
            // Also mark the merged target part as fixed (part-to-part bridge)
            if (mergedSegId && issue.partId === mergedSegId) {
              return { ...issue, status: 'fixed' };
            }
            return issue;
          }),
        };
      });
    });
    setPendingFix(null);
    // Signal that a re-analysis is needed (picked up by useEffect below)
    needsReanalysisRef.current = true;
  }, [pendingFix, applySvgUpdates, setAnalysisResults, setPendingFix]);

  // Re-analyze after bridge confirm — runs after React updates layerData
  useEffect(() => {
    if (needsReanalysisRef.current && !pendingFix && !isProcessing) {
      needsReanalysisRef.current = false;
      // layerData is now up-to-date (React re-rendered after setFabLayers)
      sendMessageInternalSilent(
        'Re-analyze all layers — a bridge was just applied. Check for remaining floating parts and thin areas.'
      );
    }
  }, [pendingFix, isProcessing, sendMessageInternalSilent]);

  /**
   * Reject the pending fix — discard SVG updates and revert to pending.
   */
  const rejectFix = useCallback(() => {
    if (!pendingFix) return;
    setAnalysisResults(prev => {
      if (!prev) return prev;
      return prev.map(lr => {
        if (String(lr.layerId) !== String(pendingFix.layerId)) return lr;
        return {
          ...lr,
          issues: lr.issues.map(issue =>
            issue.partId === pendingFix.partId ? { ...issue, status: 'pending' } : issue
          ),
        };
      });
    });
    setPendingFix(null);
  }, [pendingFix, setAnalysisResults, setPendingFix]);

  /**
   * Silent auto-analysis — sends a prompt to the agent without showing a user bubble.
   */
  const autoAnalyze = useCallback(async () => {
    const text = 'Analyze all layers for fabrication issues — check for floating parts and thin areas.';

    setIsProcessing(true);
    setStreamEvents([]); // Clear previous stream events

    // Reset refs
    currentTextRef.current = '';
    allEventsRef.current = [];
    allToolCallsRef.current = [];
    allToolResultsRef.current = [];
    hasHadToolCallsRef.current = false;

    try {
      // Send empty history for auto-analyze — forces Gemini to actually call
      // the analysis tool instead of reusing a stale response from a previous
      // conversation turn (e.g., after re-entry with changed layers).
      const response = await fetch(`${API_BASE_URL}/fabrication-agent/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          layer_data: layerData,
          conversation_history: []
        }),
      });

      if (!response.ok) {
        throw new Error(`API Error: ${response.status}`);
      }

      const result = await processStream(response);
      finishStream(result);

    } catch (error) {
      console.error('Fabrication Agent Auto-Analyze Error:', error);
      setMessages(prev => [...prev, {
        id: Date.now().toString() + '_error',
        role: 'system',
        content: `Auto-analysis error: ${error.message}`,
        isError: true,
        timestamp: new Date().toISOString()
      }]);
      setStreamEvents([]);
    } finally {
      setIsProcessing(false);
      setActiveTool(null);
      currentTextRef.current = '';
      allToolCallsRef.current = [];
      allToolResultsRef.current = [];
      hasHadToolCallsRef.current = false;
    }
  }, [layerData, processStream, finishStream]);

  return {
    messages,
    isProcessing,
    activeTool,
    highlights,
    streamEvents,
    sendMessage,
    autoAnalyze,
    // Analysis results & actions
    handleQuickFix,
    handleIgnore,
    handleUnignore,
    handleDrawBridge,
    handleUndoBridge,
    // Draw bridge mode
    drawBridgeMode,
    setDrawBridgeMode,
    handleBridgeDrawn,
    // Fix preview
    confirmFix,
    rejectFix,
  };
};
