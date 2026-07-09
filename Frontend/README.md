# FabDreamer Frontend (Vite)

This is the new frontend for FabDreamer, migrated from Create React App to Vite.

## Features

- **Vite** - Fast development server with HMR
- **React 18** - Latest React features
- **Three.js + @react-three/fiber** - 3D visualization
- **Konva** - 2D canvas editing
- **TailwindCSS** - Styling

## Key Improvements

### Performance Fixes

1. **CutBoard.js Memory Leak Fix** (`src/components/FinalPreview/CutBoard.jsx`)
   - Added proper geometry disposal on update and unmount
   - Fixes memory leak from undisposed Three.js geometries
   - Material disposal on component unmount

2. **SVGLoader Recreation Fix**
   - Created singleton `svgLoader` instance reused across parses
   - Prevents unnecessary object creation

3. **useFrame Optimization**
   - Added `isAnimating` state to conditionally run animations
   - Stops animation loop when position target is reached
   - Uses `ANIMATION_THRESHOLD` to detect completion

### Configuration

Edit `src/config.js` to switch backends:

```javascript
// API Configuration
export const API_BASE_URL = 'http://localhost:8000';  // Gemini backend (local)


export const USE_REAL_API = true;  // Set to false for mock data
```

## Setup

```bash
cd Frontend
npm install
npm run dev
```

## Development

```bash
# Start dev server (port 3000)
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

## API Proxy

The Vite dev server proxies `/api` requests to the backend:

```javascript
// vite.config.js
proxy: {
  '/api': {
    target: 'http://localhost:8000',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/api/, '')
  }
}
```

## File Structure

```
Frontend/
├── index.html              # Entry HTML (Vite)
├── vite.config.js          # Vite configuration
├── package.json            # Dependencies
├── tailwind.config.js      # TailwindCSS config
├── postcss.config.js       # PostCSS config
├── public/                 # Static assets
└── src/
    ├── main.jsx           # App entry point
    ├── App.jsx            # Router setup
    ├── Demo.jsx           # Main app container
    ├── config.js          # API configuration
    ├── index.css          # Global styles (Tailwind)
    └── components/
        ├── LayerManager.jsx
        ├── EditingSection.jsx
        ├── ImageSection.jsx
        ├── SegmentSection.jsx
        ├── LayerSection.jsx
        ├── FinalPreviewSection.jsx
        ├── Header.jsx
        ├── FinalPreview/
        │   ├── CutBoard.jsx    # ⭐ Fixed memory leak
        │   ├── ThreeDView.jsx
        │   └── FinalPreview.jsx
        ├── LayerSection/
        │   ├── LayerSet.jsx
        │   ├── LayerPreview.jsx
        │   ├── renderLayerToPng.jsx
        │   └── renderLayerToSVG.jsx
        ├── EditingSection/
        │   └── ...
        └── ImageSection/
            └── ...
```

## Migration Notes

- All `.js` files renamed to `.jsx` for Vite
- Imports updated to include `.jsx` extension where needed
- `API_BASE_URL` moved to `config.js`
- Default route redirects `/` to `/demo`

---

*Migrated: December 2025*
