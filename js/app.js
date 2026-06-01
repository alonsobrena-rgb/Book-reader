/* =========================================================================
 * Lector de PDF en voz alta
 * -------------------------------------------------------------------------
 * - Renderiza PDFs con PDF.js (carga perezosa de páginas).
 * - Extrae el texto y lo agrupa en párrafos con su posición en pantalla.
 * - Lee en voz alta con la Web Speech API (voz femenina ES/EN, hasta 2.5x).
 * - La lectura empieza desde el párrafo visible en la parte superior del
 *   scroll, resaltando el párrafo que se está leyendo.
 * ========================================================================= */

(() => {
  'use strict';

  // ---- PDF.js worker ----
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  // ---- Elementos del DOM ----
  const fileInput   = document.getElementById('fileInput');
  const langSelect  = document.getElementById('langSelect');
  const voiceSelect = document.getElementById('voiceSelect');
  const rateSlider  = document.getElementById('rateSlider');
  const rateValue   = document.getElementById('rateValue');
  const playBtn     = document.getElementById('playBtn');
  const pauseBtn    = document.getElementById('pauseBtn');
  const stopBtn     = document.getElementById('stopBtn');
  const zoomInBtn   = document.getElementById('zoomInBtn');
  const zoomOutBtn  = document.getElementById('zoomOutBtn');
  const zoomFitBtn  = document.getElementById('zoomFitBtn');
  const libraryBtn  = document.getElementById('libraryBtn');
  const libOverlay  = document.getElementById('libOverlay');
  const libCloseBtn = document.getElementById('libCloseBtn');
  const libraryList = document.getElementById('libraryList');
  const libOverlayList = document.getElementById('libOverlayList');
  const viewer      = document.getElementById('viewer');
  const emptyState  = document.getElementById('emptyState');

  const synth = window.speechSynthesis;
  const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  // ---- Estado global ----
  const state = {
    pdfDoc: null,
    fitScale: 1,        // escala para ajustar la página al ancho del visor
    zoom: 1,            // multiplicador de zoom del usuario
    pageEls: [],        // contenedores .page por página
    pagesWrapper: null, // envoltorio de páginas (para pinch-zoom)
    paragraphs: [],     // lista plana de párrafos en orden de lectura
    highlightEl: null,  // único elemento de resaltado reutilizable
    currentIndex: -1,   // párrafo en lectura
    isReading: false,
    isPaused: false,
    voices: [],
    keepAliveTimer: null,
    watchdogTimer: null,
    currentUtterance: null, // referencia fuerte (evita que el GC corte la voz)
    advanceCurrent: null,   // avanza al siguiente fragmento (usado por watchdog)
    currentDocId: null,     // id del PDF abierto (para guardar la posición)
    textCache: new Map(),   // caché de getTextContent por página (acelera el zoom)
  };

  // Escala efectiva de render = ajuste al ancho * zoom del usuario.
  function currentScale() {
    return state.fitScale * state.zoom;
  }

  /* ====================================================================
   * 1. VOCES
   * ==================================================================== */

  // Heurística para detectar voces femeninas por nombre (varía según SO/navegador).
  const FEMALE_HINTS = [
    'female', 'mujer', 'femenina',
    'monica', 'mónica', 'paulina', 'helena', 'laura', 'sabina', 'lucia', 'lucía',
    'elvira', 'sofia', 'sofía', 'esperanza', 'marisol', 'penelope', 'penélope',
    'samantha', 'victoria', 'karen', 'tessa', 'fiona', 'moira', 'serena',
    'zira', 'susan', 'catherine', 'amelie', 'amélie', 'google español',
    'google us english', 'google uk english female',
  ];

  function isLikelyFemale(voice) {
    const n = voice.name.toLowerCase();
    return FEMALE_HINTS.some((h) => n.includes(h));
  }

  function loadVoices() {
    state.voices = synth.getVoices() || [];
    populateVoiceSelect();
  }

  function populateVoiceSelect() {
    const lang = langSelect.value; // 'es' | 'en'
    const matching = state.voices.filter((v) =>
      v.lang.toLowerCase().startsWith(lang)
    );

    voiceSelect.innerHTML = '';

    if (matching.length === 0) {
      const opt = document.createElement('option');
      opt.textContent = 'No hay voces disponibles para este idioma';
      opt.value = '';
      voiceSelect.appendChild(opt);
      return;
    }

    // Las voces femeninas primero.
    matching.sort((a, b) => {
      const fa = isLikelyFemale(a) ? 0 : 1;
      const fb = isLikelyFemale(b) ? 0 : 1;
      return fa - fb;
    });

    matching.forEach((v) => {
      const opt = document.createElement('option');
      opt.value = v.name;
      opt.textContent = `${v.name} (${v.lang})${isLikelyFemale(v) ? ' ♀' : ''}`;
      voiceSelect.appendChild(opt);
    });

    // Selecciona por defecto la primera (femenina si existe).
    voiceSelect.value = matching[0].name;
  }

  function getSelectedVoice() {
    return state.voices.find((v) => v.name === voiceSelect.value) || null;
  }

  loadVoices();
  if (typeof synth.onvoiceschanged !== 'undefined') {
    synth.onvoiceschanged = loadVoices;
  }

  /* ====================================================================
   * 2. CARGA Y RENDER DEL PDF
   * ==================================================================== */

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleFile(file);
    fileInput.value = ''; // permite reabrir el mismo archivo
  });

  // Abre un archivo elegido por el usuario: lo guarda en la biblioteca y lo abre.
  async function handleFile(file) {
    const id = `${file.name}__${file.size}`;
    const meta = {
      id, name: file.name, size: file.size, blob: file,
      zoom: 1, scrollFraction: 0, savedAt: Date.now(),
    };
    // Si ya estaba guardado, conserva su posición y zoom previos.
    const existing = await dbGet(id).catch(() => null);
    if (existing) {
      meta.zoom = existing.zoom || 1;
      meta.scrollFraction = existing.scrollFraction || 0;
    }
    await dbPut(meta).catch((e) => console.warn('No se pudo guardar el PDF:', e));

    const buf = await file.arrayBuffer();
    await openDocument(buf, meta);
    refreshLibrary();
  }

  // Carga el documento en el visor y restaura zoom + posición de lectura.
  async function openDocument(buf, meta) {
    stopReading();
    showToast('Cargando PDF…');
    try {
      state.pdfDoc = await pdfjsLib.getDocument({ data: buf }).promise;
    } catch (err) {
      console.error(err);
      showToast('No se pudo abrir el PDF.');
      return;
    }

    state.currentDocId = meta.id || null;
    state.zoom = meta.zoom || 1;
    state.textCache = new Map(); // documento nuevo: caché limpia
    await computeFitScale();
    await renderAllPages();

    // Restaura la posición donde se quedó la última vez.
    requestAnimationFrame(() => {
      const max = viewer.scrollHeight - viewer.clientHeight;
      viewer.scrollTop = Math.max(0, (meta.scrollFraction || 0) * max);
    });

    if (meta.id) updateMeta(meta.id, { numPages: state.pdfDoc.numPages });
    updateControls();
    hideToast();
    showToast(`PDF cargado: ${state.pdfDoc.numPages} páginas`, 1500);
  }

  // Calcula la escala para que la página ocupe el ancho disponible del visor.
  async function computeFitScale() {
    const page = await state.pdfDoc.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const avail = Math.max(280, viewer.clientWidth - 24); // margen para sombra
    state.fitScale = avail / vp.width;
  }

  // (Re)construye todas las páginas y párrafos con la escala actual.
  async function renderAllPages() {
    stopReading();
    viewer.innerHTML = '';
    state.pageEls = [];
    state.paragraphs = [];
    state.currentIndex = -1;

    // Envoltorio que contiene el resaltado y todas las páginas.
    state.pagesWrapper = document.createElement('div');
    state.pagesWrapper.className = 'pages-wrapper';
    viewer.appendChild(state.pagesWrapper);

    // Elemento de resaltado único.
    state.highlightEl = document.createElement('div');
    state.highlightEl.className = 'reading-highlight';
    state.pagesWrapper.appendChild(state.highlightEl);

    // Crea los contenedores de todas las páginas (con su tamaño real) y
    // extrae el texto/párrafos. El canvas se renderiza de forma perezosa.
    for (let n = 1; n <= state.pdfDoc.numPages; n++) {
      await preparePage(n);
    }
    setupLazyRendering();
  }

  // Crea el contenedor de la página, fija su tamaño y construye los párrafos.
  async function preparePage(pageNum) {
    const page = await state.pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: currentScale() });

    const pageEl = document.createElement('div');
    pageEl.className = 'page';
    pageEl.style.width = `${viewport.width}px`;
    pageEl.style.height = `${viewport.height}px`;
    pageEl.dataset.pageNum = String(pageNum);
    pageEl.dataset.rendered = 'false';

    const placeholder = document.createElement('div');
    placeholder.className = 'page__placeholder';
    placeholder.textContent = `Página ${pageNum}`;
    pageEl.appendChild(placeholder);

    state.pagesWrapper.appendChild(pageEl);
    state.pageEls[pageNum] = pageEl;

    // Extrae texto (cacheado) y construye los párrafos con su geometría.
    let textContent = state.textCache.get(pageNum);
    if (!textContent) {
      textContent = await page.getTextContent();
      state.textCache.set(pageNum, textContent);
    }
    buildParagraphs(textContent, viewport, pageNum, pageEl);
  }

  // Renderiza el canvas de una página solo cuando es visible.
  async function renderPageCanvas(pageEl) {
    if (pageEl.dataset.rendered !== 'false') return;
    pageEl.dataset.rendered = 'pending';

    const pageNum = Number(pageEl.dataset.pageNum);
    const page = await state.pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: currentScale() });

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');

    await page.render({ canvasContext: ctx, viewport }).promise;

    pageEl.querySelector('.page__placeholder')?.remove();
    pageEl.insertBefore(canvas, pageEl.firstChild);
    pageEl.dataset.rendered = 'true';
  }

  function setupLazyRendering() {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) renderPageCanvas(entry.target);
        });
      },
      { root: viewer, rootMargin: '600px 0px' }
    );
    state.pageEls.forEach((el) => el && io.observe(el));
  }

  /* ====================================================================
   * 3. AGRUPACIÓN DE TEXTO EN PÁRRAFOS
   * ==================================================================== */

  function buildParagraphs(textContent, viewport, pageNum, pageEl) {
    // Convierte cada item en una caja con posición en coordenadas de viewport.
    const boxes = [];
    for (const item of textContent.items) {
      const str = item.str;
      if (!str || !str.trim()) continue;

      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const fontHeight = Math.hypot(tx[2], tx[3]) || item.height * viewport.scale;
      const width = item.width * viewport.scale;
      const left = tx[4];
      const baseline = tx[5];
      const top = baseline - fontHeight;

      boxes.push({
        str,
        left,
        top,
        width,
        height: fontHeight,
        baseline,
        right: left + width,
        bottom: baseline,
      });
    }

    if (boxes.length === 0) return;

    // Ordena por posición (de arriba a abajo, de izquierda a derecha).
    boxes.sort((a, b) => (a.baseline - b.baseline) || (a.left - b.left));

    // Agrupa en líneas (misma baseline aprox.).
    const lines = [];
    let current = null;
    for (const b of boxes) {
      const tol = b.height * 0.6;
      if (current && Math.abs(b.baseline - current.baseline) <= tol) {
        current.items.push(b);
        current.baseline = (current.baseline + b.baseline) / 2;
      } else {
        current = { baseline: b.baseline, items: [b] };
        lines.push(current);
      }
    }

    // Ordena cada línea por X y calcula su geometría/texto.
    const lineObjs = lines.map((ln) => {
      ln.items.sort((a, b) => a.left - b.left);
      const left = Math.min(...ln.items.map((i) => i.left));
      const right = Math.max(...ln.items.map((i) => i.right));
      const top = Math.min(...ln.items.map((i) => i.top));
      const bottom = Math.max(...ln.items.map((i) => i.bottom));
      const text = ln.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim();
      const height = bottom - top;
      return { text, left, right, top, bottom, height };
    });

    // Agrupa líneas en párrafos según el espacio vertical entre ellas.
    const paras = [];
    let para = null;
    for (let i = 0; i < lineObjs.length; i++) {
      const ln = lineObjs[i];
      if (!para) {
        para = newPara(ln);
        continue;
      }
      const prev = lineObjs[i - 1];
      const gap = ln.top - prev.bottom;
      const lineHeight = Math.max(ln.height, prev.height, 1);
      // Nuevo párrafo si el hueco vertical es grande o hay sangría notable.
      const bigGap = gap > lineHeight * 0.9;
      if (bigGap) {
        paras.push(para);
        para = newPara(ln);
      } else {
        para.lines.push(ln.text);
        para.left = Math.min(para.left, ln.left);
        para.right = Math.max(para.right, ln.right);
        para.top = Math.min(para.top, ln.top);
        para.bottom = Math.max(para.bottom, ln.bottom);
      }
    }
    if (para) paras.push(para);

    // Guarda cada párrafo en la lista global de lectura.
    for (const p of paras) {
      const text = p.lines.join(' ').replace(/\s+/g, ' ').trim();
      if (text.length < 2) continue;
      const pad = 4;
      state.paragraphs.push({
        text,
        pageNum,
        pageEl,
        box: {
          left: p.left - pad,
          top: p.top - pad,
          width: p.right - p.left + pad * 2,
          height: p.bottom - p.top + pad * 2,
        },
      });
    }

    function newPara(ln) {
      return {
        lines: [ln.text],
        left: ln.left, right: ln.right, top: ln.top, bottom: ln.bottom,
      };
    }
  }

  /* ====================================================================
   * 4. RESALTADO Y SCROLL
   * ==================================================================== */

  function highlightParagraph(index) {
    const p = state.paragraphs[index];
    if (!p) return;
    const hl = state.highlightEl;
    const x = p.pageEl.offsetLeft + p.box.left;
    const y = p.pageEl.offsetTop + p.box.top;
    hl.style.transform = `translate(${x}px, ${y}px)`;
    hl.style.width = `${p.box.width}px`;
    hl.style.height = `${p.box.height}px`;
    hl.classList.add('is-visible');
  }

  function clearHighlight() {
    state.highlightEl?.classList.remove('is-visible');
  }

  // Posición vertical de la página dentro del scroll del visor.
  function pageTop(pageEl) {
    const wrapTop = state.pagesWrapper ? state.pagesWrapper.offsetTop : 0;
    return wrapTop + pageEl.offsetTop;
  }

  function scrollParagraphIntoView(index) {
    const p = state.paragraphs[index];
    if (!p) return;
    const targetTop = pageTop(p.pageEl) + p.box.top;
    const margin = 90;
    const viewTop = viewer.scrollTop;
    const viewBottom = viewTop + viewer.clientHeight;
    // Solo desplaza si el párrafo no está cómodamente dentro de la vista.
    if (targetTop < viewTop + margin || targetTop > viewBottom - margin) {
      viewer.scrollTo({ top: targetTop - margin, behavior: 'smooth' });
    }
  }

  // Encuentra el primer párrafo visible en la parte superior del scroll.
  function findParagraphAtTop() {
    const threshold = viewer.scrollTop + 4;
    for (let i = 0; i < state.paragraphs.length; i++) {
      const p = state.paragraphs[i];
      const bottom = pageTop(p.pageEl) + p.box.top + p.box.height;
      if (bottom > threshold) return i;
    }
    return state.paragraphs.length > 0 ? 0 : -1;
  }

  /* ====================================================================
   * 5. LECTURA EN VOZ ALTA
   * ==================================================================== */

  // Divide un párrafo largo en fragmentos cortos (por frases) para evitar
  // el corte de utterances largas en algunos navegadores.
  function chunkText(text, maxLen = 140) {
    const sentences = text.match(/[^.!?¡¿…]+[.!?…]*/g) || [text];
    const chunks = [];
    let buf = '';
    for (const s of sentences) {
      const sentence = s.trim();
      if (!sentence) continue;
      if ((buf + ' ' + sentence).trim().length > maxLen && buf) {
        chunks.push(buf.trim());
        buf = sentence;
      } else {
        buf = (buf + ' ' + sentence).trim();
      }
    }
    if (buf) chunks.push(buf.trim());
    return chunks;
  }

  function startReading() {
    if (!state.pdfDoc || state.paragraphs.length === 0) return;

    if (state.isPaused) { // Reanudar
      synth.resume();
      state.isPaused = false;
      updateControls();
      return;
    }
    if (state.isReading) return;

    const startIndex = findParagraphAtTop();
    if (startIndex < 0) return;

    state.isReading = true;
    state.isPaused = false;
    startKeepAlive();
    startWatchdog();
    updateControls();
    speakParagraph(startIndex);
  }

  function speakParagraph(index) {
    if (!state.isReading || index >= state.paragraphs.length) {
      stopReading();
      return;
    }
    state.currentIndex = index;
    highlightParagraph(index);
    scrollParagraphIntoView(index);

    const chunks = chunkText(state.paragraphs[index].text);
    speakChunks(chunks, 0, index);
  }

  function speakChunks(chunks, ci, pIndex) {
    if (!state.isReading) return;

    if (ci >= chunks.length) {
      speakParagraph(pIndex + 1); // Siguiente párrafo
      return;
    }

    const utter = new SpeechSynthesisUtterance(chunks[ci]);
    const voice = getSelectedVoice();
    if (voice) utter.voice = voice;
    utter.lang = voice ? voice.lang : (langSelect.value === 'es' ? 'es-ES' : 'en-US');
    utter.rate = parseFloat(rateSlider.value);
    utter.pitch = 1;

    // Mantener una referencia fuerte evita que el recolector de basura del
    // navegador corte la locución a las pocas palabras (bug conocido).
    state.currentUtterance = utter;

    // Avanza al siguiente fragmento una sola vez (onend, onerror o watchdog).
    let advanced = false;
    const advance = () => {
      if (advanced) return;
      advanced = true;
      state.advanceCurrent = null;
      if (state.isReading) speakChunks(chunks, ci + 1, pIndex);
    };
    state.advanceCurrent = advance;

    utter.onend = advance;
    utter.onerror = (e) => {
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      console.warn('Error de síntesis:', e.error);
      advance();
    };

    synth.speak(utter);
  }

  function pauseReading() {
    if (state.isReading && !state.isPaused) {
      synth.pause();
      state.isPaused = true;
      updateControls();
    }
  }

  function stopReading() {
    state.isReading = false;
    state.isPaused = false;
    state.currentIndex = -1;
    state.advanceCurrent = null;
    state.currentUtterance = null;
    stopKeepAlive();
    stopWatchdog();
    if (synth.speaking || synth.pending) synth.cancel();
    clearHighlight();
    updateControls();
  }

  // En escritorio, Chrome detiene la síntesis tras ~15s; este "keep alive"
  // la mantiene activa. En móvil pause()/resume() es inestable, así que se
  // omite (los fragmentos cortos + el watchdog cubren ese caso).
  function startKeepAlive() {
    stopKeepAlive();
    if (IS_MOBILE) return;
    state.keepAliveTimer = setInterval(() => {
      if (state.isReading && !state.isPaused && synth.speaking) {
        synth.pause();
        synth.resume();
      }
    }, 10000);
  }
  function stopKeepAlive() {
    if (state.keepAliveTimer) {
      clearInterval(state.keepAliveTimer);
      state.keepAliveTimer = null;
    }
  }

  // Watchdog: si la síntesis se queda en silencio mientras "leemos" (por un
  // corte del navegador o un onend que no se dispara), reanuda el avance.
  function startWatchdog() {
    stopWatchdog();
    let idleTicks = 0;
    state.watchdogTimer = setInterval(() => {
      if (!state.isReading || state.isPaused) { idleTicks = 0; return; }
      if (synth.speaking || synth.pending) { idleTicks = 0; return; }
      idleTicks++;
      // ~1.4s de silencio inesperado => reactiva el avance.
      if (idleTicks >= 2) {
        idleTicks = 0;
        if (state.advanceCurrent) state.advanceCurrent();
      }
    }, 700);
  }
  function stopWatchdog() {
    if (state.watchdogTimer) {
      clearInterval(state.watchdogTimer);
      state.watchdogTimer = null;
    }
  }

  /* ====================================================================
   * 6. CONTROLES DE LA INTERFAZ
   * ==================================================================== */

  function updateControls() {
    const hasDoc = !!state.pdfDoc && state.paragraphs.length > 0;
    playBtn.disabled = !hasDoc || (state.isReading && !state.isPaused);
    pauseBtn.disabled = !state.isReading || state.isPaused;
    stopBtn.disabled = !state.isReading;
    playBtn.textContent = state.isPaused ? '▶ Reanudar' : '▶ Leer';

    const hasPdf = !!state.pdfDoc;
    zoomInBtn.disabled = !hasPdf || state.zoom >= 3;
    zoomOutBtn.disabled = !hasPdf || state.zoom <= 0.5;
    zoomFitBtn.disabled = !hasPdf;
  }

  // Vuelve a maquetar las páginas (zoom o cambio de tamaño de pantalla),
  // conservando aproximadamente la página que estaba arriba.
  let relayoutPending = false;
  async function relayout(recomputeFit) {
    if (!state.pdfDoc || relayoutPending) return;
    relayoutPending = true;
    const topPage = currentTopPage();
    if (recomputeFit) await computeFitScale();
    await renderAllPages();
    const el = state.pageEls[topPage];
    if (el) viewer.scrollTo({ top: pageTop(el) });
    updateControls();
    relayoutPending = false;
  }

  function currentTopPage() {
    const st = viewer.scrollTop;
    for (let n = 1; n < state.pageEls.length; n++) {
      const el = state.pageEls[n];
      if (!el) continue;
      if (pageTop(el) + el.offsetHeight > st) return n;
    }
    return 1;
  }

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  async function setZoom(z) {
    state.zoom = clamp(Math.round(z * 100) / 100, 0.5, 3);
    await relayout(false);
    savePosition();
  }

  zoomInBtn.addEventListener('click', () => setZoom(state.zoom + 0.2));
  zoomOutBtn.addEventListener('click', () => setZoom(state.zoom - 0.2));
  zoomFitBtn.addEventListener('click', () => setZoom(1));

  /* ---- Pinch-zoom con dos dedos (sin usar el zoom del navegador) ---- */
  function touchDist(t) {
    return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  }
  let pinch = null;

  viewer.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2 && state.pdfDoc && state.pagesWrapper) {
      pinch = { startDist: touchDist(e.touches), startZoom: state.zoom, ratio: 1 };
      state.pagesWrapper.style.transition = 'none';
      e.preventDefault();
    }
  }, { passive: false });

  viewer.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const target = clamp(pinch.startZoom * (touchDist(e.touches) / pinch.startDist), 0.5, 3);
    pinch.ratio = target / pinch.startZoom;
    // Vista previa fluida con CSS; al soltar se re-renderiza nítido.
    state.pagesWrapper.style.transform = `scale(${pinch.ratio})`;
  }, { passive: false });

  function endPinch() {
    if (!pinch) return;
    const newZoom = clamp(pinch.startZoom * pinch.ratio, 0.5, 3);
    const w = state.pagesWrapper;
    pinch = null;
    if (w) { w.style.transform = ''; w.style.transition = ''; }
    if (Math.abs(newZoom - state.zoom) > 0.01) setZoom(newZoom);
  }
  viewer.addEventListener('touchend', (e) => { if (pinch && e.touches.length < 2) endPinch(); });
  viewer.addEventListener('touchcancel', endPinch);

  // Reajusta al ancho al girar el teléfono o redimensionar la ventana.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (!state.pdfDoc) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => relayout(true), 300);
  });

  playBtn.addEventListener('click', startReading);
  pauseBtn.addEventListener('click', pauseReading);
  stopBtn.addEventListener('click', stopReading);

  langSelect.addEventListener('change', () => {
    populateVoiceSelect();
    if (state.isReading) stopReading();
  });

  voiceSelect.addEventListener('change', () => {
    // Si cambia la voz durante la lectura, reinicia desde el párrafo actual.
    if (state.isReading) {
      const idx = state.currentIndex;
      stopReading();
      if (idx >= 0) {
        state.isReading = true;
        startKeepAlive();
        startWatchdog();
        updateControls();
        speakParagraph(idx);
      }
    }
  });

  rateSlider.addEventListener('input', () => {
    rateValue.textContent = `${parseFloat(rateSlider.value).toFixed(1)}x`;
  });
  rateSlider.addEventListener('change', () => {
    // Aplica la nueva velocidad de inmediato reiniciando el párrafo actual.
    if (state.isReading && !state.isPaused) {
      const idx = state.currentIndex;
      synth.cancel();
      if (idx >= 0) speakParagraph(idx);
    }
  });

  // Atajo: barra espaciadora para leer/pausar (si no se escribe en un campo).
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.target === document.body) {
      e.preventDefault();
      if (state.isReading && !state.isPaused) pauseReading();
      else startReading();
    }
  });

  // Detiene la síntesis al cerrar/recargar la pestaña.
  window.addEventListener('beforeunload', () => synth.cancel());

  /* ====================================================================
   * 7. PERSISTENCIA (IndexedDB) Y BIBLIOTECA
   * ==================================================================== */

  const DB_NAME = 'lector-pdf';
  const STORE = 'pdfs';

  function openDB() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('IndexedDB no disponible'));
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbTx(mode, fn) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  const dbPut = (rec) => dbTx('readwrite', (s) => s.put(rec));
  const dbGet = (id) => dbTx('readonly', (s) => s.get(id));
  const dbGetAll = () => dbTx('readonly', (s) => s.getAll());
  const dbDelete = (id) => dbTx('readwrite', (s) => s.delete(id));

  async function updateMeta(id, partial) {
    try {
      const rec = await dbGet(id);
      if (!rec) return;
      Object.assign(rec, partial);
      await dbPut(rec);
    } catch (e) { /* persistencia no disponible */ }
  }

  // Guarda la posición de lectura (proporción del scroll) y el zoom.
  let saveTimer = null;
  function savePosition() {
    if (!state.currentDocId) return;
    const max = viewer.scrollHeight - viewer.clientHeight;
    const frac = max > 0 ? viewer.scrollTop / max : 0;
    updateMeta(state.currentDocId, { scrollFraction: frac, zoom: state.zoom, savedAt: Date.now() });
  }

  viewer.addEventListener('scroll', () => {
    if (!state.currentDocId) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(savePosition, 500);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') savePosition();
  });
  window.addEventListener('pagehide', savePosition);

  // ---- Biblioteca (lista de PDFs guardados) ----
  function buildLibrary(container, items) {
    container.innerHTML = '';
    const title = document.createElement('h2');
    title.className = 'library__title';
    title.textContent = '📚 Mis PDFs guardados';
    container.appendChild(title);

    if (!items.length) {
      const p = document.createElement('p');
      p.className = 'library__empty';
      p.textContent = 'Aún no has guardado ningún PDF. Ábrelo con “📂 Abrir PDF”.';
      container.appendChild(p);
      return;
    }

    for (const it of items) {
      const pct = Math.round((it.scrollFraction || 0) * 100);
      const row = document.createElement('div');
      row.className = 'lib-item';
      row.innerHTML =
        '<span class="lib-item__icon">📕</span>' +
        '<div class="lib-item__info">' +
        '<div class="lib-item__name"></div>' +
        '<div class="lib-item__meta"></div>' +
        '</div>';
      row.querySelector('.lib-item__name').textContent = it.name;
      row.querySelector('.lib-item__meta').textContent =
        `${it.numPages ? it.numPages + ' págs · ' : ''}` +
        (pct > 0 ? `vas por ${pct}%` : 'sin empezar');

      const del = document.createElement('button');
      del.className = 'lib-item__del';
      del.textContent = '🗑';
      del.title = 'Eliminar de la biblioteca';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        await dbDelete(it.id).catch(() => {});
        if (state.currentDocId === it.id) state.currentDocId = null;
        refreshLibrary();
      });
      row.appendChild(del);

      row.addEventListener('click', () => openFromLibrary(it.id));
      container.appendChild(row);
    }
  }

  async function refreshLibrary() {
    let items = [];
    try { items = (await dbGetAll()) || []; } catch (e) { /* sin persistencia */ }
    items.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    buildLibrary(libraryList, items);
    buildLibrary(libOverlayList, items);
  }

  async function openFromLibrary(id) {
    closeLibraryOverlay();
    const rec = await dbGet(id).catch(() => null);
    if (!rec || !rec.blob) { showToast('No se encontró el PDF guardado.'); return; }
    const buf = await rec.blob.arrayBuffer();
    await openDocument(buf, rec);
  }

  function closeLibraryOverlay() { libOverlay.classList.remove('is-open'); }

  libraryBtn.addEventListener('click', async () => {
    await refreshLibrary();
    libOverlay.classList.add('is-open');
  });
  libCloseBtn.addEventListener('click', closeLibraryOverlay);
  libOverlay.addEventListener('click', (e) => {
    if (e.target === libOverlay) closeLibraryOverlay();
  });

  /* ====================================================================
   * 8. UTILIDADES UI
   * ==================================================================== */

  let toastEl = null;
  let toastTimer = null;
  function showToast(msg, autoHide) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.display = 'block';
    if (toastTimer) clearTimeout(toastTimer);
    if (autoHide) toastTimer = setTimeout(hideToast, autoHide);
  }
  function hideToast() {
    if (toastEl) toastEl.style.display = 'none';
  }

  // Estado inicial de los controles y biblioteca.
  updateControls();
  refreshLibrary();
})();
