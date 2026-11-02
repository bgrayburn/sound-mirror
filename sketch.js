const ANALYSIS_WIDTH = 320;
const ANALYSIS_HEIGHT = 240;
const FALLBACK_FREQUENCY = 220;
const VOICE_ENVELOPE = { attack: 0.1, decay: 0.25, sustain: 0.7, release: 0.6 };

function envelopeLevel(startedAt, now) {
  const elapsed = Math.max(0, now - startedAt);
  const { attack, decay, sustain } = VOICE_ENVELOPE;
  if (elapsed < attack) return elapsed / attack;
  if (elapsed < attack + decay) return 1 - (1 - sustain) * (elapsed - attack) / decay;
  return sustain;
}

function startEnvelope(parameter, now) {
  const { attack, decay, sustain } = VOICE_ENVELOPE;
  parameter.setValueAtTime(0, now);
  parameter.linearRampToValueAtTime(1, now + attack);
  parameter.linearRampToValueAtTime(sustain, now + attack + decay);
}

function releaseEnvelope(parameter, startedAt, now) {
  // Calculate the held value explicitly for browsers without cancelAndHoldAtTime.
  const level = envelopeLevel(startedAt, now);
  parameter.cancelScheduledValues(now);
  parameter.setValueAtTime(level, now);
  const end = now + VOICE_ENVELOPE.release;
  parameter.linearRampToValueAtTime(0, end);
  return end;
}

// OpenCV's script and its WebAssembly runtime finish loading separately.
async function loadOpenCV() {
  const ready = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js";
    script.onerror = () => reject(new Error("Could not download OpenCV."));
    script.onload = () => {
      try {
        const library = window.cv;
        // This build is a self-resolving thenable: awaiting it directly loops.
        // Always wrap the initialized module rather than resolving with it.
        if (library?.Mat) resolve({ library });
        else library.then((initialized) => resolve({ library: initialized }), reject);
      } catch (error) {
        reject(error);
      }
    };
    document.head.appendChild(script);
  });
  return await Promise.race([
    ready,
    new Promise((_, reject) => setTimeout(() => reject(new Error("OpenCV loading timed out. Reload to retry.")), 60000)),
  ]);
}

function blobToFrequency(pixels, labels, label) {
  let x = 0;
  let y = 0;
  let weight = 0;
  let count = 0;
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] !== label) continue;
    count++;
    const red = pixels[i * 4] / 255;
    const green = pixels[i * 4 + 1] / 255;
    const blue = pixels[i * 4 + 2] / 255;
    const high = Math.max(red, green, blue);
    const low = Math.min(red, green, blue);
    const delta = high - low;
    const saturation = high === 0 ? 0 : delta / high;
    if (saturation < 0.12) continue;
    let hue;
    if (high === red) hue = ((green - blue) / delta + 6) % 6;
    else if (high === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
    const angle = hue * Math.PI / 3;
    x += Math.cos(angle) * saturation;
    y += Math.sin(angle) * saturation;
    weight += saturation;
  }
  // Require some usable color and a coherent hue, rather than amplifying noise.
  if (!count || weight / count < 0.01 || Math.hypot(x, y) < weight * 0.1) return FALLBACK_FREQUENCY;
  const hue = ((Math.atan2(y, x) / (2 * Math.PI)) + 1) % 1;
  return 55 * Math.pow(880 / 55, hue);
}

function softenedAmplitude(magnitude, frequency) {
  // Leave lower notes alone; taper higher notes by 3 dB per octave above A3.
  return magnitude * Math.min(1, Math.sqrt(220 / frequency));
}

function createReverbImpulse(audio, seconds) {
  const impulse = audio.createBuffer(2, Math.ceil(audio.sampleRate * seconds), audio.sampleRate);
  for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
    const samples = impulse.getChannelData(channel);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / samples.length, 3);
    }
  }
  return impulse;
}

