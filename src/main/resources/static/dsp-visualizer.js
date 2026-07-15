// =====================================================================
// VISUALIZADOR DE COMPARACIÓN — Fase 2 del Laboratorio DSP
// =====================================================================
// Dibuja, en la pestaña "Filtros", la señal ORIGINAL y la señal
// PROCESADA lado a lado (osciloscopio, FFT) más el espectrograma de la
// procesada y las métricas de potencia/SNR. Reutiliza al máximo las
// funciones ya existentes de dsp.js (FFT propia, ventana de Hann, dibujo
// en canvas, cálculo de energía/potencia/RMS) en vez de duplicarlas: este
// archivo solo ORQUESTA, no reimplementa matemática de PDS.
//
// Corre su PROPIO bucle requestAnimationFrame, independiente del de
// dsp.js, activo únicamente mientras la pestaña "Filtros" está visible
// (mismo espíritu del patrón panelVisible/iniciarLoopSiCorresponde de
// dsp.js, adaptado a un módulo separado). Usa sus PROPIOS buffers
// Float32Array: no comparte los de dsp.js porque hay dos bucles RAF
// corriendo en paralelo y compartir memoria mutable entre ellos sería una
// condición de carrera.
(function () {
  'use strict';

  const INTERVALO_FFT_MS = 100; // mismo ritmo de actualización que dsp.js para FFT/espectrograma/métricas.

  let rafId = null;
  let ultimoCalculoFft = 0;

  // Canvases (resueltos una sola vez).
  let canvasOscOriginal = null;
  let canvasOscProcesada = null;
  let canvasFftOriginal = null;
  let canvasFftProcesada = null;
  let canvasEspectrogramaProcesada = null;

  // Buffers propios para la señal ORIGINAL (se leen del analyser de
  // dsp.js, que es de solo lectura y admite múltiples consumidores).
  let bufOriginalTiempo, bufOriginalVentaneado, bufOriginalRe, bufOriginalIm, bufOriginalMagDb;
  // Buffers propios para la señal PROCESADA.
  let bufProcesadaTiempo, bufProcesadaVentaneado, bufProcesadaRe, bufProcesadaIm, bufProcesadaMagDb;
  // Buffers para los taps de potencia (señal filtrada sola / ruido solo).
  let bufPotenciaSenal, bufPotenciaRuido;

  let buffersListos = false;

  function asegurarBuffers() {
    if (buffersListos) return;
    const dsp = window.MeynaDSP;
    const engine = window.MeynaAudioEngine;
    if (!dsp || !engine) return;
    const N = dsp.FFT_SIZE;
    bufOriginalTiempo = new Float32Array(N);
    bufOriginalVentaneado = new Float32Array(N);
    bufOriginalRe = new Float32Array(N);
    bufOriginalIm = new Float32Array(N);
    bufOriginalMagDb = new Float32Array(N / 2);

    bufProcesadaTiempo = new Float32Array(N);
    bufProcesadaVentaneado = new Float32Array(N);
    bufProcesadaRe = new Float32Array(N);
    bufProcesadaIm = new Float32Array(N);
    bufProcesadaMagDb = new Float32Array(N / 2);

    bufPotenciaSenal = new Float32Array(engine.FFT_SIZE_POTENCIA);
    bufPotenciaRuido = new Float32Array(engine.FFT_SIZE_POTENCIA);

    buffersListos = true;
  }

  function resolverCanvases() {
    if (!canvasOscOriginal) canvasOscOriginal = document.getElementById('dspOriginalOscilloscopeCanvas');
    if (!canvasOscProcesada) canvasOscProcesada = document.getElementById('dspProcessedOscilloscopeCanvas');
    if (!canvasFftOriginal) canvasFftOriginal = document.getElementById('dspOriginalFftCanvas');
    if (!canvasFftProcesada) canvasFftProcesada = document.getElementById('dspProcessedFftCanvas');
    if (!canvasEspectrogramaProcesada) canvasEspectrogramaProcesada = document.getElementById('dspProcessedSpectrogramCanvas');
  }

  function estaVisible() {
    const panel = document.getElementById('dspPanel');
    const tab = document.getElementById('dspTabFiltros');
    return !!panel && panel.style.display !== 'none' && !!tab && tab.style.display !== 'none';
  }

  function actualizarIndicadoresPotenciaYSnr(potenciaSenal, potenciaRuido) {
    const elSenal = document.getElementById('dspSignalPowerIndicator');
    const elRuido = document.getElementById('dspNoisePowerIndicator');
    const elSnr = document.getElementById('dspSnrIndicator');
    if (elSenal) elSenal.textContent = potenciaSenal.toFixed(5);
    if (elRuido) elRuido.textContent = potenciaRuido.toFixed(5);
    if (elSnr) {
      const resultado = window.MeynaAudioEngine.calcularSNRdB(potenciaSenal, potenciaRuido);
      elSnr.textContent = resultado.valido ? (resultado.snrDb.toFixed(1) + ' dB') : '— (ruido inactivo)';
    }
  }

  function loopPrincipal(timestampMs) {
    if (!estaVisible()) {
      rafId = null;
      return; // se autodetiene; un temporizador ligero (ver más abajo) lo reinicia si vuelve a hacerse visible.
    }
    rafId = requestAnimationFrame(loopPrincipal);

    asegurarBuffers();
    if (!buffersListos) return;
    resolverCanvases();

    const dsp = window.MeynaDSP;
    const engine = window.MeynaAudioEngine;
    const analyserOriginal = dsp.obtenerAnalyser();
    const analyserProcesada = engine.obtenerAnalyserProcesada();

    // --- Osciloscopios: cada frame, igual que dsp.js con el original. ---
    if (analyserOriginal) {
      analyserOriginal.getFloatTimeDomainData(bufOriginalTiempo);
      dsp.dibujarOsciloscopio(bufOriginalTiempo, canvasOscOriginal);
    }
    if (analyserProcesada) {
      analyserProcesada.getFloatTimeDomainData(bufProcesadaTiempo);
      dsp.dibujarOsciloscopio(bufProcesadaTiempo, canvasOscProcesada);
    }

    // --- FFT + espectrograma + potencia/SNR: throttle a ~10 Hz. ---
    if (timestampMs - ultimoCalculoFft >= INTERVALO_FFT_MS) {
      ultimoCalculoFft = timestampMs;

      if (analyserOriginal) {
        dsp.aplicarVentanaHann(bufOriginalTiempo, bufOriginalVentaneado);
        bufOriginalRe.set(bufOriginalVentaneado);
        bufOriginalIm.fill(0);
        dsp.calcularFFT(bufOriginalRe, bufOriginalIm);
        dsp.calcularMagnitudesDb(bufOriginalRe, bufOriginalIm, bufOriginalMagDb);
        dsp.dibujarFft(bufOriginalMagDb, canvasFftOriginal);
      }

      if (analyserProcesada) {
        dsp.aplicarVentanaHann(bufProcesadaTiempo, bufProcesadaVentaneado);
        bufProcesadaRe.set(bufProcesadaVentaneado);
        bufProcesadaIm.fill(0);
        dsp.calcularFFT(bufProcesadaRe, bufProcesadaIm);
        dsp.calcularMagnitudesDb(bufProcesadaRe, bufProcesadaIm, bufProcesadaMagDb);
        dsp.dibujarFft(bufProcesadaMagDb, canvasFftProcesada);
        dsp.dibujarColumnaEspectrograma(bufProcesadaMagDb, canvasEspectrogramaProcesada);
      }

      // Potencia de señal (filtrada, sin ruido) y de ruido (ya escalado,
      // sin señal), medidas en ramas separadas ANTES de mezclarse -ver
      // comentario de calcularSNRdB en audio-dsp-engine.js sobre qué SÍ y
      // qué NO mide esta estimación-.
      const analyserSenal = engine.obtenerAnalyserSenal();
      const analyserRuido = engine.obtenerAnalyserRuido();
      if (analyserSenal && analyserRuido) {
        analyserSenal.getFloatTimeDomainData(bufPotenciaSenal);
        analyserRuido.getFloatTimeDomainData(bufPotenciaRuido);
        const potenciaSenal = dsp.calcularEstadisticas(bufPotenciaSenal).potencia;
        const potenciaRuido = dsp.calcularEstadisticas(bufPotenciaRuido).potencia;
        actualizarIndicadoresPotenciaYSnr(potenciaSenal, potenciaRuido);
      }
    }
  }

  function intentarIniciarLoop() {
    if (rafId !== null) return;
    if (!window.MeynaDSP || !window.MeynaAudioEngine) return;
    if (!estaVisible()) return;
    rafId = requestAnimationFrame(loopPrincipal);
  }

  // Sondeo ligero y desacoplado: en vez de engancharse a los botones de
  // pestaña/panel de dsp.js (acoplaría este módulo a su implementación),
  // se observa el resultado (¿está visible la pestaña "Filtros"?) cada
  // 300 ms. El costo es insignificante (dos lecturas de estilo) y el
  // bucle en sí ya se autodetiene apenas deja de ser visible.
  setInterval(intentarIniciarLoop, 300);
})();
