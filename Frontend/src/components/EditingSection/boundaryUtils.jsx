import Konva from 'konva';


export const calculateActualBoundaries = async (segment) => {
  if (!segment || !segment.svgUrl) return null;

  const imageNode = new Konva.Image({
    image: segment.image,
    x: segment.x,
    y: segment.y,
    scaleX: segment.scaleX,
    scaleY: segment.scaleY,
    rotation: segment.rotation || 0,
  });

  const canvas = await imageNode.toCanvas();

  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  let minX = canvas.width,
    minY = canvas.height,
    maxX = 0,
    maxY = 0;

  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const alpha = data[(y * canvas.width + x) * 4 + 3];
      if (alpha > 0) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  const clientRect = imageNode.getClientRect();

  const globalMinX = clientRect.x + minX * (clientRect.width / canvas.width);
  const globalMinY = clientRect.y + minY * (clientRect.height / canvas.height);
  const globalMaxX = clientRect.x + maxX * (clientRect.width / canvas.width);
  const globalMaxY = clientRect.y + maxY * (clientRect.height / canvas.height);

  return {
    x: globalMinX,
    y: globalMinY,
    width: globalMaxX - globalMinX,
    height: globalMaxY - globalMinY,
  };
};

export const snapToEdges = (node, boundaries, editingSectionSize) => {
  // This function remains unchanged
  if (!boundaries) return { x: node.x(), y: node.y() };

  let newX = node.x();
  let newY = node.y();

  let shouldSnap = false;

  // Check if boundaries are outside of the editing section
  if (boundaries.x < 0) {
    newX -= boundaries.x;
    shouldSnap = true;
  }
  if (boundaries.y < 0) {
    newY -= boundaries.y;
    shouldSnap = true;
  }
  if (boundaries.x + boundaries.width > editingSectionSize.width) {
    newX -= boundaries.x + boundaries.width - editingSectionSize.width;
    shouldSnap = true;
  }
  if (boundaries.y + boundaries.height > editingSectionSize.height) {
    newY -= boundaries.y + boundaries.height - editingSectionSize.height;
    shouldSnap = true;
  }

  // Return the new position only if snapping is necessary
  return shouldSnap ? { x: newX, y: newY } : null;
};
