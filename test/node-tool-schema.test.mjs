import test from 'node:test'
import assert from 'node:assert/strict'

import { lintParameterSchema, lintValueSchema, OUTPUT_SCHEMA, PARAMETERS_SCHEMA } from '../lib/node/lib/tool-schema.js'

test('satellite_node 的实际参数与输出规格符合作者 DSL', () => {
  assert.deepEqual(lintParameterSchema(PARAMETERS_SCHEMA), [])
  assert.deepEqual(lintValueSchema(OUTPUT_SCHEMA), [])
})

test('object 节点缺少 additionalProperties 会被拒绝（曾导致激活失败）', () => {
  const problems = lintValueSchema({
    type: 'object',
    properties: { kind: { type: 'string', required: true } },
  })
  assert.match(problems.join('\n'), /additionalProperties must be explicitly true or false/)
})

test('用数组表达 required 会被拒绝', () => {
  const problems = lintValueSchema({
    type: 'object',
    additionalProperties: false,
    properties: { kind: { type: 'string' } },
    required: ['kind'],
  })
  assert.match(problems.join('\n'), /required is not supported by the value schema DSL/)
})

test('required 只接受布尔 true，未知键与错误类型都拒绝', () => {
  assert.match(
    lintValueSchema({ type: 'string', required: false }, 'x', { allowRequired: true }).join('\n'),
    /required must be true when present/,
  )
  assert.match(lintValueSchema({ type: 'string', extra: 1 }).join('\n'), /extra is not supported/)
  assert.match(lintValueSchema({ type: 'nope' }).join('\n'), /type must be/)
  assert.match(lintValueSchema({ type: 'object', additionalProperties: false, properties: { a: { type: 'array', items: { type: 'string', required: true } } } }).join('\n'), /required is not supported/)
  assert.match(lintValueSchema({ oneOf: [{ type: 'string' }] }).join('\n'), /at least two/)
  assert.match(lintValueSchema({ oneOf: [{ type: 'string' }, { type: 'number' }], type: 'string' }).join('\n'), /cannot declare both/)
})

test('合法的嵌套与 oneOf 通过', () => {
  assert.deepEqual(
    lintValueSchema({
      type: 'object',
      additionalProperties: true,
      properties: {
        a: { type: 'string', required: true },
        b: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {} } },
        c: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        d: { type: 'json' },
      },
    }),
    [],
  )
})
