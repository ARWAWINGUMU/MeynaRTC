// =====================================================================
// LABORATORIO DSP — Procesamiento Digital de Señales para MeynaRTC
// =====================================================================
// Este módulo analiza EN PARALELO la misma señal de audio que el emisor
// transmite por WebRTC: la captura (getUserMedia/getDisplayMedia) ocurre
// una sola vez en index.html; aquí solo "escuchamos" esa misma señal con
// la Web Audio API para dibujarla y calcular sus propiedades, sin
// interferir en absoluto con la transmisión.
//
//   Micrófono -> Captura de audio -> [ Procesamiento DSP + Visualización ]
//                                  -> WebRTC transmite el audio
//
// Todo el código está comentado en español y explica, punto por punto,
// qué representa cada cálculo desde el punto de vista de Procesamiento
// Digital de Señales (PDS). No se usa ninguna librería externa: solo la
// Web Audio API (nativa del navegador) y Canvas 2D para dibujar.
window.MeynaDSP = (function () {
  'use strict';

  // -------------------------------------------------------------------
  // Configuración y estado del módulo
  // -------------------------------------------------------------------
  const FFT_SIZE = 2048;          // Tamaño de bloque para la FFT (potencia de 2).
  const INTERVALO_FFT_MS = 100;   // Recalculamos FFT/espectrograma/estadísticas ~10 veces/seg.
  const DB_MIN = -100;            // Piso de visualización (silencio / ruido de fondo del mic).
  const DB_MAX = -20;             // Techo de visualización (voz fuerte / pico de energía).
  const MAX_PUNTOS_GRAFICA = 50;  // Cuántos puntos históricos guardan las mini-gráficas de Estadísticas.

  // Paleta de color tipo "viridis" (5 colores ancla + interpolación lineal),
  // usada para pintar el espectrograma. Perceptualmente uniforme y sin
  // necesidad de ninguna librería de color.
  const PALETA_VIRIDIS = [
    [68, 1, 84],     // silencio: morado oscuro
    [59, 82, 139],   // azul
    [33, 145, 140],  // verde azulado
    [94, 201, 98],   // verde
    [253, 231, 37]   // pico de energía: amarillo
  ];

  let audioCtx = null;      // AudioContext único para toda la sesión (no se recrea nunca).
  let analyser = null;      // AnalyserNode: lo usamos SOLO como buffer de acceso a muestras reales.
  let sourceNode = null;    // Nodo que conecta el MediaStream actual al analyser.
  let rafId = null;         // id del requestAnimationFrame en curso (null = loop detenido).
  let panelVisible = false; // el loop solo corre si el panel está visible (ahorra CPU).
  let ultimoCalculoFft = 0; // marca de tiempo del último recálculo de FFT (para el throttle).

  // Buffers reutilizables: se asignan UNA sola vez y se sobrescriben en
  // cada frame, para no generar basura (garbage collection) en un bucle
  // que corre continuamente mientras dura la transmisión.
  let bufferTiempo = null;      // muestras crudas x[n] en el dominio del tiempo, en [-1, 1].
  let bufferVentaneado = null;  // mismas muestras tras aplicar la ventana de Hann.
  let bufferRe = null;          // parte real del espectro (entrada y salida de la FFT).
  let bufferIm = null;          // parte imaginaria del espectro.
  let bufferMagnitudesDb = null; // magnitud en dB por cada bin de frecuencia (solo hasta Nyquist).

  // Gráficas de Chart.js para la pestaña de Estadísticas (se crean una sola
  // vez, de forma perezosa, reutilizando el helper createChart() que YA
  // existe en index.html para las gráficas de bitrate/jitter/etc.).
  let graficaEnergia = null;
  let graficaPotencia = null;
  let graficaRms = null;

  // -------------------------------------------------------------------
  // MATEMÁTICA: Transformada Rápida de Fourier (FFT)
  // -------------------------------------------------------------------
  // Algoritmo de Cooley-Tukey, radix-2, decimación en el tiempo (DIT),
  // en forma ITERATIVA e IN-PLACE (sin recursión, sin asignar memoria
  // nueva). Es el algoritmo "canónico" que se enseña en cursos de PDS:
  // reduce el costo de calcular la Transformada Discreta de Fourier (DFT)
  // de O(N²) a O(N·log₂N) explotando la simetría de las raíces de la
  // unidad complejas.
  //
  // Precondición: re.length === im.length === N, con N potencia de 2.
  // Postcondición: re[]/im[] quedan sobrescritos con el espectro complejo
  // X[k] = Σ x[n]·e^{-i·2πkn/N}. Para una señal real de entrada, solo los
  // índices 0..N/2 son información única (el resto es el conjugado
  // simétrico: X[N-k] es el conjugado de X[k]), por eso más abajo solo
  // graficamos la primera mitad del espectro.
  function calcularFFT(re, im) {
    const n = re.length;

    // --- Paso 1: reordenamiento "bit-reversal" ---
    // La FFT "divide y vencerás" separa recursivamente las muestras
    // pares de las impares en cada nivel. Al "aplanar" esa recursión en
    // una forma iterativa, el efecto neto es que la muestra que estaba
    // en la posición i debe procesarse en la posición j = i con los bits
    // de su índice invertidos (ej. con N=8, la muestra 1 = 001b termina
    // en la posición 100b = 4). Este bucle calcula esa permutación en
    // O(N), sin recursión.
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
        tmp = im[i]; im[i] = im[j]; im[j] = tmp;
      }
    }

    // --- Paso 2: mariposas (butterflies) combinadas por etapas ---
    // Hay log2(N) etapas. En la etapa donde el tamaño de sub-bloque es
    // "len", combinamos pares de sub-FFTs de tamaño len/2 en una FFT de
    // tamaño len, usando el factor de giro (twiddle factor)
    // W_len^k = e^{-i·2πk/len} = cos(2πk/len) - i·sen(2πk/len).
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wRe = Math.cos(ang);
      const wIm = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let curRe = 1; // W_len^0 = 1, se va acumulando W_len^k en cada paso k
        let curIm = 0;
        for (let k = 0; k < len / 2; k++) {
          const idxA = i + k;
          const idxB = i + k + len / 2;
          // v = elemento B rotado por el factor de giro actual
          const vRe = re[idxB] * curRe - im[idxB] * curIm;
          const vIm = re[idxB] * curIm + im[idxB] * curRe;
          const uRe = re[idxA];
          const uIm = im[idxA];
          // Mariposa: salida_par = u + v ; salida_impar = u - v
          re[idxA] = uRe + vRe; im[idxA] = uIm + vIm;
          re[idxB] = uRe - vRe; im[idxB] = uIm - vIm;
          // Avanzamos el factor de giro: W_len^(k+1) = W_len^k · W_len^1
          const nextRe = curRe * wRe - curIm * wIm;
          const nextIm = curRe * wIm + curIm * wRe;
          curRe = nextRe; curIm = nextIm;
        }
      }
    }
  }

  // Ventana de Hann: w[n] = 0.5·(1 - cos(2πn/(N-1))).
  // Al analizar un bloque FINITO de una señal continua (el audio del
  // micrófono no empieza ni termina en el borde del bloque), aparecen
  // discontinuidades artificiales que "ensucian" el espectro con energía
  // esparcida en frecuencias que no existen en la señal real (fenómeno
  // conocido como "spectral leakage"). Multiplicar por una ventana que
  // atenúa suavemente los bordes del bloque reduce ese efecto.
  function aplicarVentanaHann(entrada, salida) {
    const n = entrada.length;
    for (let i = 0; i < n; i++) {
      const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
      salida[i] = entrada[i] * w;
    }
    return salida;
  }

  // Convierte el espectro complejo (re, im) en magnitud expresada en
  // decibelios (escala logarítmica, la forma habitual de visualizar un
  // espectro de audio porque el oído humano percibe la intensidad de
  // forma logarítmica). Solo se calculan los bins 0..N/2 (hasta la
  // frecuencia de Nyquist), que es donde está toda la información única
  // de una señal real.
  function calcularMagnitudesDb(re, im, destino) {
    const mitad = destino.length; // N/2
    const n = re.length;          // N
    const EPS = 1e-12;            // evita log(0) = -Infinity en silencio total
    for (let k = 0; k < mitad; k++) {
      // Normalizamos por 2/N: la energía de una señal real se reparte
      // entre frecuencias positivas y negativas; al graficar solo el
      // lado positivo, multiplicamos por 2 para recuperar la amplitud
      // original de cada componente senoidal.
      const magnitud = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * (2 / n);
      const db = 20 * Math.log10(Math.max(magnitud, EPS));
      destino[k] = Math.max(db, DB_MIN);
    }
    return destino;
  }

  // -------------------------------------------------------------------
  // MATEMÁTICA: Energía, Potencia y RMS (dominio del tiempo)
  // -------------------------------------------------------------------
  function calcularEstadisticas(muestras) {
    // Energía instantánea del bloque: E = Σ x[n]².
    // Representa la energía total contenida en las N muestras capturadas
    // (proporcional a la energía física de la onda sonora en ese instante).
    let energia = 0;
    for (let n = 0; n < muestras.length; n++) {
      energia += muestras[n] * muestras[n];
    }

    // Potencia promedio: P = (1/N)·Σ x[n]² = E / N.
    // Es la energía repartida entre las N muestras: mide qué tan "fuerte"
    // es la señal en promedio durante ese bloque, sin importar N.
    const potencia = energia / muestras.length;

    // Valor eficaz (RMS, Root Mean Square): RMS = √P.
    // Es la métrica estándar de "volumen" de una señal de audio: una
    // señal senoidal de amplitud A tiene RMS = A/√2. A mayor RMS, más
    // fuerte se percibe el sonido.
    const rms = Math.sqrt(potencia);

    return { energia, potencia, rms };
  }

  // -------------------------------------------------------------------
  // Color por magnitud en dB (paleta viridis, interpolación lineal)
  // -------------------------------------------------------------------
  function colorPorDb(db) {
    const t = Math.min(1, Math.max(0, (db - DB_MIN) / (DB_MAX - DB_MIN)));
    const escala = t * (PALETA_VIRIDIS.length - 1);
    const i = Math.floor(escala);
    const frac = escala - i;
    const c0 = PALETA_VIRIDIS[i];
    const c1 = PALETA_VIRIDIS[Math.min(i + 1, PALETA_VIRIDIS.length - 1)];
    const r = Math.round(c0[0] + (c1[0] - c0[0]) * frac);
    const g = Math.round(c0[1] + (c1[1] - c0[1]) * frac);
    const b = Math.round(c0[2] + (c1[2] - c0[2]) * frac);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  // -------------------------------------------------------------------
  // Dibujo: Osciloscopio (dominio del tiempo)
  // -------------------------------------------------------------------
  function dibujarOsciloscopio(buffer) {
    const canvas = document.getElementById('dspOscilloscopeCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;

    ctx.fillStyle = '#02070d';
    ctx.fillRect(0, 0, w, h);

    // Línea de referencia en amplitud 0.
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    // Forma de onda: x[n] está en [-1, 1]; lo mapeamos a [0, h] con 0 al centro.
    ctx.strokeStyle = '#5ee7d4';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const paso = w / buffer.length;
    for (let i = 0; i < buffer.length; i++) {
      const x = i * paso;
      const y = (1 - buffer[i]) * (h / 2);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // -------------------------------------------------------------------
  // Dibujo: Espectro FFT (dominio de la frecuencia)
  // -------------------------------------------------------------------
  function dibujarFft(magnitudesDb) {
    const canvas = document.getElementById('dspFftCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    const nyquist = audioCtx.sampleRate / 2; // máxima frecuencia representable dado el sampleRate

    ctx.fillStyle = '#02070d';
    ctx.fillRect(0, 0, w, h);

    // Líneas guía cada 20 dB con su etiqueta.
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '10px sans-serif';
    for (let db = DB_MAX; db >= DB_MIN; db -= 20) {
      const y = h - ((db - DB_MIN) / (DB_MAX - DB_MIN)) * h;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.fillText(db + ' dB', 4, Math.max(10, y - 2));
    }

    // Espectro de magnitud.
    ctx.strokeStyle = '#4f9cff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const n = magnitudesDb.length;
    for (let k = 0; k < n; k++) {
      const x = (k / n) * w;
      const y = h - ((magnitudesDb[k] - DB_MIN) / (DB_MAX - DB_MIN)) * h;
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Marcas de frecuencia (eje X) en 0, Nyquist/4, Nyquist/2, 3·Nyquist/4, Nyquist.
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    for (let f = 0; f <= nyquist; f += nyquist / 4) {
      const x = (f / nyquist) * w;
      ctx.fillText(Math.round(f) + ' Hz', Math.min(Math.max(x, 2), w - 45), h - 4);
    }
  }

  // -------------------------------------------------------------------
  // Dibujo: Espectrograma (tiempo x frecuencia x color=intensidad)
  // -------------------------------------------------------------------
  function dibujarColumnaEspectrograma(magnitudesDb) {
    const canvas = document.getElementById('dspSpectrogramCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;

    // Desplazamos todo el contenido existente 1px a la izquierda para
    // "hacer espacio" a la columna nueva (scroll horizontal eficiente:
    // el propio canvas sirve de origen y destino del drawImage).
    ctx.drawImage(canvas, 1, 0, w - 1, h, 0, 0, w - 1, h);

    // Pintamos la columna más reciente en el borde derecho, bin por bin.
    // Fila 0 (arriba) = frecuencias altas; fila h-1 (abajo) = graves,
    // igual que en Audacity.
    const nyquist = audioCtx.sampleRate / 2;
    const numBins = magnitudesDb.length;
    for (let y = 0; y < h; y++) {
      const frecuencia = ((h - 1 - y) / (h - 1)) * nyquist;
      const bin = Math.min(numBins - 1, Math.round((frecuencia / nyquist) * (numBins - 1)));
      ctx.fillStyle = colorPorDb(magnitudesDb[bin]);
      ctx.fillRect(w - 1, y, 1, 1);
    }
  }

  // -------------------------------------------------------------------
  // Pestaña Estadísticas: valores numéricos + mini-gráficas (Chart.js)
  // -------------------------------------------------------------------
  function inicializarGraficasEstadisticas() {
    if (graficaEnergia || typeof window.createChart !== 'function') return;
    // Reutilizamos createChart() de index.html (la misma función que ya
    // dibuja bitrate/jitter/pérdida/RTT) para no duplicar lógica de
    // gráficas. Se usan 3 gráficas SEPARADAS -no una combinada- porque
    // la Energía vive en una escala muy distinta a Potencia/RMS y se
    // aplastarían visualmente en un solo eje Y.
    graficaEnergia = window.createChart('dspEnergyChart', 'Energía instantánea');
    graficaPotencia = window.createChart('dspPowerChart', 'Potencia promedio');
    graficaRms = window.createChart('dspRmsChart', 'Nivel RMS');
  }

  function agregarPunto(chart, valor) {
    if (!chart) return;
    const serie = chart.data.datasets[0].data;
    serie.push(valor);
    if (serie.length > MAX_PUNTOS_GRAFICA) serie.shift();
    chart.data.labels = serie.map((_, i) => i + 1);
    chart.update();
  }

  function actualizarEstadisticas(stats) {
    const energyEl = document.getElementById('dspEnergyValue');
    const powerEl = document.getElementById('dspPowerValue');
    const rmsEl = document.getElementById('dspRmsValue');
    if (energyEl) energyEl.textContent = stats.energia.toFixed(2);
    if (powerEl) powerEl.textContent = stats.potencia.toFixed(4);
    if (rmsEl) rmsEl.textContent = stats.rms.toFixed(4);

    inicializarGraficasEstadisticas();
    agregarPunto(graficaEnergia, stats.energia);
    agregarPunto(graficaPotencia, stats.potencia);
    agregarPunto(graficaRms, stats.rms);
  }

  // -------------------------------------------------------------------
  // Ciclo de vida de la captura (Web Audio API)
  // -------------------------------------------------------------------
  function actualizarEstadoPanel(texto) {
    const el = document.getElementById('dspStatus');
    if (el) el.textContent = texto;
  }

  function iniciarLoopSiCorresponde() {
    if (rafId !== null || !panelVisible || !sourceNode) return;
    rafId = requestAnimationFrame(loopPrincipal);
  }

  function detenerLoop() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  function loopPrincipal(timestampMs) {
    rafId = requestAnimationFrame(loopPrincipal);
    if (!analyser) return;

    // Osciloscopio: se redibuja cada frame (barato, no involucra la FFT).
    analyser.getFloatTimeDomainData(bufferTiempo);
    dibujarOsciloscopio(bufferTiempo);

    // FFT + espectrograma + estadísticas: throttle a ~10 Hz, no hace
    // falta recalcularlos a 60fps para que se vean "en tiempo real".
    if (timestampMs - ultimoCalculoFft >= INTERVALO_FFT_MS) {
      ultimoCalculoFft = timestampMs;

      aplicarVentanaHann(bufferTiempo, bufferVentaneado);
      bufferRe.set(bufferVentaneado);
      bufferIm.fill(0);
      calcularFFT(bufferRe, bufferIm);

      calcularMagnitudesDb(bufferRe, bufferIm, bufferMagnitudesDb);
      dibujarFft(bufferMagnitudesDb);
      dibujarColumnaEspectrograma(bufferMagnitudesDb);

      // Las estadísticas se calculan sobre la señal CRUDA (sin ventana de
      // Hann): la ventana es una herramienta exclusiva del análisis
      // espectral, no debe alterar la energía/potencia/RMS reales.
      actualizarEstadisticas(calcularEstadisticas(bufferTiempo));
    }
  }

  // Conecta el módulo DSP al MediaStream que el emisor está capturando.
  // Se llama tanto al iniciar la transmisión como al cambiar de modo
  // (audio/cámara/pantalla), siempre con el stream vigente.
  // FAIL-SAFE: cualquier error queda contenido aquí adentro (con
  // console.warn) y jamás se propaga hacia startMedia()/startBroadcast(),
  // para no romper la transmisión si el análisis DSP falla por cualquier
  // motivo (navegador sin soporte, permisos, etc.).
  function attachStream(mediaStream) {
    try {
      if (!audioCtx) {
        const AudioContextClase = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClase) throw new Error('Web Audio API no soportada en este navegador');
        audioCtx = new AudioContextClase();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = FFT_SIZE;
        bufferTiempo = new Float32Array(FFT_SIZE);
        bufferVentaneado = new Float32Array(FFT_SIZE);
        bufferRe = new Float32Array(FFT_SIZE);
        bufferIm = new Float32Array(FFT_SIZE);
        bufferMagnitudesDb = new Float32Array(FFT_SIZE / 2);
      }
      // Los navegadores modernos crean el AudioContext en estado
      // "suspended" hasta un gesto explícito del usuario (política de
      // autoplay). attachStream() siempre se dispara desde un clic
      // ("Iniciar transmisión" o el selector de modo), así que ya estamos
      // dentro de un gesto válido para reanudarlo.
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(function () {});
      }

      // Solo desconectamos el nodo fuente anterior; el AudioContext y el
      // AnalyserNode se conservan para toda la sesión (crearlos de nuevo
      // en cada cambio de modo sería costoso y puede agotar el límite de
      // AudioContext simultáneos que imponen algunos navegadores).
      if (sourceNode) {
        sourceNode.disconnect();
        sourceNode = null;
      }

      const pistasAudio = mediaStream.getAudioTracks();
      if (pistasAudio.length === 0) {
        // Ej.: se comparte pantalla sin incluir el audio del sistema.
        detachStream('Sin pista de audio disponible en el modo actual.');
        return;
      }

      sourceNode = audioCtx.createMediaStreamSource(mediaStream);
      sourceNode.connect(analyser);
      // Importante: NUNCA conectamos analyser -> audioCtx.destination,
      // porque eso reproduciría el propio micrófono por los parlantes
      // (eco). El analyser solo necesita "escuchar", no "sonar".

      actualizarEstadoPanel('Analizando la señal en vivo…');
      iniciarLoopSiCorresponde();
    } catch (err) {
      console.warn('MeynaDSP: no se pudo inicializar el análisis de audio', err);
    }
  }

  // Desconecta el análisis del stream actual (al detener la transmisión,
  // o internamente cuando el modo activo no tiene pista de audio).
  // El AudioContext NO se cierra: queda listo para un próximo attachStream().
  function detachStream(motivo) {
    detenerLoop();
    if (sourceNode) {
      sourceNode.disconnect();
      sourceNode = null;
    }
    actualizarEstadoPanel(motivo || 'Esperando transmisión activa…');
  }

  // -------------------------------------------------------------------
  // Interfaz: botón, panel y pestañas
  // -------------------------------------------------------------------
  function initUI() {
    const toggleBtn = document.getElementById('toggleDspBtn');
    const panel = document.getElementById('dspPanel');
    if (!toggleBtn || !panel) return; // defensivo: no romper si el HTML aún no incluye el panel

    toggleBtn.addEventListener('click', function () {
      panelVisible = panel.style.display === 'none';
      panel.style.display = panelVisible ? 'block' : 'none';
      if (panelVisible) {
        if (audioCtx && audioCtx.state === 'suspended') {
          audioCtx.resume().catch(function () {});
        }
        inicializarGraficasEstadisticas();
        // Chart.js puede haber calculado tamaño 0 si se creó mientras el
        // panel estaba oculto; forzamos un resize al mostrarlo.
        [graficaEnergia, graficaPotencia, graficaRms].forEach(function (c) {
          if (c) c.resize();
        });
        iniciarLoopSiCorresponde();
      } else {
        detenerLoop();
      }
    });

    const botonesTab = document.querySelectorAll('.dsp-tab-btn');
    botonesTab.forEach(function (btn) {
      btn.addEventListener('click', function () {
        botonesTab.forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        document.querySelectorAll('.dsp-tab-content').forEach(function (div) {
          div.style.display = 'none';
        });
        const objetivo = document.getElementById(btn.dataset.target);
        if (objetivo) objetivo.style.display = 'block';
        // Las gráficas de la pestaña Estadísticas se crean la primera vez
        // que hay datos que graficar, lo cual puede ocurrir mientras esa
        // pestaña todavía está oculta (canvas con tamaño 0). Al mostrarla
        // forzamos un resize para que Chart.js recalcule sus dimensiones
        // reales; si no, quedarían en blanco para siempre.
        if (btn.dataset.target === 'dspTabEstadisticas') {
          [graficaEnergia, graficaPotencia, graficaRms].forEach(function (c) {
            if (c) c.resize();
          });
        }
      });
    });
  }

  // El propio módulo se inicializa apenas se carga (el <script src="/dsp.js">
  // se coloca en index.html DESPUÉS del HTML del botón/panel, así que estos
  // elementos ya existen en el DOM en este punto).
  initUI();

  return { attachStream: attachStream, detachStream: detachStream };
})();
