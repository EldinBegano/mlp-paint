// renderer.js (Electron renderer process)
let canvas;
let ctx;
let drawing = false;
let currentTool = 'pen';
let currentColor = '#000000';
let currentSize = 3;

let selectedShape = null;

// History for undo/redo
const history = [];
let historyIndex = -1;

// For shapes
let startX, startY;

// Initialize after DOM is loaded
window.onload = function() {
  canvas = document.getElementById('whiteboard');
  ctx = canvas.getContext('2d');

  // Save initial canvas state
  saveState();

  // Tool event listeners
  canvas.addEventListener('mousedown', startDrawing);
  canvas.addEventListener('mouseup', stopDrawing);
  canvas.addEventListener('mouseleave', stopDrawing);
  canvas.addEventListener('mousemove', draw);

  // Initialize button states
  highlightActiveButton();
  
  // Handle window resize
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();
  
  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'z') {
        e.preventDefault();
        undo();
      } else if (e.key === 'y') {
        e.preventDefault();
        redo();
      } else if (e.key === 's') {
        e.preventDefault();
        saveDrawing();
      }
    }
  });
};

// Tool functions
function startDrawing(e) {
  drawing = true;
  const rect = canvas.getBoundingClientRect();
  startX = e.clientX - rect.left;
  startY = e.clientY - rect.top;
  
  ctx.beginPath();
  ctx.moveTo(startX, startY);
  
  // For eraser, we need to set composition mode
  if (currentTool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
  } else {
    ctx.globalCompositeOperation = 'source-over';
  }
}

function stopDrawing(e) {
  if (!drawing) return;
  
  if (isShapeTool(currentTool)) {
    const rect = canvas.getBoundingClientRect();
    const endX = e.clientX - rect.left;
    const endY = e.clientY - rect.top;
    
    ctx.lineWidth = currentSize;
    ctx.strokeStyle = currentColor;
    
    drawShape(currentTool, startX, startY, endX, endY);
  }
  
  drawing = false;
  saveState();
}

function isShapeTool(tool) {
  return ['rectangle', 'circle', 'line', 'triangle'].includes(tool);
}

function drawShape(shape, startX, startY, endX, endY) {
  ctx.beginPath();
  
  switch(shape) {
    case 'rectangle':
      ctx.rect(startX, startY, endX - startX, endY - startY);
      break;
    case 'circle':
      const radius = Math.sqrt(Math.pow(endX - startX, 2) + Math.pow(endY - startY, 2));
      ctx.arc(startX, startY, radius, 0, Math.PI * 2);
      break;
    case 'line':
      ctx.moveTo(startX, startY);
      ctx.lineTo(endX, endY);
      break;
    case 'triangle':
      ctx.moveTo(startX, startY);
      ctx.lineTo(endX, endY);
      ctx.lineTo(startX - (endX - startX), endY);
      ctx.closePath();
      break;
  }
  
  ctx.stroke();
}

function draw(e) {
  if (!drawing) return;
  if (isShapeTool(currentTool)) return;

  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  ctx.lineWidth = currentSize;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  
  if (currentTool === 'eraser') {
    ctx.strokeStyle = '#ffffff'; // Not visible because of composite operation
  } else {
    ctx.strokeStyle = currentColor;
  }

  ctx.lineTo(x, y);
  ctx.stroke();
}

// Tool selection
function selectTool(tool) {
  currentTool = tool;
  highlightActiveButton();
}

function selectColor(color) {
  currentColor = color;
  document.getElementById('custom-color').value = color;
  highlightActiveButton();
}

function setCustomColor() {
  currentColor = document.getElementById('custom-color').value;
  highlightActiveButton();
}

function setBrushSize(size) {
  currentSize = size;
  highlightActiveButton();
}



function selectShape(shape) {
  selectedShape = shape;
  currentTool = shape;
  highlightActiveButton();
}

// UI helper
function highlightActiveButton() {
  // Reset all buttons
  document.querySelectorAll('.btn').forEach(btn => {
    btn.classList.remove('active');
  });
  
  // Highlight active tool
  const toolBtn = document.querySelector(`.tool-btn[data-tool="${currentTool}"]`);
  if (toolBtn) {
    toolBtn.classList.add('active');
  }
  
  // Highlight active color if it's a predefined button
  const colorBtn = document.querySelector(`.color-btn[data-color="${currentColor}"]`);
  if (colorBtn) {
    colorBtn.classList.add('active');
  }
  
  // Highlight active size
  const sizeBtn = document.querySelector(`.size-btn[data-size="${currentSize}"]`);
  if (sizeBtn) {
    sizeBtn.classList.add('active');
  }
  
  // Highlight active shape if any
  if (selectedShape) {
    const shapeBtn = document.querySelector(`.shape-btn[data-shape="${selectedShape}"]`);
    if (shapeBtn) {
      shapeBtn.classList.add('active');
    }
  }
}

// Canvas operations
function clearCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  saveState();
}

function saveState() {
  // Limit history to 20 states to prevent memory issues
  if (historyIndex < history.length - 1) {
    history.splice(historyIndex + 1);
  }
  
  if (history.length >= 20) {
    history.shift();
  } else {
    historyIndex++;
  }
  
  history.push(canvas.toDataURL());
}

function undo() {
  if (historyIndex > 0) {
    historyIndex--;
    loadState();
  }
}

function redo() {
  if (historyIndex < history.length - 1) {
    historyIndex++;
    loadState();
  }
}

function loadState() {
  const img = new Image();
  img.src = history[historyIndex];
  img.onload = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
  };
}

// Save drawing
function saveDrawing() {
  const link = document.createElement('a');
  link.download = 'whiteboard-drawing.png';
  link.href = canvas.toDataURL('image/png');
  link.click();
}

// Resize canvas to fit window while maintaining aspect ratio
function resizeCanvas() {
  const maxWidth = window.innerWidth * 0.9;
  const maxHeight = window.innerHeight * 0.7;
  
  let newWidth = canvas.width;
  let newHeight = canvas.height;
  
  if (canvas.width > maxWidth) {
    newWidth = maxWidth;
    newHeight = (canvas.height / canvas.width) * maxWidth;
  }
  
  if (newHeight > maxHeight) {
    newHeight = maxHeight;
    newWidth = (canvas.width / canvas.height) * maxHeight;
  }
  
  canvas.style.width = `${newWidth}px`;
  canvas.style.height = `${newHeight}px`;
}