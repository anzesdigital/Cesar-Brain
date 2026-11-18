/**
 * Cell map of the budget template (one sheet per pay period) and the pure
 * helpers that read it. Nothing here touches the network.
 */

export type GroupKey = 'income' | 'fixed' | 'variable' | 'loans' | 'savings' | 'investments'

export interface GroupLayout {
  key: GroupKey
  /** Value the sheet expects in the transaction "type" column. */
  type: string
  label: string
  nameCol: string
  budgetCol: string
  actualCol: string
}

export const GROUPS: GroupLayout[] = [
  { key: 'income', type: 'Income', label: 'Ingresos', nameCol: 'B', budgetCol: 'C', actualCol: 'D' },
  { key: 'fixed', type: 'Fixed Expense', label: 'Gastos fijos', nameCol: 'G', budgetCol: 'H', actualCol: 'I' },
  { key: 'variable', type: 'Variable Expense', label: 'Gastos variables', nameCol: 'L', budgetCol: 'M', actualCol: 'N' },
  { key: 'loans', type: 'Loan Repayment', label: 'Préstamos', nameCol: 'Q', budgetCol: 'R', actualCol: 'S' },
  { key: 'savings', type: 'Savings', label: 'Ahorro', nameCol: 'V', budgetCol: 'W', actualCol: 'X' },
  { key: 'investments', type: 'Investment', label: 'Inversión', nameCol: 'AA', budgetCol: 'AB', actualCol: 'AC' }
]

export const PERIOD_START_CELL = 'C7'
export const PERIOD_END_CELL = 'C8'
export const PERIOD_RANGE = 'C7:C8'
export const CATEGORY_FIRST_ROW = 30
export const CATEGORY_LAST_ROW = 129
export const CATEGORY_RANGE = `B${CATEGORY_FIRST_ROW}:AC${CATEGORY_LAST_ROW}`
export const TX_FIRST_ROW = 5
export const TX_LAST_ROW = 1004
export const TX_RANGE = `AG${TX_FIRST_ROW}:AJ${TX_LAST_ROW}`
export const PERIOD_SHEET_PREFIX = 'Budget '

export type Cell = string | number | boolean | null | undefined
export type Grid = Cell[][]

export interface Category {
  group: GroupKey
  type: string
  name: string
  budget: number
  actual: number
  row: number
}

export interface SheetTransaction {
  row: number
  date: string
  type: string
  category: string
  amount: number
}

// ---------- A1 notation ----------

export function colToIndex(col: string): number {
  let n = 0
  for (const ch of col.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

export function indexToCol(index: number): string {
  let n = index + 1
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

/** Quotes a sheet title for use in an A1 range. */
export function a1(sheet: string, range: string): string {
  return `'${sheet.replace(/'/g, "''")}'!${range}`
}

// ---------- Dates ----------

const MS_PER_DAY = 86_400_000
const SERIAL_EPOCH = Date.UTC(1899, 11, 30)
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/

export function isIsoDate(value: string): boolean {
  if (!ISO_RE.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

export function isoToSerial(iso: string): number {
  return Math.round((Date.parse(`${iso}T00:00:00Z`) - SERIAL_EPOCH) / MS_PER_DAY)
}

export function serialToIso(serial: number): string {
  return new Date(SERIAL_EPOCH + Math.floor(serial) * MS_PER_DAY).toISOString().slice(0, 10)
}

export function addDays(iso: string, days: number): string {
  return serialToIso(isoToSerial(iso) + days)
}

export function daysBetween(fromIso: string, toIso: string): number {
  return isoToSerial(toIso) - isoToSerial(fromIso)
}

// ---------- Parsing ----------

function num(cell: Cell): number {
  if (typeof cell === 'number') return cell
  if (typeof cell === 'string' && cell.trim() !== '') {
    const n = Number(cell)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

function text(cell: Cell): string {
  return cell === null || cell === undefined ? '' : String(cell).trim()
}

/** Same spelling test the tools use everywhere: trimmed, case-insensitive. */
export function sameName(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase('es') === b.trim().toLocaleLowerCase('es')
}

const CATEGORY_BASE_COL = colToIndex('B')

/** `grid` is the unformatted content of CATEGORY_RANGE. */
export function parseCategories(grid: Grid): Category[] {
  const out: Category[] = []
  for (const group of GROUPS) {
    const nameAt = colToIndex(group.nameCol) - CATEGORY_BASE_COL
    const budgetAt = colToIndex(group.budgetCol) - CATEGORY_BASE_COL
    const actualAt = colToIndex(group.actualCol) - CATEGORY_BASE_COL
    grid.forEach((row, i) => {
      const name = text(row?.[nameAt])
      if (!name) return
      out.push({
        group: group.key,
        type: group.type,
        name,
        budget: num(row[budgetAt]),
        actual: num(row[actualAt]),
        row: CATEGORY_FIRST_ROW + i
      })
    })
  }
  return out
}

/** First row of a group's name column that has no category yet. */
export function firstFreeCategoryRow(grid: Grid, group: GroupLayout): number | undefined {
  const nameAt = colToIndex(group.nameCol) - CATEGORY_BASE_COL
  for (let i = 0; i <= CATEGORY_LAST_ROW - CATEGORY_FIRST_ROW; i++) {
    if (!text(grid[i]?.[nameAt])) return CATEGORY_FIRST_ROW + i
  }
  return undefined
}

/** `grid` is the unformatted content of TX_RANGE (date, type, category, amount). */
export function parseTransactions(grid: Grid): SheetTransaction[] {
  const out: SheetTransaction[] = []
  grid.forEach((row, i) => {
    if (!row || row.every((c) => text(c) === '')) return
    const rawDate = row[0]
    out.push({
      row: TX_FIRST_ROW + i,
      date: typeof rawDate === 'number' ? serialToIso(rawDate) : text(rawDate),
      type: text(row[1]),
      category: text(row[2]),
      amount: num(row[3])
    })
  })
  return out
}

/** Row right after the last used transaction row. */
export function nextFreeTxRow(grid: Grid): number {
  let last = -1
  grid.forEach((row, i) => {
    if (row && row.some((c) => text(c) !== '')) last = i
  })
  return TX_FIRST_ROW + last + 1
}

export function parsePeriodDates(grid: Grid): { start?: string; end?: string } {
  const read = (cell: Cell): string | undefined =>
    typeof cell === 'number' && cell > 0 ? serialToIso(cell) : undefined
  return { start: read(grid[0]?.[0]), end: read(grid[1]?.[0]) }
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100
}
