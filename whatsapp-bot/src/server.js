require("dotenv").config();
const { Pool } = require('pg');
const express = require("express");
const axios = require("axios");
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
app.use(express.json());

// --- INICIALIZAR GEMINI AI ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- CONFIGURACIÓN DE CARPETAS ---
const publicPath = path.join(process.cwd(), 'public');
app.use(express.static(publicPath));

// Crear carpeta para comprobantes si no existe
const uploadDir = path.join(publicPath, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// --- CONFIGURACIÓN DE SESIÓN ---
app.use(session({
    secret: 'clave-secreta-la-plata',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 3600000 } // 1 hora
}));

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const { WHATSAPP_TOKEN, PHONE_NUMBER_ID, VERIFY_TOKEN, ADMIN_PASSWORD } = process.env;

// --- AUTO-CONFIGURAR MENÚ DE IA EN LA BASE DE DATOS ---
db.query("SELECT * FROM menu_dinamico WHERE tipo_accion = 'sistema_ia'").then(res => {
    if (res.rows.length === 0) {
        db.query("SELECT MAX(numero_opcion) as max FROM menu_dinamico").then(maxRes => {
            const nextNum = (maxRes.rows[0].max || 2) + 1;
            db.query("INSERT INTO menu_dinamico (numero_opcion, titulo, tipo_accion, texto_respuesta) VALUES ($1, 'Hablar con Asistente Virtual 🤖', 'sistema_ia', 'Modo IA activado')", [nextNum]);
            console.log(`✅ Opción de Inteligencia Artificial agregada automáticamente al menú en la opción ${nextNum}`);
        }).catch(console.error);
    }
}).catch(console.error);

const auth = (req, res, next) => {
    if (req.session.admin) return next();
    res.status(401).send("No autorizado");
};

// ==========================================
// --- API PARA LA INTERFAZ WEB ---
// ==========================================

app.post("/api/login", (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) {
        req.session.admin = true;
        return res.sendStatus(200);
    }
    res.status(401).send("Password incorrecto");
});

app.post("/api/logout", (req, res) => {
    req.session.destroy((err) => {
        if (err) return res.status(500).send("Error al cerrar sesión");
        res.clearCookie('connect.sid'); 
        res.sendStatus(200);
    });
});

// -- CANCHAS --
app.get("/api/canchas", auth, async (req, res) => {
    const result = await db.query("SELECT * FROM canchas ORDER BY id");
    res.json(result.rows);
});
app.post("/api/canchas", auth, async (req, res) => {
    const { id, nombre, tipo } = req.body;
    if (id) await db.query("UPDATE canchas SET nombre=$1, tipo=$2 WHERE id=$3", [nombre, tipo, id]);
    else await db.query("INSERT INTO canchas (nombre, tipo) VALUES ($1, $2)", [nombre, tipo]);
    res.sendStatus(200);
});

// -- RESERVAS Y TURNOS --
app.get("/api/reservas", auth, async (req, res) => {
    try {
        const { fecha } = req.query;
        let query = `
            SELECT t.id, t.numero_whatsapp, t.deporte, t.hora, TO_CHAR(t.fecha, 'DD/MM/YYYY') as fecha, c.nombre as cancha, t.estado, t.comprobante_url 
            FROM turnos t JOIN canchas c ON t.cancha_id = c.id
        `;
        const params = [];

        if (fecha) {
            query += ` WHERE t.fecha = $1`;
            params.push(fecha);
        }

        query += ` ORDER BY t.estado DESC, t.fecha DESC, t.hora DESC`;

        const result = await db.query(query, params);
        res.json(result.rows);
    } catch (error) {
        res.status(500).send(error.message);
    }
});

app.post("/api/reservas", auth, async (req, res) => {
    try {
        const { numero_whatsapp, deporte, fecha, hora, cancha_id } = req.body;
        await db.query(
            'INSERT INTO turnos (numero_whatsapp, deporte, fecha, hora, cancha_id, estado) VALUES ($1, $2, $3, $4, $5, $6)',
            [numero_whatsapp, deporte, fecha, hora, cancha_id, 'confirmado']
        );
        res.sendStatus(200);
    } catch (err) { 
        res.status(500).send(err.message); 
    }
});

