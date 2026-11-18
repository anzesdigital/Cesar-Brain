# Cómo se define un agente

Cada agente es una carpeta con un archivo `agent.md` dentro de la carpeta de agentes del usuario (por defecto `%USERPROFILE%\CesarBrain\agents`). La app vigila esa carpeta: crear, editar o borrar un agente surte efecto al momento, sin reiniciar y sin tocar este repositorio.

También se le puede pedir al Cerebro: «crea un agente que…». Lo hace el agente integrado **configurador** (`brain/agents/configurador`), que propone el archivo y lo escribe con tu permiso.

## Formato

```markdown
---
id: traductor
name: Teo
role: Traducción
zona: Básicos
description: Úsalo para traducir textos o documentos entre español e inglés manteniendo el formato.
tools: [Read, Write, Glob]
model: rapido
sprite:
  hair: "#22222a"
  shirt: "#2f7dd1"
  skin: "#f2c9a0"
---
Eres Teo, traductor de un equipo que ayuda a {{USER}}. El Cerebro te pasa encargos…
```

| Campo | Obligatorio | Qué es |
|---|---|---|
| `id` | no (usa el nombre de la carpeta) | minúsculas, números y guiones, 2-32 caracteres. `cerebro` está reservado. |
| `description` | sí | Cuándo debe delegarle el Cerebro. Es lo que lee para decidir. |
| cuerpo | sí | Instrucciones del agente. |
| `name`, `role` | no | Cómo se ve en la oficina. |
| `zona` | no | Sala de la oficina donde se sienta (Básicos, Desarrollo, Pruebas, Negocio, Decisiones, Dirección… o cualquier otra; una zona nueva crea una sala). Sin zona va a «General». Mayúsculas y tildes no importan. |
| `tools` | no | Herramientas permitidas. Sin el campo, todas. |
| `mcp` | no | Servidores de `mcp.json` que usa. Puede usar todas sus herramientas. |
| `repos` | no | Repositorios de código (de `config.json`) que puede usar, p. ej. `[api, web]`. Sin el campo, todos; `[]`, ninguno. |
| `model` | no | Nivel según el uso habitual del agente: `rapido` (resumir, extraer, consultar, anotar), `normal` (investigar, redactar, documentos largos) o `potente` (solo programación o análisis complejos). Cada nivel se traduce al modelo real en `config.json` (`models.<proveedor>.aliases`). También acepta un alias o id de modelo concreto. |
| `sprite` | no | Colores `#rrggbb` de pelo, camiseta y piel. |

Herramientas (`tools`), con su equivalente en Copilot:

| agent.md | Claude | Copilot |
|---|---|---|
| Read | Read | view |
| Write | Write | create |
| Edit | Edit | edit |
| Glob | Glob | glob |
| Grep | Grep | grep |
| WebFetch | WebFetch | web_fetch |
| WebSearch | WebSearch | — (no existe; el agente sigue funcionando sin ella) |
| Bash | Bash / PowerShell | powershell (Windows) / bash |

## Burbujas y permisos personalizados

Cada agente puede tener su propia voz en la oficina y sus propios textos de permiso, sin tocar código:

```yaml
burbujas:
  _encargo: "Me ponen con: {tarea}"      # al recibir un encargo
  _listo: ¡Cuentas al día!               # al terminar bien
  _error: Algo no me cuadra…             # al fallar
  WebSearch: "Rastreando «{query}»"      # por herramienta (nombre de agent.md)
  registrar_movimientos: Anotando {#movimientos|movimiento|movimientos}   # MCP: nombre corto o mcp__srv__tool
permisos:
  aplicar_presupuesto: "Cambiar el presupuesto de {periodo?el periodo actual}:\n{cambios.*:{categoria} → {presupuesto} €}"
```

| Plantilla | Resultado |
|---|---|
| `{campo}` / `{a.b}` | valor del parámetro de la herramienta (Read/Write/Edit: `file_path`; WebSearch: `query`; WebFetch: `url`; Bash: `command`) |
| `{campo?texto}` | `texto` si el parámetro falta o está vacío |
| `{#lista}` / `{#lista\|uno\|varios}` | número de elementos / «1 uno», «3 varios» |
| `{lista.*:plantilla}` | cada elemento con su propia plantilla; separados por coma en burbujas y por línea en permisos |

Si una herramienta no tiene texto propio, se usa el genérico. Las burbujas se recortan a 60 caracteres.

`{{USER}}` en `description` o en el cuerpo se sustituye por `userName` de `config.json`.

## Gastar poco

- Todos los agentes, presentes y futuros, reciben al final de su prompt las reglas comunes de `brain/estilo.md`: respuestas cortas, exactas a lo preguntado, sin explicar el proceso. Se cambian en ese archivo y afectan a todos a la vez.
- El Cerebro elige el modelo de cada encargo según su dificultad (el más barato que lo haga bien), usando los niveles de `config.json`. El `model` del agent.md es solo el valor por defecto.

## Desactivar o quitar

- Desactivar: renombra la carpeta para que empiece por `_` (por ejemplo `_traductor`).
- Quitar: borra la carpeta.

## Permisos

- Leer y escribir dentro de `workspace/` no pide permiso. Leer la carpeta de agentes tampoco.
- Escribir fuera de `workspace/` (incluida la carpeta de agentes), ejecutar comandos y usar herramientas MCP pide permiso en pantalla, salvo lo marcado como `"trusted"` en `mcp.json`.

## Repositorios de código

Carpetas de código locales en las que trabajan los agentes. Se añaden en **Ajustes → Repositorios** (o a mano en `config.json`):

```json
"repos": {
  "api": { "ruta": "C:/proyectos/api", "acceso": "escritura" },
  "web": { "ruta": "C:/proyectos/web", "acceso": "lectura" }
}
```

- **lectura**: los agentes leen y buscan sin preguntar; modificar se rechaza.
- **escritura**: también crean y editan archivos sin preguntar.
- Un agente con `repos: [api]` solo puede tocar `api`; cualquier otro repo se le rechaza.
- Los comandos (git, tests, builds…) siempre piden permiso.
- Los agentes con herramientas de archivos reciben en su prompt la lista de sus repos con su ruta y acceso. El Cerebro recibe la lista completa para repartir el trabajo.
- Un repo cuya carpeta no existe en ese equipo aparece en rojo en Ajustes, sin romper nada (útil si `config.json` viaja entre ordenadores).

## Servidores MCP (`mcp.json`)

```json
{
  "servers": {
    "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/", "headers": { "Authorization": "Bearer …" } },
    "archivos": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\Proyectos"], "trusted": true }
  }
}
```

`"trusted"` puede ser `true` (todas las herramientas del servidor sin pedir permiso) o una lista de herramientas concretas, por ejemplo `"trusted": ["estado", "buscar_reglas"]`; las demás piden permiso.

Acepta también la clave `mcpServers` para poder pegar configuraciones de otras herramientas. `"disabled": true` desactiva un servidor sin borrarlo.
