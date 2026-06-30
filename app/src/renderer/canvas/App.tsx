import React, { useCallback, useEffect, useState } from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { initCanvasIPC, setExcalidrawAPI } from './ipc';
import HUD from './HUD';
import type { CanvasHUDState } from '../../main/excalidraw/excalidrawTypes';

export default function App() {
  const [hudState, setHudState] = useState<CanvasHUDState>('idle');

  const handleExcalidrawAPI = useCallback((api: ExcalidrawImperativeAPI) => {
    setExcalidrawAPI(api);
  }, []);

  useEffect(() => {
    initCanvasIPC();
    window.budCanvasAPI.onHUDState((payload) => setHudState(payload.state));
  }, []);

  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <HUD state={hudState} />
      <Excalidraw excalidrawAPI={handleExcalidrawAPI} />
    </div>
  );
}
