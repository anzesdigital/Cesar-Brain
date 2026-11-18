# Cesar Brain

Cerebro multi-agente de escritorio con oficina pixel art. Un Cerebro coordinador reparte el trabajo entre agentes especializados y se ve lo que piensa cada uno.

- **Los agentes no son código.** Cada agente es un `agent.md` en tu carpeta de usuario. Añadir uno = soltar una carpeta; entra a funcionar al momento. Ver [docs/AGENTES.md](docs/AGENTES.md).
- **Dos proveedores:** Claude (Claude Agent SDK) o GitHub Copilot Business (Copilot SDK). Se elige en Ajustes o en `config.json`.
- **Aspecto:** skin clásica (pixel, oscura) o ING (mismo pixel art, en índigo y naranja pastel). Se elige en Ajustes → Aspecto o con `"skin": "clasica" | "ing"` en `config.json`.

## Qué hay en el repo y qué no

| En el repo | En tu carpeta de usuario (`%USERPROFILE%\CesarBrain`) |
|---|---|
| `brain/brain.md`: prompt del Cerebro | `config.json`: proveedor, tu nombre, modelos, aspecto |
| `brain/agents/configurador`: agente que crea agentes | `agents/`: tus agentes |
| `examples/`: agentes y configuraciones de ejemplo | `mcp.json`: servidores MCP |
| `src/`: la app | `memory.md`: preferencias duraderas para el Cerebro |
| | `workspace/inbox` y `workspace/output`: archivos |

La carpeta de usuario se crea en el primer arranque y copia los agentes de `examples/agents`. Para usar otra ruta, define la variable de entorno `CESAR_BRAIN_HOME`.

## Puesta en marcha

Requisitos: Node.js 22.12 o superior y Git.

```bash
git clone <este repo>
cd cesar-brain
npm install
npm run dev
```

### Con Claude

Una de estas:
- Inicia sesión con Claude Code en ese equipo (`claude`, luego `/login`), o
- pega una clave de API de Anthropic en Ajustes.

### Con GitHub Copilot Business (ordenador de trabajo)

1. Tu organización debe tener Copilot habilitado para ti y permitir **Copilot CLI** en sus políticas (si no, el administrador debe activarlo).
2. Inicia sesión con la cuenta que tiene la licencia: instala GitHub CLI y ejecuta `gh auth login`, o define `GH_TOKEN`.
3. En la app: Ajustes → Proveedor → **GitHub Copilot** → «Volver a comprobar» debe decir «Conectado como …».

`config.json` de ejemplo en [examples/config.example.json](examples/config.example.json). Los ids de modelo de Copilot disponibles para tu organización se ven en Copilot CLI con `/model`.

## Uso diario

- Escribe o suelta archivos; el Cerebro delega.
- «Crea un agente que…» → lo hace el configurador.
- Oficina: cada agente se sienta en la sala de su `zona`. Zoom con los botones o Ctrl + rueda (pellizco en táctil), arrastra el suelo para moverte, doble clic para ver todo. En ventanas estrechas, pestañas Oficina / Chat.
- Ajustes muestra el proveedor, la sesión, las carpetas y cualquier `agent.md` o `mcp.json` con errores.

## Desarrollo

```bash
npm run typecheck
npm test
```

La versión anterior con el agente de presupuesto (Google Sheets) está en el tag `personal-finanzas`.
