import React, { useState, useEffect } from 'react';
import { API_BASE_URL } from '../config.js';

const StatusSection = () => {
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

  return (
    // <div className="flex items-center space-x-2 p-2 bg-white rounded-lg shadow">
    //   <div
    //     className={`w-3 h-3 rounded-full ${
    //       isOnline ? 'bg-green-500' : 'bg-red-500'
    //     }`}
    //   ></div>
    //   <span>{isOnline ? 'Backend Online' : 'Backend Offline'}</span>
    // </div>
    <div className="flex items-center space-x-2">
      <div
        className={`w-2 h-2 rounded-full ${
          isOnline ? 'bg-green-500' : 'bg-red-500'
        }`}
      ></div>
      <span className="text-sm">
        {isOnline ? 'Backend Online' : 'Backend Offline'}
      </span>
    </div>
  );
};

export default StatusSection;
