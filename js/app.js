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
  const prevBtn     = document.getElementById('prevBtn');
  const nextBtn     = document.getElementById('nextBtn');
  const zoomInBtn   = document.getElementById('zoomInBtn');
  const zoomOutBtn  = document.getElementById('zoomOutBtn');
  const zoomFitBtn  = document.getElementById('zoomFitBtn');
  const menuBtn     = document.getElementById('menuBtn');
  const menuPanel   = document.getElementById('menuPanel');
  const searchToggle = document.getElementById('searchToggle');
  const searchPanel = document.getElementById('searchPanel');
  const searchInput = document.getElementById('searchInput');
  const searchCount = document.getElementById('searchCount');
  const searchResults = document.getElementById('searchResults');
  const searchClose = document.getElementById('searchClose');
  const fab         = document.getElementById('fab');
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
    pageDims: [],           // dimensiones (escala 1) por página
    io: null,               // IntersectionObserver para render perezoso
    currentChunks: null,    // fragmentos del párrafo en curso (para reanudar)
    currentChunkIndex: 0,   // fragmento actual dentro del párrafo
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
    await computeFitScale();
    await buildAllParagraphs(); // extrae texto/geometría una sola vez
    layoutPages();              // crea las páginas al zoom actual

    // Restaura la posición donde se quedó la última vez.
    requestAnimationFrame(() => {
      const max = viewer.scrollHeight - viewer.clientHeight;
      viewer.scrollTop = Math.max(0, (meta.scrollFraction || 0) * max);
    });

    if (meta.id) updateMeta(meta.id, { numPages: state.pdfDoc.numPages });
    updateControls();
    closeMenu();
    if (searchInput.value.trim()) runSearch(); // refresca resultados si había búsqueda
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

  // Extrae el texto y construye los párrafos UNA vez por documento.
  // La geometría se guarda en unidades de escala 1 (independiente del zoom),
  // así el zoom no necesita recalcular el texto ni interrumpir la lectura.
  async function buildAllParagraphs() {
    state.paragraphs = [];
    state.pageDims = [];
    for (let n = 1; n <= state.pdfDoc.numPages; n++) {
      const page = await state.pdfDoc.getPage(n);
      const vp1 = page.getViewport({ scale: 1 });
      state.pageDims[n] = { w: vp1.width, h: vp1.height };
      const textContent = await page.getTextContent();
      buildParagraphs(textContent, vp1, n);
    }
  }

  // Crea/recrea los contenedores de página al zoom actual (operación rápida y
  // síncrona: no toca los párrafos ni la lectura en curso).
  function layoutPages() {
    if (state.io) state.io.disconnect();
    viewer.innerHTML = '';
    state.pageEls = [];

    state.pagesWrapper = document.createElement('div');
    state.pagesWrapper.className = 'pages-wrapper';
    viewer.appendChild(state.pagesWrapper);

    state.highlightEl = document.createElement('div');
    state.highlightEl.className = 'reading-highlight';
    state.pagesWrapper.appendChild(state.highlightEl);

    const s = currentScale();
    for (let n = 1; n <= state.pdfDoc.numPages; n++) {
      const dims = state.pageDims[n];
      const pageEl = document.createElement('div');
      pageEl.className = 'page';
      pageEl.style.width = `${dims.w * s}px`;
      pageEl.style.height = `${dims.h * s}px`;
      pageEl.dataset.pageNum = String(n);
      pageEl.dataset.rendered = 'false';

      const placeholder = document.createElement('div');
      placeholder.className = 'page__placeholder';
      placeholder.textContent = `Página ${n}`;
      pageEl.appendChild(placeholder);

      state.pagesWrapper.appendChild(pageEl);
      state.pageEls[n] = pageEl;
    }
    setupLazyRendering();
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
    state.io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) renderPageCanvas(entry.target);
        });
      },
      { root: viewer, rootMargin: '600px 0px' }
    );
    state.pageEls.forEach((el) => el && state.io.observe(el));
  }

  /* ====================================================================
   * 3. AGRUPACIÓN DE TEXTO EN PÁRRAFOS
   * ==================================================================== */

  function buildParagraphs(textContent, viewport, pageNum) {
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
      // box en unidades de escala 1; al posicionar se multiplica por la escala.
      state.paragraphs.push({
        text,
        pageNum,
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
    const el = state.pageEls[p.pageNum];
    if (!el) return;
    const s = currentScale();
    const hl = state.highlightEl;
    const x = el.offsetLeft + p.box.left * s;
    const y = el.offsetTop + p.box.top * s;
    hl.style.transform = `translate(${x}px, ${y}px)`;
    hl.style.width = `${p.box.width * s}px`;
    hl.style.height = `${p.box.height * s}px`;
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

  // Posición absoluta (en el scroll) del borde superior de un párrafo.
  function paragraphTop(p) {
    const el = state.pageEls[p.pageNum];
    return el ? pageTop(el) + p.box.top * currentScale() : 0;
  }

  function scrollParagraphIntoView(index) {
    const p = state.paragraphs[index];
    if (!p || !state.pageEls[p.pageNum]) return;
    const targetTop = paragraphTop(p);
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
    const s = currentScale();
    for (let i = 0; i < state.paragraphs.length; i++) {
      const p = state.paragraphs[i];
      const el = state.pageEls[p.pageNum];
      if (!el) continue;
      const bottom = pageTop(el) + (p.box.top + p.box.height) * s;
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
    closeMenu(); // deja ver el PDF mientras lee
    if (state.isPaused) { resumeReading(); return; } // reanudar
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

  // Reanuda manualmente desde el fragmento guardado (pause()/resume() del
  // navegador no es fiable, sobre todo en móvil).
  function resumeReading() {
    const idx = state.currentIndex >= 0 ? state.currentIndex : findParagraphAtTop();
    if (idx < 0) { stopReading(); return; }
    state.isPaused = false;
    state.isReading = true;
    startKeepAlive();
    startWatchdog();
    updateControls();
    const chunks = (state.currentChunks && state.currentChunks.length)
      ? state.currentChunks
      : chunkText(state.paragraphs[idx].text);
    highlightParagraph(idx);
    scrollParagraphIntoView(idx);
    speakChunks(chunks, state.currentChunkIndex || 0, idx);
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
    state.currentChunks = chunks;
    state.currentChunkIndex = 0;
    speakChunks(chunks, 0, index);
  }

  function speakChunks(chunks, ci, pIndex) {
    if (!state.isReading || state.isPaused) return;

    if (ci >= chunks.length) {
      speakParagraph(pIndex + 1); // Siguiente párrafo
      return;
    }

    state.currentChunks = chunks;
    state.currentChunkIndex = ci; // recuerda el punto para reanudar

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
      state.isPaused = true;
      // Corta la locución; al reanudar se vuelve a leer desde el fragmento
      // guardado (más fiable que synth.pause()/resume(), roto en móvil).
      if (synth.speaking || synth.pending) synth.cancel();
      updateControls();
    }
  }

  // Salta al párrafo anterior/siguiente mientras se lee (delta = -1 o +1).
  function skipParagraph(delta) {
    if (!state.isReading || state.paragraphs.length === 0) return;
    const base = state.currentIndex >= 0 ? state.currentIndex : 0;
    const idx = clamp(base + delta, 0, state.paragraphs.length - 1);
    state.isPaused = false;
    synth.cancel();            // corta la locución actual (se ignora "canceled")
    speakParagraph(idx);       // empieza a leer desde el nuevo párrafo
    updateControls();
  }

  function stopReading() {
    state.isReading = false;
    state.isPaused = false;
    state.currentIndex = -1;
    state.advanceCurrent = null;
    state.currentUtterance = null;
    state.currentChunks = null;
    state.currentChunkIndex = 0;
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

    // Las flechas funcionan mientras se lee (incluido en pausa).
    prevBtn.disabled = !state.isReading;
    nextBtn.disabled = !state.isReading;

    const hasPdf = !!state.pdfDoc;
    zoomInBtn.disabled = !hasPdf || state.zoom >= 3;
    zoomOutBtn.disabled = !hasPdf || state.zoom <= 0.5;
    zoomFitBtn.disabled = !hasPdf;

    // Botón flotante de lectura.
    const playing = state.isReading && !state.isPaused;
    fab.hidden = !hasDoc;
    fab.textContent = playing ? '⏸' : '▶';
    fab.classList.toggle('is-playing', playing);
  }

  // Vuelve a maquetar las páginas (zoom o cambio de tamaño). NO interrumpe la
  // lectura: solo recalcula tamaños y reposiciona el resaltado.
  let relayoutPending = false;
  async function relayout(recomputeFit) {
    if (!state.pdfDoc || relayoutPending) return;
    relayoutPending = true;

    const reading = state.isReading;
    const keepIndex = state.currentIndex;
    const topPage = currentTopPage();

    if (recomputeFit) await computeFitScale();
    layoutPages(); // síncrono: no toca párrafos ni lectura

    // Reposiciona la vista: si está leyendo, sigue el párrafo actual.
    if (reading && keepIndex >= 0 && state.paragraphs[keepIndex]) {
      highlightParagraph(keepIndex);
      const top = paragraphTop(state.paragraphs[keepIndex]);
      viewer.scrollTo({ top: Math.max(0, top - 90) });
    } else {
      const el = state.pageEls[topPage];
      if (el) viewer.scrollTo({ top: pageTop(el) });
    }
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
  prevBtn.addEventListener('click', () => skipParagraph(-1));
  nextBtn.addEventListener('click', () => skipParagraph(1));

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
    if (e.target !== document.body) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (state.isReading && !state.isPaused) pauseReading();
      else startReading();
    } else if (e.code === 'ArrowRight' && state.isReading) {
      e.preventDefault();
      skipParagraph(1);
    } else if (e.code === 'ArrowLeft' && state.isReading) {
      e.preventDefault();
      skipParagraph(-1);
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
   * 8. MENÚ DESPLEGABLE, BUSCADOR Y BOTÓN FLOTANTE
   * ==================================================================== */

  function closeMenu() {
    menuPanel.classList.remove('is-open');
    menuBtn.classList.remove('is-active');
  }
  function closeSearch() {
    searchPanel.classList.remove('is-open');
    searchToggle.classList.remove('is-active');
  }

  menuBtn.addEventListener('click', () => {
    const open = menuPanel.classList.toggle('is-open');
    menuBtn.classList.toggle('is-active', open);
    if (open) closeSearch();
  });

  searchToggle.addEventListener('click', () => {
    const open = searchPanel.classList.toggle('is-open');
    searchToggle.classList.toggle('is-active', open);
    if (open) { closeMenu(); setTimeout(() => searchInput.focus(), 50); }
  });
  searchClose.addEventListener('click', closeSearch);

  // Botón flotante: alterna leer / pausar.
  fab.addEventListener('click', () => {
    if (state.isReading && !state.isPaused) pauseReading();
    else startReading();
  });

  // ---- Buscador de palabras ----
  // Pliega acentos manteniendo la longitud 1:1 con el texto original, para que
  // los índices de coincidencia sigan siendo válidos al resaltar.
  function fold(ch) {
    const n = ch.normalize('NFD');
    return (n[0] || ch).toLowerCase();
  }
  function foldText(s) {
    let out = '';
    for (const ch of s) out += fold(ch);
    return out;
  }
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  let searchTimer = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 180);
  });

  function runSearch() {
    const raw = searchInput.value.trim();
    searchResults.innerHTML = '';

    if (!state.pdfDoc || state.paragraphs.length === 0) {
      searchCount.textContent = '';
      searchResults.innerHTML = '<div class="search-empty">Abre un PDF para buscar.</div>';
      return;
    }
    if (raw.length < 2) {
      searchCount.textContent = '';
      searchResults.innerHTML = '<div class="search-empty">Escribe al menos 2 letras.</div>';
      return;
    }

    const q = foldText(raw);
    const qlen = raw.length;
    const results = [];
    let total = 0;

    for (let i = 0; i < state.paragraphs.length; i++) {
      const text = state.paragraphs[i].text;
      const folded = foldText(text);
      const positions = [];
      let idx = folded.indexOf(q);
      while (idx !== -1) {
        positions.push(idx);
        idx = folded.indexOf(q, idx + q.length);
      }
      if (positions.length) {
        results.push({ pIndex: i, positions, text, pageNum: state.paragraphs[i].pageNum });
        total += positions.length;
      }
    }

    searchCount.textContent = total
      ? `${total} resultado${total === 1 ? '' : 's'}`
      : 'Sin resultados';

    if (!results.length) {
      searchResults.innerHTML = '<div class="search-empty">No se encontró esa palabra.</div>';
      return;
    }

    const frag = document.createDocumentFragment();
    for (const r of results) {
      const el = document.createElement('div');
      el.className = 'search-result';
      el.innerHTML =
        `<span class="search-result__page">Página ${r.pageNum}` +
        (r.positions.length > 1 ? ` · ${r.positions.length} veces` : '') +
        `</span>` + buildSnippet(r.text, r.positions, qlen);
      el.addEventListener('click', () => {
        goToParagraph(r.pIndex);
        if (window.innerWidth < 700) closeSearch(); // en móvil deja ver el PDF
      });
      frag.appendChild(el);
    }
    searchResults.appendChild(frag);
  }

  // Construye un fragmento del párrafo con todas las coincidencias resaltadas.
  function buildSnippet(text, positions, qlen) {
    const first = positions[0];
    const start = Math.max(0, first - 50);
    const end = Math.min(text.length, first + qlen + 160);
    let html = start > 0 ? '…' : '';
    let cursor = start;
    for (const pos of positions) {
      if (pos < start || pos >= end) continue;
      html += escapeHtml(text.slice(cursor, pos));
      html += '<mark>' + escapeHtml(text.slice(pos, pos + qlen)) + '</mark>';
      cursor = pos + qlen;
    }
    html += escapeHtml(text.slice(cursor, end));
    if (end < text.length) html += '…';
    return html;
  }

  // Lleva la vista a un párrafo y lo resalta (desde el buscador).
  function goToParagraph(i) {
    const p = state.paragraphs[i];
    if (!p || !state.pageEls[p.pageNum]) return;
    state.currentIndex = i;
    highlightParagraph(i);
    const top = paragraphTop(p);
    viewer.scrollTo({ top: Math.max(0, top - 90), behavior: 'smooth' });
  }

  /* ====================================================================
   * 9. UTILIDADES UI
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
