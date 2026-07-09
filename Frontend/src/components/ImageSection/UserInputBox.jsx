import React, { useState, useRef, useEffect } from 'react';

const UserInputBox = ({
  onSubmit,
  isLoading,
  showBackButton,
  onBack,
  containerHeight,
}) => {
  const [inputValue, setInputValue] = useState('');
  const textareaRef = useRef(null);

  useEffect(() => {
    adjustTextareaHeight();
  }, [inputValue, containerHeight]);

  const adjustTextareaHeight = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      const maxHeight = containerHeight - 24; // Subtracting padding
      textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (inputValue.trim()) {
      onSubmit(inputValue);
      setInputValue('');
    }
  };

  const handleInputChange = (e) => {
    setInputValue(e.target.value);
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="h-full flex items-center px-4 py-3"
    >
      <div className="flex items-center space-x-3 w-full">
        <div className="flex-grow relative">
          {showBackButton && (
            <button
              type="button"
              onClick={onBack}
              className="absolute left-2 top-1/2 transform -translate-y-1/2 p-1 rounded-md bg-gray-200"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
            </button>
          )}
          <textarea
            ref={textareaRef}
            value={inputValue}
            onChange={handleInputChange}
            placeholder="Create something you want..."
            className="w-full p-3 rounded-md border-2 border-gray-300 focus:outline-none focus:border-blue-500 resize-none overflow-hidden"
            style={{
              paddingLeft: showBackButton ? '40px' : '12px',
              maxHeight: `${containerHeight - 24}px`, // Subtracting padding
            }}
          />
        </div>
        <button
          type="submit"
          className="bg-blue-500 text-white p-2 rounded-md flex items-center justify-center w-11 h-11 flex-shrink-0 hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
          disabled={isLoading}
        >
          {isLoading ? (
            <div className="w-5 h-5 border-2 border-white border-t-blue-500 rounded-full animate-spin"></div>
          ) : (
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 10l7-7m0 0l7 7m-7-7v18"
              />
            </svg>
          )}
        </button>
      </div>
    </form>
  );
};

export default UserInputBox;
