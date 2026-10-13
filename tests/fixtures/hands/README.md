# Hand fixtures for the webcam air wheel tests

* `open-fist.rgba.gz`, `closed-fist.rgba.gz`: cut-out hand sprites (gzip: a JSON header line `{"w","h"}` followed by raw
  RGBA bytes) used by `tests/camwheel-hands-synth.js` to compose synthetic webcam videos of two hands turning an
  imaginary steering wheel. Derived (background removed, cropped, scaled to 200 px wide) from:
  * "Open fist.jpg" by Cedar Tree, https://commons.wikimedia.org/wiki/File:Open_fist.jpg, licensed CC BY-SA 4.0
    (https://creativecommons.org/licenses/by-sa/4.0/)
  * "Closed fist.jpg" by Cedar Tree, https://commons.wikimedia.org/wiki/File:Closed_fist.jpg, licensed CC BY-SA 4.0
  The derived sprites are shared under the same licence (CC BY-SA 4.0).
* `landmarks.json`: real MediaPipe Hand Landmarker output (21 landmarks per hand, normalised camera-frame coordinates)
  for six frames of such a video (640 x 360), with the true wheel angle of each frame. Used by
  `tests/camwheel-hands.test.js` for the landmark -> steering-angle maths.
