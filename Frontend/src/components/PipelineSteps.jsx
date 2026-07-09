import React, { useState, useEffect } from 'react';
import { useLayerManager } from './LayerManager';
import { TbLayersSubtract, TbEdit, TbCut } from 'react-icons/tb';
import { API_BASE_URL } from '../config.js';

/**
 * Top bar with app title, online indicator, and 3-step pipeline flow.
 *
 * Pipeline stages:
 * 1. Decompose (Segmentation) - lights up when chat has content, completed when entering editing mode
 * 2. Create (Creative Editing) - active during editing
 * 3. Prepare (Fabrication) - active during fabrication mode
 */
const PipelineSteps = ({ isEditingMode, hasConversationContent = false, leftColumnWidth = 0, editingWidth = 0 }) => {
  const { uiMode, setUiMode } = useLayerManager();
  const [isOnline, setIsOnline] = useState(false);

  useEffect(() => {
    const checkStatus = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/status`);
        setIsOnline(response.ok);
      } catch (error) {
        setIsOnline(false);
      }
    };

    checkStatus();
    const interval = setInterval(checkStatus, 10000);
    return () => clearInterval(interval);
  }, []);

  // Determine current stage (1, 2, or 3)
  const getCurrentStage = () => {
    if (!isEditingMode) return 1;
    if (uiMode === 'fabrication') return 3;
    return 2;
  };

  const currentStage = getCurrentStage();

  const getStepStyle = (stepNumber) => {
    if (stepNumber === 1 && currentStage === 1 && !hasConversationContent) {
      return {
        opacity: 0.5,
        scale: 0.95,
        bg: 'bg-gray-200',
        text: 'text-gray-400',
        shadow: '',
      };
    }

    if (stepNumber === currentStage) {
      return {
        opacity: 1,
        scale: 1,
        bg: stepNumber === 1 ? 'bg-emerald-500' : stepNumber === 2 ? 'bg-blue-500' : 'bg-indigo-500',
        text: 'text-white',
        shadow: 'shadow-lg',
      };
    } else if (stepNumber < currentStage) {
      const distance = currentStage - stepNumber;
      const opacity = distance === 1 ? 0.7 : 0.5;
      return {
        opacity,
        scale: 0.95,
        bg: stepNumber === 1 ? 'bg-emerald-400' : 'bg-blue-400',
        text: 'text-white',
        shadow: '',
      };
    } else {
      return {
        opacity: 0.35,
        scale: 0.95,
        bg: 'bg-gray-200',
        text: 'text-gray-500',
        shadow: '',
      };
    }
  };

  const steps = [
    { number: 1, label: 'Decompose', icon: TbLayersSubtract, clickable: false },
    { number: 2, label: 'Create', icon: TbEdit, clickable: uiMode === 'fabrication' },
    { number: 3, label: 'Prepare', icon: TbCut, clickable: false },
  ];

  const handleStepClick = (stepNumber) => {
    if (stepNumber === 2 && uiMode === 'fabrication') {
      setUiMode('editing');
    }
  };

  // Title centered over left column, steps centered over editing section
  // Parent has px-4 (16px), columns have gap-4 (16px) between them
  const titleCenterX = 16 + leftColumnWidth / 2;
  const stepsCenterX = 16 + leftColumnWidth + 16 + editingWidth / 2;

  return (
    <div className="w-full h-full relative">
      {/* App title + online indicator — centered over left column, snapped to bottom */}
      <div
        className="absolute bottom-1 -translate-x-1/2 flex items-center gap-2"
        style={{ left: titleCenterX }}
      >
        <h1 className="text-lg font-bold text-gray-800 whitespace-nowrap">FabDreamer</h1>
        <div
          className={`w-2 h-2 rounded-full flex-shrink-0 ${isOnline ? 'bg-green-500' : 'bg-red-500'}`}
          title={isOnline ? 'Backend Online' : 'Backend Offline'}
        />
      </div>

      {/* Pipeline steps — centered over editing section, snapped to bottom */}
      <div
        className="absolute bottom-1 -translate-x-1/2 flex items-center gap-1"
        style={{ left: stepsCenterX }}
      >
        {steps.map((step, index) => {
          const style = getStepStyle(step.number);
          const Icon = step.icon;
          const isClickable = step.clickable && step.number !== currentStage;

          return (
            <React.Fragment key={step.number}>
              {index > 0 && (
                <div
                  className={`w-6 h-0.5 transition-all duration-300 ${
                    step.number <= currentStage ? 'bg-gray-400' : 'bg-gray-200'
                  }`}
                  style={{ opacity: step.number <= currentStage ? 0.8 : 0.4 }}
                />
              )}

              <button
                onClick={() => isClickable && handleStepClick(step.number)}
                disabled={!isClickable}
                className={`
                  flex items-center gap-1.5 px-3 py-1.5 rounded-full font-medium text-sm
                  transition-all duration-300 ease-out
                  ${style.bg} ${style.text} ${style.shadow}
                  ${isClickable ? 'cursor-pointer hover:scale-105' : 'cursor-default'}
                `}
                style={{
                  opacity: style.opacity,
                  transform: `scale(${style.scale})`,
                }}
                title={
                  step.number === 1
                    ? 'Image segmentation (completed)'
                    : step.number === 2
                      ? uiMode === 'fabrication' ? 'Click to return to editing' : 'Creative editing mode'
                      : 'Use "Prepare for Cutting" button to enter fabrication mode'
                }
              >
                <Icon size={16} />
                <span>{step.label}</span>
              </button>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};

export default PipelineSteps;
