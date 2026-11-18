import {
  a1,
  addDays,
  CATEGORY_FIRST_ROW,
  CATEGORY_LAST_ROW,
  CATEGORY_RANGE,
  daysBetween,
  firstFreeCategoryRow,
  GROUPS,
  isIsoDate,
  isoToSerial,
  nextFreeTxRow,
  parseCategories,
  parsePeriodDates,
  parseTransactions,
  PERIOD_END_CELL,
  PERIOD_RANGE,
  PERIOD_SHEET_PREFIX,
  PERIOD_START_CELL,
  round2,
  sameName,
  TX_LAST_ROW,
  TX_RANGE,
  type Category,
  type Grid,
  type GroupKey,
  type SheetTransaction
} from './layout'
import {
  findPeriod,
  isPayrollCategory,
  latestPeriod,
  NEW_PAYROLL_MIN_DAYS,
  periodTitle,
  provisionalEnd,
  type Period
} from './period'
import type { SheetInfo, SheetsApi, ValueUpdate } from './sheets'
import { fingerprint, matchRule, type FinanceStore, type LoggedMovement } from './store'

export type Sentido = 'gasto' | 'ingreso'
export type Origen = 'regla' | 'usuario' | 'inferida'

export interface MovementInput {
  fecha: string
  importe: number
  sentido: Sentido
  categoria: string
  descripcion: string
  origen: Origen
  motivo?: string
}

export interface PendingInput {
  fecha: string
  importe: number
  sentido: Sentido
  descripcion: string
  duda: string
}

interface PeriodData {
  period: Period
  categories: Category[]
  categoryGrid: Grid
  transactions: SheetTransaction[]
  txGrid: Grid
}

interface Rejected {
  fecha: string
  importe: number
  descripcion: string
  motivo: string
}

const NOT_CONNECTED =
  'Google Sheets no está conectado. César debe abrir Ajustes → Google Sheets, cargar la clave y pegar la URL de la hoja.'

function groupOf(sentido: Sentido, category: Category): boolean {
  return sentido === 'ingreso' ? category.group === 'income' : category.group !== 'income'
}

function categoryNames(categories: Category[], sentido: Sentido): string {
  return categories
    .filter((c) => groupOf(sentido, c))
    .map((c) => c.name)
    .join(', ')
}

export class FinanceService {
  constructor(
    private getApi: () => SheetsApi | undefined,
    private store: FinanceStore,
    private today: () => string = () => new Date().toISOString().slice(0, 10)
  ) {}

  private api(): SheetsApi {
    const api = this.getApi()
    if (!api) throw new Error(NOT_CONNECTED)
    return api
  }

  /** Budget sheets with valid dates, plus what could not be used. */
  async periods(): Promise<{ periods: Period[]; template?: SheetInfo; undated: string[]; titles: string[] }> {
    const sheets = await this.api().listSheets()
    const template = sheets.find((s) => s.title.toLowerCase().includes('hoja tipo'))
    const budget = sheets.filter((s) => s.title.toLowerCase().startsWith(PERIOD_SHEET_PREFIX.toLowerCase()))
    const grids = await this.api().batchGet(budget.map((s) => a1(s.title, PERIOD_RANGE)))
    const periods: Period[] = []
    const undated: string[] = []
    budget.forEach((sheet, i) => {
      const { start, end } = parsePeriodDates(grids[i])
      if (start && end && start <= end) periods.push({ ...sheet, start, end })
      else undated.push(sheet.title)
    })
    periods.sort((a, b) => a.start.localeCompare(b.start))
    return { periods, template, undated, titles: sheets.map((s) => s.title) }
  }

  private async load(period: Period): Promise<PeriodData> {
    const [categoryGrid, txGrid] = await this.api().batchGet([
      a1(period.title, CATEGORY_RANGE),
      a1(period.title, TX_RANGE)
    ])
    return {
      period,
      categoryGrid,
      txGrid,
      categories: parseCategories(categoryGrid),
      transactions: parseTransactions(txGrid)
    }
  }

  private async resolve(title: string | undefined): Promise<Period> {
    const { periods } = await this.periods()
    if (periods.length === 0) throw new Error('La hoja no tiene ningún periodo (hojas "Budget …" con fechas en C7 y C8).')
    if (!title) return findPeriod(periods, this.today()) ?? latestPeriod(periods)!
    const found = periods.find((p) => sameName(p.title, title))
    if (!found) throw new Error(`No existe el periodo "${title}". Periodos: ${periods.map((p) => p.title).join(', ')}`)
    return found
  }

