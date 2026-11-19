import { describe, expect, it } from 'vitest'
import { parseOptions } from '../src/shared/options'

describe('parseOptions', () => {
  it('leaves text without a block alone', () => {
    expect(parseOptions('Hola')).toEqual({ body: 'Hola', options: [] })
  })

  it('splits the block off and reads labels and details', () => {
    const text = '¿Qué prefieres?\n\n```opciones\n- Informe corto | una página\n- **Informe completo**\n2. Nada\n```'
    expect(parseOptions(text)).toEqual({
      body: '¿Qué prefieres?',
      options: [{ label: 'Informe corto', detail: 'una página' }, { label: 'Informe completo' }, { label: 'Nada' }]
    })
  })

  it('handles CRLF, text after the block and an unclosed block while streaming', () => {
    expect(parseOptions('A\r\n```opciones\r\n- Uno\r\n- Dos\r\n```\r\nFin').options).toHaveLength(2)
    expect(parseOptions('A\r\n```opciones\r\n- Uno\r\n```\r\nFin').body).toBe('A\n\nFin')
    expect(parseOptions('A\n```opciones\n- Un')).toEqual({ body: 'A', options: [{ label: 'Un' }] })
  })

  it('ignores other code blocks', () => {
    const text = '```js\nconst a = 1\n```'
    expect(parseOptions(text)).toEqual({ body: text, options: [] })
  })
})