app.post("/api/reservas/:id/estado", auth, async (req, res) => {
    const { accion } = req.body; 
    const turnoId = req.params.id;
    try {
        const resT = await db.query("SELECT * FROM turnos WHERE id=$1", [turnoId]);
        const turno = resT.rows[0];
        if(!turno) return res.sendStatus(404);

        if (accion === 'confirmar') {
            await db.query("UPDATE turnos SET estado='confirmado' WHERE id=$1", [turnoId]);
            await sendText(turno.numero_whatsapp, `✅ *¡Tu reserva ha sido confirmada!*\nYa verificamos tu pago. Te esperamos.`);
        } else {
            await db.query("DELETE FROM turnos WHERE id=$1", [turnoId]);
            await sendText(turno.numero_whatsapp, `❌ *Reserva cancelada.*\nHubo un problema con tu comprobante o pago. Por favor comunicate con la administración.`);
        }
        res.sendStatus(200);
    } catch (error) { res.status(500).send(error.message); }
});

// -- MENÚ DINÁMICO --
app.get("/api/menu", auth, async (req, res) => {
    const result = await db.query("SELECT * FROM menu_dinamico ORDER BY numero_opcion");
    res.json(result.rows);
});
app.post("/api/menu", auth, async (req, res) => {
    const { id, numero_opcion, titulo, texto_respuesta } = req.body;
    if (id) await db.query("UPDATE menu_dinamico SET numero_opcion=$1, titulo=$2, texto_respuesta=$3 WHERE id=$4", [numero_opcion, titulo, texto_respuesta, id]);
    else await db.query("INSERT INTO menu_dinamico (numero_opcion, titulo, tipo_accion, texto_respuesta) VALUES ($1, $2, 'informativo', $3)", [numero_opcion, titulo, texto_respuesta]);
    res.sendStatus(200);
});
app.delete("/api/menu/:id", auth, async (req, res) => {
    await db.query("DELETE FROM menu_dinamico WHERE id=$1 AND tipo_accion='informativo'", [req.params.id]);
    res.sendStatus(200);
});


// ==========================================
// --- LÓGICA DEL BOT (WHATSAPP) ---
// ==========================================

function formatearNumero(fromRaw) {
    let clean = fromRaw.replace(/\D/g, '');
    if (clean.startsWith("549")) {
        const cuerpo = clean.substring(3);
        const prefijosTres = ["220","221","223","230","236","237","249","260","261","263","264","266","280","291","294","297","298","299","336","341","342","343","345","348","351","353","358","362","364","370","376","379","380","381","383","385","387","388"];
        let codArea = cuerpo.startsWith("11") ? "11" : (prefijosTres.includes(cuerpo.substring(0, 3)) ? cuerpo.substring(0, 3) : cuerpo.substring(0, 4));
        return `54${codArea}15${cuerpo.substring(codArea.length)}`;5
    }
    return clean;
}

