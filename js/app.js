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
  const viewer      = document.getElementById('viewer');
  const emptyState  = document.getElementById('emptyState');

  const synth = window.speechSynthesis;

  // ---- Estado global ----
  const state = {
    pdfDoc: null,
    fitScale: 1,        // escala para ajustar la página al ancho del visor
    zoom: 1,            // multiplicador de zoom del usuario
    pageEls: [],        // contenedores .page por página
    paragraphs: [],     // lista plana de párrafos en orden de lectura
    highlightEl: null,  // único elemento de resaltado reutilizable
    currentIndex: -1,   // párrafo en lectura
    isReading: false,
    isPaused: false,
    voices: [],
    keepAliveTimer: null,
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
    if (file) loadPdf(file);
  });

  async function loadPdf(file) {
    stopReading();
    showToast('Cargando PDF…');

    const buf = await file.arrayBuffer();
    try {
      state.pdfDoc = await pdfjsLib.getDocument({ data: buf }).promise;
    } catch (err) {
      console.error(err);
      showToast('No se pudo abrir el PDF.');
      return;
    }

    state.zoom = 1;
    await computeFitScale();
    await renderAllPages();

    updateControls();
    hideToast();
    showToast(`PDF cargado: ${state.pdfDoc.numPages} páginas`, 2000);
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

    // Elemento de resaltado único.
    state.highlightEl = document.createElement('div');
    state.highlightEl.className = 'reading-highlight';
    viewer.appendChild(state.highlightEl);

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

    viewer.appendChild(pageEl);
    state.pageEls[pageNum] = pageEl;

    // Extrae texto y construye los párrafos con su geometría.
    const textContent = await page.getTextContent();
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

  function scrollParagraphIntoView(index) {
    const p = state.paragraphs[index];
    if (!p) return;
    const targetTop = p.pageEl.offsetTop + p.box.top;
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
      const bottom = p.pageEl.offsetTop + p.box.top + p.box.height;
      if (bottom > threshold) return i;
    }
    return state.paragraphs.length > 0 ? 0 : -1;
  }

  /* ====================================================================
   * 5. LECTURA EN VOZ ALTA
   * ==================================================================== */

  // Divide un párrafo largo en fragmentos cortos (por frases) para evitar
  // el corte de utterances largas en algunos navegadores.
  function chunkText(text, maxLen = 220) {
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

    utter.onend = () => {
      if (state.isReading) speakChunks(chunks, ci + 1, pIndex);
    };
    utter.onerror = (e) => {
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      console.warn('Error de síntesis:', e.error);
      if (state.isReading) speakChunks(chunks, ci + 1, pIndex);
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
    stopKeepAlive();
    if (synth.speaking || synth.pending) synth.cancel();
    clearHighlight();
    updateControls();
  }

  // Algunos navegadores (Chrome) detienen la síntesis tras ~15s en pausas
  // internas; este "keep alive" la mantiene activa.
  function startKeepAlive() {
    stopKeepAlive();
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
    if (el) viewer.scrollTo({ top: el.offsetTop });
    updateControls();
    relayoutPending = false;
  }

  function currentTopPage() {
    const st = viewer.scrollTop;
    for (let n = 1; n < state.pageEls.length; n++) {
      const el = state.pageEls[n];
      if (!el) continue;
      if (el.offsetTop + el.offsetHeight > st) return n;
    }
    return 1;
  }

  function setZoom(z) {
    state.zoom = Math.min(3, Math.max(0.5, Math.round(z * 100) / 100));
    relayout(false);
  }

  zoomInBtn.addEventListener('click', () => setZoom(state.zoom + 0.2));
  zoomOutBtn.addEventListener('click', () => setZoom(state.zoom - 0.2));
  zoomFitBtn.addEventListener('click', () => setZoom(1));

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
   * 7. UTILIDADES UI
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

  // Estado inicial de los controles.
  updateControls();
})();
