require("dotenv").config();
const { Pool } = require('pg');
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// Servir archivos estáticos para que Meta pueda descargar el PDF desde tu PC vía ngrok
app.use(express.static('public'));

// Evitar errores de TLS en entornos de desarrollo
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

// 1. Configuración de Pool para conexión siempre activa
const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
});

db.on('connect', () => console.log("✅ Conexión a Postgres establecida"));

const { WHATSAPP_TOKEN, PHONE_NUMBER_ID, VERIFY_TOKEN } = process.env;

// Lista de prefijos de 3 dígitos (según el documento proporcionado)
const prefijosTres = ["220","221","223","230","236","237","249","260","261","263","264","266","280","291","294","297","298","299","336","341","342","343","345","348","351","353","358","362","364","370","376","379","380","381","383","385","387","388"];

// Verificación del Webhook para Meta
app.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === (VERIFY_TOKEN || "botWhatsapp")) {
        return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
});

// Recepción de mensajes
app.post("/webhook", async (req, res) => {
    // CRÍTICO: Responder 200 OK inmediatamente para evitar que Meta reintente el mensaje cada 5 min
    res.sendStatus(200);

    try {
        const entry = req.body?.entry?.[0];
        const changes = entry?.changes?.[0]?.value;
        
        // Filtro: Solo procesar si hay un mensaje de texto nuevo (ignora confirmaciones de lectura)
        if (!changes?.messages || !changes.messages[0].text) return;

        const msg = changes.messages[0];
        const fromRaw = msg.from;
        const text = msg.text.body.trim().toLowerCase();

        // --- LÓGICA DE FORMATEO ARGENTINA (Basado en prefijos de 2, 3 y 4 dígitos) ---
        let clean = fromRaw.replace(/\D/g, '');
        let to = clean;
        if (clean.startsWith("549")) {
            const cuerpo = clean.substring(3); // Los 10 dígitos del número
            let codArea;
            if (cuerpo.startsWith("11")) {
                codArea = "11";
            } else if (prefijosTres.includes(cuerpo.substring(0, 3))) {
                codArea = cuerpo.substring(0, 3);
            } else {
                codArea = cuerpo.substring(0, 4);
            }
            let nroLocal = cuerpo.substring(codArea.length);
            to = `54${codArea}15${nroLocal}`; // Formato compatible para respuestas de Meta
        }

        // Consultar estado actual del usuario
        const resEstado = await db.query('SELECT estado FROM estados_usuarios WHERE numero_whatsapp = $1', [to]);
        const estadoActual = resEstado.rows[0]?.estado || 'INICIO';

        console.log(`📩 Mensaje de ${to} [Estado: ${estadoActual}]: ${text}`);

        // --- MÁQUINA DE ESTADOS / MENÚ ---
        
        // Comando para volver al inicio o empezar
        if (text === 'hola' || text === 'menu') {
            await db.query('INSERT INTO estados_usuarios (numero_whatsapp, estado) VALUES ($1, $2) ON CONFLICT (numero_whatsapp) DO UPDATE SET estado = $2', [to, 'INICIO']);
            return await sendText(to, "¡Hola! Bienvenido al sistema. 🤖\n\n1. Agendar Turno 📅\n2. Ver mis turnos 📋\n3. Ver Catálogo 🛍️\n4. Finalizar Conversación 🚩");
        }

        switch (estadoActual) {
            case 'INICIO':
                if (text === '1') {
                    await db.query('UPDATE estados_usuarios SET estado = $1 WHERE numero_whatsapp = $2', ['ESPERANDO_FECHA', to]);
                    await sendText(to, "Perfecto. Por favor, decime el día y hora en formato *DD/MM HH:MM*.\nEjemplo: *25/03 10:30*");
                } 
                else if (text === '2') {
                    const turnos = await db.query('SELECT fecha_hora FROM turnos WHERE numero_whatsapp = $1 ORDER BY id DESC LIMIT 5', [to]);
                    let lista = turnos.rows.length > 0 ? "📋 *Tus turnos:*\n" + turnos.rows.map(t => `- ${t.fecha_hora}`).join('\n') : "No tenés turnos registrados.";
                    await sendText(to, lista + "\n\nEscribí *Menu* para volver.");
                }
                else if (text === '3') {
                    await sendText(to, "📄 Te adjunto nuestro catálogo en PDF:");
                    // REEMPLAZAR con tu URL de ngrok actual
                    const urlNgrok = "https://nongravitational-unannoyingly-zackary.ngrok-free.dev"; 
                    await sendDocument(to, `${urlNgrok}/catalogo.pdf`, "Catalogo_Servicios.pdf");
                }
                else if (text === '4') {
                    await db.query('DELETE FROM estados_usuarios WHERE numero_whatsapp = $1', [to]);
                    await sendText(to, "Conversación finalizada. 👋 ¡Que tengas un gran día!");
                }
                else {
                    await sendText(to, "No entendí esa opción. Escribí *Menu* para ver las opciones disponibles.");
                }
                break;

            case 'ESPERANDO_FECHA':
                // Validación estricta para evitar errores en Postgres (DD/MM HH:MM)
                const regexFecha = /^([0-2][0-9]|3[0-1])\/(0[1-9]|1[0-2]) ([0-1][0-9]|2[0-3]):[0-5][0-9]$/;
                
                if (!regexFecha.test(text)) {
                    await sendText(to, "❌ *Formato incorrecto.*\n\nPor favor, usá exactamente este formato: *DD/MM HH:MM*\nEjemplo: *15/04 18:00*");
                } else {
                    await db.query('INSERT INTO turnos (numero_whatsapp, fecha_hora) VALUES ($1, $2)', [to, text]);
                    await db.query('UPDATE estados_usuarios SET estado = $1 WHERE numero_whatsapp = $2', ['INICIO', to]);
                    await sendText(to, `✅ ¡Excelente! Tu turno para el *${text}* ha sido agendado.`);
                }
                break;
        }

    } catch (err) {
        console.error("❌ Error en el proceso del webhook:", err.message);
    }
});

// --- FUNCIONES DE ENVÍO ---

async function sendText(to, message) {
    try {
        await axios.post(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
            messaging_product: "whatsapp", to, type: "text", text: { body: message }
        }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
    } catch (e) { console.error("❌ Error enviando texto:", e.response?.data || e.message); }
}

async function sendDocument(to, url, fileName) {
    try {
        await axios.post(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
            messaging_product: "whatsapp", to, type: "document", document: { link: url, filename: fileName }
        }, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
    } catch (e) { console.error("❌ Error enviando PDF:", e.response?.data || e.message); }
}

app.listen(5000, () => console.log("🚀 Servidor escuchando en puerto 5000"));