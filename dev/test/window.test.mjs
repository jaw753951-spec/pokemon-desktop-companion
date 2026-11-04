/**
 * The window's own size, and the zoom the picture inside it is drawn at.
 *
 * The two have to agree. The renderer draws 480x270 and scales it by whole
 * quarter steps at or above 1:1; a window sized to anything else leaves the
 * picture sitting in a band of window it cannot fill, which is the dark
 * border the companion appeared to be wearing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { snapZoom, VIEW_HEIGHT, VIEW_WIDTH, windowZoom } from '../../app/shared/constants.mjs';

/** `windowSize`, with the screen it reads handed to it rather than looked up. */
function windowSize(scale, screenWidth, screenHeight) {
  const zoom = windowZoom(scale, screenWidth, screenHeight);
  return { width: Math.round(VIEW_WIDTH * zoom), height: Math.round(VIEW_HEIGHT * zoom) };
}

/** What `fitStage` would leave around the picture, in whole pixels. */
function margin(size) {
  const zoom = snapZoom(Math.min(size.width / VIEW_WIDTH, size.height / VIEW_HEIGHT));
  return {
    x: Math.round((size.width - VIEW_WIDTH * zoom) / 2),
    y: Math.round((size.height - VIEW_HEIGHT * zoom) / 2),
  };
}

const SCREENS = [
  [1366, 768],
  [1440, 900],
  [1920, 1080],
  [2560, 1440],
  [3440, 1440],
  [3840, 2160],
];
const STEPS = [0.75, 1, 1.25, 1.5, 2];

test('the picture fills the window at every scale on every screen', () => {
  for (const [screenWidth, screenHeight] of SCREENS) {
    for (const scale of STEPS) {
      const size = windowSize(scale, screenWidth, screenHeight);
      const { x, y } = margin(size);
      assert.equal(x, 0, `${screenWidth}x${screenHeight} at ${scale}: ${x}px down the sides`);
      assert.equal(y, 0, `${screenWidth}x${screenHeight} at ${scale}: ${y}px top and bottom`);
    }
  }
});

test('the zoom snaps to quarters above 1:1 and is left alone below it', () => {
  assert.equal(snapZoom(2), 2);
  assert.equal(snapZoom(1.3333), 1.25);
  assert.equal(snapZoom(1.9999), 1.75);
  assert.equal(snapZoom(1), 1);
  // Below 1:1 a snap would throw away most of a small window.
  assert.equal(snapZoom(0.8875), 0.8875);
  assert.equal(snapZoom(0.5), 0.5);
});

test('every scale setting is a window of its own size', () => {
  for (const [screenWidth, screenHeight] of SCREENS) {
    const widths = STEPS.map((scale) => windowSize(scale, screenWidth, screenHeight).width);
    for (let index = 1; index < widths.length; index++) {
      // A step up is a visibly bigger window, not the same one give or take a
      // few pixels — which is what 1.25x used to be on a 1080p screen.
      assert.ok(
        widths[index] >= widths[index - 1] * 1.1,
        `${screenWidth}x${screenHeight}: ${STEPS[index]}x is ${widths[index]}px after ${widths[index - 1]}px`,
      );
    }
  }
});

test('no scale asks for a window bigger than the screen', () => {
  for (const [screenWidth, screenHeight] of SCREENS) {
    for (const scale of STEPS) {
      const { width, height } = windowSize(scale, screenWidth, screenHeight);
      assert.ok(width <= screenWidth && height <= screenHeight);
    }
  }
});