  async estado(): Promise<unknown> {
    const { periods, template, undated } = await this.periods()
    const today = this.today()
    const current = findPeriod(periods, today)
    const reference = current ?? latestPeriod(periods)
    const data = reference ? await this.load(reference) : undefined
    return {
      hoy: today,
      periodos: periods.map((p) => ({ titulo: p.title, inicio: p.start, fin: p.end })),
      hojas_sin_fechas_validas: undated,
      plantilla: template?.title ?? null,
      periodo_que_cubre_hoy: current?.title ?? null,
      periodo_mostrado: data
        ? {
            titulo: data.period.title,
            inicio: data.period.start,
            fin: data.period.end,
            movimientos: data.transactions.length,
            categorias: data.categories.map((c) => ({
              grupo: c.group,
              nombre: c.name,
              presupuesto: c.budget,
              real: round2(c.actual)
            }))
          }
        : null,
      pendientes: await this.store.pending(),
      reglas_aprendidas: (await this.store.rules()).length
    }
  }

  async listarMovimientos(titulo?: string): Promise<unknown> {
    const data = await this.load(await this.resolve(titulo))
    const log = (await this.store.log()).filter((l) => l.periodo === data.period.title)
    return {
      periodo: data.period.title,
      movimientos: data.transactions.map((t) => ({
        fila: t.row,
        fecha: t.date,
        categoria: t.category,
        importe: t.amount,
        descripcion: log.find((l) => l.fila === t.row)?.descripcion ?? null
      }))
    }
  }

  async buscarReglas(descripciones: string[]): Promise<unknown> {
    const rules = await this.store.rules()
    return descripciones.map((descripcion) => {
      const rule = matchRule(rules, descripcion)
      return { descripcion, categoria: rule?.categoria ?? null, patron: rule?.patron ?? null }
    })
  }

  async guardarRegla(patron: string, categoria: string): Promise<unknown> {
    const data = await this.load(await this.resolve(undefined))
    const category = data.categories.find((c) => sameName(c.name, categoria))
    if (!category) {
      throw new Error(`"${categoria}" no es una categoría de ${data.period.title}. Categorías: ${data.categories.map((c) => c.name).join(', ')}`)
    }
    return this.store.saveRule(patron, category.name)
  }

