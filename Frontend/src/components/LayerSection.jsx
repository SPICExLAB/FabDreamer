import React, { useState } from 'react';
import { FaPlus, FaDownload, FaSpinner } from 'react-icons/fa';
import { TbCut } from 'react-icons/tb';
import LayerSet from './LayerSection/LayerSet';
import { Droppable, Draggable } from '@hello-pangea/dnd';
import { useLayerManager } from './LayerManager';
import { generateXToolSvg } from '../utils/exportXToolSvg';
import { API_BASE_URL } from '../config';

const LayerSection = ({
  className,
  style,

  layers,
  setLayers,
  setActiveLayer,
  activeLayer,
  showAddButton,
  layerPreviews,
  deleteLayer,
  addLayer,
  thumbnailSize = 40, // Default 40px, can be customized
  showExportButton = false, // Only show in preparing mode
  compactMode = false, // Compact mode for preparing: 80% thumbnail, visibility on hover
}) => {
  const { duplicateLayer, setUiMode } = useLayerManager();

  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState(null);

  // Check if ready to go to fabrication mode
  const hasSegments = layers.some((layer) => layer.segments.length > 0);
  const showPrepareButton = !compactMode && !showExportButton && hasSegments;

  const handlePrepareForCutting = () => {
    setUiMode('fabrication');
  };

  const handleToggleVisibility = (layerId) => {
    setLayers(
      layers.map((layer) =>
        layer.id === layerId ? { ...layer, isVisible: !layer.isVisible } : layer
      )
    );
  };

  const handleDeleteLayer = (layerId) => {
    if (layers.length > 1) {
      deleteLayer(layerId);
      if (activeLayer === layerId) {
        setActiveLayer(layers[0]?.id || null);
      }
    }
  };

  const handleAddLayer = () => {
    const newLayer = {
      id: Date.now(),
      name: `Layer ${layers.length + 1}`,
      isVisible: true,
      segments: [],
      frameStrokeWidth: 20,
      isFrameActive: true,
      frameShape: 'squareOutline',
    };
    addLayer(newLayer);
  };

  const handleLayerNameChange = (layerId, newName) => {
    setLayers(
      layers.map((layer) =>
        layer.id === layerId ? { ...layer, name: newName } : layer
      )
    );
  };


  const canExport = layers.some((layer) => layer.segments.length > 0);

  // Export one zip containing both cut-ready SVGs (svg/) and preview PNGs (png/)
  const handleExportAsset = async () => {
    if (!canExport || isExporting) return;
    setIsExporting(true);
    setExportError(null);

    try {
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();
      const canvasWidth = 1024;
      const canvasHeight = 1024;
      const visibleLayers = layers.filter((l) => l.isVisible && l.segments.length > 0);

      for (const layer of visibleLayers) {
        const preview = layerPreviews[layer.id];
        const name = (layer.name || 'layer').replace(/[^a-z0-9]/gi, '_');

        zip.file(`svg/${name}.svg`, generateXToolSvg(layer, preview, canvasWidth, canvasHeight));

        if (preview?.png) {
          const response = await fetch(preview.png);
          const blob = await response.blob();
          zip.file(`png/${name}.png`, blob);
        }
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const url = window.URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      a.download = 'fabdreamer_asset.zip';
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      console.log('Export completed - SVGs and PNGs in fabdreamer_asset.zip');
    } catch (error) {
      console.error('Error exporting asset:', error);
      setExportError('Failed to export asset. Please try again.');
    } finally {
      setIsExporting(false);
    }
  };

  const exportButtons = showExportButton && (
    <button
      className={`w-full flex items-center justify-center py-3 px-3 rounded-lg font-medium transition-colors ${
        canExport
          ? isExporting
            ? 'bg-yellow-500 text-white cursor-wait'
            : 'bg-green-600 text-white hover:bg-green-700'
          : 'bg-gray-300 text-gray-500 cursor-not-allowed'
      }`}
      onClick={handleExportAsset}
      disabled={!canExport || isExporting}
      title="Export all layers as cut-ready SVGs and preview PNGs in one zip"
    >
      {isExporting ? (
        <FaSpinner className="animate-spin mr-2" />
      ) : (
        <FaDownload className="mr-2" />
      )}
      {isExporting ? 'Exporting...' : 'Export Asset'}
    </button>
  );

  return (
    <div className={`${className} ${showExportButton ? 'flex flex-col h-full' : ''}`}>
      {/* Prepare for Cutting button - shows in editing mode when segments exist */}
      {showPrepareButton && (
        <button
          className="w-full flex items-center justify-center py-3 px-4 rounded-lg mb-4 font-medium transition-colors bg-indigo-500 text-white hover:bg-indigo-600"
          onClick={handlePrepareForCutting}
          title="Go to fabrication mode to preview and export for laser cutting"
        >
          <TbCut className="mr-2" size={18} />
          Prepare for Cutting
        </button>
      )}

      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center">
          {showAddButton && (
            <button
              className="mr-2 p-2 border border-black rounded-md hover:bg-gray-100"
              onClick={handleAddLayer}
            >
              <FaPlus />
            </button>
          )}
          <h2 className="text-sm font-semibold">
            {showAddButton ? 'Add Layers' : 'Layer Previews'}
          </h2>
        </div>
      </div>

      {exportError && <div className="text-red-500 mb-4">{exportError}</div>}

      {/* Scrollable layer list */}
      <div className={showExportButton ? 'flex-1 overflow-y-auto min-h-0' : ''}>
        <Droppable droppableId="layers" mode="vertical" type="DEFAULT">
          {(provided) => (
            <div
              {...provided.droppableProps}
              ref={provided.innerRef}
              className="space-y-2"
            >
              {layers.map((layer, index) => (
                <Draggable
                  key={layer.id}
                  draggableId={layer.id.toString()}
                  index={index}
                >
                  {(provided, snapshot) => (
                    <div
                      ref={provided.innerRef}
                      {...provided.draggableProps}
                      {...provided.dragHandleProps}
                      style={{
                        ...provided.draggableProps.style,
                        opacity: snapshot.isDragging ? 0.5 : 1,
                      }}
                    >
                      <LayerSet
                        layer={layer}
                        isActive={layer.id === activeLayer}
                        onToggleVisibility={handleToggleVisibility}
                        onDelete={handleDeleteLayer}
                        onSelect={() => setActiveLayer(layer.id)}
                        onNameChange={handleLayerNameChange}
                        layerPreview={layerPreviews[layer.id]}
                        isOnlyLayer={layers.length === 1}
                        onDuplicate={duplicateLayer}
                        thumbnailSize={thumbnailSize}
                        compactMode={compactMode}
                      />
                    </div>
                  )}
                </Draggable>
              ))}
              {provided.placeholder}
            </div>
          )}
        </Droppable>
      </div>

      {/* Export buttons pinned to bottom */}
      {exportButtons && (
        <div className="flex-shrink-0 pt-4">
          {exportButtons}
        </div>
      )}
    </div>
  );
};

export default LayerSection;
