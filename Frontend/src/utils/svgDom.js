/**
 * SVG DOM Parsing Utilities
 *
 * Robust DOMParser-based extraction of geometry from SVG strings.
 * Replaces regex-based parsing which silently broke on attribute order,
 * multi-path SVGs, and nested structure.
 */

/**
 * Parse an SVG string into a document element.
 * @param {string} svgString - Full SVG document or fragment
 * @returns {Element|null} The <svg> root element, or null on parse failure
 */
export function parseSvgDocument(svgString) {
  if (!svgString || typeof svgString !== 'string') return null;
  try {
    const doc = new DOMParser().parseFromString(svgString, 'image/svg+xml');
    if (doc.querySelector('parsererror')) return null;
    return doc.documentElement;
  } catch (e) {
    return null;
  }
}

/**
 * Extract ALL <path> elements' data from an SVG string.
 * @param {string} svgString
 * @returns {Array<{d: string, fill: string|null, fillRule: string|null, stroke: string|null, outerHTML: string}>}
 */
export function extractPathElements(svgString) {
  const root = parseSvgDocument(svgString);
  if (!root) return [];
  return Array.from(root.querySelectorAll('path'))
    .filter((p) => p.getAttribute('d'))
    .map((p) => ({
      d: p.getAttribute('d'),
      fill: p.getAttribute('fill'),
      fillRule: p.getAttribute('fill-rule'),
      stroke: p.getAttribute('stroke'),
      outerHTML: p.outerHTML,
    }));
}

/**
 * Extract every <path>'s d attribute joined into ONE multi-subpath d string.
 * Use where a single geometry string for the whole SVG is needed
 * (each path's d already starts with M, so concatenation is valid).
 * @param {string} svgString
 * @returns {string|null} Combined d string, or null if no paths
 */
export function extractCombinedPathD(svgString) {
  const paths = extractPathElements(svgString);
  if (paths.length === 0) return null;
  return paths.map((p) => p.d).join(' ');
}

/**
 * Split an SVG string into its <defs> children and remaining content nodes.
 * @param {string} svgString
 * @returns {{ defs: string[], content: string[] }} serialized markup arrays
 */
export function extractSvgInnerNodes(svgString) {
  const root = parseSvgDocument(svgString);
  if (!root) return { defs: [], content: [] };
  const defs = [];
  const content = [];
  Array.from(root.childNodes).forEach((node) => {
    if (node.nodeType !== 1) return; // elements only
    if (node.tagName.toLowerCase() === 'defs') {
      Array.from(node.childNodes).forEach((child) => {
        if (child.nodeType === 1) defs.push(child.outerHTML);
      });
    } else {
      content.push(node.outerHTML);
    }
  });
  return { defs, content };
}
