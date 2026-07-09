import React, {
  useEffect,
  useState,
  useMemo,
  useCallback,
  useRef,
} from 'react';
import { Canvas, useThree, useFrame } from '@react-three/fiber';
import { OrbitControls, useTexture, Line, Html } from '@react-three/drei';
import {
  EffectComposer,
  Bloom,
  DepthOfField,
  Vignette,
} from '@react-three/postprocessing';
import * as THREE from 'three';
import CutBoard from './CutBoard';
import { useLayerManager, BOARD_SIZE } from '../LayerManager';

const TARGET_SIZE = 15;
const MAX_ZOOM_OUT = 40;

// Board reference plane showing 12" x 12" cutting area
const BoardReference = ({ visible }) => {
  if (!visible) return null;

  const sceneScale = TARGET_SIZE / 512;
  const boardSizeMm = BOARD_SIZE.width;
  const pixelEquivalent = 1024;
  const mmPerPixel = boardSizeMm / pixelEquivalent;

  const boardSceneSize = (boardSizeMm / mmPerPixel) * sceneScale;
  const halfSize = boardSceneSize / 2;

  const lineOffset = 0.8;
  const arrowSize = 0.3;

  const sizeInches = '12"';
  const sizeMm = '305mm';

  return (
    <group position={[0, -0.6, 0]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[boardSceneSize, boardSceneSize]} />
        <meshStandardMaterial
          color="#e8dcc8"
          transparent
          opacity={0.6}
          side={THREE.DoubleSide}
        />
      </mesh>

      <Line
        points={[
          [-halfSize, 0, -halfSize],
          [halfSize, 0, -halfSize],
          [halfSize, 0, halfSize],
          [-halfSize, 0, halfSize],
          [-halfSize, 0, -halfSize],
        ]}
        color="#666666"
        lineWidth={2}
      />

      <Line
        points={[
          [-halfSize, 0, halfSize + lineOffset],
          [halfSize, 0, halfSize + lineOffset],
        ]}
        color="#999999"
        lineWidth={1}
      />
      <Line
        points={[
          [-halfSize + arrowSize, 0, halfSize + lineOffset - arrowSize * 0.5],
          [-halfSize, 0, halfSize + lineOffset],
          [-halfSize + arrowSize, 0, halfSize + lineOffset + arrowSize * 0.5],
        ]}
        color="#999999"
        lineWidth={1}
      />
      <Line
        points={[
          [halfSize - arrowSize, 0, halfSize + lineOffset - arrowSize * 0.5],
          [halfSize, 0, halfSize + lineOffset],
          [halfSize - arrowSize, 0, halfSize + lineOffset + arrowSize * 0.5],
        ]}
        color="#999999"
        lineWidth={1}
      />
      <Line points={[[-halfSize, 0, halfSize + lineOffset - 0.2], [-halfSize, 0, halfSize + lineOffset + 0.2]]} color="#999999" lineWidth={1} />
      <Line points={[[halfSize, 0, halfSize + lineOffset - 0.2], [halfSize, 0, halfSize + lineOffset + 0.2]]} color="#999999" lineWidth={1} />

      <Html
        position={[0, 0.1, halfSize + lineOffset + 0.5]}
        center
        style={{ pointerEvents: 'none' }}
      >
        <div className="text-xs text-gray-600 bg-white/80 px-1 py-0.5 rounded whitespace-nowrap">
          {sizeInches} ({sizeMm})
        </div>
      </Html>

      <Line
        points={[
          [halfSize + lineOffset, 0, -halfSize],
          [halfSize + lineOffset, 0, halfSize],
        ]}
        color="#999999"
        lineWidth={1}
      />
      <Line
        points={[
          [halfSize + lineOffset - arrowSize * 0.5, 0, -halfSize + arrowSize],
          [halfSize + lineOffset, 0, -halfSize],
          [halfSize + lineOffset + arrowSize * 0.5, 0, -halfSize + arrowSize],
        ]}
        color="#999999"
        lineWidth={1}
      />
      <Line
        points={[
          [halfSize + lineOffset - arrowSize * 0.5, 0, halfSize - arrowSize],
          [halfSize + lineOffset, 0, halfSize],
          [halfSize + lineOffset + arrowSize * 0.5, 0, halfSize - arrowSize],
        ]}
        color="#999999"
        lineWidth={1}
      />
      <Line points={[[halfSize + lineOffset - 0.2, 0, -halfSize], [halfSize + lineOffset + 0.2, 0, -halfSize]]} color="#999999" lineWidth={1} />
      <Line points={[[halfSize + lineOffset - 0.2, 0, halfSize], [halfSize + lineOffset + 0.2, 0, halfSize]]} color="#999999" lineWidth={1} />

      <Html
        position={[halfSize + lineOffset + 0.5, 0.1, 0]}
        center
        style={{ pointerEvents: 'none' }}
      >
        <div className="text-xs text-gray-600 bg-white/80 px-1 py-0.5 rounded whitespace-nowrap">
          {sizeInches}
        </div>
      </Html>
    </group>
  );
};

