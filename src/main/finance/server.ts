import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { FinanceService } from './service'

export const FINANCE_SERVER = 'presupuesto'

/** Tools that change the budget itself: these always ask César first. */
export const FINANCE_APPROVAL_TOOLS = ['crear_periodo', 'aplicar_presupuesto']

export const FINANCE_TOOLS = [
  'estado',
  'listar_movimientos',
  'buscar_reglas',
  'guardar_regla',
  'registrar_movimientos',
  'guardar_pendientes',
  'resolver_pendiente',
  'comparar_presupuesto',
  ...FINANCE_APPROVAL_TOOLS
]

export function financeToolName(name: string): string {
  return `mcp__${FINANCE_SERVER}__${name}`
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

async function run(work: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await work(), null, 1) }] }
  } catch (err) {
    return { content: [{ type: 'text', text: `ERROR: ${(err as Error).message}` }], isError: true }
  }
}

const fecha = z.string().describe('Fecha del movimiento, AAAA-MM-DD')
const importe = z.number().positive().describe('Importe en euros, siempre positivo')
const sentido = z.enum(['gasto', 'ingreso']).describe('gasto = sale dinero; ingreso = entra dinero')
const descripcion = z.string().min(1).describe('Texto original del movimiento (comercio o concepto), sin resumir')
const grupo = z.enum(['income', 'fixed', 'variable', 'loans', 'savings', 'investments'])

export function createFinanceServer(service: FinanceService) {
  const always = { alwaysLoad: true }
  return createSdkMcpServer({
    name: FINANCE_SERVER,
    version: '1.0.0',
    tools: [
      tool(
        'estado',
        'Situación del presupuesto: periodos de la hoja, categorías del periodo actual con presupuesto y gasto real, movimientos pendientes de categoría. Llámala siempre antes de registrar nada.',
        {},
        () => run(() => service.estado()),
        always
      ),
      tool(
        'listar_movimientos',
        'Movimientos ya anotados en un periodo (por defecto el actual).',
        { periodo: z.string().optional().describe('Título de la hoja, p. ej. "Budget Mayo"') },
        (args) => run(() => service.listarMovimientos(args.periodo)),
        always
      ),
      tool(
        'buscar_reglas',
        'Para cada descripción, devuelve la categoría que César ya confirmó en el pasado, o null si no hay regla.',
        { descripciones: z.array(z.string()).min(1) },
        (args) => run(() => service.buscarReglas(args.descripciones)),
        always
      ),
      tool(
        'guardar_regla',
        'Recuerda que un comercio o concepto va siempre a una categoría. Úsala solo cuando César lo haya dicho expresamente.',
        {
          patron: z.string().min(3).describe('Palabras que identifican el comercio, p. ej. "mercadona"'),
          categoria: z.string()
        },
        (args) => run(() => service.guardarRegla(args.patron, args.categoria)),
        always
      ),
      tool(
        'registrar_movimientos',
        'Anota movimientos en la hoja. Solo para movimientos cuya categoría es segura: por regla aprendida, porque César la dijo, o inferida con un motivo claro. Los dudosos van a guardar_pendientes. Rechaza categorías que no existen y evita duplicados.',
        {
          movimientos: z
            .array(
              z.object({
                fecha,
                importe,
                sentido,
                categoria: z.string().describe('Nombre exacto de una categoría del periodo'),
                descripcion,
                origen: z
                  .enum(['regla', 'usuario', 'inferida'])
                  .describe('regla = buscar_reglas la devolvió; usuario = César la dijo; inferida = evidente por el comercio'),
                motivo: z.string().optional().describe('Obligatorio si origen es inferida: por qué es evidente')
              })
            )
            .min(1),
          forzar: z
            .boolean()
            .optional()
            .describe('true solo si César confirmó que un posible duplicado es un movimiento distinto')
        },
        (args) => run(() => service.registrar(args.movimientos, args.forzar ?? false)),
        always
      ),
      tool(
        'guardar_pendientes',
        'Aparca movimientos cuya categoría no es segura, para preguntarle a César. No se anotan en la hoja hasta resolverlos.',
        {
          pendientes: z
            .array(
              z.object({
                fecha,
                importe,
                sentido,
                descripcion,
                duda: z.string().describe('Qué no está claro y entre qué categorías dudas')
              })
            )
            .min(1)
        },
        (args) => run(() => service.guardarPendientes(args.pendientes)),
        always
      ),
      tool(
        'resolver_pendiente',
        'Cierra un pendiente con la respuesta de César: lo anota en la categoría que dijo, o lo descarta.',
        {
          id: z.string(),
          categoria: z.string().optional().describe('Categoría que indicó César'),
          descartar: z.boolean().optional().describe('true si César dijo que no se anote'),
          recordar_patron: z
            .string()
            .optional()
            .describe('Solo si César pidió recordarlo: palabras del comercio para crear la regla')
        },
        (args) => run(() => service.resolverPendiente(args)),
        always
      ),
      tool(
        'comparar_presupuesto',
        'Presupuesto contra gasto real por categoría y totales de un periodo. Base para proponer el presupuesto siguiente.',
        { periodo: z.string().optional() },
        (args) => run(() => service.comparar(args.periodo)),
        always
      ),
      tool(
        'crear_periodo',
        'Abre un periodo nuevo: duplica la plantilla, pone fechas, copia categorías y presupuesto del periodo anterior y cierra el anterior el día previo. César debe aprobarlo.',
        {
          inicio: z.string().describe('Día en que entró la nómina, AAAA-MM-DD'),
          fin: z.string().optional().describe('Último día; si se omite se usa un fin provisional (día 24)')
        },
        (args) => run(() => service.crearPeriodo(args)),
        always
      ),
      tool(
        'aplicar_presupuesto',
        'Cambia importes presupuestados o añade categorías en un periodo. Úsala solo con una propuesta que César ya aceptó; además se le pedirá confirmación.',
        {
          periodo: z.string().optional(),
          cambios: z.array(z.object({ categoria: z.string(), presupuesto: z.number().min(0) })).optional(),
          nuevas: z.array(z.object({ grupo, nombre: z.string().min(1), presupuesto: z.number().min(0) })).optional()
        },
        (args) => run(() => service.aplicarPresupuesto(args)),
        always
      )
    ]
  })
}
