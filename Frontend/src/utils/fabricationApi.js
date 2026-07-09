/**
 * Fabrication API Utilities
 * Stage 3: Backend API calls for design validation and export
 *
 * These endpoints connect to the backend fabrication pipeline that:
 * 1. Validates designs for laser cutting constraints
 * 2. Generates fabrication-ready export files (SVG, DXF)
 * 3. Provides AI-powered suggestions for design improvements
 */

import { API_BASE_URL } from '../config';

/**
 * Validate design for fabrication constraints
 * Checks for thin areas, floating islands, small gaps, sharp corners, etc.
 *
 * @param {Object} fabricationData - Output from exportForFabrication()
 * @param {Object} constraints - Fabrication constraints
 * @param {number} constraints.minWidth - Minimum feature width in mm (default: 2.0)
 * @param {number} constraints.minGap - Minimum gap between features in mm (default: 1.5)
 * @param {number} constraints.kerf - Laser kerf width in mm (default: 0.2)
 * @returns {Promise<Object>} Validation result with issues array
 */
export async function validateDesign(fabricationData, constraints = {}) {
  const defaultConstraints = {
    minWidth: 2.0,
    minGap: 1.5,
    kerf: 0.2,
    ...constraints,
  };

  const response = await fetch(`${API_BASE_URL}/analyze-fabrication`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      layers: fabricationData.layers,
      layerSvgs: fabricationData.layerSvgs,
      material: {
        type: fabricationData.fabrication.material,
        thickness: fabricationData.fabrication.materialThickness,
      },
      constraints: defaultConstraints,
      canvasSize: fabricationData.canvasSize,
    }),
  });

  if (!response.ok) {
    throw new Error(`Validation failed: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Export design to specified format
 * Generates fabrication-ready files with proper smoothing and optimization
 *
 * @param {Object} fabricationData - Output from exportForFabrication()
 * @param {string} format - Export format: 'svg', 'dxf', or 'pdf'
 * @param {Object} options - Export options
 * @param {string} options.smoothingLevel - Edge smoothing: 'none', 'low', 'medium', 'high'
 * @param {boolean} options.includeRegistration - Include registration marks
 * @param {number} options.scale - Scale factor (1.0 = actual size)
 * @param {string} options.units - Output units: 'mm' or 'inches'
 * @returns {Promise<Object>} Export result with file URL
 */
export async function exportDesign(fabricationData, format = 'svg', options = {}) {
  const defaultOptions = {
    smoothingLevel: 'medium',
    includeRegistration: true,
    scale: fabricationData.fabrication.scale || 1.0,
    units: 'mm',
    ...options,
  };

  const response = await fetch(`${API_BASE_URL}/export-design`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      layers: fabricationData.layers,
      layerSvgs: fabricationData.layerSvgs,
      format,
      options: defaultOptions,
      canvasSize: fabricationData.canvasSize,
      material: {
        type: fabricationData.fabrication.material,
        thickness: fabricationData.fabrication.materialThickness,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Export failed: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Apply auto-fix for a fabrication issue
 * Backend generates modified SVG paths to resolve the issue
 *
 * @param {Object} fabricationData - Output from exportForFabrication()
 * @param {Object} issue - Issue object from validateDesign response
 * @returns {Promise<Object>} Fixed segment data with updated SVG
 */
export async function applyAutoFix(fabricationData, issue) {
  const response = await fetch(`${API_BASE_URL}/apply-fix`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      issue,
      layerData: fabricationData.layers.find((l) => l.id === issue.layerId),
      layerSvg: fabricationData.layerSvgs[issue.layerId],
    }),
  });

  if (!response.ok) {
    throw new Error(`Auto-fix failed: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Issue types returned by validation
 */
export const ISSUE_TYPES = {
  THIN_AREA: 'thin_area',
  FLOATING_ISLAND: 'floating_island',
  SMALL_GAP: 'small_gap',
  SHARP_CORNER: 'sharp_corner',
  OVERLAPPING_PATHS: 'overlapping_paths',
  OPEN_PATH: 'open_path',
};

/**
 * Issue severity levels
 */
export const SEVERITY = {
  ERROR: 'error', // Cannot proceed with fabrication
  WARNING: 'warning', // Proceed with caution
  INFO: 'info', // Informational only
};

/**
 * Default fabrication constraints by material type
 */
export const MATERIAL_CONSTRAINTS = {
  plywood: {
    minWidth: 2.0, // mm - minimum feature width
    minGap: 1.5, // mm - minimum gap between cuts
    kerf: 0.2, // mm - laser kerf width
    maxDetailSize: 0.5, // mm - minimum engrave detail
  },
  acrylic: {
    minWidth: 1.5, // mm - acrylic can be thinner
    minGap: 1.0, // mm
    kerf: 0.15, // mm - cleaner cut on acrylic
    maxDetailSize: 0.3, // mm
  },
  mdf: {
    minWidth: 2.5, // mm - MDF needs wider features
    minGap: 2.0, // mm
    kerf: 0.25, // mm
    maxDetailSize: 0.5, // mm
  },
};