new p5((p) => {
  let cv;
  let capture;
  let stream;
  let mats;
  let audio;
  let master;
  let mix;
  let reverbGain;
  let reverbEnabled = false;
  const reverbPaths = new Set();
  let muted = false;
  let running = false;
  let failed = false;
  let activeFacing = "user";
  let mirrored = true;
  let maxBlobs = 32;
  let tracks = [];
  let nextTrackId = 1;
  let lastFrame = -1;
  let lastAnalysis = 0;
  const voices = new Set();
  const frame = document.createElement("canvas");
  frame.width = ANALYSIS_WIDTH;
  frame.height = ANALYSIS_HEIGHT;
  const frameContext = frame.getContext("2d", { willReadFrequently: true });
  const thresholdPreview = document.createElement("canvas");
  const maskPreview = document.createElement("canvas");
  for (const canvas of [thresholdPreview, maskPreview]) {
    canvas.width = ANALYSIS_WIDTH;
    canvas.height = ANALYSIS_HEIGHT;
  }
  const thresholdContext = thresholdPreview.getContext("2d");
  const maskContext = maskPreview.getContext("2d");
  const thresholdPixels = thresholdContext.createImageData(ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
  const maskPixels = maskContext.createImageData(ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
  const ui = {};

  p.setup = () => {
    p.createCanvas(p.windowWidth, p.windowHeight);
    p.pixelDensity(1);
    const toggleControls = document.getElementById("toggle-controls");
    const controlBody = document.getElementById("control-body");
    toggleControls.addEventListener("click", () => {
      const collapsed = !controlBody.hidden;
      controlBody.hidden = collapsed;
      document.getElementById("controls").classList.toggle("collapsed", collapsed);
      toggleControls.setAttribute("aria-expanded", String(!collapsed));
      toggleControls.textContent = collapsed ? "Show controls" : "Hide controls";
    });
    for (const id of ["start", "mute", "reverb", "reverb-amount", "room-size", "status", "camera", "camera-error", "threshold", "min-size", "max-blobs", "preview", "show-masks", "diagnostics"]) {
      ui[id] = document.getElementById(id);
    }
    for (const id of ["threshold", "min-size", "max-blobs"]) {
      ui[id].addEventListener("input", () => {
        document.getElementById(`${id}-value`).value = ui[id].value + (id === "min-size" ? " px" : "");
      });
    }
    ui["max-blobs"].addEventListener("input", () => {
      maxBlobs = Number(ui["max-blobs"].value);
      updateMasterGain();
      lastFrame = -1;
      lastAnalysis = 0;
    });
    ui.start.addEventListener("click", start);
    ui.camera.addEventListener("change", switchCamera);
    ui.mute.addEventListener("click", () => {
      muted = !muted;
      updateMasterGain();
      ui.mute.textContent = muted ? "Unmute" : "Mute";
      ui.mute.setAttribute("aria-pressed", String(muted));
    });
    ui.reverb.addEventListener("click", () => {
      reverbEnabled = !reverbEnabled;
      updateReverbAmount();
      ui.reverb.setAttribute("aria-pressed", String(reverbEnabled));
    });
    ui["reverb-amount"].addEventListener("input", () => {
      document.getElementById("reverb-amount-value").value = `${ui["reverb-amount"].value}%`;
      updateReverbAmount();
    });
    ui["room-size"].addEventListener("input", () => {
      document.getElementById("room-size-value").value = `${Number(ui["room-size"].value).toFixed(1)} s`;
    });
    ui["room-size"].addEventListener("change", () => {
      if (mix && reverbGain && audio && audio.state !== "closed") replaceReverbRoom();
    });
    document.addEventListener("visibilitychange", () => {
      if (!audio) return;
      if (document.hidden) {
        for (const voice of voices) voice.gain.gain.setTargetAtTime(0, audio.currentTime, 0.03);
        tracks = [];
        for (const voice of [...voices]) releaseVoice(voice);
      }
    });
    window.addEventListener("pagehide", cleanup);
    loadOpenCV().then(({ library }) => {
      cv = library;
      ui.start.disabled = false;
      ui.start.textContent = "Start camera & sound";
      ui.status.textContent = "Ready. Start to allow webcam access and enable sound.";
    }).catch((error) => {
      ui.start.textContent = "OpenCV unavailable";
      ui.status.textContent = error.message;
    });
  };

  function updateMasterGain() {
    if (!master || !audio || audio.state === "closed") return;
    // Include fading voices so reducing the limit cannot boost their whole mix.
    const gain = muted ? 0 : 0.88 / Math.max(maxBlobs, voices.size);
    master.gain.setTargetAtTime(gain, audio.currentTime, 0.05);
  }

  function updateReverbAmount() {
    if (!reverbGain || !audio || audio.state === "closed") return;
    reverbGain.gain.setTargetAtTime(reverbEnabled ? Number(ui["reverb-amount"].value) / 100 : 0, audio.currentTime, 0.05);
  }

  function replaceReverbRoom() {
    const convolver = audio.createConvolver();
    convolver.buffer = createReverbImpulse(audio, Number(ui["room-size"].value));
    const gain = audio.createGain();
    gain.gain.value = reverbPaths.size ? 0 : 1;
    const source = mix;
    source.connect(convolver).connect(gain).connect(reverbGain);
    // Crossfade room responses instead of replacing a live convolver's buffer.
    for (const path of reverbPaths) {
      if (path.timer) continue;
      path.gain.gain.setTargetAtTime(0, audio.currentTime, 0.03);
      path.timer = setTimeout(() => {
        source.disconnect(path.convolver);
        path.convolver.disconnect();
        path.gain.disconnect();
        reverbPaths.delete(path);
      }, 250);
    }
    reverbPaths.add({ convolver, gain, timer: null });
    gain.gain.setTargetAtTime(1, audio.currentTime, 0.03);
  }

  async function openCamera(facing) {
    // Mobile browsers may require releasing one camera before opening another.
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    if (!capture) {
      capture = document.createElement("video");
      capture.muted = true;
      capture.playsInline = true;
    }
    capture.srcObject = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          facingMode: facing === "environment" ? { exact: facing } : { ideal: facing },
        },
        audio: false,
      });
      capture.srcObject = stream;
      await capture.play();
      activeFacing = stream.getVideoTracks()[0].getSettings().facingMode || facing;
      mirrored = activeFacing !== "environment";
      ui.camera.value = activeFacing === "environment" ? "environment" : "user";
      lastFrame = -1;
      lastAnalysis = 0;
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      capture.srcObject = null;
      throw error;
    }
  }

  async function switchCamera() {
    if (!running) return;
    const previousFacing = activeFacing;
    const requestedFacing = ui.camera.value;
    running = false;
    ui.camera.disabled = true;
    ui["camera-error"].textContent = "";
    ui.status.textContent = "Switching camera…";
    tracks = [];
    for (const voice of voices) releaseVoice(voice);
    try {
      await openCamera(requestedFacing);
      running = true;
    } catch (error) {
      try {
        await openCamera(previousFacing);
        running = true;
        // Show the failure separately: live analysis updates the status text.
        ui["camera-error"].textContent = `Could not switch camera: ${error.message}. Restored the previous camera.`;
      } catch (restoreError) {
        cleanup();
        ui.start.disabled = false;
        ui.start.textContent = "Start camera & sound";
        ui.status.textContent = `Camera unavailable: ${restoreError.message}. Choose a camera and try again.`;
      }
    } finally {
      ui.camera.disabled = false;
    }
  }

  async function start() {
    ui.start.disabled = true;
    ui.camera.disabled = true;
    ui["camera-error"].textContent = "";
    ui.status.textContent = "Requesting camera access…";
    try {
      // Resume audio directly from the user gesture, before asking for the camera.
      audio = new AudioContext();
      await audio.resume();
      master = audio.createGain();
      master.gain.value = muted ? 0 : 0.88 / maxBlobs;
      mix = audio.createGain();
      reverbGain = audio.createGain();
      reverbGain.gain.value = reverbEnabled ? Number(ui["reverb-amount"].value) / 100 : 0;
      mix.connect(master);
      reverbGain.connect(master);
      replaceReverbRoom();
      const limiter = audio.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.ratio.value = 12;
      master.connect(limiter).connect(audio.destination);
      await openCamera(ui.camera.value);
      mats = {
        rgba: new cv.Mat(ANALYSIS_HEIGHT, ANALYSIS_WIDTH, cv.CV_8UC4),
        gray: new cv.Mat(),
        blurred: new cv.Mat(),
        binary: new cv.Mat(),
        mask: new cv.Mat(ANALYSIS_HEIGHT, ANALYSIS_WIDTH, cv.CV_8UC1),
        labels: new cv.Mat(),
        stats: new cv.Mat(),
        centroids: new cv.Mat(),
      };
      running = true;
      failed = false;
      ui.start.textContent = "Camera active";
      ui.mute.disabled = false;
      ui.reverb.disabled = false;
    } catch (error) {
      cleanup();
      ui.start.disabled = false;
      ui.status.textContent = `Could not start: ${error.message}. Use localhost or HTTPS and allow camera access.`;
    } finally {
      ui.camera.disabled = false;
    }
  }

  function detectBlobs() {
    frameContext.drawImage(capture, 0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
    mats.rgba.data.set(frameContext.getImageData(0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT).data);
    cv.cvtColor(mats.rgba, mats.gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(mats.gray, mats.blurred, new cv.Size(5, 5), 0);
    cv.threshold(mats.blurred, mats.binary, Number(ui.threshold.value), 255, cv.THRESH_BINARY);
    const count = cv.connectedComponentsWithStats(mats.binary, mats.labels, mats.stats, mats.centroids, 8, cv.CV_32S);
    const candidates = [];
    // Label zero is background. Pixel counts, not contour areas, define size.
    for (let label = 1; label < count; label++) {
      const size = mats.stats.intAt(label, cv.CC_STAT_AREA);
      if (size >= Number(ui["min-size"].value)) candidates.push({ label, size });
    }
    candidates.sort((a, b) => b.size - a.size);
    const selected = candidates.slice(0, maxBlobs);
    // Copy pixels while these WASM-backed views are valid. Later OpenCV calls
    // may grow its heap and invalidate previously obtained typed-array views.
    const binary = mats.binary.data;
    let brightPixels = 0;
    for (let i = 0; i < binary.length; i++) {
      const offset = i * 4;
      thresholdPixels.data[offset] = binary[i];
      thresholdPixels.data[offset + 1] = binary[i];
      thresholdPixels.data[offset + 2] = binary[i];
      thresholdPixels.data[offset + 3] = 255;
      if (binary[i]) brightPixels++;
    }
    thresholdContext.putImageData(thresholdPixels, 0, 0);
    maskPixels.data.fill(0);
    let edgeRegions = 0;
    const contours = new cv.MatVector();
    const hierarchy = new cv.Mat();
    try {
      const blobs = [];
      for (const candidate of selected) {
        const labels = mats.labels.data32S;
        const mask = mats.mask.data;
        for (let i = 0; i < labels.length; i++) {
          const included = labels[i] === candidate.label;
          mask[i] = included ? 255 : 0;
          if (included) {
            const offset = i * 4;
            maskPixels.data[offset] = 183;
            maskPixels.data[offset + 1] = 255;
            maskPixels.data[offset + 2] = 206;
            maskPixels.data[offset + 3] = 80;
          }
        }
        const x = mats.stats.intAt(candidate.label, cv.CC_STAT_LEFT);
        const y = mats.stats.intAt(candidate.label, cv.CC_STAT_TOP);
        const width = mats.stats.intAt(candidate.label, cv.CC_STAT_WIDTH);
        const height = mats.stats.intAt(candidate.label, cv.CC_STAT_HEIGHT);
        if (x === 0 || y === 0 || x + width === ANALYSIS_WIDTH || y + height === ANALYSIS_HEIGHT) edgeRegions++;
        const color = cv.mean(mats.rgba, mats.mask).slice(0, 3);
        // cv.mean is the intensity integral divided by the masked pixel count.
        const magnitude = cv.mean(mats.gray, mats.mask)[0] / 255;
        cv.findContours(mats.mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
        const contour = contours.get(0);
        try {
          blobs.push({
            x: mats.centroids.doubleAt(candidate.label, 0),
            y: mats.centroids.doubleAt(candidate.label, 1),
            outline: Array.from(contour.data32S),
            color,
            size: candidate.size,
            magnitude,
            frequency: blobToFrequency(mats.rgba.data, mats.labels.data32S, candidate.label),
          });
        } finally {
          contour.delete();
        }
      }
      maskContext.putImageData(maskPixels, 0, 0);
      ui.diagnostics.textContent = `${Math.round(brightPixels / (ANALYSIS_WIDTH * ANALYSIS_HEIGHT) * 100)}% of image above threshold · ${edgeRegions} selected blob${edgeRegions === 1 ? "" : "s"} touching the image edge`;
      return blobs;
    } finally {
      contours.delete();
      hierarchy.delete();
    }
  }

  function createVoice(frequency) {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    const envelope = audio.createGain();
    const startedAt = audio.currentTime;
    gain.gain.value = 0;
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    startEnvelope(envelope.gain, startedAt);
    oscillator.connect(gain).connect(envelope).connect(mix);
    const voice = { oscillator, gain, envelope, startedAt, releasing: false };
    voices.add(voice);
    updateMasterGain();
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
      envelope.disconnect();
      voices.delete(voice);
      updateMasterGain();
    };
    oscillator.start();
    return voice;
  }

  function releaseVoice(voice) {
    if (voice.releasing) return;
    voice.releasing = true;
    const end = releaseEnvelope(voice.envelope.gain, voice.startedAt, audio.currentTime);
    voice.oscillator.stop(end + 0.02);
  }

  function updateTracks(blobs) {
    const pairs = [];
    tracks.forEach((track) => blobs.forEach((blob, index) => {
      const distance = Math.hypot(track.x - blob.x, track.y - blob.y);
      if (distance < 65) pairs.push({ track, index, distance });
    }));
    pairs.sort((a, b) => a.distance - b.distance);
    const matchedTracks = new Set();
    const matches = new Map();
    for (const pair of pairs) {
      if (matchedTracks.has(pair.track) || matches.has(pair.index)) continue;
      matchedTracks.add(pair.track);
      matches.set(pair.index, pair.track);
    }
    const now = performance.now();
    const next = blobs.map((blob, index) => {
      const old = matches.get(index);
      const track = { ...blob, id: old?.id ?? nextTrackId++, voice: old?.voice ?? createVoice(blob.frequency), seen: now };
      track.voice.oscillator.frequency.setTargetAtTime(blob.frequency, audio.currentTime, 0.08);
      track.voice.gain.gain.setTargetAtTime(softenedAmplitude(blob.magnitude, blob.frequency), audio.currentTime, 0.06);
      return track;
    });
    for (const track of tracks) {
      if (matchedTracks.has(track)) continue;
      // Hold through brief detection flicker before beginning the release.
      if (now - track.seen < 200 && next.length < maxBlobs) next.push(track);
      else releaseVoice(track.voice);
    }
    tracks = next;
    ui.status.textContent = `${blobs.length} bright region${blobs.length === 1 ? "" : "s"} · up to ${maxBlobs} voices`;
  }

  function cleanup() {
    running = false;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    if (capture) capture.srcObject = null;
    if (mats) Object.values(mats).forEach((mat) => mat.delete());
    mats = null;
    tracks = [];
    for (const voice of voices) {
      voice.oscillator.onended = null;
      if (!voice.releasing) voice.oscillator.stop();
      voice.oscillator.disconnect();
      voice.gain.disconnect();
      voice.envelope.disconnect();
    }
    voices.clear();
    for (const path of reverbPaths) {
      clearTimeout(path.timer);
      mix.disconnect(path.convolver);
      path.convolver.disconnect();
      path.gain.disconnect();
    }
    reverbPaths.clear();
    mix = null;
    reverbGain = null;
    if (audio && audio.state !== "closed") audio.close();
    ui.mute.disabled = true;
    ui.reverb.disabled = true;
  }

  p.draw = () => {
    p.background(17, 21, 27);
    if (!running || capture.readyState < 2 || document.hidden) return;
    const now = performance.now();
    if (now - lastAnalysis > 50 && capture.currentTime !== lastFrame && !failed) {
      lastAnalysis = now;
      lastFrame = capture.currentTime;
      try {
        updateTracks(detectBlobs());
      } catch (error) {
        failed = true;
        cleanup();
        ui.status.textContent = `Processing stopped: ${error.message || error}. Reload to retry.`;
        return;
      }
    }
    const scale = Math.min(p.width / ANALYSIS_WIDTH, p.height / ANALYSIS_HEIGHT);
    const width = ANALYSIS_WIDTH * scale;
    const height = ANALYSIS_HEIGHT * scale;
    const left = (p.width - width) / 2;
    const top = (p.height - height) / 2;
    p.push();
    p.translate(mirrored ? left + width : left, top);
    p.scale(mirrored ? -1 : 1, 1);
    // Use the analyzed frame, not a newer live frame, to keep masks aligned.
    const context = p.drawingContext;
    context.imageSmoothingEnabled = ui.preview.value !== "threshold";
    context.drawImage(ui.preview.value === "threshold" ? thresholdPreview : frame, 0, 0, width, height);
    if (ui["show-masks"].checked) {
      context.imageSmoothingEnabled = false;
      context.drawImage(maskPreview, 0, 0, width, height);
    }
    p.noFill();
    p.stroke(183, 255, 206);
    p.strokeWeight(2);
    for (const track of tracks) {
      if (now - track.seen > 100) continue;
      p.beginShape();
      for (let i = 0; i < track.outline.length; i += 2) {
        p.vertex(track.outline[i] * scale, track.outline[i + 1] * scale);
      }
      p.endShape(p.CLOSE);
    }
    p.pop();
    p.noStroke();
    p.textSize(13);
    for (const track of tracks) {
      if (now - track.seen > 100) continue;
      const x = left + (mirrored ? width - track.x * scale : track.x * scale);
      const y = top + track.y * scale;
      const label = `#${track.id}  ${Math.round(track.frequency)} Hz · ${Math.round(track.magnitude * 100)}%`;
      p.fill(17, 21, 27, 220);
      p.rect(x - 4, y - 16, p.textWidth(label) + 8, 22, 4);
      p.fill(238, 244, 255);
      p.text(label, x, y);
    }
  };

  p.windowResized = () => p.resizeCanvas(p.windowWidth, p.windowHeight);
}, "app");
