import { describe, expect, it } from 'vitest'
import { render, templateFor } from '../src/main/brain/bubbles'
import { parseAgentFile } from '../src/main/brain/registry'

describe('bubble templates', () => {
  it('fills values, defaults, counts and lists', () => {
    expect(render('Buscando «{query}»', { query: 'clima' })).toBe('Buscando «clima»')
    expect(render('Movimientos de {periodo?este periodo}', {})).toBe('Movimientos de este periodo')
    expect(render('Movimientos de {periodo?este periodo}', { periodo: 'Mayo' })).toBe('Movimientos de Mayo')
    expect(render('Anotando {#m|movimiento|movimientos}', { m: [1] })).toBe('Anotando 1 movimiento')
    expect(render('Anotando {#m|movimiento|movimientos}', { m: [1, 2, 3] })).toBe('Anotando 3 movimientos')
    expect(render('{#m}', {})).toBe('0')
    expect(render('Fichero {a.b.c}', { a: { b: { c: 'x.pdf' } } })).toBe('Fichero x.pdf')
    expect(render('Sin {nada} dato', {})).toBe('Sin dato')
    expect(render('{l.*:{n} → {v} €}', { l: [{ n: 'Ocio', v: 50 }, { n: 'Casa', v: 700 }] })).toBe('Ocio → 50 €, Casa → 700 €')
    expect(render('Cambios:\n{l.*:{n} → {v} €}\n{z.*:Nueva {n}}', { l: [{ n: 'A', v: 1 }, { n: 'B', v: 2 }] }, '\n')).toBe(
      'Cambios:\nA → 1 €\nB → 2 €'
    )
    expect(render('llave {sin cerrar', {})).toBe('llave {sin cerrar')
  })

  it('finds a template by full or short MCP name', () => {
    const t = { Read: 'leo', estado: 'miro', mcp__x__y: 'exacto' }
    expect(templateFor(t, 'Read')).toBe('leo')
    expect(templateFor(t, 'mcp__presupuesto__estado')).toBe('miro')
    expect(templateFor(t, 'mcp__x__y')).toBe('exacto')
    expect(templateFor(t, 'Write')).toBeUndefined()
    expect(templateFor(undefined, 'Read')).toBeUndefined()
  })

  it('reads burbujas and permisos from agent.md', () => {
    const { spec } = parseAgentFile(
      `---
description: x
burbujas:
  _listo: ¡Hecho!
  estado: "Mirando: {periodo?todo}"
permisos:
  Write: "Guardar {file_path}"
---
cuerpo`,
      'a-b'
    )
    expect(spec.bubbles).toEqual({ _listo: '¡Hecho!', estado: 'Mirando: {periodo?todo}' })
    expect(spec.permissions).toEqual({ Write: 'Guardar {file_path}' })
    expect(() => parseAgentFile('---\ndescription: x\nburbujas: [a]\n---\ncuerpo', 'a-b')).toThrow(/burbujas/)
    expect(() => parseAgentFile('---\ndescription: x\nburbujas:\n  Read: [a]\n---\ncuerpo', 'a-b')).toThrow(/burbujas.Read/)
  })
})
