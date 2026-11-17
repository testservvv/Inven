// In-app QR scanner. Uses the browser's built-in BarcodeDetector where
// available and falls back to the bundled jsQR decoder otherwise (e.g. iOS).
(() => {
  'use strict';

  const root = document.querySelector('[data-scanner]');
  if (!root) return;
  const video = root.querySelector('video');
  const status = root.querySelector('[data-scanner-status]');
  const startButton = root.querySelector('[data-scanner-start]');
  const torchButton = root.querySelector('[data-scanner-torch]');

  let stream = null;
  let detector = null;
  let canvas = null;
  let running = false;
  let lastUnknown = '';

  const say = (text) => {
    status.textContent = text;
  };

  /** Only links of this installation's own labels are followed: /q/<CODE>. */
  function targetFor(text) {
    try {
      const url = new URL(text, location.origin);
      const match = /^\/q\/([A-Za-z0-9]{4,16})$/i.exec(url.pathname);
      return match ? `/q/${match[1].toUpperCase()}` : null;
    } catch {
      return null;
    }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = reject;
      document.head.append(script);
    });
  }

  async function prepareDecoder() {
    if ('BarcodeDetector' in window) {
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.includes('qr_code')) {
          detector = new window.BarcodeDetector({ formats: ['qr_code'] });
          return;
        }
      } catch {
        // Fall through to jsQR.
      }
    }
    await loadScript('/static/vendor/jsqr.js');
    canvas = document.createElement('canvas');
  }

  async function decode() {
    if (detector) {
      const codes = await detector.detect(video);
      return codes[0]?.rawValue ?? null;
    }
    // Decode a centred square, downscaled – plenty for a label and much faster.
    const side = Math.min(video.videoWidth, video.videoHeight);
    const size = Math.min(side, 640);
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(video, (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side, 0, 0, size, size);
    const image = context.getImageData(0, 0, size, size);
    return window.jsQR(image.data, size, size, { inversionAttempts: 'dontInvert' })?.data ?? null;
  }

  async function loop() {
    if (!running) return;
    try {
      if (video.readyState >= 2 && video.videoWidth > 0) {
        const text = await decode();
        if (text) {
          const target = targetFor(text);
          if (target) {
            running = false;
            say('Code erkannt …');
            navigator.vibrate?.(60);
            location.assign(target);
            return;
          }
          if (text !== lastUnknown) {
            lastUnknown = text;
            say('Dieser QR-Code gehört nicht zu einem Inventar-Etikett.');
          }
        }
      }
    } catch {
      // A single failed frame is not a problem; keep scanning.
    }
    setTimeout(loop, detector ? 150 : 220);
  }

  function stop() {
    running = false;
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
  }

  async function start() {
    startButton.hidden = true;
    if (!navigator.mediaDevices?.getUserMedia) {
      say('Dieser Browser gibt die Kamera nicht frei (HTTPS erforderlich). Bitte die Kamera-App des Handys verwenden.');
      return;
    }
    try {
      say('Kamera wird gestartet …');
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      video.srcObject = stream;
      await video.play();
      await prepareDecoder();
      const track = stream.getVideoTracks()[0];
      if (track.getCapabilities?.().torch) {
        torchButton.hidden = false;
        let on = false;
        torchButton.onclick = () => {
          on = !on;
          track.applyConstraints({ advanced: [{ torch: on }] }).catch(() => {});
        };
      }
      running = true;
      say('QR-Code in den Rahmen halten');
      loop();
    } catch (error) {
      stop();
      startButton.hidden = false;
      say(
        error?.name === 'NotAllowedError'
          ? 'Kein Zugriff auf die Kamera. Bitte in den Browser-Einstellungen erlauben und erneut starten.'
          : error?.name === 'NotFoundError'
            ? 'Keine Kamera gefunden. Die Inventarnummer lässt sich unten von Hand eingeben.'
            : 'Die Kamera konnte nicht gestartet werden.',
      );
    }
  }

  startButton.addEventListener('click', start);
  // Release the camera when the page goes to the background, resume when it returns.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else if (!running && !stream) start();
  });
  window.addEventListener('pagehide', stop);
  start();
})();
