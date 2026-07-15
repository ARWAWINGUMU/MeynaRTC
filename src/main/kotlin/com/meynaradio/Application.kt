package com.meynaradio

import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.routing
import io.ktor.server.websocket.WebSockets
import io.ktor.server.websocket.webSocket
import io.ktor.websocket.CloseReason
import io.ktor.websocket.Frame
import io.ktor.websocket.WebSocketSession
import io.ktor.websocket.close
import io.ktor.websocket.readText
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

// Este servidor usa Ktor + WebSockets para hacer de simple pasarela de señalización.
// WebRTC necesita un canal de señalización para intercambiar SDP e ICE candidates.
// En este proyecto solo reenviamos esos mensajes entre el emisor y los oyentes.

@Serializable
data class SignalMessage(
    val type: String,
    val sender: String,
    val room: String,
    val payload: JsonObject = JsonObject(emptyMap()),
    val clientId: String? = null
)

@Serializable
data class LoginRequest(
    val username: String,
    val password: String,
    val captchaToken: String? = null,
    val captchaAnswer: String? = null
)

@Serializable
data class LoginResponse(
    val success: Boolean,
    val message: String
)

@Serializable
data class CaptchaChallenge(
    val token: String,
    val question: String
)

// Representa una conexión activa dentro de una sala.
data class ClientConnection(val session: WebSocketSession, val role: String, val clientId: String? = null)

// Cada sala guarda un único emisor y un mapa de oyentes indexado por clientId.
// Usar un mapa (y no una lista) garantiza que el servidor siempre sepa exactamente
// qué WebSocketSession pertenece a cada oyente, sin ambigüedades ni necesidad de
// recorrer/adivinar destinatarios al reenviar señalización.
data class RoomState(
    var broadcaster: ClientConnection? = null,
    val listeners: MutableMap<String, ClientConnection> = ConcurrentHashMap()
)

