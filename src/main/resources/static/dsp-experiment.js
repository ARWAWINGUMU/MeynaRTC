// =====================================================================
// MODO EXPERIMENTO — Fase 3 del Laboratorio DSP
// =====================================================================
// Registra en memoria (nunca en un servidor ni base de datos: solo dura
// mientras la pestaña está abierta) una serie de muestras durante una
// prueba controlada, y al finalizar genera un reporte con promedios,
// mínimos/máximos, variabilidad, comparación original-vs-procesada y una
// conclusión en lenguaje natural (mismas reglas determinísticas que
// dsp-interpreter.js, reutilizadas, nunca duplicadas). Incluye también la
// exportación a JSON/CSV/portapapeles.
//
// Un único setInterval de grabación, que SOLO existe mientras hay un
// experimento en curso (se crea al iniciar, se destruye siempre al
// detener o reiniciar) — nunca queda un temporizador huérfano corriendo.
window.MeynaDspExperiment = (function () {
  'use strict';

  const INTERVALO_MUESTREO_MS = 1000;
  const CAMPOS_NUMERICOS = ['bitrate', 'jitter', 'perdida', 'rtt', 'rms', 'energia', 'potencia', 'snr', 'frecuenciaDominante', 'anchoDeBanda'];

  let experimentoActivo = false;
  let nombreExperimento = '';
  let duracionConfiguradaS = null; // null = manual (sin auto-detención).
  let timestampInicio = 0;
  let muestras = [];
  let timerMuestreoId = null;
  let timerAutoDetenerId = null;
  let ultimoReporte = null;

  // -------------------------------------------------------------------
  // Captura de una muestra: combina SOLO datos ya calculados por otros
  // módulos (interpretación, canal, métricas reales de WebRTC) — nunca
  // recalcula ni inventa un valor propio.
  // -------------------------------------------------------------------
  function capturarMuestra() {
    const interprete = window.MeynaDspInterpreter;
    const channel = window.MeynaDspChannel;
    // IMPORTANTE: calcularAnalisisAhora() (no obtenerUltimoAnalisis()).
    // obtenerUltimoAnalisis() devuelve un análisis cacheado que solo se
    // refresca mientras la pestaña "Interpretación" está visible; si el
    // experimento corre con otra pestaña abierta, ese caché queda
    // congelado y TODAS las muestras terminan repitiendo el mismo valor
    // (la causa exacta de que promedio=mínimo=máximo y desviación=0).
    // calcularAnalisisAhora() vuelve a leer los analizadores de audio y
    // las métricas de WebRTC en el instante mismo de cada llamada.
    const analisis = interprete ? interprete.calcularAnalisisAhora() : null;
    if (!analisis) return null; // sin datos suficientes todavía (ej. transmisión recién iniciada).
    const canal = channel ? channel.obtenerConfiguracionCanal() : { retardoMs: 0, jitterActivo: false, jitterAmplitudMs: 0, perdidaPorcentaje: 0, bitrateObjetivoBps: null };
    return {
      timestamp: Date.now(),
      bitrate: analisis.metricasWebRTC.bitrate,
      jitter: analisis.metricasWebRTC.jitter,
      perdida: analisis.metricasWebRTC.perdida,
      rtt: analisis.metricasWebRTC.rtt,
      rms: analisis.estadisticasProcesada.rms,
      energia: analisis.estadisticasProcesada.energia,
      potencia: analisis.estadisticasProcesada.potencia,
      snr: analisis.snrDespues.valido ? analisis.snrDespues.snrDb : null,
      frecuenciaDominante: analisis.dominanteProcesada.frecuenciaHz,
      anchoDeBanda: analisis.bandaProcesada.anchoDeBanda,
      filtroActivo: analisis.filtro.tipo,
      retardoArtificialMs: canal.retardoMs,
      jitterArtificialMs: canal.jitterActivo ? canal.jitterAmplitudMs : 0,
      perdidaArtificialPorcentaje: canal.perdidaPorcentaje,
      bitrateObjetivoBps: canal.bitrateObjetivoBps
    };
  }

  function tickMuestreo() {
    try {
      const muestra = capturarMuestra();
      if (muestra) {
        muestras.push(muestra);
        actualizarEstadoUI();
      }
    } catch (err) {
      console.warn('MeynaDspExperiment: error al capturar una muestra', err);
    }
  }

  // -------------------------------------------------------------------
  // Ciclo de vida
  // -------------------------------------------------------------------
  function iniciarExperimento(nombre, duracionS) {
    if (experimentoActivo) return;
    nombreExperimento = (nombre || 'experimento').trim() || 'experimento';
    duracionConfiguradaS = duracionS || null; // null = manual.
    muestras = [];
    ultimoReporte = null;
    timestampInicio = Date.now();
    experimentoActivo = true;

    timerMuestreoId = setInterval(tickMuestreo, INTERVALO_MUESTREO_MS);
    tickMuestreo(); // primera muestra inmediata, no esperar 1s.

    if (duracionConfiguradaS) {
      timerAutoDetenerId = setTimeout(function () {
        detenerExperimento();
      }, duracionConfiguradaS * 1000);
    }
    actualizarEstadoUI();
  }

  function limpiarTemporizadores() {
    if (timerMuestreoId !== null) {
      clearInterval(timerMuestreoId);
      timerMuestreoId = null;
    }
    if (timerAutoDetenerId !== null) {
      clearTimeout(timerAutoDetenerId);
      timerAutoDetenerId = null;
    }
  }

  function detenerExperimento() {
    if (!experimentoActivo) return;
    limpiarTemporizadores();
    experimentoActivo = false;
    ultimoReporte = generarReporte();
    mostrarReporte(ultimoReporte);
    actualizarEstadoUI();
  }

  function reiniciarExperimento() {
    limpiarTemporizadores();
    experimentoActivo = false;
    muestras = [];
    ultimoReporte = null;
    actualizarEstadoUI();
    const caja = document.getElementById('dspExpReportBox');
    if (caja) caja.innerHTML = '<p class="small">Sin experimento ejecutado todavía.</p>';
  }

  // -------------------------------------------------------------------
  // Reporte: promedios/min/max/variabilidad + comparación + conclusión
  // -------------------------------------------------------------------
  // Nunca inventa un valor: si no hay muestras numéricas válidas para un
  // campo (ej. SNR con el ruido siempre desactivado durante todo el
  // experimento), n queda en 0 y promedio/minimo/maximo/desviacion en
  // null — quien muestre el reporte debe imprimir "sin datos suficientes"
  // en ese caso, nunca un 0 que parecería una medición real.
  function calcularEstadisticaSerie(valores) {
    const n = valores.length;
    if (n === 0) return { promedio: null, minimo: null, maximo: null, desviacion: null, n: 0 };
    let suma = 0, minimo = valores[0], maximo = valores[0];
    for (let i = 0; i < n; i++) {
      suma += valores[i];
      if (valores[i] < minimo) minimo = valores[i];
      if (valores[i] > maximo) maximo = valores[i];
    }
    const promedio = suma / n;
    let sumaCuadrados = 0;
    for (let i = 0; i < n; i++) sumaCuadrados += (valores[i] - promedio) * (valores[i] - promedio);
    const desviacion = Math.sqrt(sumaCuadrados / n);
    return { promedio: promedio, minimo: minimo, maximo: maximo, desviacion: desviacion, n: n };
  }

  const DESCRIPCION_EFECTO_FILTRO = {
    pasabajos: 'redujo componentes de alta frecuencia',
    pasaaltos: 'atenuó componentes de baja frecuencia',
    pasabanda: 'concentró la energía en la banda configurada',
    notch: 'atenuó la componente cercana a la frecuencia central configurada'
  };

  function generarConclusion(config, mejoraSNR) {
    const partes = [];
    if (config.filtro && config.filtro !== 'ninguno') {
      let frase = 'El filtro ' + (DESCRIPCION_EFECTO_FILTRO[config.filtro] || 'modificó el espectro de la señal');
      if (mejoraSNR !== null) {
        frase += mejoraSNR > 1 ? ' y mejoró la relación señal-ruido' : (mejoraSNR < -1 ? ', aunque la relación señal-ruido empeoró' : ', sin un cambio relevante en la relación señal-ruido');
      }
      partes.push(frase + '.');
    } else if (mejoraSNR !== null) {
      partes.push('La relación señal-ruido ' + (mejoraSNR > 1 ? 'mejoró' : (mejoraSNR < -1 ? 'empeoró' : 'se mantuvo sin cambios relevantes')) + ' durante el experimento.');
    }
    if (config.retardoMs > 0 || config.perdidaArtificial > 0) {
      partes.push('El retardo y la pérdida artificiales introducidos por el Laboratorio del Canal aumentaron la degradación temporal percibida.');
    }
    if (!partes.length) partes.push('No se registraron cambios relevantes durante el experimento.');
    return partes.join(' ');
  }

  function generarReporte() {
    const series = {};
    CAMPOS_NUMERICOS.forEach(function (campo) {
      const valores = muestras
        .map(function (m) { return m[campo]; })
        // isFinite() (no solo !isNaN()) descarta también ±Infinity, que
        // isNaN() deja pasar y podría colarse como "dato válido".
        .filter(function (v) { return typeof v === 'number' && isFinite(v); });
      series[campo] = calcularEstadisticaSerie(valores);
    });

    const primero = muestras[0] || null;
    const ultimo = muestras[muestras.length - 1] || null;
    const snrInicial = primero && primero.snr !== null ? primero.snr : null;
    const snrFinal = ultimo && ultimo.snr !== null ? ultimo.snr : null;
    const mejoraSNR = (snrInicial !== null && snrFinal !== null) ? (snrFinal - snrInicial) : null;

    const configuracionUtilizada = {
      filtro: ultimo ? ultimo.filtroActivo : 'ninguno',
      retardoMs: ultimo ? ultimo.retardoArtificialMs : 0,
      jitterArtificialMs: ultimo ? ultimo.jitterArtificialMs : 0,
      perdidaArtificial: ultimo ? ultimo.perdidaArtificialPorcentaje : 0,
      bitrateObjetivoBps: ultimo ? ultimo.bitrateObjetivoBps : null,
      ruido: window.MeynaAudioEngine ? window.MeynaAudioEngine.obtenerConfiguracionRuido() : null
    };

    // Calidad estimada del experimento completo: la MISMA rúbrica que el
    // panel en vivo, aplicada a los PROMEDIOS de la serie (no a un
    // instante aislado). Si NINGUNA métrica real de WebRTC se pudo medir
    // durante todo el experimento (ej. no hubo ningún oyente conectado),
    // no se inventa una calidad "perfecta" a partir de ceros — se reporta
    // explícitamente que no hay datos suficientes.
    const interprete = window.MeynaDspInterpreter;
    const huboMetricasWebRTC = series.bitrate.n > 0 || series.jitter.n > 0 || series.perdida.n > 0 || series.rtt.n > 0;
    const calidad = (interprete && huboMetricasWebRTC)
      ? interprete.clasificarCalidad(
          {
            bitrate: series.bitrate.n > 0 ? series.bitrate.promedio : 0,
            jitter: series.jitter.n > 0 ? series.jitter.promedio : 0,
            perdida: series.perdida.n > 0 ? series.perdida.promedio : 0,
            rtt: series.rtt.n > 0 ? series.rtt.promedio : 0
          },
          series.snr.n > 0,
          series.snr.promedio
        )
      : { etiqueta: 'Sin datos suficientes', desglose: {} };

    return {
      nombre: nombreExperimento,
      duracionConfiguradaS: duracionConfiguradaS,
      duracionRealS: (Date.now() - timestampInicio) / 1000,
      timestampInicio: timestampInicio,
      timestampFin: Date.now(),
      muestras: muestras.length,
      configuracionUtilizada: configuracionUtilizada,
      series: series,
      snrInicial: snrInicial,
      snrFinal: snrFinal,
      mejoraSNR: mejoraSNR,
      calidadEstimada: calidad,
      conclusion: generarConclusion(configuracionUtilizada, mejoraSNR),
      snapshotsCrudos: muestras.slice()
    };
  }

  // -------------------------------------------------------------------
  // Exportación: JSON, CSV y resumen de texto para portapapeles.
  // -------------------------------------------------------------------
  function descargarArchivo(nombreArchivo, contenido, tipoMime) {
    const blob = new Blob([contenido], { type: tipoMime });
    const url = URL.createObjectURL(blob);
    const enlace = document.createElement('a');
    enlace.href = url;
    enlace.download = nombreArchivo;
    document.body.appendChild(enlace);
    enlace.click();
    document.body.removeChild(enlace);
    URL.revokeObjectURL(url);
  }

  function exportarJSON() {
    if (!ultimoReporte) return;
    descargarArchivo(ultimoReporte.nombre + '.json', JSON.stringify(ultimoReporte, null, 2), 'application/json');
  }

  function exportarCSV() {
    if (!ultimoReporte) return;
    const encabezados = ['timestamp', 'bitrate', 'jitter', 'perdida', 'rtt', 'rms', 'energia', 'potencia', 'snr', 'frecuenciaDominante', 'anchoDeBanda', 'filtroActivo', 'retardoArtificialMs', 'jitterArtificialMs', 'perdidaArtificialPorcentaje', 'bitrateObjetivoBps'];
    const filas = ultimoReporte.snapshotsCrudos.map(function (m) {
      return encabezados.map(function (campo) {
        const valor = m[campo];
        return (valor === null || valor === undefined) ? '' : valor;
      }).join(',');
    });
    const csv = encabezados.join(',') + '\n' + filas.join('\n');
    descargarArchivo(ultimoReporte.nombre + '.csv', csv, 'text/csv');
  }

  // Formatea el promedio de una serie, o "sin datos suficientes" si esa
  // métrica nunca se pudo medir durante el experimento (n === 0) — nunca
  // se muestra un 0 que podría confundirse con una medición real.
  function formatearPromedio(serie, decimales, unidad) {
    if (!serie || serie.n === 0) return 'sin datos suficientes';
    return serie.promedio.toFixed(decimales === undefined ? 1 : decimales) + (unidad || '');
  }

  function construirResumenTexto(reporte) {
    const s = reporte.series;
    const lineas = [
      'Resultado del experimento: ' + reporte.nombre,
      '- Duración: ' + reporte.duracionRealS.toFixed(1) + ' s (' + reporte.muestras + ' muestras)',
      '- Filtro: ' + reporte.configuracionUtilizada.filtro,
      '- Ruido: ' + (reporte.configuracionUtilizada.ruido && reporte.configuracionUtilizada.ruido.activo ? reporte.configuracionUtilizada.ruido.intensidad + ' %' : 'inactivo'),
      '- Retardo artificial: ' + reporte.configuracionUtilizada.retardoMs + ' ms',
      '- Pérdida artificial: ' + reporte.configuracionUtilizada.perdidaArtificial + ' %',
      '- Bitrate objetivo: ' + (reporte.configuracionUtilizada.bitrateObjetivoBps ? Math.round(reporte.configuracionUtilizada.bitrateObjetivoBps / 1000) + ' kbps' : 'automático'),
      '- SNR inicial: ' + (reporte.snrInicial !== null ? reporte.snrInicial.toFixed(1) + ' dB' : '—'),
      '- SNR final: ' + (reporte.snrFinal !== null ? reporte.snrFinal.toFixed(1) + ' dB' : '—'),
      '- Mejora de SNR: ' + (reporte.mejoraSNR !== null ? (reporte.mejoraSNR >= 0 ? '+' : '') + reporte.mejoraSNR.toFixed(1) + ' dB' : '—'),
      '- Bitrate promedio: ' + formatearPromedio(s.bitrate, 0, ' kbps'),
      '- Jitter promedio: ' + formatearPromedio(s.jitter, 1, ' ms'),
      '- Pérdida promedio: ' + formatearPromedio(s.perdida, 1, ' %'),
      '- Calidad estimada: ' + reporte.calidadEstimada.etiqueta,
      '',
      'Conclusión:',
      '"' + reporte.conclusion + '"'
    ];
    return lineas.join('\n');
  }

  async function copiarResumen() {
    if (!ultimoReporte) return;
    const texto = construirResumenTexto(ultimoReporte);
    const estado = document.getElementById('dspExpStatus');
    try {
      await navigator.clipboard.writeText(texto);
      if (estado) estado.textContent = 'Resumen copiado al portapapeles.';
    } catch (err) {
      console.warn('MeynaDspExperiment: no se pudo copiar al portapapeles', err);
      if (estado) estado.textContent = 'No se pudo copiar al portapapeles (revisa permisos del navegador).';
    }
  }

  // -------------------------------------------------------------------
  // Interfaz
  // -------------------------------------------------------------------
  function actualizarEstadoUI() {
    const estado = document.getElementById('dspExpStatus');
    const btnIniciar = document.getElementById('dspExpStartBtn');
    const btnDetener = document.getElementById('dspExpStopBtn');
    if (btnIniciar) btnIniciar.disabled = experimentoActivo;
    if (btnDetener) btnDetener.disabled = !experimentoActivo;
    if (estado) {
      if (experimentoActivo) {
        const transcurridoS = Math.round((Date.now() - timestampInicio) / 1000);
        estado.textContent = 'Grabando "' + nombreExperimento + '"… ' + transcurridoS + ' s (' + muestras.length + ' muestras)' + (duracionConfiguradaS ? (' de ' + duracionConfiguradaS + ' s') : ' — manual');
      } else if (ultimoReporte) {
        estado.textContent = 'Experimento finalizado: ' + ultimoReporte.nombre + ' (' + ultimoReporte.muestras + ' muestras).';
      } else {
        estado.textContent = 'Sin experimento en curso.';
      }
    }
  }

  function mostrarReporte(reporte) {
    const caja = document.getElementById('dspExpReportBox');
    if (!caja) return;
    const s = reporte.series;
    const filaMetrica = function (etiqueta, serie, unidad, decimales) {
      const d = decimales === undefined ? 1 : decimales;
      if (!serie || serie.n === 0) {
        // Nunca se inventa un 0: si la métrica no se pudo medir ni una
        // vez durante el experimento, se dice explícitamente.
        return '<tr><td>' + etiqueta + '</td><td colspan="4" class="small">Sin datos suficientes</td></tr>';
      }
      return '<tr><td>' + etiqueta + '</td><td>' + serie.promedio.toFixed(d) + ' ' + unidad + '</td><td>' + serie.minimo.toFixed(d) + '</td><td>' + serie.maximo.toFixed(d) + '</td><td>' + serie.desviacion.toFixed(d) + '</td></tr>';
    };
    caja.innerHTML =
      '<div class="metrics-grid">' +
      '<div class="metrics-card"><strong>Calidad estimada</strong><div class="small">' + reporte.calidadEstimada.etiqueta + '</div></div>' +
      '<div class="metrics-card"><strong>SNR inicial → final</strong><div class="small">' + (reporte.snrInicial !== null ? reporte.snrInicial.toFixed(1) : '—') + ' → ' + (reporte.snrFinal !== null ? reporte.snrFinal.toFixed(1) : '—') + ' dB</div></div>' +
      '<div class="metrics-card"><strong>Mejora de SNR</strong><div class="small">' + (reporte.mejoraSNR !== null ? (reporte.mejoraSNR >= 0 ? '+' : '') + reporte.mejoraSNR.toFixed(1) + ' dB' : '—') + '</div></div>' +
      '<div class="metrics-card"><strong>Muestras</strong><div class="small">' + reporte.muestras + ' en ' + reporte.duracionRealS.toFixed(1) + ' s</div></div>' +
      '</div>' +
      '<table style="margin-top:10px;"><thead><tr><th>Métrica</th><th>Promedio</th><th>Mínimo</th><th>Máximo</th><th>Desv. estándar</th></tr></thead><tbody>' +
      filaMetrica('Bitrate (kbps)', s.bitrate, '') +
      filaMetrica('Jitter (ms)', s.jitter, '') +
      filaMetrica('Pérdida (%)', s.perdida, '') +
      filaMetrica('RTT (ms)', s.rtt, '') +
      filaMetrica('RMS', s.rms, '', 4) +
      filaMetrica('SNR (dB)', s.snr, '') +
      '</tbody></table>' +
      '<p class="small" style="margin-top:10px;"><strong>Conclusión:</strong> "' + reporte.conclusion + '"</p>';
  }

  function initUI() {
    const btnIniciar = document.getElementById('dspExpStartBtn');
    if (!btnIniciar) return; // el HTML de la pestaña "Experimento" todavía no existe.

    const inputNombre = document.getElementById('dspExpName');
    const selectDuracion = document.getElementById('dspExpDuration');
    const btnDetener = document.getElementById('dspExpStopBtn');
    const btnReiniciar = document.getElementById('dspExpResetBtn');
    const btnExportarJson = document.getElementById('dspExpExportJson');
    const btnExportarCsv = document.getElementById('dspExpExportCsv');
    const btnCopiar = document.getElementById('dspExpCopyBtn');

    btnIniciar.addEventListener('click', function () {
      const valorDuracion = selectDuracion.value;
      const duracionS = valorDuracion === 'manual' ? null : Number(valorDuracion);
      iniciarExperimento(inputNombre.value, duracionS);
    });
    btnDetener.addEventListener('click', detenerExperimento);
    if (btnReiniciar) btnReiniciar.addEventListener('click', reiniciarExperimento);
    if (btnExportarJson) btnExportarJson.addEventListener('click', exportarJSON);
    if (btnExportarCsv) btnExportarCsv.addEventListener('click', exportarCSV);
    if (btnCopiar) btnCopiar.addEventListener('click', copiarResumen);

    actualizarEstadoUI();
    // Nota: no se crea un intervalo adicional para refrescar el contador
    // "transcurrido" — tickMuestreo() ya llama actualizarEstadoUI() en
    // cada muestra (misma cadencia de 1s), evitando un segundo timer.
  }

  initUI();

  return {
    iniciarExperimento: iniciarExperimento,
    detenerExperimento: detenerExperimento,
    reiniciarExperimento: reiniciarExperimento,
    obtenerUltimoReporte: function () { return ultimoReporte; }
  };
})();
