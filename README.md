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
| `brain/agents/automatizador`: agente que crea automatizaciones | `automations/`: tus automatizaciones |
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
- Tareas que corren solas: «crea una automatización que haga pull de main en api cada hora». Rob la escribe, tú la apruebas en **Automatizaciones** y aparece como un robot en el Taller. Ver [docs/AUTOMATIZACIONES.md](docs/AUTOMATIZACIONES.md).
- Decisiones difíciles: di «consejo: …» (o «debate esto», «pon a prueba esto») y cinco asesores con miradas opuestas opinan, se revisan entre ellos a ciegas y un presidente da el veredicto. Si el Cerebro ve una decisión con mucho en juego, te ofrece el consejo con un botón. Método [LLM Council](https://github.com/karpathy/llm-council) de Andrej Karpathy, adaptado del skill de [Ole Lehmann](https://github.com/aiwithremy/claude-skills-llm-council).
- Oficina: cada agente se sienta en la sala de su `zona`. Zoom con los botones o Ctrl + rueda (pellizco en táctil), arrastra el suelo para moverte, doble clic para ver todo. En ventanas estrechas, pestañas Oficina / Chat.
- Ajustes muestra el proveedor, la sesión, las carpetas y cualquier `agent.md` o `mcp.json` con errores.
- Permisos: en **Ajustes → Permisos** eliges el modo. **Preguntar** es el modo por defecto. **Aceptar ediciones** lee y escribe archivos sin preguntar. **Automático** ejecuta solo comandos que leen o comprueban (`git status`, `npm test`…), escribe solo en el workspace y en los repos con escritura, y pregunta lo demás. **Permitir todo** no pregunta nada. En la ventana de permiso puedes permitir **en esta conversación** o **siempre**: por prefijo de comando o por carpeta, solo para ese agente o para todos. Las reglas («Siempre» / «Nunca») se ven y se borran en Ajustes. Se guardan en `config.json` → `permissions`. Un prefijo nunca cubre comandos encadenados (`&&`, `|`, `;`, `>`). Las reglas «Nunca» ganan siempre, también en las automatizaciones.
- Avisos: con la ventana en segundo plano, Windows avisa cuando un agente pide permiso, cuando el Cerebro te pregunta algo (bloque de opciones) y cuando termina de responder. La barra de tareas parpadea y el icono muestra cuántas cosas esperan. En **Ajustes → Avisos** se activan o desactivan y se elige el sonido: el del sistema, ninguno o uno propio (wav, mp3 u ogg, se copia a `sonidos/aviso.<ext>` en tu carpeta). Se guarda en `config.json` → `notifications`.

## Desarrollo

```bash
npm run typecheck
npm test
```

La versión anterior con el agente de presupuesto (Google Sheets) está en el tag `personal-finanzas`.
