# Sound Mirror

A browser-based webcam instrument using p5.js, OpenCV.js, and Web Audio.

## Run

Serve this directory, for example with `python3 -m http.server 8000`, then open
<http://localhost:8000>. Click **Start camera & sound** and allow camera access.
Use headphones and start with a low device volume. Camera access requires
localhost or HTTPS. Internet access is needed to load p5.js and OpenCV.js.

Choose **Camera → Front / Rear** before starting or switch while running. The
front view is mirrored; the rear view is not. If the requested camera is
unavailable, a live switch attempts to restore the previous camera. Desktop
webcams generally do not offer a rear-facing camera.

## Initial algorithm

- Analyze webcam frames at 320 × 240, up to 20 times per second.
- Grayscale, blur, and threshold the image; identify 8-connected bright regions.
- Ignore regions smaller than the minimum pixel count; play the largest regions
  up to **Max blobs** (1–256, default 32). The slider updates live. High limits
  may reduce processing speed, especially on mobile devices.
- Measure hue from the original, unblurred pixels within each region. Ignore
  pixels below 12% saturation and circular-average the remaining hues, weighted
  by saturation; white highlights no longer wash out colorful pixels. Map hue
  logarithmically from 55 to 880 Hz. Regions with too little usable color
  (average saturation contribution below 1%) or conflicting hues with no clear
  direction use 220 Hz, as do gray and white regions. This range is one octave
  lower than the original mapping for a softer sound.
- Set each sine oscillator's amplitude to the region's original mean grayscale
  intensity divided by 255: the intensity integral divided by region size.
  Gently reduce higher notes by 3 dB per octave above 220 Hz (half amplitude
  at 880 Hz); lower notes keep their original level. On-screen percentages
  still show measured brightness, before this softening.
  Area does not otherwise affect volume. Master gain and a compressor keep the
  combined signal controlled.
- Match nearby blobs across frames; smooth pitch and amplitude changes and fade
  lost voices. Touching regions merge; splits and large movements may create new
  voices. Hidden tabs silence their voices.

Each new voice has a fixed ADSR envelope: 100 ms attack, 250 ms decay, then
70% sustain while its blob stays visible. Brightness and high-note softening
control volume independently of the envelope. Brief detection gaps retain the
voice for up to 200 ms without retriggering; after that it releases over 600 ms.
Disappearing during attack or decay releases smoothly from the current level.
Reappearing after release begins creates a new note. Reverb can extend the tail.

The front-camera preview is mirrored. Green outlines and labels show each selected region's
tracking ID, target frequency, and normalized intensity. Controls adjust the
brightness threshold and minimum blob size. **Mute** leaves the visual analysis
running.

Toggle **Reverb** to add a room-like decay (off by default). **Reverb amount**
sets the added wet level from 0–100% (default 30%), leaving the direct sound
unchanged. **Room size** sets decay length from 0.2–5 seconds (default 2 seconds),
not a physical room measurement. Changes apply when the slider is released,
crossfading between room responses. Both sliders can be set before starting.
The effect fades in and out smoothly, and **Mute** silences both the direct
sound and the reverb tail. Longer rooms use more audio processing and memory.

## Inspecting blob detection

Use **Preview → Threshold** to see exactly which pixels pass the blurred
brightness threshold (white) and which do not (black). **Show detected blob
masks** shades the pixels of the selected, audible blobs in translucent green;
dark holes remain unshaded. The outlines and masks use the same analyzed frame
as the webcam preview, including the selected camera's orientation.

The diagnostics report the percentage of bright pixels and how many selected
blobs touch the image edge. A connected bright background can legitimately
produce an outline spanning the frame. Raise the threshold to separate bright
objects from that background. Minimum size filters blobs but does not split
connected regions.
