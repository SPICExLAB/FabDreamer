/**
 * Canvas and coordinate system constants
 * Used throughout the application for consistent sizing
 */

// Canvas dimensions (in pixels)
export const CANVAS_SIZE = 1024;        // Full canvas size (backend mask size)
export const CANVAS_HALF = 512;         // Half canvas size
export const SEGMENT_SOURCE_SIZE = 512; // Default segment source size

// Comparison thresholds
export const EPSILON = 0.001;           // For floating point comparisons
export const TRANSLATE_THRESHOLD = 0.1; // Minimum translation to apply

// Fabrication physical dimensions
export const BOARD_SIZE_MM = 304.8;     // 12 inches in mm
export const BOARD_SIZE_INCHES = 12;    // Standard board size
export const MATERIAL_THICKNESS_MM = 3.175; // 1/8 inch in mm

// 3D scene scaling
export const BASE_SCALE_3D = 0.01;      // 1024px → 10.24 scene units
