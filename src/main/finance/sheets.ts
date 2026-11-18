import { JWT } from 'google-auth-library'
import type { Grid } from './layout'

export interface SheetInfo {
  sheetId: number
  title: string
}

export interface ValueUpdate {
  /** Full A1 range including the sheet, e.g. 'Budget Mayo'!AG5:AJ7 */
  range: string
  values: Grid
}

/** The slice of Google Sheets the budget tools need. Faked in tests. */
export interface SheetsApi {
  listSheets(): Promise<SheetInfo[]>
  /** Unformatted values (dates as serial numbers), one grid per requested range. */
  batchGet(ranges: string[]): Promise<Grid[]>
  batchUpdate(updates: ValueUpdate[]): Promise<void>
  clear(ranges: string[]): Promise<void>
  duplicateSheet(sourceSheetId: number, newTitle: string): Promise<SheetInfo>
}

export interface GoogleCredentials {
  client_email: string
  private_key: string
}

export interface GoogleConfig {
  credentials: GoogleCredentials
  spreadsheetId: string
}

export function parseSpreadsheetId(urlOrId: string): string {
  const value = urlOrId.trim()
  const fromUrl = value.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/)
  if (fromUrl) return fromUrl[1]
  if (/^[a-zA-Z0-9_-]{20,}$/.test(value)) return value
  throw new Error('No reconozco esa dirección. Pega la URL completa de la hoja de Google Sheets.')
}

export function parseCredentials(json: string): GoogleCredentials {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(json) as Record<string, unknown>
  } catch {
    throw new Error('El archivo de clave no es un JSON válido.')
  }
  if (parsed.type !== 'service_account' || typeof parsed.client_email !== 'string' || typeof parsed.private_key !== 'string') {
    throw new Error('El archivo no es una clave de cuenta de servicio de Google (falta client_email o private_key).')
  }
  return { client_email: parsed.client_email, private_key: parsed.private_key }
}

const BASE = 'https://sheets.googleapis.com/v4/spreadsheets'

export class GoogleSheets implements SheetsApi {
  private auth: JWT
  private id: string

  constructor(config: GoogleConfig) {
    this.id = config.spreadsheetId
    this.auth = new JWT({
      email: config.credentials.client_email,
      key: config.credentials.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    })
  }

  private async call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const { token } = await this.auth.getAccessToken()
    if (!token) throw new Error('Google no entregó un token de acceso.')
    const response = await fetch(`${BASE}/${this.id}${path}`, {
      method: init?.method ?? 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body)
    })
    if (!response.ok) {
      let detail = response.statusText
      try {
        const body = (await response.json()) as { error?: { message?: string } }
        detail = body.error?.message ?? detail
      } catch {
        // keep statusText
      }
      if (response.status === 403 || response.status === 404) {
        throw new Error(
          `Google Sheets rechazó el acceso (${response.status}): ${detail}. ¿Compartiste la hoja con ${this.auth.email} como Editor?`
        )
      }
      throw new Error(`Google Sheets respondió ${response.status}: ${detail}`)
    }
    return (await response.json()) as T
  }

  async listSheets(): Promise<SheetInfo[]> {
    const data = await this.call<{ sheets: { properties: SheetInfo }[] }>('?fields=sheets.properties(sheetId,title)')
    return data.sheets.map((s) => ({ sheetId: s.properties.sheetId, title: s.properties.title }))
  }

  async batchGet(ranges: string[]): Promise<Grid[]> {
    if (ranges.length === 0) return []
    const query = new URLSearchParams({
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'SERIAL_NUMBER'
    })
    for (const range of ranges) query.append('ranges', range)
    const data = await this.call<{ valueRanges: { values?: Grid }[] }>(`/values:batchGet?${query}`)
    return data.valueRanges.map((v) => v.values ?? [])
  }

  async batchUpdate(updates: ValueUpdate[]): Promise<void> {
    if (updates.length === 0) return
    await this.call('/values:batchUpdate', {
      method: 'POST',
      body: { valueInputOption: 'RAW', data: updates }
    })
  }

  async clear(ranges: string[]): Promise<void> {
    if (ranges.length === 0) return
    await this.call('/values:batchClear', { method: 'POST', body: { ranges } })
  }

  async duplicateSheet(sourceSheetId: number, newTitle: string): Promise<SheetInfo> {
    const count = (await this.listSheets()).length
    const data = await this.call<{ replies: { duplicateSheet: { properties: SheetInfo } }[] }>(':batchUpdate', {
      method: 'POST',
      body: {
        requests: [{ duplicateSheet: { sourceSheetId, insertSheetIndex: count, newSheetName: newTitle } }]
      }
    })
    const props = data.replies[0].duplicateSheet.properties
    return { sheetId: props.sheetId, title: props.title }
  }
}
