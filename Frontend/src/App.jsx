import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Demo from './Demo.jsx';

const App = () => {
  return (
    <Router>
      <main className="h-screen">
        <Routes>
          <Route path="/" element={<Navigate to="/demo" replace />} />
          <Route path="/demo" element={<Demo />} />
        </Routes>
      </main>
    </Router>
  );
};

export default App;
