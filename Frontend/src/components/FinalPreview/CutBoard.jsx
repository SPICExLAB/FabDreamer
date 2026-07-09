import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
  forwardRef,
  useImperativeHandle,
} from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader';
import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils';
import { useLayerManager } from '../LayerManager';
import { getSegmentSvgTransform } from '../../utils/transformUtils';

const DEFAULT_LAYER_DEPTH = 0.3;
const LAYER_GAP = 0.3;
const BASELINE_THICKNESS = 3.0; // mm — depth 0.3 corresponds to 3mm
const ANIMATION_THRESHOLD = 0.001; // Stop animating when difference is small

// Create a single SVGLoader instance to reuse (fixes recreation issue)
const svgLoader = new SVGLoader();

// Point-in-polygon test using ray casting algorithm
const isPointInPolygon = (point, polygon) => {
  let inside = false;
  const x = point.x;
  const y = point.y;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;

    const intersect = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / (yj - yi) + xi);

    if (intersect) inside = !inside;
  }

  return inside;
};

// Simple hash function for SVG content to detect changes
const hashSvg = (svg) => {
  if (!svg) return '';
  let hash = 0;
  for (let i = 0; i < svg.length; i++) {
    const char = svg.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16);
};

const CutBoard = forwardRef(
  (
    {
      layerId,
      layerPreview,
      position,
      woodTexture,
      layerIndex,
      totalLayers,
      isVisible,
      needsUpdate,
      isNew,
      onProcessed,
      scale = 1,  // Fabrication scale factor
      frameCenter = null,  // { x, y } - center point for fabrication mode
      highlightedSegment = null,
      layer = null, // Full layer object containing segments
      isActive = false,
      isFabricationMode = false,
      hasActiveLayer = false,
      layerName = '',
      frameDimensions = null,
      layerGap,
      stackY = null,
    },
    ref
  ) => {
    const [mergedGeometry, setMergedGeometry] = useState(null);
    const [traceGeometry, setTraceGeometry] = useState(null);  // Line geometry for trace edges
    const [highlightGeometry, setHighlightGeometry] = useState(null); // Geometry for highlighted segment
    const previousHighlightGeometryRef = useRef(null);
    const [ghostGeometry, setGhostGeometry] = useState(null); // Geometry for pending fix preview
    const previousGhostGeometryRef = useRef(null);

    // Read pendingFix, analysisResults, and editingSize from context
    const { pendingFix, analysisResults, editingSize } = useLayerManager();
    const [thinHighlightGeometry, setThinHighlightGeometry] = useState(null);
    const previousThinHighlightRef = useRef(null);
    const thinHighlightTimerRef = useRef(null);
    
    // In fabrication mode, center on frame segment if provided
    // Otherwise use canvas center (512, 512)
    // This allows frame segments at any position to become the center of the final cut
    const center = useMemo(() => {
      if (frameCenter) {
        return new THREE.Vector3(frameCenter.x, frameCenter.y, 0);
      }
      return new THREE.Vector3(512, 512, 0);
    }, [frameCenter]);
    const groupRef = useRef();
    const [targetY, setTargetY] = useState(0);
    const [isAnimating, setIsAnimating] = useState(false);

    // Keep track of previous geometry for disposal (fixes memory leak)
    const previousGeometryRef = useRef(null);
    const previousTraceGeometryRef = useRef(null);
    // Track SVG hash + depth to avoid rebuilding geometry for same content
    const svgHashRef = useRef('');
    const traceHashRef = useRef('');
    const depthRef = useRef(DEFAULT_LAYER_DEPTH);

    // Per-layer material appearance from AI (set via set_material tool)
    const appearance = isFabricationMode ? layer?.materialAppearance : null;
    const layerThickness = isFabricationMode ? (layer?.materialThickness || BASELINE_THICKNESS) : BASELINE_THICKNESS;
    const layerDepth = (layerThickness / BASELINE_THICKNESS) * DEFAULT_LAYER_DEPTH;

    // Stable key for memo dependency — avoids object reference issues
    const appearanceKey = appearance
      ? `${appearance.color}|${appearance.roughness}|${appearance.transmission}|${appearance.clearcoat}|${appearance.opacity}|${appearance.metalness}|${appearance.ior}|${appearance.useWoodTexture}`
      : 'default';

    const material = useMemo(() => {
      // Scale up wood texture so grain looks larger / less repetitive
      if (woodTexture) {
        woodTexture.wrapS = THREE.RepeatWrapping;
        woodTexture.wrapT = THREE.RepeatWrapping;
        woodTexture.repeat.set(0.5, 0.5);
      }

      // In fab mode with AI-provided appearance properties
      if (isFabricationMode && appearance) {
        const isTransparent = (appearance.transmission || 0) > 0;
        return new THREE.MeshPhysicalMaterial({
          color: appearance.color || '#d4a76a',
          map: appearance.useWoodTexture ? woodTexture : null,
          side: THREE.DoubleSide,
          roughness: appearance.roughness ?? 0.7,
          metalness: appearance.metalness ?? 0.0,
          clearcoat: appearance.clearcoat ?? 0.0,
          clearcoatRoughness: appearance.clearcoat ? 0.1 : 0.4,
          // Physically-based transparency (glass/acrylic)
          transmission: appearance.transmission ?? 0.0,
          ior: appearance.ior ?? 1.5,
          thickness: isTransparent ? 0.5 : 0, // physical thickness for refraction
          transparent: isTransparent || (appearance.opacity ?? 1.0) < 1.0,
          opacity: appearance.opacity ?? 1.0,
          envMapIntensity: isTransparent ? 0.8 : 0.4,
          reflectivity: appearance.clearcoat ? 0.5 : 0.25,
        });
      }
      // Editing mode: wood texture; Fab mode without material: plain color
      if (!isFabricationMode) {
        return new THREE.MeshPhysicalMaterial({
          map: woodTexture,
          side: THREE.DoubleSide,
          roughness: 0.7,
          metalness: 0.0,
          clearcoat: 0.15,
          clearcoatRoughness: 0.4,
          reflectivity: 0.25,
          envMapIntensity: 0.4,
        });
      }
      // Fab mode, no material selected yet: plain neutral color
      return new THREE.MeshPhysicalMaterial({
        color: '#d4a76a',
        side: THREE.DoubleSide,
        roughness: 0.7,
        metalness: 0.0,
        clearcoat: 0.15,
        clearcoatRoughness: 0.4,
        reflectivity: 0.25,
        envMapIntensity: 0.4,
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [woodTexture, isFabricationMode, appearanceKey]);

    // Line material for trace edges (black lines for engraving)
    const traceMaterial = useMemo(
      () =>
        new THREE.LineBasicMaterial({
          color: 0x000000,  // Black for engrave lines
          linewidth: 2,
          transparent: true, // Allow opacity changes
        }),
      []
    );

    // Update trace material opacity too
    useEffect(() => {
      if (!traceMaterial) return;
      
      if (isFabricationMode && hasActiveLayer) {
        if (isActive) {
          traceMaterial.opacity = 1.0;
        } else {
          traceMaterial.opacity = 0.1;
        }
      } else {
        traceMaterial.opacity = 1.0;
      }
      traceMaterial.needsUpdate = true;
    }, [traceMaterial, isFabricationMode, hasActiveLayer, isActive]);

    // Highlight material (glowing effect)
    const highlightMaterial = useMemo(
      () =>
        new THREE.MeshBasicMaterial({
          color: 0xffaa00, // Amber/Gold
          transparent: true,
          opacity: 0.6,
          side: THREE.DoubleSide,
          depthTest: false, // Always show on top
          depthWrite: false,
        }),
      []
    );

    // Ghost material (blue, translucent) for pending fix preview
    const ghostMaterial = useMemo(
      () =>
        new THREE.MeshBasicMaterial({
          color: 0x3b82f6, // Tailwind blue-500
          transparent: true,
          opacity: 0.5,
          side: THREE.DoubleSide,
          depthTest: false,
          depthWrite: false,
        }),
      []
    );

    // Thin area highlight material (red, translucent)
    const thinHighlightMaterial = useMemo(
      () =>
        new THREE.MeshBasicMaterial({
          color: 0xef4444, // Tailwind red-500
          transparent: true,
          opacity: 0.55,
          side: THREE.DoubleSide,
          depthTest: false,
          depthWrite: false,
        }),
      []
    );

    // Update highlight material opacity (it should always be visible if active, but maybe fade if layer is inactive?
    // Actually highlight implies active layer usually, but just in case)
    useEffect(() => {
        if (!highlightMaterial) return;
        // If the layer itself is inactive (ghosted), the highlight should probably also be ghosted or hidden
        if (isFabricationMode && hasActiveLayer && !isActive) {
            highlightMaterial.opacity = 0.1;
        } else {
            highlightMaterial.opacity = 0.6;
        }
        highlightMaterial.needsUpdate = true;
    }, [highlightMaterial, isFabricationMode, hasActiveLayer, isActive]);

    // Update material opacity based on focus state
    useEffect(() => {
      if (!material) return;

      if (isFabricationMode && hasActiveLayer) {
        if (isActive) {
          // Active layer: Fully opaque
          material.opacity = 1.0;
          material.transparent = false; // Ensure it's solid
        } else {
          // Inactive layers: Ghosted
          material.opacity = 0.1;
          material.transparent = true;
        }
      } else {
        // Default state (Editing mode or no selection): Fully opaque
        material.opacity = 1.0;
        material.transparent = false;
      }
      material.needsUpdate = true;
    }, [material, isFabricationMode, hasActiveLayer, isActive]);

    // Cleanup function to dispose a geometry
    const disposeGeometry = useCallback((geo) => {
      if (geo) {
        geo.dispose();
      }
    }, []);

    // Cleanup on unmount - dispose merged geometry and material
    useEffect(() => {
      return () => {
        // Dispose current geometry
        disposeGeometry(mergedGeometry);
        disposeGeometry(traceGeometry);
        // Dispose any previous geometry
        disposeGeometry(previousGeometryRef.current);
        disposeGeometry(previousTraceGeometryRef.current);
        // Dispose highlight geometry
        disposeGeometry(highlightGeometry);
        disposeGeometry(previousHighlightGeometryRef.current);
        // Dispose ghost geometry
        disposeGeometry(ghostGeometry);
        disposeGeometry(previousGhostGeometryRef.current);
        // Dispose thin highlight geometry
        disposeGeometry(thinHighlightGeometry);
        disposeGeometry(previousThinHighlightRef.current);
        if (thinHighlightTimerRef.current) clearTimeout(thinHighlightTimerRef.current);
        // Dispose material
        if (material) {
          material.dispose();
        }
        if (traceMaterial) {
          traceMaterial.dispose();
        }
        if (highlightMaterial) {
          highlightMaterial.dispose();
        }
        if (ghostMaterial) {
          ghostMaterial.dispose();
        }
        if (thinHighlightMaterial) {
          thinHighlightMaterial.dispose();
        }
      };
    }, []); // Empty deps - only run on unmount

    // Process highlight geometry if a segment is selected
    useEffect(() => {
      // If no highlight or not for this layer, clear geometry
      if (!highlightedSegment || highlightedSegment.layerId !== layerId || !layer) {
        if (highlightGeometry) {
          previousHighlightGeometryRef.current = highlightGeometry;
          setHighlightGeometry(null);
          setTimeout(() => {
            disposeGeometry(previousHighlightGeometryRef.current);
            previousHighlightGeometryRef.current = null;
          }, 0);
        }
        return;
      }

      // Find the segment
      // The segmentId might be a full ID or a partial name
      // Try exact match first, then partial
      const segment = layer.segments.find(s => 
        s.id === highlightedSegment.segmentId || 
        s.name === highlightedSegment.segmentId ||
        (s.id && s.id.includes(highlightedSegment.segmentId))
      );

      // Fall back to _originalSvg for segments whose svg was nullified by frame/segment union
      const segSvg = segment?.svg || segment?._originalSvg;
      if (!segment || !segSvg) {
        console.warn(`[CutBoard] Highlight segment not found or no SVG: ${highlightedSegment.segmentId}`);
        return;
      }

      // Parse the segment's SVG with transforms applied (same as thin highlight)
      try {
        const editW = editingSize?.width || 1024;
        const editH = editingSize?.height || 1024;

        // Extract path tags and wrap with segment transform
        const pathMatch = segSvg.match(/<path[^>]*d="([^"]*)"[^>]*>/g);
        if (!pathMatch) {
          console.warn(`[CutBoard] Highlight segment has no paths: ${highlightedSegment.segmentId}`);
          return;
        }

        const transform = segment.skipTransform ? '' : getSegmentSvgTransform(segment, editW, editH);
        const transformedPaths = pathMatch.map(pathTag =>
          transform ? `<g transform="${transform}">${pathTag}</g>` : pathTag
        );
        const composedSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${transformedPaths.join('')}</svg>`;

        const svgData = svgLoader.parse(composedSvg);
        const geometriesToMerge = [];

        svgData.paths.forEach((path) => {
          const shapes = SVGLoader.createShapes(path);
          shapes.forEach((shape) => {
            // Extrude slightly thicker than the board to make it visible
            const geometry = new THREE.ExtrudeGeometry(shape, {
              depth: layerDepth * 100 + 2, // Extra depth to pop out
              bevelEnabled: false,
            });
            geometriesToMerge.push(geometry);
          });
        });

        if (geometriesToMerge.length > 0) {
          const merged = BufferGeometryUtils.mergeGeometries(geometriesToMerge);
          
          // Apply same UV mapping logic if needed, but for highlight simple color is fine
          
          previousHighlightGeometryRef.current = highlightGeometry;
          setHighlightGeometry(merged);
          
          setTimeout(() => {
            disposeGeometry(previousHighlightGeometryRef.current);
            previousHighlightGeometryRef.current = null;
          }, 0);
          
          // Dispose individual geometries
          geometriesToMerge.forEach(g => g.dispose());
        }
      } catch (error) {
        console.error(`[CutBoard] Error creating highlight geometry:`, error);
      }
    }, [highlightedSegment, layerId, layer, disposeGeometry, editingSize]);

    // Process pendingFix into ghost geometry for bridge preview
    useEffect(() => {
      // Only show ghost on the layer that has the pending fix
      if (pendingFix) {
        console.log(`[CutBoard] Ghost check: pendingFix.layerId=${pendingFix.layerId} layerId=${layerId} match=${String(pendingFix.layerId) === String(layerId)}`);
      }
      if (!pendingFix || String(pendingFix.layerId) !== String(layerId)) {
        if (ghostGeometry) {
          previousGhostGeometryRef.current = ghostGeometry;
          setGhostGeometry(null);
          setTimeout(() => {
            disposeGeometry(previousGhostGeometryRef.current);
            previousGhostGeometryRef.current = null;
          }, 0);
        }
        return;
      }

      // Use bridgePath (just the bridge polygon) for the ghost preview.
      // If not available, fall back to the first segment_update SVG.
      let ghostSvgString;
      if (pendingFix.bridgePath) {
        ghostSvgString = `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><path d="${pendingFix.bridgePath}" fill="rgb(59,130,246)"/></svg>`;
      } else {
        const segmentUpdate = pendingFix.svgUpdates.find(u => u.type === 'segment_update' && u.svg);
        ghostSvgString = segmentUpdate?.svg;
      }

      if (!ghostSvgString) {
        if (ghostGeometry) {
          previousGhostGeometryRef.current = ghostGeometry;
          setGhostGeometry(null);
          setTimeout(() => {
            disposeGeometry(previousGhostGeometryRef.current);
            previousGhostGeometryRef.current = null;
          }, 0);
        }
        return;
      }

      console.log('[CutBoard] Ghost SVG length:', ghostSvgString.length, 'first 200:', ghostSvgString.substring(0, 200));

      try {
        // Strip <defs> before parsing (SVGLoader doesn't support clipPath)
        const svgForParsing = ghostSvgString.replace(/<defs>[\s\S]*?<\/defs>/g, '');
        const svgData = svgLoader.parse(svgForParsing);
        const geometriesToMerge = [];

        svgData.paths.forEach((path) => {
          const { fill, fillOpacity } = path.userData.style;
          // Need a filled shape to extrude — skip empty/black fills
          const hasFill = fill && fill !== 'none' && fill !== 'rgb(0,0,0)' &&
                          (fillOpacity === undefined || fillOpacity > 0);
          if (!hasFill) return;

          const shapes = SVGLoader.createShapes(path);
          shapes.forEach((shape) => {
            const geometry = new THREE.ExtrudeGeometry(shape, {
              depth: 4, // Thin overlay, just enough to be visible
              bevelEnabled: false,
            });
            geometriesToMerge.push(geometry);
          });
        });

        console.log(`[CutBoard] Ghost: ${svgData.paths.length} paths → ${geometriesToMerge.length} geometries`);

        if (geometriesToMerge.length > 0) {
          const merged = BufferGeometryUtils.mergeGeometries(geometriesToMerge);

          previousGhostGeometryRef.current = ghostGeometry;
          setGhostGeometry(merged);

          setTimeout(() => {
            disposeGeometry(previousGhostGeometryRef.current);
            previousGhostGeometryRef.current = null;
          }, 0);

          geometriesToMerge.forEach(g => g.dispose());
        } else {
          console.warn('[CutBoard] Ghost: no valid geometries from SVG');
        }
      } catch (error) {
        console.error('[CutBoard] Error creating ghost geometry:', error);
      }
    }, [pendingFix, layerId, disposeGeometry]);

    // Thin area highlight — flash red on segments with thin issues, auto-fade after 3s
    useEffect(() => {
      if (!analysisResults || !layer) {
        if (thinHighlightGeometry) {
          previousThinHighlightRef.current = thinHighlightGeometry;
          setThinHighlightGeometry(null);
          setTimeout(() => {
            disposeGeometry(previousThinHighlightRef.current);
            previousThinHighlightRef.current = null;
          }, 0);
        }
        return;
      }

      // Find thin issues for this layer
      const layerResult = analysisResults.find(lr => String(lr.layerId) === String(layerId));
      const thinIssues = layerResult?.issues?.filter(i => i.type === 'thin' && i.status === 'pending') || [];

      if (thinIssues.length === 0) {
        if (thinHighlightGeometry) {
          previousThinHighlightRef.current = thinHighlightGeometry;
          setThinHighlightGeometry(null);
          setTimeout(() => {
            disposeGeometry(previousThinHighlightRef.current);
            previousThinHighlightRef.current = null;
          }, 0);
        }
        return;
      }

      // Build a mini composed SVG for affected segments (with transforms applied)
      const thinPartIds = new Set(thinIssues.map(i => i.partId));
      const editW = editingSize?.width || 1024;
      const editH = editingSize?.height || 1024;

      // Collect transformed path strings
      // Fall back to _originalSvg for segments whose svg was nullified by frame/segment union
      const svgPaths = [];
      for (const seg of (layer.segments || [])) {
        const segSvg = seg.svg || seg._originalSvg;
        if (!thinPartIds.has(seg.id) || !segSvg) continue;
        const pathMatch = segSvg.match(/<path[^>]*d="([^"]*)"[^>]*>/g);
        if (!pathMatch) continue;

        const transform = seg.skipTransform ? '' : getSegmentSvgTransform(seg, editW, editH);
        for (const pathTag of pathMatch) {
          svgPaths.push(transform ? `<g transform="${transform}">${pathTag}</g>` : pathTag);
        }
      }

      if (svgPaths.length === 0) {
        if (thinHighlightGeometry) {
          previousThinHighlightRef.current = thinHighlightGeometry;
          setThinHighlightGeometry(null);
          setTimeout(() => {
            disposeGeometry(previousThinHighlightRef.current);
            previousThinHighlightRef.current = null;
          }, 0);
        }
        return;
      }

      const composedSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${svgPaths.join('')}</svg>`;

      const geometriesToMerge = [];
      try {
        const svgData = svgLoader.parse(composedSvg);
        svgData.paths.forEach((path) => {
          const shapes = SVGLoader.createShapes(path);
          shapes.forEach((shape) => {
            const geo = new THREE.ExtrudeGeometry(shape, {
              depth: layerDepth * 100 + 2,
              bevelEnabled: false,
            });
            geometriesToMerge.push(geo);
          });
        });
      } catch (e) {
        // skip unparseable SVG
      }

      if (geometriesToMerge.length > 0) {
        const merged = BufferGeometryUtils.mergeGeometries(geometriesToMerge);
        previousThinHighlightRef.current = thinHighlightGeometry;
        setThinHighlightGeometry(merged);
        setTimeout(() => {
          disposeGeometry(previousThinHighlightRef.current);
          previousThinHighlightRef.current = null;
        }, 0);
        geometriesToMerge.forEach(g => g.dispose());

        // Auto-fade after 8 seconds
        if (thinHighlightTimerRef.current) clearTimeout(thinHighlightTimerRef.current);
        thinHighlightTimerRef.current = setTimeout(() => {
          setThinHighlightGeometry(prev => {
            if (prev) {
              setTimeout(() => disposeGeometry(prev), 0);
            }
            return null;
          });
          thinHighlightTimerRef.current = null;
        }, 8000);
      }

      return () => {
        if (thinHighlightTimerRef.current) {
          clearTimeout(thinHighlightTimerRef.current);
          thinHighlightTimerRef.current = null;
        }
      };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [analysisResults, layerId, layer, disposeGeometry, layerDepth, editingSize]);

    const processGeometries = useCallback(() => {
      if (!layerPreview || !layerPreview.svg) {
        return null;
      }

      // Validate SVG string before parsing
      const svgString = layerPreview.svg;
      if (typeof svgString !== 'string' || !svgString.startsWith('<')) {
        console.warn(`[CutBoard] Invalid SVG for layer ${layerId}: starts with "${svgString?.substring?.(0, 20) || 'undefined'}"`);
        return null;
      }

      // Check SVG hash + depth to avoid rebuilding for same content
      const newHash = hashSvg(svgString);
      const depthChanged = depthRef.current !== layerDepth;
      if (newHash === svgHashRef.current && !depthChanged && mergedGeometry) {
        return null; // No rebuild needed
      }
      svgHashRef.current = newHash;
      depthRef.current = layerDepth;

      // Strip <defs> (clip-path definitions) before parsing — SVGLoader doesn't
      // support clipPath and would render the definition paths as visible geometry.
      const svgForParsing = svgString.replace(/<defs>[\s\S]*?<\/defs>/g, '');

      // Reuse the singleton SVGLoader with error handling
      let svgData;
      try {
        svgData = svgLoader.parse(svgForParsing);
      } catch (error) {
        console.error(`[CutBoard] SVGLoader parse error for layer ${layerId}:`, error);
        console.error(`[CutBoard] SVG preview:`, svgString.substring(0, 200));
        return null;
      }

      const geometriesToMerge = [];

      // Build extrude geometries from a path's rings with PROPER nesting parity:
      // depth 0,2,4… = solid shells; depth 1,3,5… = holes of their immediate
      // parent shell. The old logic treated every ring inside the largest one
      // as a hole, which turned nested solids (e.g. a floating piece inside a
      // frame window) into cutouts — rendering a full board with the piece
      // carved out instead of the piece itself.
      const buildNestedGeometries = (rings) => {
        const items = rings
          .map((shape) => {
            const pts = shape.getPoints();
            let area = 0;
            for (let i = 0; i < pts.length; i++) {
              const j = (i + 1) % pts.length;
              area += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
            }
            return { shape, pts, area: Math.abs(area) / 2 };
          })
          .filter((it) => it.pts.length >= 3 && it.area > 0);

        // Nesting depth = number of larger rings containing this ring
        items.forEach((it) => {
          it.depth = items.filter(
            (o) => o !== it && o.area > it.area && isPointInPolygon(it.pts[0], o.pts)
          ).length;
        });

        const shells = items.filter((it) => it.depth % 2 === 0);
        shells.forEach((s) => { s.shape.holes = []; });

        items
          .filter((it) => it.depth % 2 === 1)
          .forEach((hole) => {
            // Parent = smallest solid shell containing this hole
            const parents = shells
              .filter((o) => o.area > hole.area && isPointInPolygon(hole.pts[0], o.pts))
              .sort((a, b) => a.area - b.area);
            if (parents[0]) {
              parents[0].shape.holes.push(new THREE.Path(hole.pts));
            }
          });

        return shells.map(
          (s) => new THREE.ExtrudeGeometry(s.shape, {
            depth: layerDepth * 100,
            bevelEnabled: false,
          })
        );
      };

      svgData.paths.forEach((path) => {
        const { fill, fillOpacity, stroke, strokeOpacity } =
          path.userData.style;
        if (fill === 'rgb(0,0,0)' || stroke === 'rgb(0,0,0)') return;

        // Check for fill or stroke (treat undefined opacity as 1.0, which is the SVG default)
        const hasFill = fill && (fillOpacity === undefined || fillOpacity > 0);
        const hasStroke = stroke && (strokeOpacity === undefined || strokeOpacity > 0);
        if (hasFill || hasStroke) {
          // Work from raw subPath rings — SVGLoader.createShapes' winding
          // heuristics misassign holes for evenodd multi-subpath paths
          const subPathRings = (path.subPaths || [])
            .filter((sp) => sp.curves && sp.curves.length > 0)
            .map((sp) => {
              const s = new THREE.Shape();
              s.curves = sp.curves.slice();
              s.autoClose = sp.autoClose;
              return s;
            });

          if (subPathRings.length > 1) {
            buildNestedGeometries(subPathRings).forEach((g) => geometriesToMerge.push(g));
          } else {
            // Single subpath — standard shape creation
            SVGLoader.createShapes(path).forEach((shape) => {
              geometriesToMerge.push(new THREE.ExtrudeGeometry(shape, {
                depth: layerDepth * 100,
                bevelEnabled: false,
              }));
            });
          }
        }
      });

      if (geometriesToMerge.length === 0) {
        return null;
      }

      // Merge all geometries into one for single draw call
      const merged = BufferGeometryUtils.mergeGeometries(geometriesToMerge);

      // Generate UV coordinates that map to the full canvas PNG texture
      // SVG coordinates are in viewBox space (0-1024), we need UVs in 0-1 range
      // that correspond to the correct position in the PNG
      if (merged.attributes.position) {
        const positions = merged.attributes.position.array;
        const uvArray = new Float32Array((positions.length / 3) * 2);
        const sourceSize = 1024;  // viewBox size

        for (let i = 0; i < positions.length / 3; i++) {
          const x = positions[i * 3];
          const y = positions[i * 3 + 1];
          // Map position to UV: x/1024, y/1024 (flipped Y for texture)
          uvArray[i * 2] = x / sourceSize;
          uvArray[i * 2 + 1] = 1 - (y / sourceSize);  // Flip Y for texture coords
        }

        merged.setAttribute('uv', new THREE.BufferAttribute(uvArray, 2));
        merged.setAttribute('uv2', new THREE.BufferAttribute(uvArray.slice(), 2));
        // console.log(`[CutBoard] Generated canvas-mapped UVs for layer ${layerId}`);
      }

      // Dispose individual geometries after merge
      geometriesToMerge.forEach((g) => g.dispose());

      // console.log(`[CutBoard] Merged ${geometriesToMerge.length} shapes into 1 geometry for layer ${layerId}`);

      return { geometry: merged };
    }, [layerPreview, layerId, mergedGeometry, layerDepth]);

    // Process trace SVG into line geometry for engrave preview
    // Returns: { geometry, shouldClear } or null (no change needed)
    const processTraceGeometry = useCallback(() => {
      // If no svg_trace, signal to clear any existing geometry
      if (!layerPreview || !layerPreview.svg_trace) {
        if (traceGeometry) {
          return { geometry: null, shouldClear: true };
        }
        return null;
      }

      // Validate trace SVG string before parsing
      const traceSvgString = layerPreview.svg_trace;
      if (typeof traceSvgString !== 'string' || !traceSvgString.startsWith('<')) {
        console.warn(`[CutBoard] Invalid trace SVG for layer ${layerId}: starts with "${traceSvgString?.substring?.(0, 20) || 'undefined'}"`);
        if (traceGeometry) {
          return { geometry: null, shouldClear: true };
        }
        return null;
      }

      // Check hash to avoid rebuilding (include clipBoundary so clipping changes trigger rebuild)
      const newHash = hashSvg(traceSvgString + (layerPreview?.clipBoundary || ''));
      if (newHash === traceHashRef.current && traceGeometry) {
        return null;  // No change
      }

      // Hash changed - update ref and process
      const oldHash = traceHashRef.current;
      traceHashRef.current = newHash;

      // Strip <defs> (clip-path definitions) before parsing — SVGLoader doesn't
      // support clipPath and would render the clip boundary path as visible lines.
      const traceForParsing = traceSvgString.replace(/<defs>[\s\S]*?<\/defs>/g, '');

      let svgData;
      try {
        svgData = svgLoader.parse(traceForParsing);
      } catch (error) {
        console.error(`[CutBoard] SVGLoader trace parse error for layer ${layerId}:`, error);
        console.error(`[CutBoard] Trace SVG preview:`, traceSvgString.substring(0, 200));
        if (traceGeometry) {
          return { geometry: null, shouldClear: true };
        }
        return null;
      }
      const linePoints = [];

      // Parse clip boundary polygon for trace clipping (if provided via layerPreview)
      let clipPolygon = null;
      if (layerPreview?.clipBoundary) {
        clipPolygon = [];
        const clipPath = layerPreview.clipBoundary;
        // Parse absolute M/L path commands into points
        const coords = clipPath.match(/[ML]\s*([\d.e+-]+)[,\s]+([\d.e+-]+)/gi);
        if (coords) {
          coords.forEach((cmd) => {
            const match = cmd.match(/[ML]\s*([\d.e+-]+)[,\s]+([\d.e+-]+)/i);
            if (match) {
              clipPolygon.push({ x: parseFloat(match[1]), y: parseFloat(match[2]) });
            }
          });
        }
        if (clipPolygon.length < 3) clipPolygon = null;
      }

      svgData.paths.forEach((path) => {
        // Process stroke paths (trace lines are stroke-only)
        const subPaths = path.subPaths;
        subPaths.forEach((subPath) => {
          const points = subPath.getPoints();
          for (let i = 0; i < points.length - 1; i++) {
            // If clip polygon exists, only include segments where at least one endpoint is inside
            if (clipPolygon) {
              const p1Inside = isPointInPolygon(points[i], clipPolygon);
              const p2Inside = isPointInPolygon(points[i + 1], clipPolygon);
              if (!p1Inside && !p2Inside) continue; // Both outside — skip
            }
            // Add line segment: start point, end point
            linePoints.push(
              points[i].x, points[i].y, layerDepth * 100 + 1,  // Slightly above surface
              points[i + 1].x, points[i + 1].y, layerDepth * 100 + 1
            );
          }
        });
      });

      // Hash changed but no renderable paths - clear existing geometry
      if (linePoints.length === 0) {
        if (traceGeometry) {
          // console.log(`[CutBoard] No trace paths found after hash change, clearing geometry for layer ${layerId}`);
          return { geometry: null, shouldClear: true };
        }
        return null;
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(linePoints, 3));

      // console.log(`[CutBoard] Created trace geometry with ${linePoints.length / 6} line segments for layer ${layerId}`);
      return { geometry, shouldClear: false };
    }, [layerPreview, layerId, traceGeometry]);

    const updateGeometry = useCallback(() => {
      const result = processGeometries();
      if (result) {
        // Store old geometry for disposal
        previousGeometryRef.current = mergedGeometry;

        // Set new merged geometry
        setMergedGeometry(result.geometry);

        // Dispose old geometry after state update
        setTimeout(() => {
          disposeGeometry(previousGeometryRef.current);
          previousGeometryRef.current = null;
        }, 0);
      } else if (mergedGeometry && (!layerPreview?.svg || layerPreview.svg.length < 50)) {
        // SVG was cleared (all segments deleted) - dispose and set to null
        // console.log(`[CutBoard] Clearing main geometry for layer ${layerId} (svg empty)`);
        previousGeometryRef.current = mergedGeometry;
        setMergedGeometry(null);
        svgHashRef.current = '';
        setTimeout(() => {
          disposeGeometry(previousGeometryRef.current);
          previousGeometryRef.current = null;
        }, 0);
      }

      // Process trace geometry
      const traceResult = processTraceGeometry();
      if (traceResult) {
        if (traceResult.shouldClear) {
          // Clear trace geometry (segment deleted, no svg_trace, or no renderable paths)
          // console.log(`[CutBoard] Clearing trace geometry for layer ${layerId}`);
          previousTraceGeometryRef.current = traceGeometry;
          setTraceGeometry(null);
          traceHashRef.current = '';
          setTimeout(() => {
            disposeGeometry(previousTraceGeometryRef.current);
            previousTraceGeometryRef.current = null;
          }, 0);
        } else if (traceResult.geometry) {
          // Update with new trace geometry
          previousTraceGeometryRef.current = traceGeometry;
          setTraceGeometry(traceResult.geometry);
          setTimeout(() => {
            disposeGeometry(previousTraceGeometryRef.current);
            previousTraceGeometryRef.current = null;
          }, 0);
        }
      }
      // If traceResult is null, no change needed (hash unchanged)

      onProcessed?.();
    }, [processGeometries, processTraceGeometry, onProcessed, mergedGeometry, traceGeometry, disposeGeometry, layerPreview, layerId]);

    useImperativeHandle(ref, () => ({
      updatePosition: () => {
        updateTargetY();
      },
    }));

    const updateTargetY = useCallback(() => {
      // Use parent-computed stackY (accounts for per-layer thickness) if available
      const effectiveGap = layerGap != null ? layerGap : LAYER_GAP;
      let newTargetY = stackY != null
        ? stackY
        : (totalLayers - 1 - layerIndex) * (layerDepth + effectiveGap);

      // Fabrication Mode "Explode/Focus" View
      if (isFabricationMode && hasActiveLayer) {
        if (isActive) {
          // Active layer pops up significantly
          newTargetY += 5;
        } else {
          // Other layers stay down (or move down slightly)
          // We can keep them where they are or compress them
        }
      }

      setTargetY(newTargetY);
      setIsAnimating(true); // Start animation
    }, [totalLayers, layerIndex, layerDepth, layerGap, stackY, isFabricationMode, hasActiveLayer, isActive]);

    useEffect(() => {
      updateTargetY();
    }, [updateTargetY, layerIndex, totalLayers, layerDepth, layerGap, stackY, isFabricationMode, hasActiveLayer, isActive]);

    useEffect(() => {
      if (isNew || needsUpdate || !mergedGeometry) {
        updateGeometry();
      }
    }, [isNew, needsUpdate, updateGeometry, mergedGeometry]);

    // Rebuild geometry when material thickness changes (depth affects extrusion)
    useEffect(() => {
      if (mergedGeometry) {
        updateGeometry();
      }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [layerDepth]);

    // Optimized useFrame - only run when animating (fixes unnecessary frame updates)
    useFrame(() => {
      if (!groupRef.current || !isAnimating) return;

      const diff = targetY - groupRef.current.position.y;

      // Check if animation should stop
      if (Math.abs(diff) < ANIMATION_THRESHOLD) {
        groupRef.current.position.y = targetY;
        setIsAnimating(false);
        return;
      }

      groupRef.current.position.y += diff * 0.1;
    });

    if (!mergedGeometry) return null;

    // Apply fabrication scale to the base scale
    const baseScale = 0.01;
    const finalScale = baseScale * scale;

    return (
      <group
        ref={groupRef}
        position={[position[0], 0, position[2]]}
        rotation={[-Math.PI / 2, 0, 0]}
        scale={[finalScale, -finalScale, finalScale]}
      >
        <mesh
          geometry={mergedGeometry}
          material={material}
          position={[-center.x, -center.y, 0]}
          castShadow
          receiveShadow
        />
        {/* Show trace lines for segments with 'traced' style */}
        {traceGeometry && (
          <lineSegments
            geometry={traceGeometry}
            material={traceMaterial}
            position={[-center.x, -center.y, 0]}
          />
        )}
        {/* Highlight overlay */}
        {highlightGeometry && (
          <mesh
            geometry={highlightGeometry}
            material={highlightMaterial}
            position={[-center.x, -center.y, 0.5]} // Slightly offset Z to avoid z-fighting
          />
        )}
        {/* Ghost bridge preview (pending fix) */}
        {ghostGeometry && (
          <mesh
            geometry={ghostGeometry}
            material={ghostMaterial}
            position={[-center.x, -center.y, layerDepth * 100 + 3]}
          />
        )}
        {/* Thin area highlight (red, temporary) */}
        {thinHighlightGeometry && (
          <mesh
            geometry={thinHighlightGeometry}
            material={thinHighlightMaterial}
            position={[-center.x, -center.y, 0.5]}
          />
        )}
        
        {/* Layer label - shown when layer is active in fabrication mode */}
        {isFabricationMode && isActive && layerName && (
          <Html
            position={[
              0, 
              (frameDimensions ? frameDimensions.height / 2 : 512) + 60, 
              layerDepth * 100 + 20
            ]} // Bottom Center, outside border
            center
            style={{ pointerEvents: 'none' }}
            zIndexRange={[100, 0]}
          >
            <div className="px-3 py-1.5 bg-blue-500 text-white rounded-full shadow-lg text-sm font-medium whitespace-nowrap animate-fadeIn flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />
              {layerName}
            </div>
          </Html>
        )}
      </group>
    );
  }
);

CutBoard.displayName = 'CutBoard';

export default CutBoard;
