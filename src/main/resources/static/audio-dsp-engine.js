// =====================================================================
// MOTOR DE PROCESAMIENTO DE AUDIO — Fase 2 del Laboratorio DSP
// =====================================================================
// Mientras dsp.js (Fase 1) solo ANALIZA la señal capturada, este módulo
// además la MODIFICA de verdad (filtros reales con BiquadFilterNode,
// ruido blanco real mezclado con GainNode) y expone una pista de audio
// procesada que index.html puede transmitir por WebRTC en lugar de la
// original, sin desconectar a ningún oyente.
//
// Reutiliza el ÚNICO AudioContext y el ÚNICO MediaStreamAudioSourceNode
// que ya administra dsp.js (vía MeynaDSP.obtenerAudioContext() y
// MeynaDSP.conectarRamaAdicional()): NO se crea un segundo AudioContext.
// El grafo de audio completo queda así:
//
//   sourceNode (de dsp.js)
//     ├──> analyser original (Fase 1, sin tocar)
//     └──> filtroA -> filtroB -> cadenaGain -> nodoMezcla -> compresorLimitador -> retardoNode -> perdidaGain ─┬─> analyserProcesada
//                                                 ▲                                                            └─> destinoProcesado (MediaStreamAudioDestinationNode)
//                                  ruidoGain ──────┘
//                                     ▲
//                              ruidoSource (buffer de ruido blanco en loop)
//
//   cadenaGain -> analyserSenal   (tap de solo lectura: potencia de la señal filtrada, SIN ruido)
//   ruidoGain  -> analyserRuido   (tap de solo lectura: potencia del ruido YA escalado, SIN señal)
//
// Fase 3 (Laboratorio del Canal): retardoNode (DelayNode) y perdidaGain
// (GainNode) degradan REALMENTE la señal procesada -no son animaciones-,
// con la misma filosofía de topología fija que los filtros: siempre están
// conectados, y "sin degradación" es simplemente retardo=0 / ganancia=1.
// Como van ANTES de analyserProcesada, la comparación "original vs.
// procesada" de la pestaña Filtros también refleja retardo/pérdida.
//
// Todo el código está comentado en español.
window.MeynaAudioEngine = (function () {
  'use strict';

  // -------------------------------------------------------------------
  // Constantes de configuración
  // -------------------------------------------------------------------
  const Q_DEFECTO = 0.7071067811865476; // 1/√2: alineación "Butterworth", sin resonancia en el borde del filtro.
  const Q_NOTCH_DEFECTO = 10;           // Q alto = notch angosto: elimina la frecuencia central sin comerse el resto.
  const RUIDO_DURACION_S = 2;           // duración del buffer de ruido en loop.
  const RUIDO_GANANCIA_MAXIMA = 0.35;   // límite superior del aporte del ruido a la mezcla (ver comentario de clipping abajo).
  const FFT_SIZE_POTENCIA = 512;        // tamaño de bloque de los analizadores de potencia (señal/ruido); no necesitan la resolución en frecuencia de la FFT principal, solo un valor estable de energía.
  const RETARDO_MAXIMO_S = 2;           // margen del DelayNode: sobra frente al pico posible (500ms base + 100ms de jitter = 600ms).
  const TICK_CANAL_MS = 150;            // período del ticker compartido de jitter/pérdida.
  const RAMPA_JITTER_S = 0.04;          // constante de tiempo al mover el retardo (evita saltos bruscos; el "wobble" de tono residual es inherente a modular un DelayNode en vivo, igual que en un jitter buffer real).
  const DURACION_RAFAGA_PERDIDA_S = 0.07; // duración de cada silenciamiento simulado.
  const RAMPA_PERDIDA_S = 0.005;        // rampa de entrada/salida de la ráfaga (evita el "clic" de un corte instantáneo).

  // -------------------------------------------------------------------
  // Estado del motor (nodos del grafo, construidos UNA sola vez y
  // reutilizados durante toda la sesión, igual que el patrón de dsp.js).
  // -------------------------------------------------------------------
  let audioCtxRef = null;
  let filtroA = null;
  let filtroB = null;
  let cadenaGain = null;
  let nodoMezcla = null;
  let compresorLimitador = null;
  let analyserProcesada = null;
  let destinoProcesado = null;
  let analyserSenal = null;
  let analyserRuido = null;
  let generadorRuido = null;
  let retardoNode = null;
  let perdidaGain = null;
  let tickerCanalId = null;   // único setInterval compartido para jitter + pérdida.
  let rafagaPerdidaEnCurso = false;

  // Estado "lógico" de filtro/ruido: vive independientemente de si los
  // nodos ya existen o no, para que un usuario pueda dejar configurados
  // filtro/ruido ANTES de iniciar la transmisión y que se apliquen apenas
  // arranque (en vez de perderse silenciosamente).
  let filtroActual = {
    tipo: 'ninguno', // 'ninguno' | 'pasabajos' | 'pasaaltos' | 'pasabanda' | 'notch'
    frecuenciaCorte: 1000,
    frecuenciaInferior: 300,
    frecuenciaSuperior: 3400,
    frecuenciaCentral: 60,
    q: Q_DEFECTO
  };
  let ruidoEstado = { activo: false, intensidad: 30 };

  // Estado "lógico" del canal (Fase 3): igual criterio que filtroActual,
  // sobrevive aunque el motor todavía no se haya construido.
  let canalEstado = {
    retardoMs: 0,
    jitterActivo: false,
    jitterAmplitudMs: 0,
    perdidaPorcentaje: 0
  };
  let contadoresPerdida = { bloquesEvaluados: 0, bloquesDegradados: 0 };

  let transmitirProcesado = false;
  const callbacksCambioPista = [];

  // -------------------------------------------------------------------
  // FILTROS — topología fija (filtroA -> filtroB), solo cambian parámetros
  // -------------------------------------------------------------------
  // En vez de reconectar nodos distintos según el filtro elegido,
  // mantenemos SIEMPRE dos BiquadFilterNode en cascada y variamos su
  // .type/.frequency/.Q. "Sin filtro" dejar ambos en type='allpass': un
  // allpass tiene, por construcción matemática (coeficientes del Audio EQ
  // Cookbook), magnitud |H(ω)|=1 en TODO el espectro -no es una
  // aproximación visual, es una propiedad exacta del filtro-, así que en
  // cascada (dos allpass) la energía/potencia/RMS de la señal no cambian.
  // Ojo: un allpass SÍ altera la fase, así que el osciloscopio "procesado
  // sin filtro" puede no verse pixel-idéntico al original aunque la FFT de
  // magnitud y el RMS coincidan — es esperado, no es un bug.
  //
  // "Pasa-banda" se arma cascadeando un pasa-altos (frecuencia inferior)
  // con un pasa-bajos (frecuencia superior) en vez de usar el
  // type='bandpass' nativo de Web Audio: así el usuario controla borde por
  // borde con dos frecuencias independientes e intuitivas, y de paso el
  // corte es más pronunciado (12 dB/octava por borde, dos polos por etapa,
  // contra ~6 dB/octava del bandpass nativo de una sola etapa) — ideal
  // para el preset de "canal telefónico". Para bandas muy angostas esto
  // introduce algo de rizado por solape de las bandas de transición; en
  // 300-3400 Hz (relación >10x) es despreciable.
  function aplicarParametrosFiltro() {
    if (!filtroA || !filtroB || !audioCtxRef) return;
    const ahora = audioCtxRef.currentTime;
    const RAMPA = 0.01; // constante de tiempo para setTargetAtTime: evita "zipper noise" al mover sliders en vivo.

    switch (filtroActual.tipo) {
      case 'pasabajos':
        filtroA.type = 'lowpass';
        filtroA.frequency.setTargetAtTime(filtroActual.frecuenciaCorte, ahora, RAMPA);
        filtroA.Q.setTargetAtTime(filtroActual.q, ahora, RAMPA);
        filtroB.type = 'allpass';
        filtroB.frequency.setTargetAtTime(1000, ahora, RAMPA);
        break;
      case 'pasaaltos':
        filtroA.type = 'highpass';
        filtroA.frequency.setTargetAtTime(filtroActual.frecuenciaCorte, ahora, RAMPA);
        filtroA.Q.setTargetAtTime(filtroActual.q, ahora, RAMPA);
        filtroB.type = 'allpass';
        filtroB.frequency.setTargetAtTime(1000, ahora, RAMPA);
        break;
      case 'pasabanda':
        filtroA.type = 'highpass';
        filtroA.frequency.setTargetAtTime(filtroActual.frecuenciaInferior, ahora, RAMPA);
        filtroA.Q.setTargetAtTime(filtroActual.q, ahora, RAMPA);
        filtroB.type = 'lowpass';
        filtroB.frequency.setTargetAtTime(filtroActual.frecuenciaSuperior, ahora, RAMPA);
        filtroB.Q.setTargetAtTime(filtroActual.q, ahora, RAMPA);
        break;
      case 'notch':
        filtroA.type = 'notch';
        filtroA.frequency.setTargetAtTime(filtroActual.frecuenciaCentral, ahora, RAMPA);
        filtroA.Q.setTargetAtTime(filtroActual.q, ahora, RAMPA);
        filtroB.type = 'allpass';
        filtroB.frequency.setTargetAtTime(1000, ahora, RAMPA);
        break;
      default: // 'ninguno'
        filtroA.type = 'allpass';
        filtroA.frequency.setTargetAtTime(1000, ahora, RAMPA);
        filtroB.type = 'allpass';
        filtroB.frequency.setTargetAtTime(1000, ahora, RAMPA);
    }
  }

  // Aplica una nueva configuración de filtro. `.type` de un BiquadFilterNode
  // NO es un AudioParam rampeable: cambia los coeficientes IIR de golpe en
  // el siguiente bloque de audio, lo que puede sonar como un clic si se
  // cambia en vivo durante la transmisión. Lo envolvemos en un
  // silenciamiento breve (~25 ms) alrededor del cambio para que sea
  // inaudible; los cambios de frecuencia/Q dentro del MISMO tipo de filtro
  // no necesitan esto porque ya usan setTargetAtTime (rampa suave).
  function configurarFiltro(nuevaConfig) {
    const cambioDeTipo = nuevaConfig.tipo !== undefined && nuevaConfig.tipo !== filtroActual.tipo;
    Object.assign(filtroActual, nuevaConfig);

    if (!filtroA || !cadenaGain || !audioCtxRef) {
      actualizarIndicadoresFiltro();
      return; // el motor aún no se inicializó (sin transmisión activa); el estado ya quedó guardado para cuando arranque.
    }

    if (cambioDeTipo) {
      const ahora = audioCtxRef.currentTime;
      cadenaGain.gain.setTargetAtTime(0, ahora, 0.005);
      setTimeout(function () {
        aplicarParametrosFiltro();
        if (audioCtxRef) {
          cadenaGain.gain.setTargetAtTime(1, audioCtxRef.currentTime, 0.005);
        }
      }, 25);
    } else {
      aplicarParametrosFiltro();
    }
    actualizarIndicadoresFiltro();
  }

  // -------------------------------------------------------------------
  // RUIDO — generación real de ruido blanco, mezclado de verdad
  // -------------------------------------------------------------------
  // Se genera un buffer corto con muestras aleatorias independientes y se
  // reproduce en loop (un AudioBufferSourceNode solo puede arrancarse UNA
  // vez en toda su vida útil, así que se arranca aquí y el
  // encendido/apagado se controla exclusivamente con la ganancia).
  function crearGeneradorRuido(audioCtx) {
    const numMuestras = Math.floor(audioCtx.sampleRate * RUIDO_DURACION_S);
    const buffer = audioCtx.createBuffer(1, numMuestras, audioCtx.sampleRate);
    const datos = buffer.getChannelData(0);
    for (let i = 0; i < numMuestras; i++) {
      // Ruido blanco UNIFORME (no gaussiano): cada muestra es
      // independiente y equiprobable en [-1, 1]. Es la aproximación
      // didáctica habitual de "ruido blanco" -densidad espectral de
      // potencia aproximadamente plana-, aunque la definición estadística
      // estricta usa una distribución gaussiana.
      datos[i] = Math.random() * 2 - 1;
    }

    const fuente = audioCtx.createBufferSource();
    fuente.buffer = buffer;
    fuente.loop = true;
    // NOTA: al repetirse cada 2s, el "ruido" es en realidad periódico
    // (0.5 Hz) en vez de infinito/no correlacionado a largo plazo.
    // Inaudible como periodicidad para el oído humano, pero relevante para
    // quien le aplique un análisis de autocorrelación de larga duración.

    const ganancia = audioCtx.createGain();
    ganancia.gain.value = 0;
    fuente.connect(ganancia);
    fuente.start();

    let activo = false;
    let intensidadPorcentaje = 30;

    function aplicarGanancia() {
      const objetivo = activo ? (intensidadPorcentaje / 100) * RUIDO_GANANCIA_MAXIMA : 0;
      ganancia.gain.setTargetAtTime(objetivo, audioCtx.currentTime, 0.02);
    }

    return {
      nodoSalida: ganancia,
      setActivo: function (valor) { activo = !!valor; aplicarGanancia(); },
      setIntensidad: function (pct) { intensidadPorcentaje = Math.min(100, Math.max(0, Number(pct) || 0)); aplicarGanancia(); },
      estaActivo: function () { return activo; },
      obtenerIntensidad: function () { return intensidadPorcentaje; }
    };
  }

  function configurarRuido(opciones) {
    if (opciones.activo !== undefined) ruidoEstado.activo = !!opciones.activo;
    if (opciones.intensidad !== undefined) ruidoEstado.intensidad = Math.min(100, Math.max(0, Number(opciones.intensidad) || 0));
    if (generadorRuido) {
      generadorRuido.setActivo(ruidoEstado.activo);
      generadorRuido.setIntensidad(ruidoEstado.intensidad);
    }
    actualizarIndicadorRuido();
  }

  // -------------------------------------------------------------------
  // LABORATORIO DEL CANAL (Fase 3) — retardo, jitter y pérdida REALES
  // -------------------------------------------------------------------
  // IMPORTANTE (documentado también en la UI): el jitter y la pérdida
  // simulados aquí actúan sobre la SEÑAL DE AUDIO ya capturada, con nodos
  // reales de Web Audio (DelayNode/GainNode) — no son animaciones ni
  // números inventados. Pero NO son jitter/pérdida de paquetes RTP reales
  // (eso ocurre en la capa de red/RTP, inaccesible desde JavaScript en el
  // navegador). Las métricas "reales" de WebRTC (bitrate/jitter/pérdida/
  // RTT medidos por getStats()) se muestran aparte y nunca se confunden
  // con estos valores configurados.

  function aplicarRetardoBase() {
    if (!retardoNode || !audioCtxRef) return;
    const base = canalEstado.retardoMs / 1000;
    retardoNode.delayTime.setTargetAtTime(base, audioCtxRef.currentTime, RAMPA_JITTER_S);
  }

  function configurarRetardo(ms) {
    canalEstado.retardoMs = Math.max(0, Number(ms) || 0);
    aplicarRetardoBase();
    actualizarIndicadoresCanal();
  }

  function configurarJitter(opciones) {
    if (opciones.activo !== undefined) canalEstado.jitterActivo = !!opciones.activo;
    if (opciones.amplitudMs !== undefined) canalEstado.jitterAmplitudMs = Math.max(0, Number(opciones.amplitudMs) || 0);
    if (!canalEstado.jitterActivo) {
      // Al desactivar, el retardo vuelve limpiamente a su valor base (sin
      // dejar una variación "congelada" a mitad de camino).
      aplicarRetardoBase();
    }
    actualizarIndicadoresCanal();
  }

  function configurarPerdida(opciones) {
    if (opciones.porcentaje !== undefined) canalEstado.perdidaPorcentaje = Math.min(100, Math.max(0, Number(opciones.porcentaje) || 0));
    if (opciones.porcentaje !== undefined) {
      contadoresPerdida = { bloquesEvaluados: 0, bloquesDegradados: 0 }; // reiniciar el conteo al cambiar la configuración
    }
    actualizarIndicadoresCanal();
  }

  // Único tick compartido (cada TICK_CANAL_MS) para jitter y pérdida.
  // Cada rama tiene su propio try/catch: un fallo en una no debe impedir
  // que la otra se siga evaluando en el mismo tick (mismo criterio
  // fail-safe que el resto del motor).
  function tickCanal() {
    try {
      if (canalEstado.jitterActivo && retardoNode && audioCtxRef) {
        const amplitudS = canalEstado.jitterAmplitudMs / 1000;
        const offset = (Math.random() * 2 - 1) * amplitudS; // uniforme en [-amplitud, +amplitud]
        const nuevoRetardo = Math.max(0, canalEstado.retardoMs / 1000 + offset);
        retardoNode.delayTime.setTargetAtTime(nuevoRetardo, audioCtxRef.currentTime, RAMPA_JITTER_S);
      }
    } catch (err) {
      console.warn('MeynaAudioEngine: error al aplicar jitter', err);
    }

    try {
      if (canalEstado.perdidaPorcentaje > 0 && perdidaGain && audioCtxRef && !rafagaPerdidaEnCurso) {
        contadoresPerdida.bloquesEvaluados++;
        if (Math.random() * 100 < canalEstado.perdidaPorcentaje) {
          contadoresPerdida.bloquesDegradados++;
          dispararRafagaPerdida();
        }
        // Refresca el indicador "bloques degradados/evaluados" en cada
        // tick (no solo cuando el usuario cambia el control): si no, el
        // contador crece internamente pero la UI queda congelada en 0/0.
        actualizarIndicadoresCanal();
      }
    } catch (err) {
      console.warn('MeynaAudioEngine: error al aplicar pérdida artificial', err);
    }
  }

  function dispararRafagaPerdida() {
    rafagaPerdidaEnCurso = true;
    const ahora = audioCtxRef.currentTime;
    // cancelAndHoldAtTime evita el salto que produciría cancelar y volver a
    // programar sobre un valor de .value potencialmente desactualizado
    // (solo se refresca una vez por quantum de renderizado de audio).
    perdidaGain.gain.cancelAndHoldAtTime(ahora);
    perdidaGain.gain.setTargetAtTime(0.05, ahora, RAMPA_PERDIDA_S); // silencio casi total, no absoluto (evita un corte 100% seco)
    const finRafaga = ahora + DURACION_RAFAGA_PERDIDA_S;
    perdidaGain.gain.setTargetAtTime(1, finRafaga, RAMPA_PERDIDA_S);
    setTimeout(function () {
      rafagaPerdidaEnCurso = false;
    }, (DURACION_RAFAGA_PERDIDA_S + RAMPA_PERDIDA_S * 3) * 1000);
  }

  function iniciarTickerCanal() {
    if (tickerCanalId !== null) return; // nunca más de un intervalo activo.
    tickerCanalId = setInterval(tickCanal, TICK_CANAL_MS);
  }

  function detenerTickerCanal() {
    if (tickerCanalId !== null) {
      clearInterval(tickerCanalId);
      tickerCanalId = null;
    }
  }

  // -------------------------------------------------------------------
  // MÉTRICAS — relación señal-ruido (SNR)
  // -------------------------------------------------------------------
  // SNR_dB = 10·log10(P_señal / P_ruido), la fórmula estándar para
  // relación señal-ruido en potencia (a diferencia de la versión en
  // amplitud, que usaría 20·log10 — aquí P_señal/P_ruido YA son potencias,
  // calculadas con calcularEstadisticas() de dsp.js, así que corresponde
  // el factor 10).
  //
  // LIMITACIÓN IMPORTANTE (documentada a propósito): esto mide el SNR "de
  // inyección" — potencia de la señal filtrada y potencia del ruido que
  // NOSOTROS generamos, medidas en dos ramas separadas ANTES de mezclarse
  // (ver analyserSenal/analyserRuido en construirCadena). Es una medición
  // directa y exacta porque controlamos el ruido. NO es una técnica de
  // estimación ciega de SNR sobre una grabación real con ruido ambiental
  // desconocido (eso requeriría técnicas estadísticas mucho más
  // avanzadas, como separación ciega de fuentes). No confundir ambos usos.
  function calcularSNRdB(potenciaSenal, potenciaRuido) {
    const EPS = 1e-9;
    if (!(potenciaRuido > EPS)) {
      // Sin ruido activo (o con una potencia insignificante) no existe una
      // estimación válida de SNR: se reporta explícitamente en vez de
      // devolver Infinity o un número engañoso.
      return { snrDb: null, valido: false };
    }
    const snrDb = 10 * Math.log10(Math.max(potenciaSenal, EPS) / potenciaRuido);
    return { snrDb: snrDb, valido: true };
  }

  // -------------------------------------------------------------------
  // MOTOR — construcción del grafo y ciclo de vida
  // -------------------------------------------------------------------
  function construirCadena(audioCtx) {
    filtroA = audioCtx.createBiquadFilter();
    filtroB = audioCtx.createBiquadFilter();
    filtroA.connect(filtroB);

    cadenaGain = audioCtx.createGain(); // envuelve los cambios de tipo de filtro en un soft-mute (ver configurarFiltro).
    filtroB.connect(cadenaGain);

    // Tap de potencia de la señal YA filtrada, SIN ruido (para el SNR).
    analyserSenal = audioCtx.createAnalyser();
    analyserSenal.fftSize = FFT_SIZE_POTENCIA;
    cadenaGain.connect(analyserSenal);

    nodoMezcla = audioCtx.createGain(); // un GainNode normal suma automáticamente todas sus entradas: no hace falta un nodo "mezclador" especial.
    cadenaGain.connect(nodoMezcla);

    generadorRuido = crearGeneradorRuido(audioCtx);
    generadorRuido.nodoSalida.connect(nodoMezcla);

    // Tap de potencia del ruido YA escalado por la intensidad, SIN señal.
    analyserRuido = audioCtx.createAnalyser();
    analyserRuido.fftSize = FFT_SIZE_POTENCIA;
    generadorRuido.nodoSalida.connect(analyserRuido);

    // La suma señal+ruido puede superar [-1, 1] y producir clipping (lo
    // que además invalidaría el SNR medido por separado). Un limitador
    // nativo -sin librerías externas- evita esto; no es un efecto
    // artístico, es una protección técnica.
    compresorLimitador = audioCtx.createDynamicsCompressor();
    compresorLimitador.threshold.setValueAtTime(-3, audioCtx.currentTime);
    compresorLimitador.knee.setValueAtTime(0, audioCtx.currentTime);
    compresorLimitador.ratio.setValueAtTime(20, audioCtx.currentTime);
    compresorLimitador.attack.setValueAtTime(0.003, audioCtx.currentTime);
    compresorLimitador.release.setValueAtTime(0.25, audioCtx.currentTime);
    nodoMezcla.connect(compresorLimitador);

    // Fase 3 — Laboratorio del Canal: retardo y pérdida artificiales,
    // REALES sobre la señal (no una animación). Topología fija, igual
    // criterio que los filtros: "sin degradación" es simplemente
    // retardo=0 / ganancia=1, nunca se desconectan estos nodos.
    retardoNode = audioCtx.createDelay(RETARDO_MAXIMO_S);
    retardoNode.delayTime.value = 0;
    compresorLimitador.connect(retardoNode);

    perdidaGain = audioCtx.createGain();
    perdidaGain.gain.value = 1;
    retardoNode.connect(perdidaGain);

    analyserProcesada = audioCtx.createAnalyser();
    // Mismo tamaño de bloque que el analizador original de dsp.js, para
    // que la comparación FFT original-vs-procesada use igual resolución
    // en frecuencia y sea directamente comparable.
    analyserProcesada.fftSize = window.MeynaDSP.FFT_SIZE;
    perdidaGain.connect(analyserProcesada);

    destinoProcesado = audioCtx.createMediaStreamDestination();
    perdidaGain.connect(destinoProcesado);
    // Importante: NUNCA conectamos a audioCtx.destination (evitar eco del
    // propio micrófono), igual que hace dsp.js con su analyser original.

    // Aplicamos el estado guardado (por si el usuario configuró filtro,
    // ruido o canal ANTES de iniciar la transmisión, mientras el motor no
    // existía).
    aplicarParametrosFiltro();
    generadorRuido.setActivo(ruidoEstado.activo);
    generadorRuido.setIntensidad(ruidoEstado.intensidad);
    aplicarRetardoBase();
  }

  // Se llama justo DESPUÉS de MeynaDSP.attachStream() en cada startMedia()
  // (primer inicio de transmisión y cada cambio de modo). FAIL-SAFE: igual
  // que dsp.js, cualquier error queda contenido aquí, nunca rompe la
  // transmisión.
  function attachStream() {
    try {
      const audioCtx = window.MeynaDSP && window.MeynaDSP.obtenerAudioContext();
      if (!audioCtx) return; // dsp.js no pudo inicializarse; ya reportó su propio warning.
      audioCtxRef = audioCtx;

      if (!filtroA) {
        construirCadena(audioCtx);
      }

      // Reconecta la cadena de procesamiento al sourceNode VIGENTE de
      // dsp.js (un objeto nuevo en cada cambio de modo). Si el modo actual
      // no tiene pista de audio (ej. pantalla sin audio del sistema),
      // conectarRamaAdicional devuelve false sin lanzar error.
      const conectado = window.MeynaDSP.conectarRamaAdicional(filtroA);
      actualizarEstadoDisponibilidad(conectado);
      iniciarTickerCanal();
    } catch (err) {
      console.warn('MeynaAudioEngine: no se pudo inicializar el procesamiento de audio', err);
    }
  }

  function detachStream() {
    actualizarEstadoDisponibilidad(false);
    detenerTickerCanal();
  }

  // -------------------------------------------------------------------
  // Pista procesada para WebRTC
  // -------------------------------------------------------------------
  function obtenerPistaAudioActiva() {
    if (!transmitirProcesado || !destinoProcesado) return null;
    const pistas = destinoProcesado.stream.getAudioTracks();
    return pistas.length ? pistas[0] : null;
  }

  function notificarCambioPista() {
    callbacksCambioPista.forEach(function (cb) {
      try { cb(); } catch (err) { console.warn('MeynaAudioEngine: error en callback de cambio de pista', err); }
    });
  }

  function establecerTransmitirProcesado(valor) {
    transmitirProcesado = !!valor;
    notificarCambioPista();
  }

  // index.html registra aquí la función que recorre peerConnections y hace
  // replaceTrack() cuando cambia qué pista debe transmitirse.
  function alCambiarPistaActiva(callback) {
    if (typeof callback === 'function') callbacksCambioPista.push(callback);
  }

  // -------------------------------------------------------------------
  // Presets didácticos
  // -------------------------------------------------------------------
  // Configuraciones de referencia con fines educativos, NO modelos
  // universales de canal ni recomendaciones de producción.
  const PRESETS = {
    vozClara: {
      // Pasa-altos suave (elimina retumbo/zumbido grave) + pasa-bajos
      // (recorta siseo/agudos innecesarios), implementado como pasa-banda
      // ancho: deja pasar cómodamente la voz humana.
      filtro: { tipo: 'pasabanda', frecuenciaInferior: 120, frecuenciaSuperior: 6000, q: Q_DEFECTO }
    },
    canalTelefonico: {
      // Ancho de banda clásico de telefonía analógica (300-3400 Hz).
      filtro: { tipo: 'pasabanda', frecuenciaInferior: 300, frecuenciaSuperior: 3400, q: Q_DEFECTO }
    },
    eliminacionZumbido: {
      // 60 Hz es la frecuencia de la red eléctrica en Colombia/América;
      // en regiones con red a 50 Hz (Europa, gran parte de Asia/África)
      // debe ajustarse la frecuencia central a 50 Hz con el slider.
      filtro: { tipo: 'notch', frecuenciaCentral: 60, q: Q_NOTCH_DEFECTO }
    },
    canalConRuido: {
      filtro: { tipo: 'ninguno' },
      ruido: { activo: true, intensidad: 30 }
    }
  };

  function aplicarPreset(nombre) {
    const preset = PRESETS[nombre];
    if (!preset) return;
    if (preset.filtro) configurarFiltro(preset.filtro);
    configurarRuido(preset.ruido || { activo: false });
  }

  // -------------------------------------------------------------------
  // Indicadores de la interfaz
  // -------------------------------------------------------------------
  const NOMBRES_FILTRO = {
    ninguno: 'Sin filtro',
    pasabajos: 'Pasa-bajos',
    pasaaltos: 'Pasa-altos',
    pasabanda: 'Pasa-banda',
    notch: 'Rechazo de banda (notch)'
  };

  function actualizarIndicadoresFiltro() {
    const elTipo = document.getElementById('dspFilterActiveIndicator');
    if (elTipo) elTipo.textContent = NOMBRES_FILTRO[filtroActual.tipo] || filtroActual.tipo;

    const elCorte = document.getElementById('dspCutoffIndicator');
    if (elCorte) {
      if (filtroActual.tipo === 'pasabajos' || filtroActual.tipo === 'pasaaltos') {
        elCorte.textContent = filtroActual.frecuenciaCorte + ' Hz';
      } else if (filtroActual.tipo === 'pasabanda') {
        elCorte.textContent = filtroActual.frecuenciaInferior + ' – ' + filtroActual.frecuenciaSuperior + ' Hz';
      } else if (filtroActual.tipo === 'notch') {
        elCorte.textContent = filtroActual.frecuenciaCentral + ' Hz';
      } else {
        elCorte.textContent = '—';
      }
    }
  }

  function actualizarIndicadorRuido() {
    const el = document.getElementById('dspNoiseActiveIndicator');
    if (el) {
      el.textContent = ruidoEstado.activo ? ('Sí (' + ruidoEstado.intensidad + '%)') : 'No';
    }
  }

  function actualizarEstadoDisponibilidad(disponible) {
    const check = document.getElementById('dspTransmitProcessed');
    if (check) check.disabled = !disponible;
    const hint = document.getElementById('dspProcessingHint');
    if (hint) {
      hint.textContent = disponible
        ? ''
        : 'El procesamiento requiere una pista de audio activa (no disponible en el modo actual).';
    }
  }

  // Indicadores propios del motor que también se muestran en la pestaña
  // "Canal" (dsp-channel.js); ese módulo sincroniza sus propios controles
  // (sliders/selects) por separado, esto solo actualiza los textos.
  function actualizarIndicadoresCanal() {
    const elRetardo = document.getElementById('dspChannelDelayIndicator');
    if (elRetardo) elRetardo.textContent = canalEstado.retardoMs + ' ms';
    const elJitter = document.getElementById('dspChannelJitterIndicator');
    if (elJitter) {
      elJitter.textContent = canalEstado.jitterActivo ? ('±' + canalEstado.jitterAmplitudMs + ' ms') : 'Desactivado';
    }
    const elPerdida = document.getElementById('dspChannelLossIndicator');
    if (elPerdida) elPerdida.textContent = canalEstado.perdidaPorcentaje + ' %';
    const elBloques = document.getElementById('dspChannelLossBlocksIndicator');
    if (elBloques) {
      elBloques.textContent = contadoresPerdida.bloquesDegradados + ' / ' + contadoresPerdida.bloquesEvaluados;
    }
  }

  // -------------------------------------------------------------------
  // Interfaz: controles de la pestaña "Filtros"
  // -------------------------------------------------------------------
  function grupoVisiblePara(tipo) {
    const grupoCorte = document.getElementById('dspCutoffGroup');
    const grupoBanda = document.getElementById('dspBandGroup');
    const grupoNotch = document.getElementById('dspNotchGroup');
    const grupoQ = document.getElementById('dspQGroup');
    if (grupoCorte) grupoCorte.style.display = (tipo === 'pasabajos' || tipo === 'pasaaltos') ? 'block' : 'none';
    if (grupoBanda) grupoBanda.style.display = tipo === 'pasabanda' ? 'block' : 'none';
    if (grupoNotch) grupoNotch.style.display = tipo === 'notch' ? 'block' : 'none';
    if (grupoQ) grupoQ.style.display = tipo === 'ninguno' ? 'none' : 'block';
  }

  // Actualiza los números que se muestran junto a cada slider (ej. "Corte:
  // 1000 Hz") a partir del valor ACTUAL de cada control en el DOM.
  function actualizarEtiquetasSliders() {
    const pares = [
      ['dspCutoffFreq', 'dspCutoffFreqLabel'],
      ['dspLowFreq', 'dspLowFreqLabel'],
      ['dspHighFreq', 'dspHighFreqLabel'],
      ['dspNotchFreq', 'dspNotchFreqLabel'],
      ['dspFilterQ', 'dspFilterQLabel'],
      ['dspNoiseIntensity', 'dspNoiseIntensityLabel']
    ];
    pares.forEach(function (par) {
      const input = document.getElementById(par[0]);
      const label = document.getElementById(par[1]);
      if (input && label) label.textContent = input.value;
    });
  }

  function sincronizarControlesConEstado() {
    const selectTipo = document.getElementById('dspFilterType');
    const sliderCorte = document.getElementById('dspCutoffFreq');
    const sliderInferior = document.getElementById('dspLowFreq');
    const sliderSuperior = document.getElementById('dspHighFreq');
    const sliderCentral = document.getElementById('dspNotchFreq');
    const sliderQ = document.getElementById('dspFilterQ');
    const checkRuido = document.getElementById('dspNoiseActive');
    const sliderRuido = document.getElementById('dspNoiseIntensity');
    if (selectTipo) selectTipo.value = filtroActual.tipo;
    if (sliderCorte) sliderCorte.value = filtroActual.frecuenciaCorte;
    if (sliderInferior) sliderInferior.value = filtroActual.frecuenciaInferior;
    if (sliderSuperior) sliderSuperior.value = filtroActual.frecuenciaSuperior;
    if (sliderCentral) sliderCentral.value = filtroActual.frecuenciaCentral;
    if (sliderQ) sliderQ.value = filtroActual.q;
    if (checkRuido) checkRuido.checked = ruidoEstado.activo;
    if (sliderRuido) sliderRuido.value = ruidoEstado.intensidad;
    grupoVisiblePara(filtroActual.tipo);
    actualizarEtiquetasSliders();
    actualizarIndicadoresFiltro();
    actualizarIndicadorRuido();
  }

  function initUI() {
    const selectTipo = document.getElementById('dspFilterType');
    if (!selectTipo) return; // el HTML de la pestaña "Filtros" todavía no existe (defensivo, mismo criterio que dsp.js).

    const sliderCorte = document.getElementById('dspCutoffFreq');
    const sliderInferior = document.getElementById('dspLowFreq');
    const sliderSuperior = document.getElementById('dspHighFreq');
    const sliderCentral = document.getElementById('dspNotchFreq');
    const sliderQ = document.getElementById('dspFilterQ');
    const btnRestaurar = document.getElementById('dspFilterResetBtn');
    const checkRuido = document.getElementById('dspNoiseActive');
    const sliderRuido = document.getElementById('dspNoiseIntensity');
    const checkTransmitir = document.getElementById('dspTransmitProcessed');

    function leerFormularioYAplicar() {
      configurarFiltro({
        tipo: selectTipo.value,
        frecuenciaCorte: Number(sliderCorte.value),
        frecuenciaInferior: Number(sliderInferior.value),
        frecuenciaSuperior: Number(sliderSuperior.value),
        frecuenciaCentral: Number(sliderCentral.value),
        q: Number(sliderQ.value)
      });
      grupoVisiblePara(selectTipo.value);
      actualizarEtiquetasSliders();
    }

    selectTipo.addEventListener('change', leerFormularioYAplicar);
    [sliderCorte, sliderInferior, sliderSuperior, sliderCentral, sliderQ].forEach(function (el) {
      el.addEventListener('input', leerFormularioYAplicar);
    });

    if (btnRestaurar) {
      btnRestaurar.addEventListener('click', function () {
        // Restaura SOLO los parámetros de filtro/ruido; deliberadamente NO
        // toca el interruptor "Transmitir audio procesado" para no cortar
        // el audio hacia los oyentes en medio de una demostración en vivo.
        filtroActual = { tipo: 'ninguno', frecuenciaCorte: 1000, frecuenciaInferior: 300, frecuenciaSuperior: 3400, frecuenciaCentral: 60, q: Q_DEFECTO };
        ruidoEstado = { activo: false, intensidad: 30 };
        configurarFiltro(filtroActual);
        configurarRuido(ruidoEstado);
        sincronizarControlesConEstado();
      });
    }

    if (checkRuido) {
      checkRuido.addEventListener('change', function () {
        configurarRuido({ activo: checkRuido.checked, intensidad: Number(sliderRuido.value) });
      });
    }
    if (sliderRuido) {
      sliderRuido.addEventListener('input', function () {
        configurarRuido({ activo: checkRuido.checked, intensidad: Number(sliderRuido.value) });
        actualizarEtiquetasSliders();
      });
    }

    if (checkTransmitir) {
      checkTransmitir.addEventListener('change', function () {
        establecerTransmitirProcesado(checkTransmitir.checked);
      });
    }

    const presets = {
      dspPresetVozClara: 'vozClara',
      dspPresetTelefonico: 'canalTelefonico',
      dspPresetZumbido: 'eliminacionZumbido',
      dspPresetRuido: 'canalConRuido'
    };
    Object.keys(presets).forEach(function (idBoton) {
      const boton = document.getElementById(idBoton);
      if (boton) {
        boton.addEventListener('click', function () {
          aplicarPreset(presets[idBoton]);
          sincronizarControlesConEstado();
        });
      }
    });

    grupoVisiblePara(selectTipo.value);
    actualizarEtiquetasSliders();
    actualizarIndicadoresFiltro();
    actualizarIndicadorRuido();
    actualizarEstadoDisponibilidad(false); // hasta que attachStream() confirme que hay audio disponible.
  }

  initUI();

  return {
    attachStream: attachStream,
    detachStream: detachStream,
    configurarFiltro: configurarFiltro,
    configurarRuido: configurarRuido,
    aplicarPreset: aplicarPreset,
    establecerTransmitirProcesado: establecerTransmitirProcesado,
    obtenerPistaAudioActiva: obtenerPistaAudioActiva,
    alCambiarPistaActiva: alCambiarPistaActiva,
    calcularSNRdB: calcularSNRdB,
    obtenerAnalyserProcesada: function () { return analyserProcesada; },
    obtenerAnalyserSenal: function () { return analyserSenal; },
    obtenerAnalyserRuido: function () { return analyserRuido; },
    FFT_SIZE_POTENCIA: FFT_SIZE_POTENCIA,
    // Fase 3 — Laboratorio del Canal.
    configurarRetardo: configurarRetardo,
    configurarJitter: configurarJitter,
    configurarPerdida: configurarPerdida,
    // Getters de solo lectura para que dsp-channel.js / dsp-interpreter.js
    // / dsp-experiment.js reutilicen el estado sin recalcularlo ni
    // duplicar variables propias.
    obtenerConfiguracionFiltro: function () { return Object.assign({}, filtroActual); },
    obtenerConfiguracionRuido: function () { return Object.assign({}, ruidoEstado); },
    obtenerConfiguracionCanalAudio: function () {
      return {
        retardoMs: canalEstado.retardoMs,
        jitterActivo: canalEstado.jitterActivo,
        jitterAmplitudMs: canalEstado.jitterAmplitudMs,
        perdidaPorcentaje: canalEstado.perdidaPorcentaje,
        bloquesEvaluados: contadoresPerdida.bloquesEvaluados,
        bloquesDegradados: contadoresPerdida.bloquesDegradados
      };
    }
  };
})();