// Layer size indicator
const LayerSizeIndicator = ({ fabricationScale, frameDimensions, visible }) => {
  if (!visible) return null;

  const frameWidth = frameDimensions?.width || 1024;
  const frameHeight = frameDimensions?.height || 1024;

  const canvasSize = 1024;
  const baseScale = 0.01;
  const sceneWidth = frameWidth * baseScale * fabricationScale;
  const sceneHeight = frameHeight * baseScale * fabricationScale;
  const halfWidth = sceneWidth / 2;
  const halfHeight = sceneHeight / 2;

  const boardSizeMm = BOARD_SIZE.width;
  const boardSceneSize = canvasSize * (TARGET_SIZE / 512);
  const layerSceneSize = canvasSize * baseScale;
  const layerToBoardRatio = layerSceneSize / boardSceneSize;
  const canvasSizeMm = boardSizeMm * layerToBoardRatio;
  const mmPerPixel = canvasSizeMm / canvasSize;

  const widthMm = frameWidth * fabricationScale * mmPerPixel;
  const heightMm = frameHeight * fabricationScale * mmPerPixel;
  const widthIn = widthMm / 25.4;
  const heightIn = heightMm / 25.4;

  const lineOffset = 0.3;
  const arrowSize = 0.15;

  const isSquare = Math.abs(frameWidth - frameHeight) < 10;
  const widthText = `${widthIn.toFixed(1)}" (${widthMm.toFixed(0)}mm)`;
  const heightText = isSquare ? widthText : `${heightIn.toFixed(1)}" (${heightMm.toFixed(0)}mm)`;

  return (
    <group position={[0, 0.1, 0]}>
      <Line
        points={[
          [-halfWidth, 0, halfHeight + lineOffset],
          [halfWidth, 0, halfHeight + lineOffset],
        ]}
        color="#3b82f6"
        lineWidth={1.5}
      />
      <Line
        points={[
          [-halfWidth + arrowSize, 0, halfHeight + lineOffset - arrowSize * 0.5],
          [-halfWidth, 0, halfHeight + lineOffset],
          [-halfWidth + arrowSize, 0, halfHeight + lineOffset + arrowSize * 0.5],
        ]}
        color="#3b82f6"
        lineWidth={1.5}
      />
      <Line
        points={[
          [halfWidth - arrowSize, 0, halfHeight + lineOffset - arrowSize * 0.5],
          [halfWidth, 0, halfHeight + lineOffset],
          [halfWidth - arrowSize, 0, halfHeight + lineOffset + arrowSize * 0.5],
        ]}
        color="#3b82f6"
        lineWidth={1.5}
      />
      <Line points={[[-halfWidth, 0, halfHeight + lineOffset - 0.15], [-halfWidth, 0, halfHeight + lineOffset + 0.15]]} color="#3b82f6" lineWidth={1.5} />
      <Line points={[[halfWidth, 0, halfHeight + lineOffset - 0.15], [halfWidth, 0, halfHeight + lineOffset + 0.15]]} color="#3b82f6" lineWidth={1.5} />

      <Html
        position={[0, 0.1, halfHeight + lineOffset + 0.25]}
        center
        style={{ pointerEvents: 'none' }}
      >
        <div className="text-xs text-blue-600 bg-white/90 px-1.5 py-0.5 rounded shadow-sm whitespace-nowrap font-medium">
          {widthText}
        </div>
      </Html>

      {!isSquare && (
        <>
          <Line
            points={[
              [halfWidth + lineOffset, 0, -halfHeight],
              [halfWidth + lineOffset, 0, halfHeight],
            ]}
            color="#3b82f6"
            lineWidth={1.5}
          />
          <Line
            points={[
              [halfWidth + lineOffset - arrowSize * 0.5, 0, -halfHeight + arrowSize],
              [halfWidth + lineOffset, 0, -halfHeight],
              [halfWidth + lineOffset + arrowSize * 0.5, 0, -halfHeight + arrowSize],
            ]}
            color="#3b82f6"
            lineWidth={1.5}
          />
          <Line
            points={[
              [halfWidth + lineOffset - arrowSize * 0.5, 0, halfHeight - arrowSize],
              [halfWidth + lineOffset, 0, halfHeight],
              [halfWidth + lineOffset + arrowSize * 0.5, 0, halfHeight - arrowSize],
            ]}
            color="#3b82f6"
            lineWidth={1.5}
          />
          <Line points={[[halfWidth + lineOffset - 0.15, 0, -halfHeight], [halfWidth + lineOffset + 0.15, 0, -halfHeight]]} color="#3b82f6" lineWidth={1.5} />
          <Line points={[[halfWidth + lineOffset - 0.15, 0, halfHeight], [halfWidth + lineOffset + 0.15, 0, halfHeight]]} color="#3b82f6" lineWidth={1.5} />

          <Html
            position={[halfWidth + lineOffset + 0.4, 0.1, 0]}
            center
            style={{ pointerEvents: 'none' }}
          >
            <div className="text-xs text-blue-600 bg-white/90 px-1.5 py-0.5 rounded shadow-sm whitespace-nowrap font-medium">
              {heightText}
            </div>
          </Html>
        </>
      )}
    </group>
  );
};

