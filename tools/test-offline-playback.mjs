/* Prueba automatizada del motor de reproducción offline (voz en segundo plano).
 * - Sirve la app localmente.
 * - Simula el módulo de TTS (esm.sh) devolviendo WAV reales (tono corto).
 * - Carga un PDF de prueba, activa la voz offline y le da Leer.
 * - Verifica: reproducción continua por varios párrafos, Media Session,
 *   pausa/reanudar, saltar, y que NO se salte hasta el final.
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const PDF = process.argv[2];
if (!PDF || !fs.existsSync(PDF)) { console.error('Falta el PDF de prueba'); process.exit(2); }

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.map': 'application/json' };

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

// Módulo TTS simulado: predict() devuelve un WAV de ~0.4s (tono), como Blob.
const MOCK_TTS = `
function wavBlob(seconds, freq) {
  const sr = 8000, n = Math.floor(sr * seconds);
  const buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0,'RIFF'); dv.setUint32(4, 36 + n*2, true); w(8,'WAVE'); w(12,'fmt ');
  dv.setUint32(16,16,true); dv.setUint16(20,1,true); dv.setUint16(22,1,true);
  dv.setUint32(24,sr,true); dv.setUint32(28,sr*2,true); dv.setUint16(32,2,true); dv.setUint16(34,16,true);
  w(36,'data'); dv.setUint32(40,n*2,true);
  for (let i=0;i<n;i++) dv.setInt16(44+i*2, Math.round(Math.sin(2*Math.PI*freq*i/sr)*6000), true);
  return new Blob([buf], { type: 'audio/wav' });
}
export async function stored() { return ['es_ES-sharvard-medium','es_MX-claude-high','es_AR-daniela-high','es_ES-davefx-medium','es_MX-ald-medium','en_US-hfc_female-medium','en_US-amy-medium','en_GB-jenny_dioco-medium','en_US-ryan-high','en_US-hfc_male-medium']; }
export async function download() { return; }
export async function voices() { return (await stored()).map(k => ({ key: k })); }
export async function predict({ text }) {
  window.__ttsCalls = (window.__ttsCalls || 0) + 1;
  await new Promise(r => setTimeout(r, 60));  // simula un pequeño tiempo de generación
  return wavBlob(0.4, 330);
}
`;

async function main() {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  console.log('Servidor local en', base);

  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
  });
  const page = await browser.newPage();
  const fails = [];
  page.on('pageerror', (e) => fails.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') fails.push('console.error: ' + m.text()); });

  // Intercepta el import del módulo TTS (esm.sh) y sirve el simulado.
  await page.route('**/@diffusionstudio/vits-web**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/javascript', body: MOCK_TTS }));

  // Evita la recarga por aislamiento de origen durante la prueba.
  await page.addInitScript(() => { try { sessionStorage.setItem('coiReloaded', '1'); } catch (e) {} });

  await page.goto(base + '/', { waitUntil: 'load' });

  const results = [];
  const check = (name, cond, extra = '') => {
    results.push({ name, ok: !!cond, extra });
    console.log((cond ? '✓' : '✗') + ' ' + name + (extra ? ' — ' + extra : ''));
  };

  // 1) Activa la voz offline (el switch oculta el checkbox: disparo su evento).
  await page.click('#menuBtn');
  await page.evaluate(() => {
    const t = document.getElementById('offlineToggle');
    t.checked = true;
    t.dispatchEvent(new Event('change', { bubbles: true }));
  });

  // 2) Carga el PDF de prueba (esto cierra el menú y muestra el botón flotante).
  await page.setInputFiles('#fileInput', PDF);
  await page.waitForFunction(() => document.querySelectorAll('.page').length > 0, { timeout: 15000 });

  const paraCount = await page.evaluate(() => document.querySelectorAll('.page').length);
  check('PDF cargado (páginas renderizadas)', paraCount > 0, 'páginas=' + paraCount);

  // 3) Pulsa el botón flotante Leer (gesto de usuario real).
  await page.click('#fab');

  // Espera a que empiece a sonar.
  await page.waitForFunction(() => {
    const a = document.getElementById('ttsAudio');
    return a && !a.paused && a.src && a.src.startsWith('blob:');
  }, { timeout: 15000 }).catch(() => {});

  const started = await page.evaluate(() => {
    const a = document.getElementById('ttsAudio');
    return { paused: a.paused, isBlob: (a.src || '').startsWith('blob:'), calls: window.__ttsCalls || 0 };
  });
  check('La voz offline empezó a reproducir', started.paused === false && started.isBlob, 'estado=' + JSON.stringify(started));

  // 4) Reproducción CONTINUA: el índice de párrafo/fragmento debe avanzar.
  const idx0 = await page.evaluate(() => window.__ttsCalls || 0);
  await page.waitForTimeout(3000);
  const idx1 = await page.evaluate(() => window.__ttsCalls || 0);
  check('Avanza solo por los fragmentos (continuo)', idx1 > idx0 + 1, `llamadas TTS ${idx0} -> ${idx1}`);

  // 5) No se saltó hasta el final instantáneamente (el bug viejo).
  const notAtEnd = await page.evaluate(() => {
    // heurística: no debería haber consumido decenas de fragmentos en 3s.
    return (window.__ttsCalls || 0) < 30;
  });
  check('No se salta hasta el final (sin cascada)', notAtEnd, 'llamadas=' + (await page.evaluate(() => window.__ttsCalls)));

  // 6) Media Session activa (metadata + playbackState).
  const ms = await page.evaluate(() => ({
    state: navigator.mediaSession && navigator.mediaSession.playbackState,
    hasMeta: !!(navigator.mediaSession && navigator.mediaSession.metadata),
  }));
  check('Media Session en "playing"', ms.state === 'playing', 'state=' + ms.state);
  check('Media Session con metadata', ms.hasMeta, 'meta=' + ms.hasMeta);

  // 7) Pausa con el botón flotante: el audio se detiene.
  await page.click('#fab');
  await page.waitForTimeout(300);
  const paused = await page.evaluate(() => {
    const a = document.getElementById('ttsAudio');
    return { paused: a.paused, state: navigator.mediaSession.playbackState };
  });
  check('Pausa detiene el audio', paused.paused === true, JSON.stringify(paused));

  // 8) Reanudar con el botón flotante: vuelve a sonar y sigue avanzando.
  const callsBeforeResume = await page.evaluate(() => window.__ttsCalls || 0);
  await page.click('#fab');
  await page.waitForTimeout(2500);
  const afterResume = await page.evaluate(() => ({
    paused: document.getElementById('ttsAudio').paused,
    calls: window.__ttsCalls || 0,
  }));
  check('Reanudar sigue leyendo', afterResume.paused === false && afterResume.calls > callsBeforeResume, JSON.stringify(afterResume));

  // 9) Saltar al siguiente párrafo (botón flotante ⏭).
  await page.click('#fabNext');
  await page.waitForTimeout(1500);
  const afterSkip = await page.evaluate(() => ({
    paused: document.getElementById('ttsAudio').paused,
  }));
  check('Saltar párrafo sigue reproduciendo', afterSkip.paused === false, JSON.stringify(afterSkip));

  // 10) Simula "segundo plano": dispara visibilitychange=hidden y confirma que
  //     el audio NO se detiene ni salta al final por su cuenta.
  const callsBeforeHide = await page.evaluate(() => window.__ttsCalls || 0);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(2500);
  const hidden = await page.evaluate(() => ({
    paused: document.getElementById('ttsAudio').paused,
    calls: window.__ttsCalls || 0,
  }));
  check('En segundo plano sigue sonando (no se detiene)', hidden.paused === false, JSON.stringify(hidden));
  check('En segundo plano no cascada al final', (hidden.calls - callsBeforeHide) < 30, 'delta=' + (hidden.calls - callsBeforeHide));

  // Stop y cierre.
  await page.evaluate(() => { document.getElementById('stopBtn').click(); }).catch(() => {});
  await browser.close();
  server.close();

  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  console.log(`\nRESULTADO: ${passed}/${total} verificaciones OK`);
  if (fails.length) { console.log('Errores de página:'); fails.slice(0, 8).forEach((f) => console.log('  - ' + f)); }
  process.exit(passed === total && fails.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error('Fallo del test:', e); process.exit(1); });
