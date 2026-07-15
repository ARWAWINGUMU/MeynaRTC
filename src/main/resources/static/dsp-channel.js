// =====================================================================
// LABORATORIO DEL CANAL — Fase 3 del Laboratorio DSP
// =====================================================================
// Este módulo NO crea nodos de audio propios: el retardo/jitter/pérdida
// artificiales viven en audio-dsp-engine.js (que ya administra la cadena
// de audio completa) y aquí solo se ORQUESTAN — se traduce la UI de la
// pestaña "Canal" a llamadas sobre esa API existente. Lo único que este
// archivo posee de verdad es la limitación de BITRATE, porque eso no es
// audio: es configuración de RTCRtpSender (WebRTC), algo que
// audio-dsp-engine.js no conoce ni debe conocer.
//
// Diferenciación importante (también documentada en la UI):
//   - Retardo/jitter/pérdida: degradan la señal de audio DE VERDAD
//     (DelayNode/GainNode reales), pero son una simulación académica —
//     NO tocan paquetes RTP reales.
//   - Bitrate: SÍ es real — RTCRtpSender.setParameters() limita de verdad
//     el encoder de WebRTC.
//   - Bitrate/jitter/pérdida/RTT "medidos": provienen de getStats() real
//     (ya expuestos por index.html en #bitrateValue/#jitterValue/etc.),
//     nunca se inventan aquí.
window.MeynaDspChannel = (function () {
  'use strict';

  let bitrateObjetivoBps = null; // null = automático (sin límite).
  const callbacksCambioBitrate = [];

  // -------------------------------------------------------------------
  // Bitrate (WebRTC real)
  // -------------------------------------------------------------------
  function establecerBitrateObjetivo(bps) {
    bitrateObjetivoBps = bps || null;
    actualizarIndicadorBitrateObjetivo();
    callbacksCambioBitrate.forEach(function (cb) {
      try { cb(); } catch (err) { console.warn('MeynaDspChannel: error en callback de cambio de bitrate', err); }
    });
  }

  function obtenerBitrateObjetivo() {
    return bitrateObjetivoBps;
  }

  // index.html registra aquí la función que debe ejecutarse cada vez que
  // cambia el bitrate objetivo (para recorrer sus PeerConnection reales).
  function alCambiarBitrate(callback) {
    if (typeof callback === 'function') callbacksCambioBitrate.push(callback);
  }

  // Aplica el bitrate objetivo actual a UN sender. Patrón seguro: nunca se
  // construye un objeto encodings desde cero, siempre se muta el que
  // devuelve getParameters() (llamada más reciente); "automático" se
  // representa borrando la propiedad maxBitrate (no asignando 0, que en
  // algunas implementaciones significa "pausar el envío").
  async function aplicarLimiteBitrateA(sender) {
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      if (bitrateObjetivoBps) {
        params.encodings[0].maxBitrate = bitrateObjetivoBps;
      } else {
        delete params.encodings[0].maxBitrate;
      }
      await sender.setParameters(params);
    } catch (err) {
      console.warn('MeynaDspChannel: no se pudo aplicar el límite de bitrate', err);
    }
  }

  // Aplica el bitrate objetivo a TODOS los senders de audio de un mapa de
  // RTCPeerConnection (lo pasa index.html: aquí no se guarda una
  // referencia propia a peerConnections, para no duplicar el estado).
  // Promise.allSettled: un oyente con la conexión en mal estado no debe
  // bloquear el resto.
  async function aplicarLimiteBitrateATodos(peerConnections) {
    if (!peerConnections) return;
    return Promise.allSettled(
      Array.from(peerConnections.values()).map(function (pc) {
        const sender = pc.getSenders().find(function (s) { return s.track && s.track.kind === 'audio'; });
        return aplicarLimiteBitrateA(sender);
      })
    );
  }

  // -------------------------------------------------------------------
  // Ruido del canal: reutiliza tal cual MeynaAudioEngine.configurarRuido
  // (Fase 2). Aquí solo se agregan 3 presets de intensidad "amigables".
  // -------------------------------------------------------------------
  const PRESETS_RUIDO_CANAL = { suave: 15, moderado: 30, fuerte: 50 };

  function aplicarPresetRuido(nivel) {
    const intensidad = PRESETS_RUIDO_CANAL[nivel];
    if (intensidad === undefined || !window.MeynaAudioEngine) return;
    window.MeynaAudioEngine.configurarRuido({ activo: true, intensidad: intensidad });
  }

  // -------------------------------------------------------------------
  // Presets didácticos del canal completo (filtro + ruido + retardo +
  // jitter + pérdida + bitrate). Configuraciones de referencia para el
  // aula, NO estándares universales de red — documentado también en la UI.
  // -------------------------------------------------------------------
  const PRESETS_CANAL = {
    canalIdeal: {
      filtro: { tipo: 'ninguno' }, ruido: { activo: false },
      retardoMs: 0, jitter: { activo: false, amplitudMs: 0 }, perdida: { porcentaje: 0 },
      bitrateBps: null
    },
    redEstable: {
      filtro: { tipo: 'ninguno' }, ruido: { activo: false },
      retardoMs: 50, jitter: { activo: true, amplitudMs: 10 }, perdida: { porcentaje: 0 },
      bitrateBps: null
    },
    redCongestionada: {
      filtro: { tipo: 'ninguno' }, ruido: { activo: false },
      retardoMs: 200, jitter: { activo: true, amplitudMs: 50 }, perdida: { porcentaje: 5 },
      bitrateBps: 32000
    },
    redDeficiente: {
      filtro: { tipo: 'ninguno' }, ruido: { activo: false },
      retardoMs: 500, jitter: { activo: true, amplitudMs: 100 }, perdida: { porcentaje: 20 },
      bitrateBps: 16000
    },
    canalTelefonicoDegradado: {
      filtro: { tipo: 'pasabanda', frecuenciaInferior: 300, frecuenciaSuperior: 3400, q: 0.7071067811865476 },
      ruido: { activo: true, intensidad: 20 },
      retardoMs: 50, jitter: { activo: false, amplitudMs: 0 }, perdida: { porcentaje: 0 },
      bitrateBps: 16000
    }
  };

  function aplicarPresetCanal(nombre) {
    const preset = PRESETS_CANAL[nombre];
    if (!preset || !window.MeynaAudioEngine) return;
    const engine = window.MeynaAudioEngine;
    engine.configurarFiltro(preset.filtro);
    engine.configurarRuido(preset.ruido);
    engine.configurarRetardo(preset.retardoMs);
    engine.configurarJitter(preset.jitter);
    engine.configurarPerdida(preset.perdida);
    establecerBitrateObjetivo(preset.bitrateBps);
  }

  // -------------------------------------------------------------------
  // Indicadores e interfaz
  // -------------------------------------------------------------------
  function actualizarIndicadorBitrateObjetivo() {
    const el = document.getElementById('dspChannelBitrateTargetIndicator');
    if (el) el.textContent = bitrateObjetivoBps ? (Math.round(bitrateObjetivoBps / 1000) + ' kbps') : 'Automático';
  }

  // El bitrate REAL ya lo mide index.html (getStats() real) y lo muestra
  // en #bitrateValue; aquí solo se refleja para poder compararlo junto al
  // objetivo, sin duplicar la medición.
  function actualizarBitrateRealYDiferencia() {
    const elReal = document.getElementById('dspChannelBitrateRealIndicator');
    const elDiff = document.getElementById('dspChannelBitrateDiffIndicator');
    const elemento = document.getElementById('bitrateValue');
    if (!elemento) return;
    const realKbps = parseFloat(elemento.textContent) || 0;
    if (elReal) elReal.textContent = realKbps + ' kbps';
    if (elDiff) {
      if (!bitrateObjetivoBps) {
        elDiff.textContent = '—';
      } else {
        const objetivoKbps = bitrateObjetivoBps / 1000;
        elDiff.textContent = (realKbps - objetivoKbps).toFixed(1) + ' kbps';
      }
    }
  }

  function estaVisible() {
    const panel = document.getElementById('dspPanel');
    const tab = document.getElementById('dspTabCanal');
    return !!panel && panel.style.display !== 'none' && !!tab && tab.style.display !== 'none';
  }

  function sincronizarControlesConEstado() {
    const engine = window.MeynaAudioEngine;
    if (!engine) return;
    const canal = engine.obtenerConfiguracionCanalAudio();
    const selectRetardo = document.getElementById('dspChannelDelay');
    const selectJitter = document.getElementById('dspChannelJitter');
    const selectPerdida = document.getElementById('dspChannelLoss');
    const selectBitrate = document.getElementById('dspChannelBitrate');
    if (selectRetardo) selectRetardo.value = String(canal.retardoMs);
    if (selectJitter) selectJitter.value = canal.jitterActivo ? String(canal.jitterAmplitudMs) : '0';
    if (selectPerdida) selectPerdida.value = String(canal.perdidaPorcentaje);
    if (selectBitrate) selectBitrate.value = bitrateObjetivoBps ? String(bitrateObjetivoBps) : 'auto';
    actualizarIndicadorBitrateObjetivo();
  }

  function initUI() {
    const selectRetardo = document.getElementById('dspChannelDelay');
    if (!selectRetardo) return; // el HTML de la pestaña "Canal" todavía no existe.

    const selectJitter = document.getElementById('dspChannelJitter');
    const selectPerdida = document.getElementById('dspChannelLoss');
    const selectBitrate = document.getElementById('dspChannelBitrate');
    const btnRestaurar = document.getElementById('dspChannelResetBtn');

    selectRetardo.addEventListener('change', function () {
      if (window.MeynaAudioEngine) window.MeynaAudioEngine.configurarRetardo(Number(selectRetardo.value));
    });

    selectJitter.addEventListener('change', function () {
      const amplitud = Number(selectJitter.value);
      if (window.MeynaAudioEngine) {
        window.MeynaAudioEngine.configurarJitter({ activo: amplitud > 0, amplitudMs: amplitud });
      }
    });

    selectPerdida.addEventListener('change', function () {
      if (window.MeynaAudioEngine) window.MeynaAudioEngine.configurarPerdida({ porcentaje: Number(selectPerdida.value) });
    });

    selectBitrate.addEventListener('change', function () {
      const valor = selectBitrate.value;
      establecerBitrateObjetivo(valor === 'auto' ? null : Number(valor));
    });

    if (btnRestaurar) {
      btnRestaurar.addEventListener('click', function () {
        // Restaura SOLO retardo/jitter/pérdida/bitrate (lo propio de esta
        // pestaña); filtro y ruido tienen su propio "Restaurar valores" en
        // la pestaña Filtros, para no producir efectos cruzados sorpresa.
        if (window.MeynaAudioEngine) {
          window.MeynaAudioEngine.configurarRetardo(0);
          window.MeynaAudioEngine.configurarJitter({ activo: false, amplitudMs: 0 });
          window.MeynaAudioEngine.configurarPerdida({ porcentaje: 0 });
        }
        establecerBitrateObjetivo(null);
        sincronizarControlesConEstado();
      });
    }

    const presetsRuido = { dspChannelNoiseSuave: 'suave', dspChannelNoiseModerado: 'moderado', dspChannelNoiseFuerte: 'fuerte' };
    Object.keys(presetsRuido).forEach(function (id) {
      const boton = document.getElementById(id);
      if (boton) boton.addEventListener('click', function () { aplicarPresetRuido(presetsRuido[id]); });
    });
    const btnRuidoOff = document.getElementById('dspChannelNoiseOff');
    if (btnRuidoOff) {
      btnRuidoOff.addEventListener('click', function () {
        if (window.MeynaAudioEngine) window.MeynaAudioEngine.configurarRuido({ activo: false });
      });
    }

    const presetsCanal = {
      dspChannelPresetIdeal: 'canalIdeal',
      dspChannelPresetEstable: 'redEstable',
      dspChannelPresetCongestionada: 'redCongestionada',
      dspChannelPresetDeficiente: 'redDeficiente',
      dspChannelPresetTelefonico: 'canalTelefonicoDegradado'
    };
    Object.keys(presetsCanal).forEach(function (id) {
      const boton = document.getElementById(id);
      if (boton) {
        boton.addEventListener('click', function () {
          aplicarPresetCanal(presetsCanal[id]);
          sincronizarControlesConEstado();
        });
      }
    });

    sincronizarControlesConEstado();

    // Único intervalo de este módulo: refresca "bitrate real" y la
    // diferencia frente al objetivo (el valor real ya lo mide index.html
    // vía getStats(); aquí solo se refleja, nunca se recalcula). Se
    // autolimita revisando la visibilidad de la pestaña en cada tick, en
    // vez de crear/destruir el intervalo constantemente.
    setInterval(function () {
      if (estaVisible()) actualizarBitrateRealYDiferencia();
    }, 1000);
  }

  initUI();

  return {
    establecerBitrateObjetivo: establecerBitrateObjetivo,
    obtenerBitrateObjetivo: obtenerBitrateObjetivo,
    alCambiarBitrate: alCambiarBitrate,
    aplicarLimiteBitrateA: aplicarLimiteBitrateA,
    aplicarLimiteBitrateATodos: aplicarLimiteBitrateATodos,
    obtenerConfiguracionCanal: function () {
      const engine = window.MeynaAudioEngine;
      const canal = engine ? engine.obtenerConfiguracionCanalAudio() : { retardoMs: 0, jitterActivo: false, jitterAmplitudMs: 0, perdidaPorcentaje: 0, bloquesEvaluados: 0, bloquesDegradados: 0 };
      canal.bitrateObjetivoBps = bitrateObjetivoBps;
      return canal;
    }
  };
})();
