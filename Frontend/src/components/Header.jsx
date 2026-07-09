import React, { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { FaGithub } from 'react-icons/fa';
import { API_BASE_URL } from '../config.js';

const Header = () => {
  const location = useLocation();
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

  const isActive = (path) => {
    if (path === '/' && location.pathname !== '/') return false;
    return location.pathname.startsWith(path);
  };

  return (
    <header className="fixed top-0 left-0 right-0 flex items-center justify-between px-4 py-2 bg-white border-b border-gray-200 z-10">
      <div className="flex items-center gap-2">
        <h1 className="text-xl font-bold">FabDreamer</h1>
        <div
          className={`w-2.5 h-2.5 rounded-full ${isOnline ? 'bg-green-500' : 'bg-red-500'}`}
          title={isOnline ? 'Backend Online' : 'Backend Offline'}
        />
      </div>
      <nav>
        <ul className="flex items-center space-x-4">
          <li>
            <Link to="/" className={`text-gray-600 hover:text-gray-900 ${isActive('/') ? 'border-b-2 border-blue-500' : ''}`}>
              Home
            </Link>
          </li>
          <li>
            <Link to="/demo" className={`text-gray-600 hover:text-gray-900 ${isActive('/demo') ? 'border-b-2 border-blue-500' : ''}`}>
              Demo
            </Link>
          </li>
          <li>
            <Link to="/paper" className={`text-gray-600 hover:text-gray-900 ${isActive('/paper') ? 'border-b-2 border-blue-500' : ''}`}>
              Paper
            </Link>
          </li>
          <li>
            <Link to="/code" className={`text-gray-600 hover:text-gray-900 ${isActive('/code') ? 'border-b-2 border-blue-500' : ''}`}>
              <FaGithub />
            </Link>
          </li>
        </ul>
      </nav>
    </header>
  );
};

export default Header;