  async registrar(movimientos: MovementInput[], forzar = false): Promise<{
    registrados: unknown[]
    duplicados: unknown[]
    rechazados: Rejected[]
    inferidas_para_revisar: unknown[]
  }> {
    const { periods } = await this.periods()
    const rules = await this.store.rules()
    const log = await this.store.log()
    const known = new Set(log.map((l) => l.huella))
    const cache = new Map<string, PeriodData>()
    const occurrences = new Map<string, number>()
    /** sheet rows that the local log does not account for, per period */
    const unlogged = new Map<string, Map<string, number>>()

    const rechazados: Rejected[] = []
    const duplicados: unknown[] = []
    const accepted = new Map<string, { data: PeriodData; rows: { input: MovementInput; category: Category; huella: string }[] }>()

    const sheetKey = (fecha: string, importe: number, categoria: string): string =>
      `${fecha}|${importe.toFixed(2)}|${categoria.toLowerCase()}`

    for (const input of movimientos) {
      const reject = (motivo: string): void => {
        rechazados.push({ fecha: input.fecha, importe: input.importe, descripcion: input.descripcion, motivo })
      }
      if (!isIsoDate(input.fecha)) {
        reject('Fecha inválida; usa AAAA-MM-DD.')
        continue
      }
      if (!(input.importe > 0)) {
        reject('El importe debe ser positivo; el sentido (gasto/ingreso) va aparte.')
        continue
      }
      const period = findPeriod(periods, input.fecha)
      if (!period) {
        reject(
          `Ningún periodo cubre ${input.fecha}. Periodos: ${periods.map((p) => `${p.title} (${p.start} a ${p.end})`).join('; ') || 'ninguno'}.`
        )
        continue
      }
      let data = cache.get(period.title)
      if (!data) {
        data = await this.load(period)
        cache.set(period.title, data)
        const counts = new Map<string, number>()
        for (const t of data.transactions) {
          const k = sheetKey(t.date, t.amount, t.category)
          counts.set(k, (counts.get(k) ?? 0) + 1)
        }
        for (const l of log.filter((entry) => entry.periodo === period.title)) {
          const k = sheetKey(l.fecha, l.importe, l.categoria)
          if (counts.has(k)) counts.set(k, counts.get(k)! - 1)
        }
        unlogged.set(period.title, counts)
      }

      const category = data.categories.find((c) => sameName(c.name, input.categoria))
      if (!category) {
        reject(
          `"${input.categoria}" no existe en ${period.title}. Categorías de ${input.sentido}: ${categoryNames(data.categories, input.sentido)}. Si ninguna encaja, guárdalo como pendiente y pregunta.`
        )
        continue
      }
      if (!groupOf(input.sentido, category)) {
        reject(`"${category.name}" es una categoría de ${category.group === 'income' ? 'ingreso' : 'gasto'}, pero el movimiento es un ${input.sentido}.`)
        continue
      }
      if (input.origen === 'regla') {
        const rule = matchRule(rules, input.descripcion)
        if (!rule || !sameName(rule.categoria, category.name)) {
          reject(`No hay regla aprendida que asigne "${input.descripcion}" a ${category.name}. Usa origen "inferida" con motivo, o pregunta.`)
          continue
        }
      }
      if (input.origen === 'inferida' && !input.motivo?.trim()) {
        reject('Una categoría inferida necesita "motivo". Si no puedes justificarla, guárdalo como pendiente.')
        continue
      }
      if (
        category.group === 'income' &&
        isPayrollCategory(category.name) &&
        daysBetween(period.start, input.fecha) >= NEW_PAYROLL_MIN_DAYS
      ) {
        reject(
          `Esta nómina llega ${daysBetween(period.start, input.fecha)} días después del inicio de ${period.title}: abre un periodo nuevo. Propón el presupuesto a César y usa crear_periodo con inicio ${input.fecha}; después registra la nómina.`
        )
        continue
      }

      const occurrenceKey = `${input.fecha}|${input.importe.toFixed(2)}|${input.descripcion.toLowerCase().trim()}`
      const occurrence = occurrences.get(occurrenceKey) ?? 0
      occurrences.set(occurrenceKey, occurrence + 1)
      const huella = fingerprint(input.fecha, input.importe, input.descripcion, occurrence)

      if (!forzar) {
        if (known.has(huella)) {
          duplicados.push({ ...input, motivo: 'Ya estaba registrado con la misma fecha, importe y descripción.' })
          continue
        }
        const counts = unlogged.get(period.title)!
        const k = sheetKey(input.fecha, input.importe, category.name)
        if ((counts.get(k) ?? 0) > 0) {
          counts.set(k, counts.get(k)! - 1)
          duplicados.push({
            ...input,
            motivo: `La hoja ya tiene un movimiento de ${input.importe} en ${category.name} el ${input.fecha} que no anoté yo. Pregunta a César si es el mismo antes de forzar.`
          })
          continue
        }
      }

      const bucket = accepted.get(period.title) ?? { data, rows: [] }
      bucket.rows.push({ input, category, huella })
      accepted.set(period.title, bucket)
    }

    const updates: ValueUpdate[] = []
    const entries: LoggedMovement[] = []
    for (const [title, { data, rows }] of accepted) {
      const first = nextFreeTxRow(data.txGrid)
      const last = first + rows.length - 1
      if (last > TX_LAST_ROW) {
        for (const row of rows) {
          rechazados.push({
            fecha: row.input.fecha,
            importe: row.input.importe,
            descripcion: row.input.descripcion,
            motivo: `${title} no tiene filas libres en la tabla de movimientos (máximo ${TX_LAST_ROW}).`
          })
        }
        accepted.delete(title)
        continue
      }
      updates.push({
        range: a1(title, `AG${first}:AJ${last}`),
        values: rows.map((r) => [isoToSerial(r.input.fecha), r.category.type, r.category.name, round2(r.input.importe)])
      })
      rows.forEach((r, i) => {
        entries.push({
          huella: r.huella,
          fecha: r.input.fecha,
          importe: round2(r.input.importe),
          categoria: r.category.name,
          descripcion: r.input.descripcion,
          origen: r.input.origen,
          motivo: r.input.motivo,
          periodo: title,
          fila: first + i,
          ts: Date.now()
        })
      })
    }

    await this.api().batchUpdate(updates)
    await this.store.appendLog(entries)

    const brief = (e: LoggedMovement): unknown => ({
      fecha: e.fecha,
      importe: e.importe,
      categoria: e.categoria,
      descripcion: e.descripcion,
      periodo: e.periodo
    })
    return {
      registrados: entries.map(brief),
      duplicados,
      rechazados,
      inferidas_para_revisar: entries
        .filter((e) => e.origen === 'inferida')
        .map((e) => ({ ...(brief(e) as object), motivo: e.motivo }))
    }
  }

