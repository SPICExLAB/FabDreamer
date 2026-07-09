import React, { useState, useEffect, useCallback } from 'react';
import ImageControlSection from './ImageSection/ImageControlSection';
import { API_BASE_URL } from '../config.js';

const ImageSection = ({
  className,
  style,
  images,
  currentImageIndex,
  setCurrentImageIndex,
  onImageChange,
  onNewImageLoad,
  processSegmentation,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [controlState, setControlState] = useState('initial');
  const [pendingSegmentation, setPendingSegmentation] = useState(null);

  useEffect(() => {
    if (images.length > 0) {
      setControlState('hidden');
    } else {
      setControlState('initial');
    }
  }, [images]);

  useEffect(() => {
    if (pendingSegmentation !== null) {
      processSegmentation(
        pendingSegmentation.imageData,
        pendingSegmentation.useRealAPI
      );
      setPendingSegmentation(null);
    }
  }, [pendingSegmentation, processSegmentation]);

  const handleAddImage = useCallback(
    async (file) => {
      setIsLoading(true);
      const newImageIndex = images.length;
      try {
        const reader = new FileReader();
        reader.onloadend = async () => {
          const base64Image = reader.result;
          //console.log(base64Image)
          const newImageData = {
            id: images.length,
            raw: base64Image,
            segments: [],
            restImage: null,
          };
          onNewImageLoad(newImageData);
          setCurrentImageIndex(newImageIndex);
          setControlState('hidden');
          setPendingSegmentation({
            imageData: newImageData,
            useRealAPI: false,
          });
        };
        reader.readAsDataURL(file);
      } catch (error) {
        console.error('Error adding image:', error);
      } finally {
        setIsLoading(false);
      }
    },
    [images.length, onNewImageLoad, setCurrentImageIndex]
  );

  const handleGenerateImage = useCallback(
    async (prompt) => {
      setIsLoading(true);
      console.log(`Start GenerateImage: ${prompt}`);
      try {
        const response = await fetch(`${API_BASE_URL}/generate-image`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ prompt: prompt }),
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        console.log('handleGenerateImage: Response received', data);

        // Backend returns image with data:image/... prefix already
        const base64Image = data.image.startsWith('data:')
          ? data.image
          : `data:image/png;base64,${data.image}`;
        const newImageIndex = images.length;

        const newImageData = {
          id: newImageIndex,
          raw: base64Image,
          segments: [],
          restImage: null,
        };
        onNewImageLoad(newImageData);
        setCurrentImageIndex(newImageIndex);
        setControlState('hidden');
        setPendingSegmentation({ imageData: newImageData, useRealAPI: true });
      } catch (error) {
        console.error('Error generating image:', error);
        // Add user notification here if needed
      } finally {
        setIsLoading(false);
      }
    },
    [images.length, onNewImageLoad, setCurrentImageIndex]
  );

  const handleImageSelect = useCallback(
    (index) => {
      setCurrentImageIndex(index);
      onImageChange(index);
    },
    [onImageChange, setCurrentImageIndex]
  );

  const handleDragEnter = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) {
        handleAddImage(file);
      }
    },
    [handleAddImage]
  );

  return (
    <div
      className={`${className} relative overflow-hidden`}
      style={style}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {images.length > 0 && (
        <img
          src={images[currentImageIndex].raw}
          alt={`Generated or uploaded ${currentImageIndex + 1}`}
          className="w-full h-full object-cover"
        />
      )}
      {(controlState === 'input' ||
        controlState === 'initial' ||
        isDragging) && (
        <div className="absolute inset-0 flex items-center justify-center bg-gray-100 bg-opacity-50">
          <div
            className={`text-center p-8 rounded-3xl border-4 border-dashed ${
              isDragging ? 'border-blue-500 bg-blue-100' : 'border-gray-300'
            }`}
          >
            <p className="text-lg mb-2">Drag n drop an image here</p>
            <p>or generate a new one</p>
          </div>
        </div>
      )}
      <ImageControlSection
        images={images}
        onImageSelect={handleImageSelect}
        onAddImage={handleAddImage}
        onGenerateImage={handleGenerateImage}
        isLoading={isLoading}
        controlState={controlState}
        setControlState={setControlState}
      />
      {/* {isSegmenting && (
        <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-50">
          <div className="text-white">Segmenting image...</div>
        </div>
      )} */}
    </div>
  );
};

export default ImageSection;
