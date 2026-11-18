import { addDays, daysBetween, PERIOD_SHEET_PREFIX, sameName } from './layout'

export interface Period {
  title: string
  sheetId: number
  start: string
  end: string
}

const MONTHS = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
]

/** A payroll this many days into a period belongs to the next period. */
export const NEW_PAYROLL_MIN_DAYS = 20

export function isPayrollCategory(name: string): boolean {
  return /^n[oó]mina$/i.test(name.trim())
}

/**
 * End used until the next payroll arrives: the 24th that falls at least
 * NEW_PAYROLL_MIN_DAYS after the start.
 */
export function provisionalEnd(start: string): string {
  let year = Number(start.slice(0, 4))
  let month = Number(start.slice(5, 7)) // 1-12
  for (let i = 0; i < 3; i++) {
    const candidate = `${year}-${String(month).padStart(2, '0')}-24`
    if (daysBetween(start, candidate) >= NEW_PAYROLL_MIN_DAYS) return candidate
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  return addDays(start, 30)
}

/** "Budget Mayo" for a period that mostly falls in May. */
export function periodTitle(start: string, end: string, existingTitles: string[]): string {
  const middle = addDays(start, Math.floor(daysBetween(start, end) / 2))
  const base = `${PERIOD_SHEET_PREFIX}${MONTHS[Number(middle.slice(5, 7)) - 1]}`
  if (!existingTitles.some((t) => sameName(t, base))) return base
  const withYear = `${base} ${middle.slice(0, 4)}`
  if (!existingTitles.some((t) => sameName(t, withYear))) return withYear
  return `${withYear} (${start})`
}

/** Period whose dates contain `date`; the latest one wins if several overlap. */
export function findPeriod(periods: Period[], date: string): Period | undefined {
  return [...periods]
    .sort((a, b) => b.start.localeCompare(a.start))
    .find((p) => p.start <= date && date <= p.end)
}

export function latestPeriod(periods: Period[]): Period | undefined {
  return [...periods].sort((a, b) => b.start.localeCompare(a.start))[0]
}