  guardarPendientes(items: PendingInput[]): Promise<unknown> {
    for (const item of items) {
      if (!isIsoDate(item.fecha)) throw new Error(`Fecha inválida en pendiente: ${item.fecha}`)
      if (!(item.importe > 0)) throw new Error('El importe de un pendiente debe ser positivo.')
    }
    return this.store.addPending(items)
  }

  async resolverPendiente(args: {
    id: string
    categoria?: string
    descartar?: boolean
    recordar_patron?: string
  }): Promise<unknown> {
    const pending = (await this.store.pending()).find((p) => p.id === args.id)
    if (!pending) throw new Error(`No hay ningún pendiente con id ${args.id}.`)
    if (args.descartar) {
      await this.store.removePending(args.id)
      return { descartado: pending }
    }
    if (!args.categoria) throw new Error('Indica la categoría que dijo César, o descartar: true.')
    const result = await this.registrar([
      {
        fecha: pending.fecha,
        importe: pending.importe,
        sentido: pending.sentido,
        descripcion: pending.descripcion,
        categoria: args.categoria,
        origen: 'usuario'
      }
    ])
    if (result.rechazados.length > 0) return { resuelto: false, ...result }
    await this.store.removePending(args.id)
    const regla = args.recordar_patron ? await this.store.saveRule(args.recordar_patron, args.categoria) : null
    return { resuelto: true, ...result, regla }
  }

  async comparar(titulo?: string): Promise<unknown> {
    const data = await this.load(await this.resolve(titulo))
    const sum = (key: GroupKey, field: 'budget' | 'actual'): number =>
      round2(data.categories.filter((c) => c.group === key).reduce((total, c) => total + c[field], 0))
    const outgoing = GROUPS.filter((g) => g.key !== 'income')
    const budgetOut = round2(outgoing.reduce((t, g) => t + sum(g.key, 'budget'), 0))
    const actualOut = round2(outgoing.reduce((t, g) => t + sum(g.key, 'actual'), 0))
    return {
      periodo: data.period.title,
      inicio: data.period.start,
      fin: data.period.end,
      categorias: data.categories.map((c) => ({
        grupo: c.group,
        nombre: c.name,
        presupuesto: c.budget,
        real: round2(c.actual),
        diferencia: round2(c.actual - c.budget)
      })),
      totales: GROUPS.map((g) => ({ grupo: g.key, presupuesto: sum(g.key, 'budget'), real: sum(g.key, 'actual') })),
      ingreso_presupuestado: sum('income', 'budget'),
      ingreso_real: sum('income', 'actual'),
      sin_asignar_presupuesto: round2(sum('income', 'budget') - budgetOut),
      sobrante_real: round2(sum('income', 'actual') - actualOut)
    }
  }

