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
* `open-hand.rgba.gz`, `half-hand.rgba.gz`, `open-hand-2.rgba.gz`: further cut-out hand sprites (open hand, half-closed
  "claw" hand with the fingers curled about 90 degrees at the middle joints, and a second open hand of a different
  person), all palm facing the camera, fingers up, thumb on the image's left. Header `{"w","h","wx","wy","pw"}`: (`wx`, `wy`) = pixel centre of the wrist crease, `pw` = palm
  width across the knuckles in px (scaled to roughly match the fist sprites). Derived (background removed, cropped,
  scaled; `half-hand` also rotated and mirrored horizontally) from:
  * `open-hand`: "Hand female 5.jpg" by Sciencia58, https://commons.wikimedia.org/wiki/File:Hand_female_5.jpg, licensed
    CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/). The derived sprite is shared under the same licence
    (CC BY-SA 4.0).
  * `half-hand`: "Male Right Hand - Kolkata 2011-04-19 2335.JPG" by Biswarup Ganguly,
    https://commons.wikimedia.org/wiki/File:Male_Right_Hand_-_Kolkata_2011-04-19_2335.JPG, licensed CC BY 3.0
    (https://creativecommons.org/licenses/by/3.0/; the file is dual-licensed GFDL / CC BY 3.0, used here under
    CC BY 3.0). Attribution kept as required; the derived sprite is shared under CC BY 3.0.
  * `open-hand-2`: "A hand.jpg" by Khunou S, https://commons.wikimedia.org/wiki/File:A_hand.jpg, released under CC0 1.0
    (https://creativecommons.org/publicdomain/zero/1.0/); attribution given as a courtesy.
