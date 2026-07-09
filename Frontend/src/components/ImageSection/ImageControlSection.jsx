import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import UserInputBox from './UserInputBox';

const ImageControlSection = ({
  images,
  onImageSelect,
  onAddImage,
  onGenerateImage,
  isLoading,
  controlState,
  setControlState,
}) => {
  const [containerHeight, setContainerHeight] = useState(100);
  const containerRef = useRef(null);

  useEffect(() => {
    const updateHeight = () => {
      if (containerRef.current) {
        setContainerHeight(containerRef.current.clientHeight);
      }
    };

    updateHeight();
    window.addEventListener('resize', updateHeight);
    return () => window.removeEventListener('resize', updateHeight);
  }, []);

  const variants = {
    initial: { height: 100, y: 0, width: '100%' },
    expanded: { height: 100, y: 0, width: '100%' },
    hidden: { height: 15, width: 100, y: -5 },
  };

  return (
    <div className="absolute bottom-4 left-4 right-4 flex justify-center">
      <motion.div
        ref={containerRef}
        className="bg-white shadow-lg rounded-2xl overflow-hidden"
        initial="initial"
        animate={controlState}
        variants={variants}
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        onMouseEnter={() =>
          controlState === 'hidden' && setControlState('expanded')
        }
        onMouseLeave={() =>
          controlState === 'expanded' && setControlState('hidden')
        }
      >
        <AnimatePresence>
          {(controlState === 'initial' || controlState === 'input') && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="h-full"
            >
              <UserInputBox
                onSubmit={onGenerateImage}
                isLoading={isLoading}
                showBackButton={controlState === 'input'}
                onBack={() => setControlState('expanded')}
                containerHeight={containerHeight}
              />
            </motion.div>
          )}

          {controlState === 'expanded' && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="h-full"
            >
              <div className="flex space-x-2 overflow-x-auto p-3 h-full items-center">
                {images.map((img, index) => (
                  <img
                    key={index}
                    src={img.raw}
                    alt={`Preview ${index + 1}`}
                    className="w-16 h-16 object-cover rounded-lg cursor-pointer"
                    onClick={() => onImageSelect(index)}
                  />
                ))}
                <button
                  onClick={() => setControlState('input')}
                  className="min-w-[64px] h-16 bg-gray-200 rounded-lg flex items-center justify-center text-2xl"
                >
                  +
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
};

export default ImageControlSection;