fun Application.module() {
    // Habilitamos negociación de JSON para endpoints HTTP simples como el login.
    install(ContentNegotiation) {
        json()
    }

    // Activamos el soporte para WebSockets.
    install(WebSockets) {
        maxFrameSize = Long.MAX_VALUE
        masking = false
    }

    // Creamos un mapa de salas para que cada room tenga su propio estado.
    val rooms = ConcurrentHashMap<String, RoomState>()
    val captchaStore = ConcurrentHashMap<String, Int>()
    val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    // Credenciales simples para entorno académico/demostrativo.
    // En producción conviene moverlas a variables de entorno seguras y usar HTTPS.
    val transmitterUser = System.getenv("TRANSMITTER_USER")?.trim()?.takeIf { it.isNotBlank() } ?: "admin"
    val transmitterPassword = System.getenv("TRANSMITTER_PASSWORD")?.trim()?.takeIf { it.isNotBlank() } ?: "admin123"

    routing {
        // Ruta principal: sirve la portada con las opciones de transmitir o escuchar.
        get("/") {
            call.respondText(readResource("static/index.html"), ContentType.Text.Html)
        }

        // Ruta para la página del oyente.
        get("/oyente.html") {
            call.respondText(readResource("static/oyente.html"), ContentType.Text.Html)
        }

        // Sirve el módulo del Laboratorio DSP (análisis de la señal en el emisor).
        get("/dsp.js") {
            call.respondText(readResource("static/dsp.js"), ContentType.Text.JavaScript)
        }

        // Fase 2 del Laboratorio DSP: motor de procesamiento (filtros/ruido/SNR)
        // y visualizador de comparación original-vs-procesada.
        get("/audio-dsp-engine.js") {
            call.respondText(readResource("static/audio-dsp-engine.js"), ContentType.Text.JavaScript)
        }
        get("/dsp-visualizer.js") {
            call.respondText(readResource("static/dsp-visualizer.js"), ContentType.Text.JavaScript)
        }

        // Fase 3: Laboratorio del Canal, Interpretación automática y Modo Experimento.
        get("/dsp-channel.js") {
            call.respondText(readResource("static/dsp-channel.js"), ContentType.Text.JavaScript)
        }
        get("/dsp-interpreter.js") {
            call.respondText(readResource("static/dsp-interpreter.js"), ContentType.Text.JavaScript)
        }
        get("/dsp-experiment.js") {
            call.respondText(readResource("static/dsp-experiment.js"), ContentType.Text.JavaScript)
        }

        // Genera un captcha simple para el formulario de login del emisor.
        get("/captcha") {
            val token = UUID.randomUUID().toString()
            val first = (1..9).random()
            val second = (1..9).random()
            val answer = first + second
            captchaStore[token] = answer
            call.respond(CaptchaChallenge(token, "$first + $second = ?"))
        }

        // Endpoint de autenticación para el modo emisor.
        post("/login-transmitter") {
            val request = call.receive<LoginRequest>()
            val expectedAnswer = request.captchaToken?.let { captchaStore.remove(it) }
            val captchaOk = expectedAnswer != null && expectedAnswer == request.captchaAnswer?.toIntOrNull()
            val credentialsOk = request.username == transmitterUser && request.password == transmitterPassword
            val success = credentialsOk && captchaOk

            val response = if (success) {
                LoginResponse(true, "Acceso concedido. Ya puedes transmitir.")
            } else {
                LoginResponse(false, "Usuario, contraseña o captcha incorrectos.")
            }

            call.respond(if (success) HttpStatusCode.OK else HttpStatusCode.Unauthorized, response)
        }

        // Endpoint WebSocket para la señalización.
        webSocket("/ws/{room}/{role}") {
            val room = call.parameters["room"] ?: run {
                close(CloseReason(CloseReason.Codes.CANNOT_ACCEPT, "Falta el nombre de la sala"))
                return@webSocket
            }

            val role = call.parameters["role"] ?: run {
                close(CloseReason(CloseReason.Codes.CANNOT_ACCEPT, "Falta el rol"))
                return@webSocket
            }

            val roomState = rooms.computeIfAbsent(room) { RoomState() }

            // El emisor es único por sala. Si ya existe, se rechaza la conexión.
            if (role == "emisor") {
                val errorMessage = synchronized(roomState) {
                    if (roomState.broadcaster != null) {
                        SignalMessage(
                            type = "error",
                            sender = "servidor",
                            room = room,
                            payload = JsonObject(mapOf("message" to JsonPrimitive("Ya existe un emisor en esta sala")))
                        )
                    } else {
                        roomState.broadcaster = ClientConnection(this, role)
                        null
                    }
                }
                if (errorMessage != null) {
                    send(Frame.Text(json.encodeToString(SignalMessage.serializer(), errorMessage)))
                    close(CloseReason(CloseReason.Codes.VIOLATED_POLICY, "Solo un emisor por sala"))
                    return@webSocket
                }
            }

            // Se recibe un mensaje inicial de "join" desde el oyente con su clientId.
            var notifiedLeave = false
            try {
                for (frame in incoming) {
                    if (frame !is Frame.Text) continue

                    val text = frame.readText()
                    val message = json.decodeFromString(SignalMessage.serializer(), text)

                    when (message.type) {
                        "join" -> {
                            // Solo los oyentes se registran con un identificador propio (clientId).
                            if (role == "oyente") {
                                val clientId = message.clientId ?: UUID.randomUUID().toString()
                                synchronized(roomState) {
                                    // Registramos (o reemplazamos, en caso de reconexión) ÚNICAMENTE
                                    // la entrada de ESTE clientId. Nunca se toca la de otro oyente.
                                    roomState.listeners[clientId] = ClientConnection(this, role, clientId)
                                }

                                // Avisamos al emisor que llegó un oyente nuevo para que cree una
                                // RTCPeerConnection dedicada y le envíe una oferta fresca.
                                // No existe ningún "offer pendiente" que reenviar aquí: cada oyente
                                // siempre negocia su propia sesión desde cero con el emisor, así que
                                // nunca puede recibir el SDP destinado a otro oyente.
                                val listenerJoinedMessage = SignalMessage(
                                    type = "listener-joined",
                                    sender = "servidor",
                                    room = room,
                                    payload = JsonObject(mapOf("clientId" to JsonPrimitive(clientId))),
                                    clientId = clientId
                                )
                                roomState.broadcaster?.session?.send(Frame.Text(json.encodeToString(SignalMessage.serializer(), listenerJoinedMessage)))
                            }
                        }

                        "offer" -> {
                            // El emisor crea una oferta específica para un oyente (identificado por
                            // clientId) y el servidor la reenvía EXCLUSIVAMENTE a ese oyente.
                            // Si el oyente ya no está en el mapa (se desconectó justo antes), el
                            // mensaje simplemente se descarta: nunca se hace broadcast de un offer,
                            // porque su SDP solo es válido para el destinatario original.
                            if (role == "emisor") {
                                val targetClientId = message.clientId
                                val targetListener = targetClientId?.let {
                                    synchronized(roomState) { roomState.listeners[it] }
                                }
                                targetListener?.session?.send(Frame.Text(json.encodeToString(SignalMessage.serializer(), message)))
                            }
                        }

                        "answer" -> {
                            // El oyente responde a SU oferta; se reenvía al emisor con su clientId
                            // intacto para que este aplique la respuesta a la PeerConnection correcta.
                            if (role == "oyente") {
                                roomState.broadcaster?.session?.send(Frame.Text(json.encodeToString(SignalMessage.serializer(), message)))
                            }
                        }

                        "candidate" -> {
                            if (role == "oyente") {
                                // ICE candidate del oyente -> se reenvía al emisor, que lo asocia a
                                // la PeerConnection correspondiente mediante el clientId del mensaje.
                                roomState.broadcaster?.session?.send(Frame.Text(json.encodeToString(SignalMessage.serializer(), message)))
                            } else if (role == "emisor") {
                                // ICE candidate del emisor -> se reenvía SOLO al oyente indicado por
                                // clientId. Sin este reenvío la negociación ICE de ese oyente nunca
                                // se completa fuera de la red local (falta STUN/TURN trickle), que es
                                // justo lo que fallaba tras el despliegue.
                                val targetClientId = message.clientId
                                val targetListener = targetClientId?.let {
                                    synchronized(roomState) { roomState.listeners[it] }
                                }
                                targetListener?.session?.send(Frame.Text(json.encodeToString(SignalMessage.serializer(), message)))
                            }
                        }

                        "receiver-stats" -> {
                            if (role == "oyente") {
                                roomState.broadcaster?.session?.send(Frame.Text(json.encodeToString(SignalMessage.serializer(), message)))
                            }
                        }

                        "leave" -> {
                            notifiedLeave = true
                            if (role == "oyente") {
                                val receiverId = message.payload["receiverId"]?.jsonPrimitive?.contentOrNull ?: message.clientId
                                val leftMessage = SignalMessage(
                                    type = "receiver-left",
                                    sender = "servidor",
                                    room = room,
                                    payload = JsonObject(mapOf("receiverId" to JsonPrimitive(receiverId ?: ""))),
                                    clientId = receiverId
                                )
                                roomState.broadcaster?.session?.send(Frame.Text(json.encodeToString(SignalMessage.serializer(), leftMessage)))
                            }
                            break
                        }
                    }
                }
            } finally {
                // Al cerrar la conexión, se elimina al cliente de la sala y, si era un
                // oyente el que se fue sin avisar (cierre abrupto de pestaña/red), se
                // notifica al emisor para que cierre SOLO esa PeerConnection.
                // (El bloque synchronized devuelve el par emisor+clientId a notificar;
                // antes se descartaba con un "null" final y la notificación nunca salía.)
                val notification: Pair<WebSocketSession, String>? = synchronized(roomState) {
                    var pending: Pair<WebSocketSession, String>? = null
                    if (role == "emisor") {
                        if (roomState.broadcaster?.session == this) {
                            roomState.broadcaster = null
                        }
                    } else {
                        val removedClientId = roomState.listeners.entries.firstOrNull { it.value.session == this }?.key
                        if (removedClientId != null) {
                            roomState.listeners.remove(removedClientId)
                            val broadcasterSession = roomState.broadcaster?.session
                            if (!notifiedLeave && broadcasterSession != null) {
                                pending = broadcasterSession to removedClientId
                            }
                        }
                    }

                    if (roomState.broadcaster == null && roomState.listeners.isEmpty()) {
                        rooms.remove(room)
                    }
                    pending
                }

                if (notification != null) {
                    val (broadcasterSession, removedClientId) = notification
                    val leftMessage = SignalMessage(
                        type = "receiver-left",
                        sender = "servidor",
                        room = room,
                        payload = JsonObject(mapOf("receiverId" to JsonPrimitive(removedClientId))),
                        clientId = removedClientId
                    )
                    broadcasterSession.send(Frame.Text(json.encodeToString(SignalMessage.serializer(), leftMessage)))
                }
            }
        }
    }
}

fun main() {
    // Railway y otros proveedores exponen el puerto mediante la variable PORT.
    val port = System.getenv("PORT")?.toIntOrNull() ?: 8080
    embeddedServer(Netty, port = port, host = "0.0.0.0") {
        module()
    }.start(wait = true)
}

// Lee un recurso del classpath para servir los archivos HTML desde resources/static.
private fun readResource(path: String): String {
    return Thread.currentThread().contextClassLoader.getResource(path)
        ?.readText()
        ?: error("No se encontró el recurso $path")
}
