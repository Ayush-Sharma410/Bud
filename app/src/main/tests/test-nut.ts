import { mouse, keyboard, Point, Button, Key } from '@nut-tree-fork/nut-js';

async function run() {
  console.log('Testing nut-js mouse movement...');
  try {
    // Check current mouse speed and config
    mouse.config.autoDelayMs = 100;
    
    console.log('Moving mouse to 500, 500...');
    await mouse.setPosition(new Point(500, 500));
    
    console.log('Clicking...');
    await mouse.click(Button.LEFT);
    
    console.log('Typing hello...');
    await keyboard.type('hello');
    
    console.log('Done testing!');
  } catch (err) {
    console.error('Error testing nut-js:', err);
  }
}

run();
