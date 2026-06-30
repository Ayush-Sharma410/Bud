import React, { useCallback, useEffect } from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { initCanvasIPC, setExcalidrawAPI } from './ipc';

export default function App() {
  const handleExcalidrawAPI = useCallback((api: ExcalidrawImperativeAPI) => {
    setExcalidrawAPI(api);
  }, []);

  useEffect(() => {
    initCanvasIPC();
  }, []);

  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <Excalidraw excalidrawAPI={handleExcalidrawAPI} />
    </div>
  );
}
