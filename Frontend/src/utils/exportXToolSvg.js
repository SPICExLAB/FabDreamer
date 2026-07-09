/**
 * Export layer as xTool-compatible SVG
 *
 * xTool P2 interprets SVG elements as:
 * - Strokes → Cut/Score paths (laser follows the line)
 * - Fills → Engrave areas (laser sweeps back and forth)
 *
 * Color conventions:
 * - Red (#FF0000) → Cut
 * - Black (#000000) → Engrave
 *
 * Strategy: Use the already-composed layer preview SVGs as the source of truth.
 * These have all transforms, boolean unions, and frame merges applied.
 * We extract the inner content and restyle for xTool.
 */

import { CANVAS_SIZE } from '../constants/canvas';
import { parseSvgDocument } from './svgDom';

/**
 * Extract defs and restyle drawable content for laser output.
 *
 * Styling is written as ATTRIBUTES on each drawable element (not a <style>
 * block with !important) so the colors survive importers that ignore CSS —
 * Adobe Illustrator and xTool Creative Space both do for pasted/opened SVGs.
 * Elements inside <defs> (clipPaths) are extracted first and left unstyled.
 *
 * @param {string} svgString - Composed layer preview SVG
 * @param {string} strokeColor - '#FF0000' for cut, '#000000' for engrave
 * @returns {{ defs: string, content: string }}
 */
const restyleForLaser = (svgString, strokeColor) => {
  const root = parseSvgDocument(svgString);
  if (!root) return { defs: '', content: '' };

  // Pull <defs> children out (clipPaths etc.) so they aren't restyled
  const defsParts = [];
  root.querySelectorAll('defs').forEach((defs) => {
    Array.from(defs.children).forEach((child) => defsParts.push(child.outerHTML));
    defs.remove();
  });

  // Restyle every drawable element via attributes
  root
    .querySelectorAll('path, rect, ellipse, circle, polygon, polyline, line')
    .forEach((el) => {
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke', strokeColor);
      el.setAttribute('stroke-width', '1');
      el.removeAttribute('style');
      el.removeAttribute('class');
    });

  const content = Array.from(root.childNodes)
    .filter((n) => n.nodeType === 1)
    .map((n) => n.outerHTML)
    .join('\n    ');

  return { defs: defsParts.join('\n    '), content };
};

/**
 * Generate xTool-compatible SVG for a layer.
 *
 * Takes the already-composed preview SVGs (which have correct transforms,
 * boolean unions, frame merges) and re-wraps them with xTool styling.
 * Cut paths (outlines) = red stroke, Engrave paths (traces) = black stroke.
 */
export const generateXToolSvg = (layerData, layerPreview, width, height) => {
  const sourceSize = CANVAS_SIZE;

  const cut = restyleForLaser(layerPreview?.svg, '#FF0000');
  const engrave = restyleForLaser(layerPreview?.svg_trace, '#000000');
  const allDefs = [cut.defs, engrave.defs].filter(Boolean).join('\n    ');

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:xlink="http://www.w3.org/1999/xlink"
     width="${width}"
     height="${height}"
     viewBox="0 0 ${sourceSize} ${sourceSize}">
  <defs>
    ${allDefs}
  </defs>

  <!-- Engrave paths (black stroke) -->
  <g id="engrave">
    ${engrave.content}
  </g>

  <!-- Cut paths (red stroke) -->
  <g id="cut">
    ${cut.content}
  </g>
</svg>`;

  return svg;
};

/**
 * Generate xTool SVG with embedded PNG for raster engraving.
 * Cut outlines from preview SVG + embedded PNG for engrave.
 */
export const generateXToolSvgWithPng = (layerData, layerPreview, width, height) => {
  const sourceSize = CANVAS_SIZE;

  const cut = restyleForLaser(layerPreview?.svg, '#FF0000');

  const embeddedPng = layerPreview?.png ?
    `<image x="0" y="0" width="${sourceSize}" height="${sourceSize}" xlink:href="${layerPreview.png}"/>` : '';

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:xlink="http://www.w3.org/1999/xlink"
     width="${width}"
     height="${height}"
     viewBox="0 0 ${sourceSize} ${sourceSize}">
  <defs>
    ${cut.defs}
  </defs>

  <!-- Raster engrave (embedded PNG) -->
  <g id="engrave">
    ${embeddedPng}
  </g>

  <!-- Cut paths (red stroke) -->
  <g id="cut">
    ${cut.content}
  </g>
</svg>`;

  return svg;
};

/**
 * Download SVG as file
 * @param {string} svgContent - SVG string
 * @param {string} filename - Output filename
 */
export const downloadSvg = (svgContent, filename) => {
  const blob = new Blob([svgContent], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

