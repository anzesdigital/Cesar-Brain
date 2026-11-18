import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  colToIndex,
  indexToCol,
  isIsoDate,
  isoToSerial,
  serialToIso,
  type Cell,
  type Grid
} from '../src/main/finance/layout'
import { findPeriod, periodTitle, provisionalEnd } from '../src/main/finance/period'
import { FinanceService, type MovementInput } from '../src/main/finance/service'
import { parseCredentials, parseSpreadsheetId, type SheetInfo, type SheetsApi, type ValueUpdate } from '../src/main/finance/sheets'
import { fingerprint, FinanceStore, matchRule, normalize } from '../src/main/finance/store'

/** In-memory spreadsheet that understands the A1 ranges the service uses. */
class FakeSheets implements SheetsApi {
  sheets = new Map<string, { id: number; cells: Map<string, Cell> }>()
  private nextId = 1

  add(title: string, cells: Record<string, Cell> = {}): void {
    this.sheets.set(title, { id: this.nextId++, cells: new Map(Object.entries(cells)) })
  }

  cell(title: string, ref: string): Cell {
    return this.sheets.get(title)?.cells.get(ref)
  }

  private parse(range: string): { title: string; c1: number; r1: number; c2: number; r2: number } {
    const match = range.match(/^'(.+)'!([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/)
    if (!match) throw new Error(`bad range ${range}`)
    const [, title, colA, rowA, colB, rowB] = match
    return {
      title: title.replace(/''/g, "'"),
      c1: colToIndex(colA),
      r1: Number(rowA),
      c2: colToIndex(colB ?? colA),
      r2: Number(rowB ?? rowA)
    }
  }

  async listSheets(): Promise<SheetInfo[]> {
    return [...this.sheets].map(([title, s]) => ({ title, sheetId: s.id }))
  }

  async batchGet(ranges: string[]): Promise<Grid[]> {
    return ranges.map((range) => {
      const { title, c1, r1, c2, r2 } = this.parse(range)
      const sheet = this.sheets.get(title)
      if (!sheet) throw new Error(`no sheet ${title}`)
      const grid: Grid = []
      for (let r = r1; r <= r2; r++) {
        const row: Cell[] = []
        for (let c = c1; c <= c2; c++) row.push(sheet.cells.get(`${indexToCol(c)}${r}`) ?? '')
        grid.push(row)
      }
      return grid
    })
  }

  async batchUpdate(updates: ValueUpdate[]): Promise<void> {
    for (const update of updates) {
      const { title, c1, r1 } = this.parse(update.range)
      const sheet = this.sheets.get(title)
      if (!sheet) throw new Error(`no sheet ${title}`)
      update.values.forEach((row, i) =>
        row.forEach((value, j) => {
          const ref = `${indexToCol(c1 + j)}${r1 + i}`
          if (value === '' || value === null || value === undefined) sheet.cells.delete(ref)
          else sheet.cells.set(ref, value)
        })
      )
    }
  }

  async clear(ranges: string[]): Promise<void> {
    for (const range of ranges) {
      const { title, c1, r1, c2, r2 } = this.parse(range)
      const sheet = this.sheets.get(title)!
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) sheet.cells.delete(`${indexToCol(c)}${r}`)
    }
  }

  async duplicateSheet(sourceSheetId: number, newTitle: string): Promise<SheetInfo> {
    const source = [...this.sheets.values()].find((s) => s.id === sourceSheetId)!
    this.add(newTitle, Object.fromEntries(source.cells))
    return { title: newTitle, sheetId: this.sheets.get(newTitle)!.id }
  }
}

const MAYO = 'Budget Mayo'

function seed(): FakeSheets {
  const fake = new FakeSheets()
  fake.add('Start Here', { H25: '€' })
  fake.add('Copia de Hoja Tipo ', {
    C7: isoToSerial('2025-01-01'),
    C8: isoToSerial('2025-01-31'),
    B30: 'Plantilla ingreso',
    AG5: isoToSerial('2025-01-02'),
    AH5: 'Income',
    AI5: 'Plantilla ingreso',
    AJ5: 1
  })
  fake.add(MAYO, {
    C7: isoToSerial('2026-04-25'),
    C8: isoToSerial('2026-05-26'),
    B30: 'Nomina', C30: 2150, D30: 2050,
    B31: 'Devolucion Bizum', C31: 0, D31: 0,
    G30: 'Alquiler', H30: 537, I30: 537,
    G31: 'Comida', H31: 350, I31: 24.35,
    L30: 'Comer fuera', M30: 100, N30: 0,
    L31: 'Compras', M31: 100, N31: 225.31,
    V30: 'Ahorro', W30: 200, X30: 0,
    // two movements entered by hand before the agent existed
    AG5: isoToSerial('2026-04-25'), AH5: 'Fixed Expense', AI5: 'Comida', AJ5: 24.35,
    AG6: isoToSerial('2026-04-25'), AH6: 'Income', AI6: 'Nomina', AJ6: 2050
  })
  return fake
}

const gasto = (over: Partial<MovementInput> = {}): MovementInput => ({
  fecha: '2026-05-02',
  importe: 18.5,
  sentido: 'gasto',
  categoria: 'Comida',
  descripcion: 'MERCADONA 0423 MADRID',
  origen: 'inferida',
  motivo: 'Supermercado',
  ...over
})

describe('layout helpers', () => {
  it('converts columns and dates like the spreadsheet does', () => {
    expect(colToIndex('A')).toBe(0)
    expect(colToIndex('AA')).toBe(26)
    expect(indexToCol(colToIndex('AJ'))).toBe('AJ')
    // values observed in the real workbook
    expect(serialToIso(46137)).toBe('2026-04-25')
    expect(serialToIso(46168)).toBe('2026-05-26')
    expect(isoToSerial('2026-04-25')).toBe(46137)
    expect(isIsoDate('2026-02-30')).toBe(false)
    expect(isIsoDate('26/05/2026')).toBe(false)
  })
})

describe('periods', () => {
  it('uses the 24th as provisional end whatever day payroll lands', () => {
    expect(provisionalEnd('2026-05-25')).toBe('2026-06-24')
    expect(provisionalEnd('2026-05-23')).toBe('2026-06-24')
    expect(provisionalEnd('2026-05-27')).toBe('2026-06-24')
    expect(provisionalEnd('2026-12-24')).toBe('2027-01-24')
  })

  it('names a period after the month it mostly covers and avoids collisions', () => {
    expect(periodTitle('2026-04-25', '2026-05-24', [])).toBe('Budget Mayo')
    expect(periodTitle('2026-05-25', '2026-06-24', ['Budget Junio'])).toBe('Budget Junio 2026')
  })

  it('finds the period that contains a date', () => {
    const periods = [{ title: MAYO, sheetId: 1, start: '2026-04-25', end: '2026-05-26' }]
    expect(findPeriod(periods, '2026-04-25')?.title).toBe(MAYO)
    expect(findPeriod(periods, '2026-05-27')).toBeUndefined()
  })
})

describe('rules and fingerprints', () => {
  it('normalizes bank descriptions', () => {
    expect(normalize('COMPRA TARJ. 4532 MERCADONA  0423 Madrid')).toBe('compra tarj mercadona madrid')
    expect(normalize('Café Ñandú')).toBe('cafe nandu')
  })

  it('matches whole words and prefers the longest pattern', () => {
    const rules = [
      { patron: 'amazon', categoria: 'Compras', ts: 0 },
      { patron: 'amazon prime', categoria: 'Suscripciones', ts: 0 }
    ]
    expect(matchRule(rules, 'AMAZON PRIME*2K4')?.categoria).toBe('Suscripciones')
    expect(matchRule(rules, 'Amazon.es pedido')?.categoria).toBe('Compras')
    expect(matchRule(rules, 'AMAZONAS RESTAURANTE')).toBeUndefined()
  })

  it('separates repeated identical lines by occurrence', () => {
    const a = fingerprint('2026-05-02', 1.79, 'Monster', 0)
    expect(fingerprint('2026-05-02', 1.79, ' monster ', 0)).toBe(a)
    expect(fingerprint('2026-05-02', 1.79, 'Monster', 1)).not.toBe(a)
  })
})

describe('google config parsing', () => {
  it('extracts the spreadsheet id', () => {
    const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdEFG'
    expect(parseSpreadsheetId(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`)).toBe(id)
    expect(parseSpreadsheetId(id)).toBe(id)
    expect(() => parseSpreadsheetId('https://example.com/hoja')).toThrow(/No reconozco/)
  })

  it('rejects files that are not service account keys', () => {
    expect(() => parseCredentials('no json')).toThrow(/JSON/)
    expect(() => parseCredentials('{"type":"authorized_user"}')).toThrow(/cuenta de servicio/)
    expect(parseCredentials('{"type":"service_account","client_email":"a@b.c","private_key":"k"}').client_email).toBe('a@b.c')
  })
})

describe('FinanceService', () => {
  let dir: string
  let fake: FakeSheets
  let store: FinanceStore
  let service: FinanceService

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'finanzas-'))
    fake = seed()
    store = new FinanceStore(dir)
    service = new FinanceService(() => fake, store, () => '2026-05-03')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reports a clear error when Google is not connected', async () => {
    const offline = new FinanceService(() => undefined, store)
    await expect(offline.estado()).rejects.toThrow(/no está conectado/)
  })

  it('reads periods and categories', async () => {
    const estado = (await service.estado()) as {
      periodo_que_cubre_hoy: string
      periodo_mostrado: { movimientos: number; categorias: { nombre: string; presupuesto: number }[] }
    }
    expect(estado.periodo_que_cubre_hoy).toBe(MAYO)
    expect(estado.periodo_mostrado.movimientos).toBe(2)
    expect(estado.periodo_mostrado.categorias.find((c) => c.nombre === 'Comida')?.presupuesto).toBe(350)
  })

  it('appends a movement after the last used row with the sheet spelling', async () => {
    const result = await service.registrar([gasto({ categoria: 'comida' })])
    expect(result.registrados).toHaveLength(1)
    expect(result.inferidas_para_revisar).toHaveLength(1)
    expect(fake.cell(MAYO, 'AG7')).toBe(isoToSerial('2026-05-02'))
    expect(fake.cell(MAYO, 'AH7')).toBe('Fixed Expense')
    expect(fake.cell(MAYO, 'AI7')).toBe('Comida')
    expect(fake.cell(MAYO, 'AJ7')).toBe(18.5)
    expect((await store.log())[0]).toMatchObject({ descripcion: 'MERCADONA 0423 MADRID', fila: 7, periodo: MAYO })
  })

  it('never writes a category that does not exist', async () => {
    const result = await service.registrar([gasto({ categoria: 'Supermercado' })])
    expect(result.registrados).toHaveLength(0)
    expect(result.rechazados[0].motivo).toMatch(/no existe/)
    expect(fake.cell(MAYO, 'AG7')).toBeUndefined()
  })

  it('rejects guesses: inferred without reason, rule without a rule, wrong direction, no period', async () => {
    const result = await service.registrar([
      gasto({ motivo: ' ' }),
      gasto({ origen: 'regla', motivo: undefined }),
      gasto({ categoria: 'Nomina' }),
      gasto({ fecha: '2026-07-15' }),
      gasto({ importe: -5 }),
      gasto({ fecha: '15/05/2026' })
    ])
    expect(result.registrados).toHaveLength(0)
    expect(result.rechazados.map((r) => r.motivo)).toEqual([
      expect.stringMatching(/motivo/),
      expect.stringMatching(/No hay regla/),
      expect.stringMatching(/categoría de ingreso/),
      expect.stringMatching(/Ningún periodo cubre/),
      expect.stringMatching(/positivo/),
      expect.stringMatching(/Fecha inválida/)
    ])
  })

  it('accepts origin "regla" only when a learned rule agrees', async () => {
    await store.saveRule('Mercadona', 'Comida')
    const ok = await service.registrar([gasto({ origen: 'regla', motivo: undefined })])
    expect(ok.registrados).toHaveLength(1)
    const wrong = await service.registrar([gasto({ origen: 'regla', categoria: 'Compras', fecha: '2026-05-04' })])
    expect(wrong.rechazados[0].motivo).toMatch(/No hay regla/)
  })

  it('does not duplicate when the same statement is imported twice', async () => {
    const statement = [
      gasto(),
      gasto({ descripcion: 'Monster', importe: 1.79, categoria: 'Compras' }),
      gasto({ descripcion: 'Monster', importe: 1.79, categoria: 'Compras' })
    ]
    const first = await service.registrar(statement)
    expect(first.registrados).toHaveLength(3)
    const second = await service.registrar(statement)
    expect(second.registrados).toHaveLength(0)
    expect(second.duplicados).toHaveLength(3)
    expect(fake.cell(MAYO, 'AG10')).toBeUndefined()
  })

  it('flags a movement that already sits in the sheet from before, unless forced', async () => {
    const existing = gasto({ fecha: '2026-04-25', importe: 24.35, descripcion: 'Carrefour' })
    const first = await service.registrar([existing])
    expect(first.registrados).toHaveLength(0)
    expect(first.duplicados).toHaveLength(1)
    const forced = await service.registrar([existing], true)
    expect(forced.registrados).toHaveLength(1)
  })

  it('sends a new payroll to a new period instead of the old one', async () => {
    const payroll: MovementInput = {
      fecha: '2026-05-25',
      importe: 2150,
      sentido: 'ingreso',
      categoria: 'Nomina',
      descripcion: 'NOMINA EMPRESA SL',
      origen: 'usuario'
    }
    const before = await service.registrar([payroll])
    expect(before.rechazados[0].motivo).toMatch(/crear_periodo/)

    const created = (await service.crearPeriodo({ inicio: '2026-05-25' })) as { creado: string; fin: string }
    expect(created.creado).toBe('Budget Junio')
    expect(created.fin).toBe('2026-06-24')
    expect(fake.cell(MAYO, 'C8')).toBe(isoToSerial('2026-05-24'))
    expect(fake.cell('Budget Junio', 'C7')).toBe(isoToSerial('2026-05-25'))
    // categories and budgets come from the previous period, not the template
    expect(fake.cell('Budget Junio', 'B30')).toBe('Nomina')
    expect(fake.cell('Budget Junio', 'H31')).toBe(350)
    expect(fake.cell('Budget Junio', 'AG5')).toBeUndefined()

    const after = await service.registrar([payroll])
    expect(after.registrados).toHaveLength(1)
    expect(fake.cell('Budget Junio', 'AI5')).toBe('Nomina')
  })

  it('refuses a period that does not start after the latest one', async () => {
    await expect(service.crearPeriodo({ inicio: '2026-04-01' })).rejects.toThrow(/después de/)
  })

  it('keeps unclear movements pending until César answers', async () => {
    const [pending] = (await service.guardarPendientes([
      { fecha: '2026-05-02', importe: 30, sentido: 'gasto', descripcion: 'BIZUM A PABLO', duda: '¿Comer fuera o Compras?' }
    ])) as { id: string }[]
    expect(fake.cell(MAYO, 'AG7')).toBeUndefined()
    expect(await store.pending()).toHaveLength(1)

    const bad = (await service.resolverPendiente({ id: pending.id, categoria: 'Fiesta' })) as { resuelto: boolean }
    expect(bad.resuelto).toBe(false)
    expect(await store.pending()).toHaveLength(1)

    const ok = (await service.resolverPendiente({ id: pending.id, categoria: 'Comer fuera' })) as { resuelto: boolean }
    expect(ok.resuelto).toBe(true)
    expect(fake.cell(MAYO, 'AI7')).toBe('Comer fuera')
    expect(await store.pending()).toHaveLength(0)
    expect(await store.rules()).toHaveLength(0)
  })

  it('compares budget with actuals', async () => {
    const report = (await service.comparar()) as {
      categorias: { nombre: string; diferencia: number }[]
      ingreso_presupuestado: number
      sin_asignar_presupuesto: number
    }
    expect(report.categorias.find((c) => c.nombre === 'Compras')?.diferencia).toBe(125.31)
    expect(report.ingreso_presupuestado).toBe(2150)
    expect(report.sin_asignar_presupuesto).toBe(2150 - (537 + 350 + 100 + 100 + 200))
  })

  it('applies approved budget changes atomically', async () => {
    await expect(
      service.aplicarPresupuesto({ cambios: [{ categoria: 'Compras', presupuesto: 150 }, { categoria: 'Nope', presupuesto: 1 }] })
    ).rejects.toThrow(/No se aplicó ningún cambio/)
    expect(fake.cell(MAYO, 'M31')).toBe(100)

    await service.aplicarPresupuesto({
      cambios: [{ categoria: 'Compras', presupuesto: 150 }],
      nuevas: [
        { grupo: 'variable', nombre: 'Farmacia', presupuesto: 20 },
        { grupo: 'variable', nombre: 'Regalos', presupuesto: 30 }
      ]
    })
    expect(fake.cell(MAYO, 'M31')).toBe(150)
    expect(fake.cell(MAYO, 'L32')).toBe('Farmacia')
    expect(fake.cell(MAYO, 'L33')).toBe('Regalos')
    expect(fake.cell(MAYO, 'M33')).toBe(30)
  })
})
