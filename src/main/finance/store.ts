import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface Rule {
  /** Normalized text that must appear in a movement's description. */
  patron: string
  categoria: string
  ts: number
}

export interface PendingMovement {
  id: string
  fecha: string
  importe: number
  sentido: 'gasto' | 'ingreso'
  descripcion: string
  /** What the agent could not decide, in its own words. */
  duda: string
  ts: number
}

export interface LoggedMovement {
  huella: string
  fecha: string
  importe: number
  categoria: string
  descripcion: string
  origen: 'regla' | 'usuario' | 'inferida'
  motivo?: string
  periodo: string
  fila: number
  ts: number
}

/** Lowercase, no accents, no punctuation or digits: "MERCADONA 0423 MADRID" -> "mercadona madrid". */
export function normalize(description: string): string {
  return description
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Longest matching pattern wins, so "amazon prime" beats "amazon". */
export function matchRule(rules: Rule[], description: string): Rule | undefined {
  const text = ` ${normalize(description)} `
  return rules
    .filter((r) => r.patron && text.includes(` ${r.patron} `))
    .sort((a, b) => b.patron.length - a.patron.length)[0]
}

/**
 * Identity of a movement. `occurrence` separates genuinely repeated lines
 * inside one batch (two identical coffees on the same day), so importing the
 * same statement twice still produces the same set of fingerprints.
 */
export function fingerprint(fecha: string, importe: number, descripcion: string, occurrence: number): string {
  const key = `${fecha}|${importe.toFixed(2)}|${descripcion.toLowerCase().replace(/\s+/g, ' ').trim()}|${occurrence}`
  return createHash('sha1').update(key).digest('hex').slice(0, 16)
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw new Error(`No pude leer ${file}: ${(err as Error).message}`)
  }
}

/** Local memory the spreadsheet has no room for: rules, pending items, audit log. */
export class FinanceStore {
  constructor(private dir: string) {}

  private path(name: string): string {
    return join(this.dir, name)
  }

  private async write(name: string, data: unknown): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const target = this.path(name)
    const temp = `${target}.tmp`
    await writeFile(temp, JSON.stringify(data, null, 2), 'utf8')
    await rename(temp, target)
  }

  rules(): Promise<Rule[]> {
    return readJson<Rule[]>(this.path('reglas.json'), [])
  }

  async saveRule(patron: string, categoria: string): Promise<Rule> {
    const normalized = normalize(patron)
    if (normalized.length < 3) throw new Error(`El patrón "${patron}" es demasiado corto para ser una regla fiable.`)
    const rules = (await this.rules()).filter((r) => r.patron !== normalized)
    const rule: Rule = { patron: normalized, categoria, ts: Date.now() }
    await this.write('reglas.json', [...rules, rule])
    return rule
  }

  pending(): Promise<PendingMovement[]> {
    return readJson<PendingMovement[]>(this.path('pendientes.json'), [])
  }

  async addPending(items: Omit<PendingMovement, 'id' | 'ts'>[]): Promise<PendingMovement[]> {
    const current = await this.pending()
    const added: PendingMovement[] = []
    for (const item of items) {
      const duplicate = [...current, ...added].find(
        (p) => p.fecha === item.fecha && p.importe === item.importe && p.descripcion === item.descripcion
      )
      if (duplicate) continue
      added.push({ ...item, id: randomUUID().slice(0, 8), ts: Date.now() })
    }
    if (added.length) await this.write('pendientes.json', [...current, ...added])
    return added
  }

  async removePending(id: string): Promise<PendingMovement | undefined> {
    const current = await this.pending()
    const found = current.find((p) => p.id === id)
    if (found) await this.write('pendientes.json', current.filter((p) => p.id !== id))
    return found
  }

  log(): Promise<LoggedMovement[]> {
    return readJson<LoggedMovement[]>(this.path('movimientos.json'), [])
  }

  async appendLog(entries: LoggedMovement[]): Promise<void> {
    if (entries.length === 0) return
    await this.write('movimientos.json', [...(await this.log()), ...entries])
  }
}
