/**
 * Workbench HTTP API test.
 *
 * Drives `ApiServer` with Node-style request/response doubles, so the exact
 * payloads `client.js` consumes are verified against `docs/CONTRACT.md` without
 * needing an authenticated browser session.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { BidRuntime } from '../lib/runtime.js'
import { ApiServer, API_PREFIX } from '../lib/api.js'

const FIXTURE = fileURLToPath(new URL('../fixtures/mock-tender.md', import.meta.url))

/**
 * Run one request against the API server.
 * @param {ApiServer} api - server.
 * @param {string} path - path after the prefix.
 * @param {{ method?: string, body?: object }} [options] - request options.
 * @returns {Promise<{ status: number, headers: Record<string,string>, body: any, raw: Buffer }>} response.
 */
async function call(api, path, options = {}) {
  const payload = options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body))]
  const req = Object.assign(Readable.from(payload), {
    method: options.method ?? 'GET',
    url: `${API_PREFIX}${path}`,
    headers: { host: '127.0.0.1', 'content-type': 'application/json' },
  })
  const chunks = []
  const headers = {}
  const res = {
    statusCode: 200,
    writeHead(status, extra) {
      this.statusCode = status
      Object.assign(headers, extra ?? {})
      return this
    },
    end(data) {
      if (data !== undefined) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)))
    },
  }
  await api.handle(req, res)
  const raw = Buffer.concat(chunks)
  const isJson = String(headers['content-type'] ?? '').includes('application/json')
  return { status: res.statusCode, headers, body: isJson ? JSON.parse(raw.toString('utf8')) : null, raw }
}

test('workbench API serves the contract payloads the client consumes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bidkit-api-'))
  const runtime = new BidRuntime({ root, allowWrite: true, defaultTargetWords: 60_000, kbDir: null, logger: () => undefined })
  const api = new ApiServer({ runtime, admit: () => undefined })
  try {
    const created = await runtime.createProject({ name: '工作台 API 测试', tenderPath: FIXTURE })
    const id = created.project.id
    await runtime.lockFacts(id, [{ key: '投标人名称', value: '云枢智联科技股份有限公司' }])
    await runtime.planOutline(id)
    const stored = await runtime.store.read(id)
    const leaf = stored.outline.nodes[0].children?.[0] ?? stored.outline.nodes[0]
    await runtime.writeSection(id, leaf.id, '## 测试章节\n\n正文 **加粗**。')
    const figure = await runtime.addFigure(id, {
      sectionId: leaf.id,
      kind: 'flow',
      title: '测试流程图',
      steps: [{ title: '第一步' }, { title: '第二步' }],
    })

    const health = await call(api, '/health')
    assert.equal(health.status, 200)
    assert.equal(health.body.ok, true)
    assert.match(health.body.version, /^\d+\.\d+\.\d+$/u)

    const projects = await call(api, '/projects')
    assert.equal(projects.status, 200)
    const summary = projects.body.projects.find(entry => entry.id === id)
    assert.ok(summary !== undefined)
    assert.equal(summary.progress.coverage.total, 18)

    const view = await call(api, `/projects/${id}`)
    assert.equal(view.status, 200)
    const project = view.body.project
    for (const field of ['id', 'name', 'tender', 'parse', 'facts', 'outline', 'sections', 'figures', 'review', 'exports']) {
      assert.ok(field in project, `ProjectView must expose ${field}`)
    }
    assert.equal(project.parse.items.length, 18)
    assert.ok(project.parse.starClauses.length > 0)
    assert.ok(Array.isArray(project.outline) && project.outline.length > 0)
    assert.equal(project.facts[0].value, '云枢智联科技股份有限公司')

    const section = await call(api, `/projects/${id}/sections/${leaf.id}`)
    assert.equal(section.status, 200)
    assert.ok(section.body.section.markdown.includes('测试章节'))

    const svg = await call(api, `/projects/${id}/figures/${figure.figureId}.svg`)
    assert.equal(svg.status, 200)
    assert.match(String(svg.headers['content-type']), /image\/svg\+xml/u)
    assert.ok(svg.raw.toString('utf8').startsWith('<svg'))

    const missing = await call(api, `/projects/${id}/sections/nope`)
    assert.equal(missing.status, 404)
    assert.equal(missing.body.ok, false)
    assert.equal(missing.body.error.code, 'section_not_found')

    const review = await call(api, `/projects/${id}/review`, { method: 'POST', body: {} })
    assert.equal(review.status, 200)
    assert.equal(review.body.ok, true)
    assert.ok(review.body.review.summary.blocker >= 0)
    const persisted = await runtime.store.read(id)
    assert.ok(persisted.review !== null)

    const noExport = await call(api, `/projects/${id}/export/latest`)
    assert.equal(noExport.status, 404)
    assert.equal(noExport.body.error.code, 'no_export')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('API rejects a request the connection policy denies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bidkit-api-deny-'))
  const runtime = new BidRuntime({ root, allowWrite: true, defaultTargetWords: 0, kbDir: null, logger: () => undefined })
  const api = new ApiServer({ runtime, admit: () => 403 })
  try {
    const response = await call(api, '/health')
    assert.equal(response.status, 403)
    assert.equal(response.body.error.code, 'rejected')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
