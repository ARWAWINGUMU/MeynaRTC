// =====================================================================
// INTERPRETACIÓN AUTOMÁTICA — Fase 3 del Laboratorio DSP
// =====================================================================
// No usa IA externa ni ninguna API remota: todo son reglas
// determinísticas en JavaScript que combinan datos REALES ya calculados
// por otros módulos (nunca inventa ni simula un valor):
//   - dsp.js: FFT/ventana/magnitudes/estadísticas del espectro ORIGINAL.
//   - audio-dsp-engine.js: analizadores de la señal PROCESADA, de la
//     señal filtrada sola y del ruido solo, configuración del filtro.
//   - dsp-channel.js: configuración del canal artificial (retardo/jitter/
//     pérdida/bitrate objetivo).
//   - index.html: métricas REALES de WebRTC (bitrate/jitter/pérdida/RTT
//     medidos con getStats(), vía window.obtenerMetricasWebRTC()).
//
// Corre su PROPIO temporizador (setInterval, no requestAnimationFrame:
// esto es un panel de texto, no necesita 60fps), activo únicamente
// mientras la pestaña "Interpretación" está visible.
window.MeynaDspInterpreter = (function () {
  'use strict';

  const INTERVALO_MS = 800;
  const UMBRAL_SNR_DB = 1; // por debajo de esto, el cambio de SNR se reporta como "sin cambio relevante".
  const ETIQUETAS_FILTRO = {
    ninguno: 'Sin filtro', pasabajos: 'Pasa-bajos', pasaaltos: 'Pasa-altos',
    pasabanda: 'Pasa-banda', notch: 'Rechazo de banda (notch)'
  };

  let ultimoAnalisis = null;

  // Buffers propios (independientes de los de dsp.js/dsp-visualizer.js,
  // que corren en sus propios bucles): se asignan la primera vez que hay
  // AudioContext disponible.
  let N = null;
  let bufOriginal, bufOriginalVent, bufOriginalRe, bufOriginalIm, bufOriginalMagDb;
  let bufProcesada, bufProcesadaVent, bufProcesadaRe, bufProcesadaIm, bufProcesadaMagDb;
  let bufPotenciaSenal, bufPotenciaRuido;

  function asegurarBuffers() {
    if (N) return true;
    const dsp = window.MeynaDSP;
    const engine = window.MeynaAudioEngine;
    if (!dsp || !engine) return false;
    N = dsp.FFT_SIZE;
    bufOriginal = new Float32Array(N);
    bufOriginalVent = new Float32Array(N);
    bufOriginalRe = new Float32Array(N);
    bufOriginalIm = new Float32Array(N);
    bufOriginalMagDb = new Float32Array(N / 2);
    bufProcesada = new Float32Array(N);
    bufProcesadaVent = new Float32Array(N);
    bufProcesadaRe = new Float32Array(N);
    bufProcesadaIm = new Float32Array(N);
    bufProcesadaMagDb = new Float32Array(N / 2);
    bufPotenciaSenal = new Float32Array(engine.FFT_SIZE_POTENCIA);
    bufPotenciaRuido = new Float32Array(engine.FFT_SIZE_POTENCIA);
    return true;
  }

  // -------------------------------------------------------------------
  // Efecto del filtro: solo se afirma algo si HAY evidencia medible en
  // los propios datos (nunca un mensaje genérico por el solo hecho de que
  // haya un filtro seleccionado).
  // -------------------------------------------------------------------
  function magnitudEnFrecuencia(magnitudesDb, frecuenciaHz, sampleRate) {
    const nyquist = sampleRate / 2;
    const mitad = magnitudesDb.length;
    const bin = Math.max(0, Math.min(mitad - 1, Math.round((frecuenciaHz / nyquist) * mitad)));
    return magnitudesDb[bin];
  }

  function describirEfectoFiltro(filtro, bandaOriginal, bandaProcesada, magDbOriginal, magDbProcesada, sampleRate) {
    const umbralHz = Math.max(50, bandaOriginal.anchoDeBanda * 0.1);
    if (filtro.tipo === 'pasabajos') {
      if (bandaProcesada.frecuenciaSuperior < bandaOriginal.frecuenciaSuperior - umbralHz) {
        return 'El filtro pasa-bajos redujo las componentes por encima de ' + Math.round(filtro.frecuenciaCorte) + ' Hz.';
      }
      return null;
    }
    if (filtro.tipo === 'pasaaltos') {
      if (bandaProcesada.frecuenciaInferior > bandaOriginal.frecuenciaInferior + umbralHz) {
        return 'El filtro pasa-altos atenuó las componentes por debajo de ' + Math.round(filtro.frecuenciaCorte) + ' Hz.';
      }
      return null;
    }
    if (filtro.tipo === 'pasabanda') {
      const esTelefonico = Math.abs(filtro.frecuenciaInferior - 300) < 20 && Math.abs(filtro.frecuenciaSuperior - 3400) < 20;
      if (bandaProcesada.anchoDeBanda < bandaOriginal.anchoDeBanda - umbralHz) {
        return esTelefonico
          ? 'El canal telefónico concentró la energía entre 300 y 3400 Hz.'
          : ('El filtro pasa-banda concentró la energía entre ' + Math.round(filtro.frecuenciaInferior) + ' y ' + Math.round(filtro.frecuenciaSuperior) + ' Hz.');
      }
      return null;
    }
    if (filtro.tipo === 'notch') {
      const magOriginalCentral = magnitudEnFrecuencia(magDbOriginal, filtro.frecuenciaCentral, sampleRate);
      const magProcesadaCentral = magnitudEnFrecuencia(magDbProcesada, filtro.frecuenciaCentral, sampleRate);
      if (magProcesadaCentral < magOriginalCentral - 6) { // al menos 6dB de atenuación en el punto exacto del notch
        return 'El filtro notch redujo la componente cercana a ' + Math.round(filtro.frecuenciaCentral) + ' Hz.';
      }
      return null;
    }
    return null; // 'ninguno': no hay filtro que describir.
  }

  // -------------------------------------------------------------------
  // Clasificación de calidad: rúbrica explícita (0=excelente..3=deficiente
  // por factor), documentada aquí y mostrada íntegra en la UI — nunca
  // oculta los criterios. Se combina con métricas REALES de WebRTC + SNR
  // PROCESADO (no con las degradaciones artificiales configuradas, que son
  // la CAUSA, no el efecto medido).
  // -------------------------------------------------------------------
  function puntuarPerdida(pct) { if (pct < 1) return 0; if (pct < 3) return 1; if (pct < 8) return 2; return 3; }
  function puntuarJitter(ms) { if (ms < 30) return 0; if (ms < 60) return 1; if (ms < 100) return 2; return 3; }
  function puntuarRtt(ms) { if (ms < 150) return 0; if (ms < 300) return 1; if (ms < 500) return 2; return 3; }
  function puntuarSnr(db) { if (db > 20) return 0; if (db > 10) return 1; if (db > 0) return 2; return 3; }
  function puntuarBitrate(kbps) { if (kbps >= 32) return 0; if (kbps >= 24) return 1; if (kbps >= 16) return 2; return 3; }

  const ETIQUETAS_CALIDAD = ['Excelente', 'Buena', 'Regular', 'Deficiente'];

  function clasificarCalidad(metricasWebRTC, snrProcesadoValido, snrProcesadoDb) {
    const puntos = {
      perdida: puntuarPerdida(metricasWebRTC.perdida),
      jitter: puntuarJitter(metricasWebRTC.jitter),
      rtt: puntuarRtt(metricasWebRTC.rtt),
      snr: snrProcesadoValido ? puntuarSnr(snrProcesadoDb) : 1, // sin ruido activo no penalizamos ni premiamos por SNR.
      bitrate: puntuarBitrate(metricasWebRTC.bitrate)
    };
    const promedio = (puntos.perdida + puntos.jitter + puntos.rtt + puntos.snr + puntos.bitrate) / 5;
    const indice = Math.min(3, Math.round(promedio));
    return { etiqueta: ETIQUETAS_CALIDAD[indice], desglose: puntos };
  }

  // -------------------------------------------------------------------
  // Explicación en lenguaje natural (reglas determinísticas)
  // -------------------------------------------------------------------
  function generarExplicacion(a) {
    const partes = [];
    partes.push('Comunicación estimada como ' + a.calidad.etiqueta.toLowerCase() + ' (estimación educativa, no una medición absoluta).');
    partes.push('Bitrate real: ' + Math.round(a.metricasWebRTC.bitrate) + ' kbps, pérdida ' + a.metricasWebRTC.perdida.toFixed(1) + ' %, jitter ' + a.metricasWebRTC.jitter.toFixed(1) + ' ms, RTT ' + a.metricasWebRTC.rtt.toFixed(0) + ' ms (métricas reales de WebRTC).');
    if (a.efectoFiltro) partes.push(a.efectoFiltro);
    if (a.cambioSNR.delta !== null) {
      partes.push('La relación señal-ruido ' + a.cambioSNR.texto + (a.cambioSNR.texto !== 'sin cambio relevante' ? (' en ' + Math.abs(a.cambioSNR.delta).toFixed(1) + ' dB') : '') + ' tras el procesamiento.');
    }
    const c = a.configuracionCanal;
    if (c.retardoMs > 0 || c.jitterActivo || c.perdidaPorcentaje > 0) {
      let frase = 'El Laboratorio del Canal está introduciendo degradaciones artificiales adicionales (retardo ' + c.retardoMs + ' ms';
      if (c.jitterActivo) frase += ', jitter simulado ±' + c.jitterAmplitudMs + ' ms';
      if (c.perdidaPorcentaje > 0) frase += ', pérdida simulada ' + c.perdidaPorcentaje + '%';
      frase += ').';
      partes.push(frase);
    }
    return partes.join(' ');
  }

  // -------------------------------------------------------------------
  // Ciclo de análisis
  // -------------------------------------------------------------------
  function estaVisible() {
    const panel = document.getElementById('dspPanel');
    const tab = document.getElementById('dspTabInterpretacion');
    return !!panel && panel.style.display !== 'none' && !!tab && tab.style.display !== 'none';
  }

  function calcularAnalisis() {
    const dsp = window.MeynaDSP;
    const engine = window.MeynaAudioEngine;
    const channel = window.MeynaDspChannel;
    const audioCtx = dsp.obtenerAudioContext();
    if (!audioCtx) return null;
    const sampleRate = audioCtx.sampleRate;

    const analyserOriginal = dsp.obtenerAnalyser();
    const analyserProcesada = engine.obtenerAnalyserProcesada();
    const analyserSenal = engine.obtenerAnalyserSenal();
    const analyserRuido = engine.obtenerAnalyserRuido();
    if (!analyserOriginal || !analyserProcesada || !analyserSenal || !analyserRuido) return null;

    // --- Espectro original ---
    analyserOriginal.getFloatTimeDomainData(bufOriginal);
    dsp.aplicarVentanaHann(bufOriginal, bufOriginalVent);
    bufOriginalRe.set(bufOriginalVent);
    bufOriginalIm.fill(0);
    dsp.calcularFFT(bufOriginalRe, bufOriginalIm);
    dsp.calcularMagnitudesDb(bufOriginalRe, bufOriginalIm, bufOriginalMagDb);
    const dominanteOriginal = dsp.calcularFrecuenciaDominante(bufOriginalMagDb, sampleRate);
    const bandaOriginal = dsp.calcularAnchoDeBandaOcupado(bufOriginalMagDb, sampleRate, 0.9);

    // --- Espectro procesado ---
    analyserProcesada.getFloatTimeDomainData(bufProcesada);
    dsp.aplicarVentanaHann(bufProcesada, bufProcesadaVent);
    bufProcesadaRe.set(bufProcesadaVent);
    bufProcesadaIm.fill(0);
    dsp.calcularFFT(bufProcesadaRe, bufProcesadaIm);
    dsp.calcularMagnitudesDb(bufProcesadaRe, bufProcesadaIm, bufProcesadaMagDb);
    const dominanteProcesada = dsp.calcularFrecuenciaDominante(bufProcesadaMagDb, sampleRate);
    const bandaProcesada = dsp.calcularAnchoDeBandaOcupado(bufProcesadaMagDb, sampleRate, 0.9);

    // --- SNR antes/después ---
    analyserRuido.getFloatTimeDomainData(bufPotenciaRuido);
    const potenciaRuido = dsp.calcularEstadisticas(bufPotenciaRuido).potencia;
    const potenciaOriginal = dsp.calcularEstadisticas(bufOriginal).potencia;
    analyserSenal.getFloatTimeDomainData(bufPotenciaSenal);
    const potenciaFiltrada = dsp.calcularEstadisticas(bufPotenciaSenal).potencia;
    const snrAntes = engine.calcularSNRdB(potenciaOriginal, potenciaRuido);
    const snrDespues = engine.calcularSNRdB(potenciaFiltrada, potenciaRuido);
    const cambioSNR = (snrAntes.valido && snrDespues.valido)
      ? (function () {
          const delta = snrDespues.snrDb - snrAntes.snrDb;
          const texto = delta > UMBRAL_SNR_DB ? 'mejoró' : (delta < -UMBRAL_SNR_DB ? 'empeoró' : 'sin cambio relevante');
          return { delta: delta, texto: texto };
        })()
      : { delta: null, texto: 'sin estimación válida (ruido inactivo)' };

    const filtro = engine.obtenerConfiguracionFiltro();
    const efectoFiltro = describirEfectoFiltro(filtro, bandaOriginal, bandaProcesada, bufOriginalMagDb, bufProcesadaMagDb, sampleRate);

    const metricasWebRTC = (typeof window.obtenerMetricasWebRTC === 'function')
      ? window.obtenerMetricasWebRTC()
      : { bitrate: 0, jitter: 0, perdida: 0, rtt: 0 };

    const calidad = clasificarCalidad(metricasWebRTC, snrDespues.valido, snrDespues.snrDb);

    const configuracionCanal = channel ? channel.obtenerConfiguracionCanal() : { retardoMs: 0, jitterActivo: false, jitterAmplitudMs: 0, perdidaPorcentaje: 0 };

    // Estadísticas de la señal PROCESADA (reutiliza el buffer que ya se
    // capturó arriba para la FFT procesada, sin leer el analyser otra
    // vez): las usa dsp-experiment.js para RMS/energía/potencia sin
    // duplicar cálculos.
    const estadisticasProcesada = dsp.calcularEstadisticas(bufProcesada);

    const analisis = {
      dominanteOriginal: dominanteOriginal,
      dominanteProcesada: dominanteProcesada,
      bandaOriginal: bandaOriginal,
      bandaProcesada: bandaProcesada,
      snrAntes: snrAntes,
      snrDespues: snrDespues,
      cambioSNR: cambioSNR,
      filtro: filtro,
      efectoFiltro: efectoFiltro,
      estadisticasProcesada: estadisticasProcesada,
      metricasWebRTC: metricasWebRTC,
      calidad: calidad,
      configuracionCanal: configuracionCanal,
      timestamp: Date.now()
    };
    analisis.explicacion = generarExplicacion(analisis);
    return analisis;
  }

  function actualizarUI(a) {
    const set = function (id, texto) {
      const el = document.getElementById(id);
      if (el) el.textContent = texto;
    };
    set('dspInterpDominantFreq', Math.round(a.dominanteProcesada.frecuenciaHz) + ' Hz');
    set('dspInterpDominantMag', a.dominanteProcesada.magnitudDb.toFixed(1) + ' dB');
    set('dspInterpBandwidthLow', Math.round(a.bandaProcesada.frecuenciaInferior) + ' Hz');
    set('dspInterpBandwidthHigh', Math.round(a.bandaProcesada.frecuenciaSuperior) + ' Hz');
    set('dspInterpBandwidthTotal', Math.round(a.bandaProcesada.anchoDeBanda) + ' Hz');
    set('dspInterpFilterEffect', a.efectoFiltro || ('Filtro activo: ' + (ETIQUETAS_FILTRO[a.filtro.tipo] || a.filtro.tipo) + ' (sin evidencia suficiente para describir un efecto).'));
    set('dspInterpSnrBefore', a.snrAntes.valido ? (a.snrAntes.snrDb.toFixed(1) + ' dB') : '— (ruido inactivo)');
    set('dspInterpSnrAfter', a.snrDespues.valido ? (a.snrDespues.snrDb.toFixed(1) + ' dB') : '— (ruido inactivo)');
    set('dspInterpSnrDelta', a.cambioSNR.delta !== null ? (a.cambioSNR.delta >= 0 ? '+' : '') + a.cambioSNR.delta.toFixed(1) + ' dB' : '—');
    set('dspInterpSnrVerdict', a.cambioSNR.texto);
    set('dspInterpQuality', a.calidad.etiqueta);
    set('dspInterpQualityBreakdown', 'Pérdida:' + a.calidad.desglose.perdida + ' Jitter:' + a.calidad.desglose.jitter + ' RTT:' + a.calidad.desglose.rtt + ' SNR:' + a.calidad.desglose.snr + ' Bitrate:' + a.calidad.desglose.bitrate + ' (0=excelente..3=deficiente por factor; estimación educativa)');
    set('dspInterpExplanation', a.explicacion);
  }

  function tick() {
    try {
      if (!asegurarBuffers()) return;
      const analisis = calcularAnalisis();
      if (!analisis) return;
      ultimoAnalisis = analisis;
      actualizarUI(analisis);
    } catch (err) {
      console.warn('MeynaDspInterpreter: error al calcular el análisis', err);
    }
  }

  // Único intervalo de este módulo: arranca/detiene solo, según la
  // visibilidad de su propia pestaña (mismo criterio que dsp-visualizer.js).
  setInterval(function () {
    if (estaVisible()) tick();
  }, INTERVALO_MS);

  return {
    // ATENCIÓN: obtenerUltimoAnalisis() devuelve el último análisis que
    // calculó tick() — y tick() SOLO corre mientras la pestaña
    // "Interpretación" está visible (estaVisible(), arriba). Si el usuario
    // está en otra pestaña (ej. "Experimento"), este valor queda
    // CONGELADO. No usar este getter para grabar muestras periódicas;
    // para eso existe calcularAnalisisAhora() (ver abajo).
    obtenerUltimoAnalisis: function () { return ultimoAnalisis; },
    // Calcula un análisis FRESCO en el momento, sin depender de que la
    // pestaña "Interpretación" esté visible ni de ningún temporizador
    // propio. dsp-experiment.js debe usar SIEMPRE esta función (no
    // obtenerUltimoAnalisis) para que cada muestra grabada refleje el
    // estado real en ese instante — este era exactamente el bug: el modo
    // experimento leía el análisis cacheado, que solo se actualiza cuando
    // esta pestaña está en pantalla, así que todas las muestras terminaban
    // repitiendo el mismo valor congelado.
    calcularAnalisisAhora: function () {
      try {
        if (!asegurarBuffers()) return null;
        return calcularAnalisis();
      } catch (err) {
        console.warn('MeynaDspInterpreter: error al calcular análisis bajo demanda', err);
        return null;
      }
    },
    // Se reutiliza tal cual desde dsp-experiment.js para que el reporte
    // final use EXACTAMENTE la misma rúbrica que el panel en vivo (nunca
    // una segunda copia de los umbrales).
    clasificarCalidad: clasificarCalidad
  };
})();
