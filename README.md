# MeynaRTC

> **Comunica. Analiza. Experimenta.**

**MeynaRTC** es un laboratorio interactivo para el estudio de **Sistemas de Comunicación**, **Teoría de la Información** y **Procesamiento Digital de Señales (DSP)**, desarrollado sobre **WebRTC**, **Kotlin + Ktor**, **WebSockets** y **Web Audio API**.

A diferencia de una aplicación tradicional de videoconferencia, MeynaRTC integra transmisión multimedia en tiempo real con herramientas de análisis, procesamiento y experimentación sobre la señal de audio, permitiendo visualizar y comprender conceptos fundamentales de las comunicaciones digitales.

---

# Características principales

## Comunicación multimedia en tiempo real

- Transmisión mediante **WebRTC nativo**.
- Modos de transmisión:
  - Solo audio.
  - Audio + cámara.
  - Compartir pantalla.
- Cambio dinámico entre modos sin reiniciar la sesión.
- Soporte para múltiples oyentes simultáneos.
- Arquitectura Peer-to-Peer (Mesh).

---

## Métricas de comunicación (QoS)

Monitoreo en tiempo real mediante `RTCPeerConnection.getStats()`:

- Bitrate
- RTT (Round Trip Time)
- Jitter
- Pérdida de paquetes
- Estado ICE
- Estado de la conexión

Las métricas corresponden a datos reales proporcionados por WebRTC y permiten evaluar la calidad de la comunicación.

---

# Laboratorio DSP

Uno de los principales aportes de MeynaRTC es la incorporación de un laboratorio completo de Procesamiento Digital de Señales.

## Fase 1 — Análisis

Visualización en tiempo real de la señal capturada.

Incluye:

- Osciloscopio
- Transformada Rápida de Fourier (FFT)
- Espectrograma
- Energía
- Potencia
- RMS
- Frecuencia dominante
- Ancho de banda ocupado

La FFT fue implementada utilizando el algoritmo de **Cooley-Tukey**, permitiendo realizar análisis espectral en tiempo real.

---

## Fase 2 — Procesamiento

El usuario puede modificar la señal antes de ser transmitida mediante:

- Filtro pasa bajos
- Filtro pasa altos
- Filtro pasa banda
- Filtro Notch
- Inyección de ruido blanco
- Estimación de SNR
- Comparación entre señal original y procesada

Opcionalmente, el audio procesado puede enviarse directamente a todos los oyentes utilizando `RTCRtpSender.replaceTrack()`.

---

## Fase 3 — Laboratorio del Canal

Permite simular diferentes condiciones de una red de comunicaciones.

Características:

- Retardo artificial
- Jitter artificial
- Pérdida simulada de información
- Limitación real del bitrate del codificador WebRTC
- Presets educativos:

  - Canal ideal
  - Red estable
  - Red congestionada
  - Red degradada
  - Canal telefónico (300–3400 Hz)

Esto permite estudiar el impacto que tienen las condiciones del canal sobre la calidad de la comunicación.

---

# Interpretación automática

El sistema analiza automáticamente los resultados obtenidos durante la transmisión.

Calcula:

- Frecuencia dominante
- Ancho de banda ocupado
- RMS
- Energía
- Potencia
- SNR
- Calidad estimada

Además genera conclusiones automáticas basadas en reglas determinísticas, sin utilizar servicios de inteligencia artificial externos.

---

# Modo Experimento

MeynaRTC incorpora un modo de experimentación para realizar pruebas controladas.

Durante el experimento se registran automáticamente:

- Bitrate
- RTT
- Jitter
- Pérdida
- RMS
- Energía
- Potencia
- SNR
- Frecuencia dominante
- Ancho de banda

Al finalizar, el sistema genera:

- Promedio
- Valor mínimo
- Valor máximo
- Desviación estándar
- Conclusión automática

Los resultados pueden exportarse como:

- JSON
- CSV

Estos archivos pueden analizarse posteriormente utilizando:

- MATLAB
- Python
- Google Colab
- Microsoft Excel
- LibreOffice Calc

---

# Arquitectura

## Backend

- Kotlin
- Ktor
- WebSockets
- Docker

## Frontend

- HTML5
- CSS3
- JavaScript (Vanilla)

## Comunicación

- WebRTC
- MediaStream
- RTCPeerConnection
- WebSocket Signaling
- STUN

## Procesamiento de audio

- Web Audio API
- AudioContext
- DelayNode
- GainNode
- BiquadFilterNode
- AnalyserNode

---

# Relación con la asignatura

MeynaRTC fue desarrollado como laboratorio para la asignatura **Teoría de la Información y Sistemas de Comunicación**, permitiendo estudiar de manera práctica conceptos como:

- Modelo de Shannon
- Transformada de Fourier
- FFT
- Procesamiento Digital de Señales
- Energía
- Potencia
- RMS
- Relación Señal-Ruido (SNR)
- Filtros digitales
- Canales de comunicación
- QoS
- Latencia
- Jitter
- Bitrate
- Pérdida de paquetes
- WebRTC

---

# Requisitos

- Java 17 o superior
- Gradle 9+
- Docker (opcional)
- Navegador moderno con soporte para WebRTC y Web Audio API

---

# Ejecución local

```bash
gradle run
```

Abrir en el navegador:

```
http://localhost:8080/
```

Oyente:

```
http://localhost:8080/oyente.html
```

---

# Flujo de uso

1. Ingresar como emisor.
2. Autenticarse.
3. Seleccionar el modo de transmisión.
4. Iniciar la comunicación.
5. Activar el Laboratorio DSP.
6. Aplicar filtros o modificar el canal.
7. Ejecutar un experimento.
8. Analizar las métricas.
9. Exportar los resultados.

---

# Despliegue

El proyecto puede desplegarse mediante:

- Docker
- Render
- Railway

Recomiendo probar en Render a través del siguiente enlace: https://meynartc-2.onrender.com/ esperar de 1 a 3 minutos que despliegue el programa y probar.
---

# Aplicaciones académicas

MeynaRTC puede utilizarse como laboratorio para cursos de:

- Teoría de la Información
- Sistemas de Comunicación
- Procesamiento Digital de Señales
- Redes de Computadores
- Multimedia
- Telecomunicaciones
- Ingeniería Electrónica
- Ingeniería de Sistemas

---

# Estado del proyecto

Proyecto desarrollado con fines académicos.

Su objetivo es demostrar la integración entre transmisión multimedia en tiempo real, análisis de señales y experimentación sobre sistemas de comunicación dentro de un navegador web moderno.

---

# Licencia

Proyecto desarrollado con fines educativos y de investigación.
