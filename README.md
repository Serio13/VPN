# FreeVPN

VPN gratuita para **Windows 11** con interfaz visual: mapa mundial, lista de países con banderas y
conexión con un clic. Usa los servidores públicos de [VPN Gate](https://www.vpngate.net) (API pública)
y OpenVPN como motor.

## Instalar (usuario final)
1. Entra en **Releases** de este repositorio y descarga `FreeVPN-Setup-*.exe` (instalador) o `FreeVPN-*-portable.exe`.
2. Ejecútalo (pide permisos de administrador: hace falta para crear el túnel).
3. La primera vez, si falta OpenVPN, pulsa **Instalar automáticamente** (usa `winget`, incluido en Windows 11).
4. Pulsa **Conexión rápida** o elige un país en el mapa/lista → **Conectar al mejor servidor**.

Windows SmartScreen puede avisar de "editor desconocido" porque el `.exe` no está firmado
(un certificado de firma cuesta dinero): *Más información → Ejecutar de todas formas*.

## Qué hace
- Lista **todos los países que tienen servidores activos** en ese momento (VPN Gate suele tener 40-90).
- Mapa interactivo (zoom/arrastre), búsqueda, velocidad y ping por servidor.
- **Failover**: "mejor servidor" prueba hasta 5 servidores (descartando los que no responden) hasta que uno conecta.
- Apagado limpio de OpenVPN (no deja rutas colgadas) y desconexión automática al cerrar la app.
- Funciona con la última lista guardada si no hay internet.

## Limitaciones honestas
- Son **servidores de voluntarios**: sirven para cambiar de país/saltar bloqueos, no para anonimato.
  Algunos guardan registros ~2 semanas; el voluntario puede ver tráfico no cifrado (usa HTTPS).
- "Todo el mundo" = los países con voluntarios conectados hoy; no hay garantía de los 195.
- Aún no hay *kill switch* (corte de tráfico si cae el túnel). Siguiente paso previsto.
- Solo VPN Gate. Para privacidad real, monta tus propios servidores WireGuard (`cli/deploy/`).

## Desarrollo
```bash
cd app
npm ci
npm run prepare-assets   # copia mapa, d3 y banderas al renderer
npm test                 # tests del núcleo con un OpenVPN falso
npm start                # ejecuta la app (Electron)
npm run dist             # genera los .exe (en Windows)
```
El CI (`.github/workflows/build-windows.yml`) ejecuta los tests y compila los `.exe` en un runner Windows.

`cli/` contiene la primera versión en línea de comandos (Python) y el script para montar un servidor WireGuard propio.
`docs/ANALISIS.md` explica cómo funciona un VPN comercial y por qué no se clona NordVPN.
