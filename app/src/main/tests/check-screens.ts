import { app, screen } from 'electron';

async function run() {
  await app.whenReady();
  
  const displays = screen.getAllDisplays();
  console.log(`Displays count: ${displays.length}`);
  
  for (let i = 0; i < displays.length; i++) {
    const display = displays[i];
    console.log(`Display ${i}:`);
    console.log(`  ID: ${display.id}`);
    console.log(`  Scale Factor: ${display.scaleFactor}`);
    console.log(`  Logical Size: ${display.size.width}x${display.size.height}`);
    console.log(`  Bounds: ${display.bounds.x}, ${display.bounds.y}, ${display.bounds.width}, ${display.bounds.height}`);
  }
  
  try {
    const screenshot = require('screenshot-desktop');
    const displaysList = await screenshot.listDisplays();
    console.log(`screenshot-desktop displays:`, displaysList);
    
    for (let i = 0; i < displaysList.length; i++) {
      const imgBuffer = await screenshot({ screen: i, format: 'jpg' });
      console.log(`  Captured Screen ${i} buffer size: ${imgBuffer.length} bytes`);
    }
  } catch (err) {
    console.error('Error capturing screen:', err);
  }
  
  process.exit(0);
}

run();
