/* Prueba automatizada: botón de pausa de los audífonos con la voz del sistema.
 * - Simula speechSynthesis (cada locución "suena" ~300ms).
 * - Captura los manejadores de Media Session (lo que el sistema llama al
 *   pulsar el botón de los audífonos / pantalla de bloqueo).
 * - Verifica: al leer hay audio silencioso activo + playbackState "playing";
 *   "pause" detiene la voz; "play" reanuda; "nexttrack" salta; parar libera.
 * Uso: python3 tools/make-test-pdf.py /tmp/t.pdf && node tools/test-media-keys.mjs /tmp/t.pdf
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const { chromium } = createRequire(import.meta.url)('playwright');

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const PDF = process.argv[2];
if (!PDF || !fs.existsSync(PDF)) { console.error('Falta el PDF de prueba'); process.exit(2); }

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('nf');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

// Se ejecuta antes que la app: síntesis simulada + captura de Media Session.
function initStubs() {
  try { sessionStorage.setItem('coiReloaded', '1'); } catch (e) {}
  window.__spoken = [];
  window.__handlers = {};
  let current = null, timer = null;
  const synth = {
    speaking: false, pending: false, paused: false,
    getVoices: () => [],
    addEventListener() {}, removeEventListener() {},
    onvoiceschanged: null,
    speak(u) {
      current = u; this.speaking = true; window.__spoken.push(u.text);
      timer = setTimeout(() => { this.speaking = false; current = null; u.onend && u.onend({}); }, 300);
    },
    cancel() {
      clearTimeout(timer); const u = current; current = null; this.speaking = false;
      if (u && u.onerror) u.onerror({ error: 'canceled' });
    },
    pause() {}, resume() {},
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  if (navigator.mediaSession) {
    const orig = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
    navigator.mediaSession.setActionHandler = (a, fn) => { window.__handlers[a] = fn; try { orig(a, fn); } catch (e) {} };
  }
}

async function main() {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
  const page = await browser.newPage();
  const fails = [];
  page.on('pageerror', (e) => fails.push('pageerror: ' + e.message));
  await page.addInitScript(initStubs);
  await page.goto(base + '/', { waitUntil: 'load' });

  const results = [];
  const check = (name, cond, extra = '') => {
    results.push(!!cond);
    console.log((cond ? '✓' : '✗') + ' ' + name + (extra ? ' — ' + extra : ''));
  };
  const snap = () => page.evaluate(() => ({
    spoken: window.__spoken.length,
    playback: navigator.mediaSession && navigator.mediaSession.playbackState,
    handlers: Object.keys(window.__handlers),
    silentPlaying: window.__mk ? !window.__mk.paused : null,
    fab: document.getElementById('fab').textContent,
  }));
  // Localiza el <audio> silencioso (creado con new Audio(), fuera del DOM).
  await page.evaluate(() => {
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (this.id !== 'ttsAudio' && this.loop) window.__mk = this;
      return origPlay.call(this);
    };
  });

  await page.setInputFiles('#fileInput', PDF);
  await page.waitForFunction(() => document.querySelectorAll('.page').length > 0, { timeout: 15000 });
  await page.waitForTimeout(800);

  await page.click('#fab'); // Leer (voz del sistema)
  await page.waitForTimeout(1200);
  let s = await snap();
  check('Lee con la voz del sistema', s.spoken > 0, 'locuciones=' + s.spoken);
  check('Audio silencioso activo (sesión multimedia)', s.silentPlaying === true);
  check('playbackState = playing', s.playback === 'playing', s.playback);
  check('Manejadores de Media Session registrados',
    ['play', 'pause', 'nexttrack', 'previoustrack', 'stop'].every((h) => s.handlers.includes(h)),
    s.handlers.join(','));

  // Botón de pausa de los audífonos.
  await page.evaluate(() => window.__handlers.pause({ action: 'pause' }));
  const n0 = (await snap()).spoken;
  await page.waitForTimeout(1200);
  s = await snap();
  check('Pausa: la voz se detiene', s.spoken === n0, `antes=${n0} después=${s.spoken}`);
  check('Pausa: playbackState = paused', s.playback === 'paused', s.playback);
  check('Pausa: audio silencioso en pausa', s.silentPlaying === false);
  check('Pausa: botón flotante muestra ▶', s.fab === '▶', s.fab);

  // Volver a pulsar (play).
  await page.evaluate(() => window.__handlers.play({ action: 'play' }));
  await page.waitForTimeout(1200);
  s = await snap();
  check('Play: la lectura se reanuda', s.spoken > n0, `antes=${n0} ahora=${s.spoken}`);
  check('Play: playbackState = playing', s.playback === 'playing', s.playback);
  check('Play: audio silencioso activo', s.silentPlaying === true);

  // "pause" enviado estando ya en pausa (audífonos que alternan) => reanuda.
  await page.evaluate(() => window.__handlers.pause({ action: 'pause' }));
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__handlers.pause({ action: 'pause' }));
  await page.waitForTimeout(800);
  s = await snap();
  check('Pausa doble alterna (reanuda)', s.playback === 'playing' && s.fab === '⏸', `${s.playback} ${s.fab}`);

  // Siguiente párrafo.
  const before = await page.evaluate(() => window.__spoken[window.__spoken.length - 1]);
  await page.evaluate(() => window.__handlers.nexttrack({ action: 'nexttrack' }));
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => window.__spoken[window.__spoken.length - 1]);
  check('Siguiente pista salta de párrafo', before !== after, `${before.slice(0, 30)} → ${after.slice(0, 30)}`);

  // Parar.
  await page.evaluate(() => window.__handlers.stop({ action: 'stop' }));
  await page.waitForTimeout(300);
  s = await snap();
  check('Stop: audio silencioso detenido', s.silentPlaying === false);
  check('Stop: playbackState = none', s.playback === 'none', s.playback);

  check('Sin errores de página', fails.length === 0, fails.join(' | '));
  await browser.close();
  server.close();
  const ok = results.every(Boolean);
  console.log(ok ? '\nTODO OK' : '\nHAY FALLOS');
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
