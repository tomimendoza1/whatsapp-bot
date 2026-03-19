const { sendText } = require("./whatsapp.service");

module.exports = async function (fastify) {
    // ✅ Verificación del webhook (Meta)
    fastify.get("/webhook", async (req, reply) => {
        console.log("VERIFY_TOKEN env:", process.env.VERIFY_TOKEN);
        console.log("token recibido:", req.query["hub.verify_token"]);
        const mode = req.query["hub.mode"];
        const token = req.query["hub.verify_token"];
        const challenge = req.query["hub.challenge"];

        if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
            reply.code(200).send(challenge);
            return;
        }

        reply.code(403).send("Forbidden");
    });

    // ✅ Recepción de mensajes
    fastify.post("/webhook", async (req, reply) => {
        try {
            const body = req.body;

            const msg =
                body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

            // WhatsApp manda también status updates, por eso chequeamos msg
            if (msg) {
                const from = msg.from; // teléfono
                const text = msg.text?.body || "";

                // Eco-bot simple
                await sendText(from, `Recibí: ${text}`);
            }

            reply.code(200).send("ok");
        } catch (err) {
            fastify.log.error(err);
            reply.code(200).send("ok"); // importante: WhatsApp espera 200
        }
    });
};