  async crearPeriodo(args: { inicio: string; fin?: string }): Promise<unknown> {
    if (!isIsoDate(args.inicio)) throw new Error('inicio debe ser AAAA-MM-DD.')
    const end = args.fin ?? provisionalEnd(args.inicio)
    if (!isIsoDate(end) || end <= args.inicio) throw new Error('fin debe ser una fecha AAAA-MM-DD posterior a inicio.')

    const { periods, template, titles } = await this.periods()
    if (!template) throw new Error('No encuentro la hoja plantilla ("Hoja Tipo") para duplicar.')
    const previous = latestPeriod(periods)
    if (previous && args.inicio <= previous.start) {
      throw new Error(`El periodo nuevo debe empezar después de ${previous.title} (${previous.start}).`)
    }

    const title = periodTitle(args.inicio, end, titles)
    const previousData = previous ? await this.load(previous) : undefined
    const created = await this.api().duplicateSheet(template.sheetId, title)

    const updates: ValueUpdate[] = [
      { range: a1(created.title, PERIOD_START_CELL), values: [[isoToSerial(args.inicio)]] },
      { range: a1(created.title, PERIOD_END_CELL), values: [[isoToSerial(end)]] }
    ]
    if (previousData) {
      const rows = CATEGORY_LAST_ROW - CATEGORY_FIRST_ROW + 1
      for (const group of GROUPS) {
        const categories = previousData.categories.filter((c) => c.group === group.key)
        const names: Grid = Array.from({ length: rows }, (_, i) => [categories[i]?.name ?? ''])
        const budgets: Grid = Array.from({ length: rows }, (_, i) => [categories[i] ? categories[i].budget : ''])
        updates.push({
          range: a1(created.title, `${group.nameCol}${CATEGORY_FIRST_ROW}:${group.nameCol}${CATEGORY_LAST_ROW}`),
          values: names
        })
        updates.push({
          range: a1(created.title, `${group.budgetCol}${CATEGORY_FIRST_ROW}:${group.budgetCol}${CATEGORY_LAST_ROW}`),
          values: budgets
        })
      }
      updates.push({ range: a1(previous!.title, PERIOD_END_CELL), values: [[isoToSerial(addDays(args.inicio, -1))]] })
    }
    await this.api().clear([a1(created.title, TX_RANGE)])
    await this.api().batchUpdate(updates)

    const late = previousData?.transactions.filter((t) => t.date >= args.inicio) ?? []
    return {
      creado: created.title,
      inicio: args.inicio,
      fin: end,
      fin_es_provisional: !args.fin,
      presupuesto_copiado_de: previous?.title ?? null,
      periodo_anterior_cerrado_el: previous ? addDays(args.inicio, -1) : null,
      movimientos_del_anterior_con_fecha_del_nuevo: late.map((t) => ({
        fila: t.row,
        fecha: t.date,
        categoria: t.category,
        importe: t.amount
      }))
    }
  }

  async aplicarPresupuesto(args: {
    periodo?: string
    cambios?: { categoria: string; presupuesto: number }[]
    nuevas?: { grupo: GroupKey; nombre: string; presupuesto: number }[]
  }): Promise<unknown> {
    const data = await this.load(await this.resolve(args.periodo))
    const title = data.period.title
    const updates: ValueUpdate[] = []
    const grid = data.categoryGrid.map((row) => [...(row ?? [])])

    for (const change of args.cambios ?? []) {
      const category = data.categories.find((c) => sameName(c.name, change.categoria))
      if (!category) throw new Error(`"${change.categoria}" no existe en ${title}. No se aplicó ningún cambio.`)
      if (!(change.presupuesto >= 0)) throw new Error(`Presupuesto inválido para ${category.name}. No se aplicó ningún cambio.`)
      const group = GROUPS.find((g) => g.key === category.group)!
      updates.push({ range: a1(title, `${group.budgetCol}${category.row}`), values: [[round2(change.presupuesto)]] })
    }
    for (const added of args.nuevas ?? []) {
      const group = GROUPS.find((g) => g.key === added.grupo)
      const name = added.nombre.trim()
      if (!group) throw new Error(`Grupo desconocido "${added.grupo}". No se aplicó ningún cambio.`)
      if (!name) throw new Error('Una categoría nueva necesita nombre. No se aplicó ningún cambio.')
      if (!(added.presupuesto >= 0)) throw new Error(`Presupuesto inválido para ${name}. No se aplicó ningún cambio.`)
      if (data.categories.some((c) => sameName(c.name, name))) {
        throw new Error(`Ya existe la categoría "${name}" en ${title}. No se aplicó ningún cambio.`)
      }
      const row = firstFreeCategoryRow(grid, group)
      if (!row) throw new Error(`No quedan filas libres en ${group.label}. No se aplicó ningún cambio.`)
      // Reserve the row so two new categories in one call do not collide.
      const index = row - CATEGORY_FIRST_ROW
      while (grid.length <= index) grid.push([])
      grid[index][GROUPS.indexOf(group) * 5] = name
      updates.push({ range: a1(title, `${group.nameCol}${row}`), values: [[name]] })
      updates.push({ range: a1(title, `${group.budgetCol}${row}`), values: [[round2(added.presupuesto)]] })
    }
    if (updates.length === 0) throw new Error('No hay cambios que aplicar.')
    await this.api().batchUpdate(updates)
    return this.comparar(title)
  }
}
