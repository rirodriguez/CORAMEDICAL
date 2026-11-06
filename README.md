# Puente WhatsApp por QR · CoraSys

Mantiene el WhatsApp de la tienda vinculado (como WhatsApp Web) y pasa los mensajes a CoraSys.

## Instalar en Railway
1. Crea una cuenta en https://railway.app y un proyecto nuevo → "Deploy from GitHub repo" (sube esta carpeta a un repo) o "Empty service" → arrastra esta carpeta.
2. En el servicio → **Volumes** → agrega un volumen montado en `/data` (guarda la sesión; sin él habría que escanear el QR en cada reinicio).
3. En **Variables**:
   - `API_KEY` = la misma clave guardada en CoraSys como `WA_GATEWAY_API_KEY`.
   - `CORASYS_WEBHOOK_URL` = `https://corasys.lovable.app/api/public/whatsapp-qr`
4. **Settings → Networking → Generate Domain**. Copia esa dirección (ej. `https://xxx.up.railway.app`) y guárdala en CoraSys como `WA_GATEWAY_URL`.
5. En CoraSys → Configuración → WhatsApp aparece el QR. Celular → Ajustes → Dispositivos vinculados → Vincular.

## Reglas
- El bot solo responde; nunca escribe primero.
- Si alguien escribe desde el celular a un cliente, el bot se calla 2 horas en ese chat.
- Grupos, estados y canales se ignoran.

Aviso: Meta no permite oficialmente clientes no oficiales; existe riesgo de suspensión del número.