/**
 * Bridge drawing overlay — handles right-click drag to draw bridge lines.
 * Raycasts onto the y=0 plane and converts to SVG coordinates.
 */
const BridgeDrawOverlay = ({ drawBridgeMode, fabricationScale, frameDimensions, onBridgeDrawn, orbitControlsRef }) => {
  const { camera, gl, scene } = useThree();
  const [startPoint, setStartPoint] = useState(null);
  const [endPoint, setEndPoint] = useState(null);
  const isDragging = useRef(false);
  const raycaster = useRef(new THREE.Raycaster());

  const baseScale = 0.01;
  const finalScale = baseScale * fabricationScale;

  // Convert screen coordinates to SVG coordinates via raycasting against board meshes
  const screenToSvg = useCallback((clientX, clientY) => {
    const rect = gl.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );

    raycaster.current.setFromCamera(mouse, camera);

    // First try: raycast against scene meshes (board surfaces)
    const intersects = raycaster.current.intersectObjects(scene.children, true);
    let worldPoint = null;

    if (intersects.length > 0) {
      worldPoint = intersects[0].point;
    } else {
      // Fallback: intersect y=0 plane
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      const intersection = new THREE.Vector3();
      if (!raycaster.current.ray.intersectPlane(plane, intersection)) return null;
      worldPoint = intersection;
    }

    // Convert scene coordinates to SVG coordinates
    const centerX = frameDimensions?.centerX || 512;
    const centerY = frameDimensions?.centerY || 512;

    const svgX = worldPoint.x / finalScale + centerX;
    const svgY = worldPoint.z / finalScale + centerY;

    return { x: svgX, y: svgY, sceneX: worldPoint.x, sceneY: worldPoint.y, sceneZ: worldPoint.z };
  }, [camera, gl, scene, finalScale, frameDimensions]);

  useEffect(() => {
    if (!drawBridgeMode) {
      setStartPoint(null);
      setEndPoint(null);
      isDragging.current = false;
      return;
    }

    const canvas = gl.domElement;

    const handleContextMenu = (e) => {
      e.preventDefault(); // Prevent browser context menu
    };

    const handleMouseDown = (e) => {
      if (e.button !== 2) return; // Right-click only
      e.preventDefault();
      e.stopPropagation();

      const svgPoint = screenToSvg(e.clientX, e.clientY);
      if (!svgPoint) return;

      isDragging.current = true;
      setStartPoint(svgPoint);
      setEndPoint(svgPoint);

      // Disable orbit controls during draw
      if (orbitControlsRef.current) {
        orbitControlsRef.current.enableRotate = false;
        orbitControlsRef.current.enablePan = false;
      }
    };

    const handleMouseMove = (e) => {
      if (!isDragging.current) return;

      const svgPoint = screenToSvg(e.clientX, e.clientY);
      if (svgPoint) {
        setEndPoint(svgPoint);
      }
    };

    const handleMouseUp = (e) => {
      if (e.button !== 2 || !isDragging.current) return;
      isDragging.current = false;

      // Re-enable orbit controls
      if (orbitControlsRef.current) {
        orbitControlsRef.current.enableRotate = true;
      }

      const svgEnd = screenToSvg(e.clientX, e.clientY);
      if (svgEnd && startPoint) {
        // Only fire if the drag was meaningful (not a click)
        const dx = svgEnd.x - startPoint.x;
        const dy = svgEnd.y - startPoint.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist > 5) { // minimum 5 SVG units
          onBridgeDrawn(
            drawBridgeMode.layerId,
            drawBridgeMode.partId,
            { x: startPoint.x, y: startPoint.y },
            { x: svgEnd.x, y: svgEnd.y }
          );
        }
      }

      setStartPoint(null);
      setEndPoint(null);
    };

    canvas.addEventListener('contextmenu', handleContextMenu);
    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);

    return () => {
      canvas.removeEventListener('contextmenu', handleContextMenu);
      canvas.removeEventListener('mousedown', handleMouseDown);
      canvas.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('mouseup', handleMouseUp);

      // Restore orbit controls
      if (orbitControlsRef.current) {
        orbitControlsRef.current.enableRotate = true;
      }
    };
  }, [drawBridgeMode, gl, screenToSvg, onBridgeDrawn, startPoint, orbitControlsRef]);

  // Preview line while dragging
  if (!startPoint || !endPoint || !isDragging.current) return null;

  return (
    <Line
      points={[
        [startPoint.sceneX, (startPoint.sceneY || 0) + 0.01, startPoint.sceneZ],
        [endPoint.sceneX, (endPoint.sceneY || 0) + 0.01, endPoint.sceneZ],
      ]}
      color="#ef4444"
      lineWidth={3}
    />
  );
};