app.get("/webhook", (req, res) => {
    if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === (VERIFY_TOKEN || "botWhatsapp")) return res.status(200).send(req.query["hub.challenge"]);
    res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
    res.sendStatus(200);
    try {
        const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        if (!msg) return;
        
        let text = msg.text?.body?.trim().toLowerCase() || '';
        const msgType = msg.type;
        const to = formatearNumero(msg.from);

        const resUser = await db.query('SELECT * FROM estados_usuarios WHERE numero_whatsapp = $1', [to]);
        const user = resUser.rows[0] || { estado: 'INICIO' };

        // COMANDO GLOBAL DE REINICIO
        if (text === 'hola' || text === 'menu' || text === 'salir') {
            await db.query('INSERT INTO estados_usuarios (numero_whatsapp, estado) VALUES ($1, $2) ON CONFLICT (numero_whatsapp) DO UPDATE SET estado = $2, deporte_elegido=NULL, fecha_elegida=NULL, hora_elegida=NULL, cancha_elegida_id=NULL', [to, 'INICIO']);
            const resMenu = await db.query('SELECT numero_opcion, titulo FROM menu_dinamico ORDER BY numero_opcion');
            let msgBienvenida = "🏟️ *Bienvenido al Complejo*\n\n";
            resMenu.rows.forEach(m => msgBienvenida += `${m.numero_opcion}. ${m.titulo}\n`);
            return await sendText(to, msgBienvenida);
        }

        switch (user.estado) {
            case 'INICIO':
                const numeroElegido = parseInt(text);
                
                if (!isNaN(numeroElegido) && text.length <= 2) {
                    const resOpcion = await db.query('SELECT * FROM menu_dinamico WHERE numero_opcion = $1', [numeroElegido]);
                    const opcion = resOpcion.rows[0];

                    if (opcion) {
                        if (opcion.tipo_accion === 'sistema_reservar') {
                            await db.query('UPDATE estados_usuarios SET estado=$1 WHERE numero_whatsapp=$2', ['SELECCION_DEPORTE', to]);
                            await sendText(to, "Indicanos el deporte:\n1. ⚽ Fútbol\n2. 🎾 Pádel");
                        } else if (opcion.tipo_accion === 'sistema_turnos') {
                            const t = await db.query(`SELECT TO_CHAR(fecha, 'DD/MM') as f, hora, (SELECT nombre FROM canchas WHERE id=cancha_id) as c FROM turnos WHERE numero_whatsapp=$1 AND estado='confirmado' AND fecha>=CURRENT_DATE ORDER BY fecha, hora`, [to]);
                            let m = t.rows.length ? "📋 *Mis Turnos Confirmados:*\n" : "No tenés turnos agendados.";
                            t.rows.forEach(r => m += `📅 ${r.f} - ${r.hora}hs (${r.c})\n`);
                            await sendText(to, m);
                        } else if (opcion.tipo_accion === 'sistema_ia') {
                            await db.query('UPDATE estados_usuarios SET estado=$1 WHERE numero_whatsapp=$2', ['HABLANDO_CON_IA', to]);
                            await sendText(to, "🤖 *Modo Asistente Activado*\n\n¡Hola! Soy la inteligencia artificial del complejo. Podés preguntarme lo que quieras.\n\n_(Para volver al menú de reservas, escribí *salir* o *menu*)_");
                        } else if (opcion.tipo_accion === 'informativo') {
                            await sendText(to, opcion.texto_respuesta);
                        }
                    } else await sendText(to, "Opción inválida. Elegí un número de la lista.");
                
                } else {
                    // SI ESCRIBE TEXTO LIBRE FUERA DEL MENÚ
                    try {
                        const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" }); 
                        const promptSistema = `
                            Sos el asistente de un complejo de canchas. El usuario no eligió un número del menú y te dijo: "${text}".
                            Respondé rápido, amable y con un emoji. 
                            IMPORTANTE: Al final de la respuesta, decile siempre al usuario que escriba "Menu" para ver las opciones, o que elija el número de "Asistente Virtual" si quiere seguir charlando.
                        `;
                        const result = await model.generateContent(promptSistema);
                        await sendText(to, result.response.text());
                    } catch (error) {
                        console.error("Error con Gemini:", error);
                        await sendText(to, "Escribí 'Menu' para ver las opciones disponibles.");
                    }
                }
                break;

            case 'HABLANDO_CON_IA':
                try {
                    const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });
                    const promptConversacion = `
                       Sos una persona gay y tenes que responder como si fueras un futbolista: "${text}"
                    `;
                    const result = await model.generateContent(promptConversacion);
                    await sendText(to, result.response.text());
                } catch (error) {
                    console.error("Error en conversación con Gemini:", error);
                    await sendText(to, "Disculpá, tuve un error en mis cables 🤖. Escribí 'Salir' para volver al menú.");
                }
                break;

            case 'SELECCION_DEPORTE':
                let dep = text === '1' ? 'futbol' : text === '2' ? 'padel' : null;
                if (dep) {
                    await db.query('UPDATE estados_usuarios SET estado=$1, deporte_elegido=$2 WHERE numero_whatsapp=$3', ['SELECCION_FECHA', dep, to]);
                    await sendText(to, "Elegí fecha (DD/MM):");
                } else {
                    await sendText(to, "Escribí 1 para Fútbol o 2 para Pádel.");
                }
                break;

            case 'SELECCION_FECHA':
                if (/^\d{2}\/\d{2}$/.test(text)) {
                    const [d, m] = text.split('/');
                    const año = new Date().getFullYear();
                    const fechaObj = new Date(año, parseInt(m) - 1, parseInt(d));
                    const hoy = new Date(); hoy.setHours(0,0,0,0);
                    
                    if (fechaObj < hoy) return await sendText(to, "❌ No podés elegir una fecha pasada.");

                    const f = `${año}-${m}-${d}`;
                    const hT = user.deporte_elegido === 'futbol' ? ['19:00', '21:00', '22:30'] : ['18:00', '19:30', '21:00'];
                    const resC = await db.query('SELECT COUNT(*) FROM canchas WHERE tipo=$1', [user.deporte_elegido]);
                    
                    const resO = await db.query("SELECT hora, COUNT(*) as oc FROM turnos WHERE deporte=$1 AND fecha=$2 AND estado IN ('confirmado', 'pendiente') GROUP BY hora", [user.deporte_elegido, f]);
                    
                    const libres = hT.filter(h => {
                        const oc = resO.rows.find(r => r.hora.trim() === h);
                        return !oc || parseInt(oc.oc) < parseInt(resC.rows[0].count);
                    });
                    
                    if (libres.length) {
                        await db.query('UPDATE estados_usuarios SET estado=$1, fecha_elegida=$2 WHERE numero_whatsapp=$3', ['SELECCION_HORA', f, to]);
                        let mH = "Horarios libres:\n\n";
                        libres.forEach((h, i) => mH += `${i+1}. ${h}hs\n`);
                        await sendText(to, mH);
                    } else await sendText(to, "❌ No hay lugar para esa fecha.");
                } else {
                    await sendText(to, "Formato incorrecto. Usá DD/MM (ej: 25y/03)");
                }
                break;

            case 'SELECCION_HORA':
                const hList = user.deporte_elegido === 'futbol' ? ['19:00', '21:00', '22:30'] : ['18:00', '19:30', '21:00'];
                const hSel = hList[parseInt(text)-1];
                if (hSel) {
                    const libres = await db.query(`SELECT id, nombre FROM canchas WHERE tipo=$1 AND id NOT IN (SELECT cancha_id FROM turnos WHERE fecha=$2 AND hora=$3 AND estado IN ('confirmado', 'pendiente'))`, [user.deporte_elegido, user.fecha_elegida, hSel]);
                    let mC = "Canchas disponibles:\n\n";
                    libres.rows.forEach((c, i) => mC += `${i+1}. ${c.nombre}\n`);
                    await db.query('UPDATE estados_usuarios SET estado=$1, hora_elegida=$2 WHERE numero_whatsapp=$3', ['SELECCION_CANCHA', hSel, to]);
                    await sendText(to, mC);
                } else {
                    await sendText(to, "Opción inválida.");
                }
                break;

            case 'SELECCION_CANCHA':
                const resOp = await db.query(`SELECT id, nombre FROM canchas WHERE tipo=$1 AND id NOT IN (SELECT cancha_id FROM turnos WHERE fecha=$2 AND hora=$3 AND estado IN ('confirmado', 'pendiente'))`, [user.deporte_elegido, user.fecha_elegida, user.hora_elegida]);
                const cF = resOp.rows[parseInt(text)-1];
                
                if (cF) {
                    await db.query('UPDATE estados_usuarios SET estado=$1, cancha_elegida_id=$2 WHERE numero_whatsapp=$3', ['ESPERANDO_COMPROBANTE', cF.id, to]);
                    await sendText(to, `¡Perfecto! Elegiste *${cF.nombre}*.\n\nPara terminar la reserva, por favor enviá ahora una **foto o PDF del comprobante de transferencia**, o escribí el número de operación.`);
                } else {
                    await sendText(to, "Opción no válida.");
                }
                break;
                
            case 'ESPERANDO_COMPROBANTE':
                let comprobanteGuardado = "Texto/Código provisto";

                if (msgType === 'image' || msgType === 'document') {
                    try {
                        const media = msgType === 'image' ? msg.image : msg.document;
                        const mediaId = media.id;
                        
                        let extension = 'jpg';
                        if (msgType === 'document' && media.mime_type === 'application/pdf') {
                            extension = 'pdf';
                        }

                        const urlRes = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
                        const imgData = await axios.get(urlRes.data.url, { responseType: 'arraybuffer', headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
                        
                        const fileName = `comp_${Date.now()}.${extension}`;
                        fs.writeFileSync(path.join(uploadDir, fileName), imgData.data);
                        comprobanteGuardado = `/uploads/${fileName}`;
                    } catch (e) {
                        console.error("Error al descargar archivo:", e.message);
                        comprobanteGuardado = "Error al descargar archivo";
                    }
                } else if (text) {
                    comprobanteGuardado = text; 
                }

                await db.query('INSERT INTO turnos (numero_whatsapp, deporte, fecha, hora, cancha_id, estado, comprobante_url) VALUES ($1,$2,$3,$4,$5,$6,$7)', 
                    [to, user.deporte_elegido, user.fecha_elegida, user.hora_elegida, user.cancha_elegida_id, 'pendiente', comprobanteGuardado]);

                await db.query('UPDATE estados_usuarios SET estado=$1, deporte_elegido=NULL, fecha_elegida=NULL, hora_elegida=NULL, cancha_elegida_id=NULL WHERE numero_whatsapp=$2', ['INICIO', to]);

                await sendText(to, "⏳ *¡Comprobante recibido!*\n\nTu turno está **PENDIENTE** de aprobación. Un administrador verificará el pago y te avisaremos por este medio cuando quede confirmado. ¡Gracias!");
                break;
        }
    } catch (err) { console.error("Error general:", err.message); }
});

async function sendText(to, body) {
    try {
        await axios.post(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, 
        { messaging_product: "whatsapp", to, type: "text", text: { body } }, 
        { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
    } catch (e) { console.error("Error WA:", e.message); }
}

app.listen(5000, () => console.log("🚀 Servidor con Inteligencia Artificial iniciado (Puerto 5000)"));