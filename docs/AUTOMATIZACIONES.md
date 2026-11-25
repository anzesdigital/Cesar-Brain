# Automatizaciones

Una automatización es trabajo que corre solo, sin pedírselo al Cerebro: comandos (por ejemplo `git pull`) y encargos directos a un agente, encadenados. En la oficina cada una es un **robot** en la sala **Taller**; el botón **Automatizaciones** (arriba, junto a Uso) muestra la lista, sus ajustes y el historial con la salida de cada paso.

Como los agentes, no son código: cada una es una carpeta con un `automation.md` dentro de `%USERPROFILE%\CesarBrain\automations`. La app vigila la carpeta.

La forma fácil: «crea una automatización que haga pull de main en api cada hora». Lo hace el agente integrado **automatizador** (Rob), que propone el archivo y lo escribe con tu permiso.

## Aprobación

Una automatización nueva **no corre** hasta que la revisas y apruebas (panel Automatizaciones, o pulsando su robot). Ves los comandos tal cual, dónde se ejecutan, qué agentes llama y qué permisos extra pide. Al aprobar queda activa.

- Si el archivo cambia (lo edites tú o un agente), vuelve a quedar pendiente de aprobación.
- La aprobación se guarda en los datos privados de la app, no en la carpeta de usuario, así que ningún agente puede aprobarse a sí mismo.
- El interruptor la activa o desactiva sin borrarla. «Ejecutar ahora» funciona aunque esté desactivada (si está aprobada).

## Formato

```markdown
---
id: pull-api
name: Pull de api
description: Mantiene api al día con origin/main
cuando:
  cada: 1h               # 30m, 2h, 1d… (mínimo 1m)
  al-arrancar: true      # al abrir la app
  archivos: inbox        # cuando cambia una carpeta del directorio de trabajo, o repo:api
  agente: [dev]          # antes de que el Cerebro le pase un encargo a dev; el encargo espera
pasos:
  - nombre: Traer cambios
    comando: git pull origin main
    repo: api            # o carpeta: output (dentro del directorio de trabajo); sin nada, el directorio de trabajo
    timeout: 120         # segundos (opcional; 120 por defecto, 900 para agentes)
  - agente: resumidor
    encargo: "Resume estos cambios en output/cambios.md:\n{salida}"
    modelo: rapido       # opcional
permitir: [Write]        # herramientas que los pasos de agente pueden usar sin preguntar
si-falla: parar          # o seguir
sprite:
  body: "#3aa6b8"        # color del robot
---
Notas libres.
```

| Campo | Qué es |
|---|---|
| `cuando.cada` | Intervalo. La próxima hora se recuerda al cerrar la app; si se pasó mientras estaba cerrada, corre a los pocos segundos de abrirla. |
| `cuando.al-arrancar` | Corre una vez al abrir la app. |
| `cuando.archivos` | Corre cuando cambia algo en esa carpeta (ignora `.git` y `node_modules`). Los cambios que hace la propia automatización no la relanzan. |
| `cuando.agente` | Corre antes de cada encargo del Cerebro a esos agentes, y el encargo espera a que termine (máximo 5 min). |
| `pasos[].comando` | Línea de comandos: PowerShell en Windows, `sh` en macOS/Linux. Debe terminar sola, sin pedir nada. |
| `pasos[].agente` + `encargo` | El agente trabaja solo (sin pasar por el Cerebro), con su prompt, herramientas, MCP y modelo. `{salida}` pone la salida del paso anterior (los últimos 4000 caracteres). |
| `permitir` | Sin nadie delante, lo que normalmente pediría permiso se deniega. Lo que pongas aquí se permite: `Bash`, `Write`, `mcp__servidor`… |
| `si-falla` | `parar` (por defecto) o `seguir` con el siguiente paso. |

Siempre se pueden lanzar a mano. Nunca corre la misma dos veces a la vez, y como mucho dos automatizaciones a la vez (las demás esperan).

## Historial

Se guardan las últimas 50 ejecuciones de cada una (disparador, duración, salida de cada paso). Los tokens de los pasos de agente cuentan en Uso.