const Scene = React.memo(
  ({
    visibleLayers,
    layerPreviews,
    woodTextureUrl,
    managedLayers,
    onLayerProcessed,
    setCutBoardRef,
    showBoardReference,
    fabricationScale,
    isFabricationMode,
    layerGap,
    frameDimensions,
    highlightedSegment,
    activeLayerId,
    drawBridgeMode,
    onBridgeDrawn,
    orbitControlsRef,
  }) => {
    const { camera, scene } = useThree();
    const woodTexture = useTexture(woodTextureUrl);

    useEffect(() => {
      camera.position.set(0, TARGET_SIZE, TARGET_SIZE);
      camera.lookAt(0, 0, 0);
      scene.background = new THREE.Color('#f0f0f0');
    }, [camera, scene]);

    return (
      <>
        <ambientLight intensity={0.8} />
        <directionalLight
          position={[0, 5, 0]}
          intensity={1.5}
          castShadow
          shadow-mapSize-width={1024}
          shadow-mapSize-height={1024}
          shadow-camera-far={50}
          shadow-camera-left={-10}
          shadow-camera-right={10}
          shadow-camera-top={10}
          shadow-camera-bottom={-10}
        />
        <pointLight position={[0, 5, 0]} intensity={0.8} />
        {visibleLayers.map((layer, index) => {
          // Compute cumulative stack Y from per-layer thicknesses
          // Layers are stacked bottom-up: last layer at Y=0, first layer on top
          const effectiveGap = layerGap != null ? layerGap : 0.3;
          let stackY = 0;
          for (let i = visibleLayers.length - 1; i > index; i--) {
            const t = isFabricationMode ? (visibleLayers[i].materialThickness || 3.0) : 3.0;
            const depth = (t / 3.0) * 0.3; // same formula as CutBoard: (thickness / BASELINE) * DEFAULT_DEPTH
            stackY += depth + effectiveGap;
          }
          return (
            <CutBoard
              key={layer.id}
              ref={(el) => setCutBoardRef(layer.id, el)}
              layerId={layer.id}
              layerPreview={layerPreviews[layer.id]}
              position={[0, 0, 0]}
              woodTexture={woodTexture}
              layerIndex={index}
              totalLayers={visibleLayers.length}
              isVisible={true}
              needsUpdate={managedLayers[layer.id]?.needsUpdate}
              isNew={managedLayers[layer.id]?.isNew}
              onProcessed={() => onLayerProcessed(layer.id)}
              scale={isFabricationMode ? fabricationScale : 1}
              frameCenter={isFabricationMode && frameDimensions ? { x: frameDimensions.centerX, y: frameDimensions.centerY } : null}
              frameDimensions={isFabricationMode && frameDimensions ? frameDimensions : null}
              highlightedSegment={highlightedSegment}
              layer={layer}
              isActive={layer.id === activeLayerId}
              isFabricationMode={isFabricationMode}
              hasActiveLayer={!!activeLayerId}
              layerName={layer.name || `Layer ${index + 1}`}
              layerGap={layerGap}
              stackY={stackY}
            />
          );
        })}

        {/* Board reference plane (fabrication mode only) */}
        {isFabricationMode && (
          <BoardReference visible={showBoardReference} />
        )}

        {/* Layer size indicator (fabrication mode only) */}
        {isFabricationMode && visibleLayers.length > 0 && (
          <LayerSizeIndicator
            fabricationScale={fabricationScale}
            frameDimensions={frameDimensions}
            visible={true}
          />
        )}

        {/* Bridge drawing overlay */}
        {drawBridgeMode && (
          <BridgeDrawOverlay
            drawBridgeMode={drawBridgeMode}
            fabricationScale={fabricationScale}
            frameDimensions={frameDimensions}
            onBridgeDrawn={onBridgeDrawn}
            orbitControlsRef={orbitControlsRef}
          />
        )}

        <mesh
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, -0.5, 0]}
          receiveShadow
        >
          <planeGeometry args={[TARGET_SIZE * 2, TARGET_SIZE * 2]} />
          <shadowMaterial transparent opacity={0.2} />
        </mesh>
      </>
    );
  }
);

