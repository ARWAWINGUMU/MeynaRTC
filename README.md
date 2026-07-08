# MeynaRTC

Laboratorio multimedia de comunicaciones en tiempo real basado en WebRTC nativo, Kotlin + Ktor y WebSockets.

## Qué cambia en esta versión
- El proyecto ahora se presenta como MeynaRTC con el slogan oficial: "Comunica sin fronteras."
- El emisor autenticado puede elegir entre tres modos de transmisión:
  - Solo audio
  - Cámara + audio
  - Compartir pantalla
- El oyente entra libremente y reproduce el stream correspondiente.
- El emisor puede enviar archivos pequeños por WebRTC DataChannel.
- El oyente puede recibir, previsualizar o descargar esos archivos.
- Se agregan métricas WebRTC en tiempo real: bitrate, jitter, pérdida, RTT y estado de la conexión.

## Arquitectura didáctica
- Canal multimedia WebRTC: transporta audio, video y datos entre pares.
- Canal de señalización WebSocket: reenvía SDP e ICE candidates entre emisor y oyentes.
- Canal de datos DataChannel: transporta archivos binarios entre pares.

## Relación con Teoría de la Información y Sistemas de Comunicación
- Fuente de información: micrófono, cámara o pantalla.
- Codificación: WebRTC encapsula y adapta el flujo para la red.
- Canal: enlace P2P entre emisor y oyente.
- Señalización: WebSocket para negociación inicial.
- Transmisión: MediaStream para audio/video y datos para archivos.
- Recepción: reproducción local y reconstrucción de archivos.
- Jitter, latencia, pérdida de paquetes y QoS: se observan en las métricas del navegador.

## Requisitos
- Java 17+
- Gradle 9+
- Navegador moderno con soporte para WebRTC y DataChannel

## Ejecutar localmente
1. Abre una terminal en la carpeta del proyecto.
2. Ejecuta:
   ```bash
   gradle run
   ```
3. Abre en el navegador:
   - http://localhost:8080/
   - http://localhost:8080/oyente.html

## Flujo de uso
1. En la portada elige "Transmitir" o "Escuchar".
2. El emisor accede con las credenciales de desarrollo:
   - Usuario: admin
   - Contraseña: admin123
3. El emisor selecciona un modo: audio, cámara o pantalla.
4. Inicia la transmisión y luego puede enviar archivos pequeños (máx. 10 MB).
5. El oyente entra a la misma sala y recibe el stream o los archivos.

## Métricas de múltiples oyentes
- Cada oyente reporta cada segundo métricas de recepción al emisor por WebSocket.
- El emisor conserva un resumen general, una tabla por oyente y un selector para ver las gráficas individuales.
- Esto permite comparar cómo se comporta el mismo flujo multimedia en distintos receptores.

## Notas de seguridad
- Este ejemplo sigue siendo didáctico y académico.
- Se recomienda HTTPS en producción.
- Para producción se deben mover las credenciales a variables de entorno seguras.
- Si la red es restrictiva, puede requerirse TURN.

## Despliegue en Railway
1. Sube el repositorio a GitHub.
2. Crea un nuevo proyecto en Railway.
3. Conecta el repositorio.
4. Configura las variables de entorno:
   - TRANSMITTER_USER
   - TRANSMITTER_PASSWORD
5. Genera el dominio público y prueba el laboratorio completo.
