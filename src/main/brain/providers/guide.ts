import type { AppConfig } from '../../config'
import type { ProviderId } from '@shared/types'

/** Model tiers an agent.md or a delegation can ask for. */
export const TIERS = ['rapido', 'normal', 'potente'] as const
export type Tier = (typeof TIERS)[number]

const USES: Record<Tier, string> = {
  rapido: 'tareas sencillas: resumir, extraer datos, consultar, clasificar, anotar, responder algo concreto',
  normal: 'trabajo de dificultad media: investigar y contrastar, redactar, analizar documentos largos',
  potente: 'solo lo realmente complejo: programación difícil, análisis delicados o con mucho razonamiento'
}

/** Real model value for each tier with this provider (only the ones configured). */
export function tierModels(config: AppConfig, provider: ProviderId, allowed?: ReadonlySet<string>): Partial<Record<Tier, string>> {
  const out: Partial<Record<Tier, string>> = {}
  for (const tier of TIERS) {
    const model = config.models[provider].aliases[tier]?.trim()
    if (model && (!allowed || allowed.has(model))) out[tier] = model
  }
  return out
}

/**
 * How the brain hands work to an agent, including which model to ask for so
 * each job costs no more than it needs.
 */
export function delegationGuide(
  tool: string,
  agentField: string,
  models: Partial<Record<Tier, string>>
): string {
  const lines = [
    `Delegas con la herramienta \`${tool}\`: pon en \`${agentField}\` el id del agente (el que va entre comillas en la lista), en \`prompt\` el encargo completo y en \`description\` un resumen de 3 a 6 palabras. Usa solo los agentes de la lista.`
  ]
  const tiers = TIERS.filter((t) => models[t])
  if (tiers.length) {
    lines.push(
      '',
      `Elige el modelo de cada encargo con \`model\`, el más barato que haga bien el trabajo:`,
      ...tiers.map((t) => `- \`${models[t]}\`: ${USES[t]}.`),
      'Si dudas entre dos, elige el más barato. Si no pones `model`, se usa el del agente.'
    )
  }
  return lines.join('\n')
}