const ThreeDView = ({ woodTextureUrl, isFabricationMode = false, highlightedSegment = null, drawBridgeMode = null, onBridgeDrawn = null }) => {
  const {
    layers,
    layerPreviews,
    geometryUpdateQueue,
    simpleUpdateQueue,
    clearGeometryUpdateQueue,
    clearSimpleUpdateQueue,
    showBoardReference,
    fabricationScale,
    fabricationGap,
    frameDimensions,
    activeLayer,
    fabLayers,
    fabLayerPreviews,
  } = useLayerManager();

  // In fabrication mode, use the isolated fab copy when available
  const effectiveLayers = (isFabricationMode && fabLayers) ? fabLayers : layers;
  const effectivePreviews = (isFabricationMode && fabLayerPreviews) ? fabLayerPreviews : layerPreviews;

  const activeLayerId = activeLayer?.id || null;
  const [managedLayers, setManagedLayers] = useState({});
  const cutBoardRefs = useRef({});
  const orbitControlsRef = useRef(null);

  const visibleLayers = useMemo(() => {
    let filtered = effectiveLayers.filter((layer) => layer.isVisible);
    // In draw-bridge mode, only show the target layer
    if (drawBridgeMode) {
      filtered = filtered.filter(
        (layer) => String(layer.id) === String(drawBridgeMode.layerId)
      );
    }
    return filtered;
  }, [effectiveLayers, drawBridgeMode]);

  const setCutBoardRef = useCallback((layerId, ref) => {
    if (ref) {
      cutBoardRefs.current[layerId] = ref;
    }
  }, []);

   useEffect(() => {
     if (geometryUpdateQueue.length > 0) {
       const newManagedLayers = { ...managedLayers };

       geometryUpdateQueue.forEach((layerId) => {
         const layer = effectiveLayers.find((l) => l.id === layerId);
         if (layer && layer.isVisible && effectivePreviews[layerId]?.svg) {
           newManagedLayers[layerId] = {
             ...newManagedLayers[layerId],
             needsUpdate: true,
             isNew: !managedLayers[layerId],
           };
         }
       });

       setManagedLayers(newManagedLayers);
       clearGeometryUpdateQueue();
     }
   }, [
     geometryUpdateQueue,
     clearGeometryUpdateQueue,
     effectiveLayers,
     managedLayers,
     effectivePreviews,
   ]);


  useEffect(() => {
    if (simpleUpdateQueue.length > 0) {
      simpleUpdateQueue.forEach((update) => {
        if (update === 'reorder') {
          Object.values(cutBoardRefs.current).forEach((ref) => {
            ref.updatePosition();
          });
        } else if (update.startsWith('delete-')) {
          const layerId = update.split('-')[1];
          setManagedLayers((prev) => {
            const { [layerId]: _, ...rest } = prev;
            return rest;
          });
        }
      });
      clearSimpleUpdateQueue();
    }
  }, [simpleUpdateQueue, clearSimpleUpdateQueue]);

  const handleLayerProcessed = useCallback((layerId) => {
    setManagedLayers((prev) => ({
      ...prev,
      [layerId]: { ...prev[layerId], needsUpdate: false, isNew: false },
    }));
  }, []);

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        cursor: drawBridgeMode ? 'crosshair' : undefined,
      }}
    >
      <Canvas
        shadows
        camera={{ position: [0, TARGET_SIZE, TARGET_SIZE], fov: 75 }}
        gl={{
          antialias: true,
          toneMapping: THREE.ACESFilmicToneMapping,
          outputColorSpace: THREE.SRGBColorSpace,
          powerPreference: 'high-performance',
        }}
        performance={{ min: 0.5 }}
      >
        <Scene
          visibleLayers={visibleLayers}
          layerPreviews={effectivePreviews}
          woodTextureUrl={woodTextureUrl}
          managedLayers={managedLayers}
          onLayerProcessed={handleLayerProcessed}
          setCutBoardRef={setCutBoardRef}
          showBoardReference={showBoardReference}
          fabricationScale={fabricationScale}
          isFabricationMode={isFabricationMode}
          layerGap={isFabricationMode ? fabricationGap : undefined}
          frameDimensions={frameDimensions}
          highlightedSegment={highlightedSegment}
          activeLayerId={activeLayerId}
          drawBridgeMode={drawBridgeMode}
          onBridgeDrawn={onBridgeDrawn}
          orbitControlsRef={orbitControlsRef}
        />
        <OrbitControls
          ref={orbitControlsRef}
          enablePan={false}
          enableZoom={true}
          enableRotate={true}
          minPolarAngle={isFabricationMode ? 0.05 : 0}
          maxPolarAngle={isFabricationMode ? Math.PI - 0.05 : Math.PI / 2}
          maxDistance={MAX_ZOOM_OUT}
        />
        <EffectComposer>
          <DepthOfField
            focusDistance={0.01}
            focalLength={0.02}
            bokehScale={2}
            height={480}
          />
          <Bloom
            intensity={0.1}
            luminanceThreshold={0.9}
            luminanceSmoothing={0.9}
          />
          <Vignette opacity={0.3} darkness={0.7} eskil={false} />
        </EffectComposer>
      </Canvas>
    </div>
  );
};

export default ThreeDView;
