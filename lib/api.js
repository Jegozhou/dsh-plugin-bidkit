/**
 * HTTP API for the browser half.
 *
 * The workbench reads the same project bytes the agent writes. Every request is
 * admitted by the Harness `connection` service (the plugin never invents a
 * second authentication scheme), every route is exact, and every failure
 * answers JSON with a stable `{ code, message }` so the UI can state the exact
 * reason instead of showing an empty panel.
 *
 * @module lib/api
 */

import { countWords, flattenOutline } from './store.js'
import { TENDER_ITEMS } from './parse.js'

/** Base path of the JSON API; must match `client.js`. */
export const API_PREFIX = '/dsh-plugin-bidkit/api'
/** Plugin version reported by `/health`. */
export const API_VERSION = '0.1.0'

/** One API server bound to a runtime. */
export class ApiServer {
  /**
   * @param {{ runtime: import('./runtime.js').BidRuntime, admit?: (req: import('node:http').IncomingMessage) => number|undefined, log?: (message: string, error?: unknown) => void }} deps - dependencies.
   */
  constructor(deps) {
    this.runtime = deps.runtime
    this.admit = deps.admit ?? (() => undefined)
    this.log = deps.log ?? (() => undefined)
  }

  /**
   * Handle one HTTP request.
   * @param {import('node:http').IncomingMessage} req - request.
   * @param {import('node:http').ServerResponse} res - response.
   * @returns {Promise<void>} resolves when the response is written.
   */
  async handle(req, res) {
    try {
      const rejection = this.admit(req)
      if (typeof rejection === 'number') {
        writeJson(res, rejection, { ok: false, error: { code: 'rejected', message: 'request rejected by the connection policy' } })
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) : url.pathname
      const segments = path.split('/').filter(Boolean)
      const method = req.method ?? 'GET'
      await this.route(method, segments, req, res)
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'internal'
      const message = error instanceof Error ? error.message : String(error)
      const status = code === 'project_not_found' || code === 'section_not_found' ? 404 : code === 'invalid_argument' ? 400 : 500
      if (status === 500) this.log('api request failed', error)
      writeJson(res, status, { ok: false, error: { code, message } })
    }
  }

  /**
   * Dispatch one request.
   * @param {string} method - HTTP method.
   * @param {string[]} segments - path segments after the prefix.
   * @param {import('node:http').IncomingMessage} req - request.
   * @param {import('node:http').ServerResponse} res - response.
   * @returns {Promise<void>} resolves when handled.
   */
  async route(method, segments, req, res) {
    const runtime = this.runtime
    if (method === 'GET' && segments.length === 1 && segments[0] === 'health') {
      const projects = await runtime.store.list().catch(() => [])
      writeJson(res, 200, { ok: true, version: API_VERSION, projectCount: projects.length, root: runtime.store.root })
      return
    }
    if (method === 'GET' && segments.length === 1 && segments[0] === 'projects') {
      const projects = await runtime.store.list()
      const summaries = []
      for (const project of projects) summaries.push(await summaryOf(runtime, project))
      writeJson(res, 200, { ok: true, projects: summaries })
      return
    }
    if (segments[0] !== 'projects' || segments.length < 2) {
      writeJson(res, 404, { ok: false, error: { code: 'not_found', message: `no route for ${method} ${segments.join('/')}` } })
      return
    }
    const id = decodeURIComponent(segments[1])

    if (method === 'GET' && segments.length === 2) {
      writeJson(res, 200, { ok: true, project: await projectView(runtime, id) })
      return
    }
    if (method === 'GET' && segments[2] === 'sections' && segments.length === 4) {
      const sectionId = decodeURIComponent(segments[3])
      const section = await runtime.readSection(id, sectionId)
      writeJson(res, 200, {
        ok: true,
        section: {
          id: section.id,
          title: section.title,
          markdown: section.markdown,
          words: section.words,
          status: section.status,
          figures: section.figures.map(figure => ({
            id: figure.id,
            title: figure.title,
            url: `${API_PREFIX}/projects/${id}/figures/${figure.id}.svg`,
          })),
        },
      })
      return
    }
    if (method === 'GET' && segments[2] === 'figures' && segments.length === 4) {
      const name = segments[3].replace(/\.svg$/u, '')
      const svg = await runtime.store.readFigure(id, name)
      res.writeHead(200, {
        'content-type': 'image/svg+xml; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-length': String(Buffer.byteLength(svg)),
      })
      res.end(svg)
      return
    }
    if (method === 'GET' && segments[2] === 'export' && segments[3] === 'latest') {
      const index = await runtime.store.read(id)
      const latest = (index.exports ?? [])[0]
      if (latest === undefined) {
        writeJson(res, 404, { ok: false, error: { code: 'no_export', message: '尚未导出过 .docx' } })
        return
      }
      const file = await runtime.store.path(id, `exports/${latest.file}`)
      const { readFile } = await import('node:fs/promises')
      const bytes = await readFile(file)
      res.writeHead(200, {
        'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(latest.file)}`,
        'content-length': String(bytes.length),
        'cache-control': 'no-store',
      })
      res.end(bytes)
      return
    }
    if (method === 'POST' && segments[2] === 'review' && segments.length === 3) {
      const body = await readBody(req)
      const compareWith = body?.compareWith === undefined ? undefined : String(body.compareWith)
      const review = await runtime.review(id, { compareWith })
      writeJson(res, 200, { ok: true, review })
      return
    }
    writeJson(res, 404, { ok: false, error: { code: 'not_found', message: `no route for ${method} ${segments.join('/')}` } })
  }
}

/**
 * Compact project summary for the project rail.
 * @param {import('./runtime.js').BidRuntime} runtime - runtime.
 * @param {object} project - project index.
 * @returns {Promise<object>} summary.
 */
async function summaryOf(runtime, project) {
  const status = await runtime.status(project.id).catch(() => null)
  const nodes = flattenOutline(project.outline?.nodes ?? [])
  return {
    id: project.id,
    name: project.name,
    updatedAt: project.updatedAt,
    progress: {
      sections: status?.writing.writtenSections ?? 0,
      sectionsTotal: status?.writing.totalSections ?? nodes.length,
      words: status?.writing.words ?? 0,
      coverage: status?.parse.coverage ?? { filled: 0, total: 18 },
      stars: status?.parse.stars ?? 0,
      risks: status?.review?.summary ?? { blocker: 0, major: 0, minor: 0 },
      exported: (project.exports ?? []).length > 0,
    },
  }
}

/**
 * Full workbench view of one project.
 * @param {import('./runtime.js').BidRuntime} runtime - runtime.
 * @param {string} id - project id.
 * @returns {Promise<object>} project view (see docs/CONTRACT.md §2.2).
 */
async function projectView(runtime, id) {
  const index = await runtime.store.read(id)
  const nodes = flattenOutline(index.outline?.nodes ?? [])
  const figures = index.figures ?? []
  return {
    id: index.id,
    name: index.name,
    updatedAt: index.updatedAt,
    tender: {
      title: index.tender?.title ?? index.name,
      sourceFile: index.tender?.sourceFile ?? '',
      sectionCount: index.tender?.sectionCount ?? 0,
    },
    parse: {
      coverage: index.parse?.coverage ?? { filled: 0, total: TENDER_ITEMS.length },
      items: (index.parse?.items ?? []).map(item => ({
        key: item.key,
        label: item.label,
        status: item.status,
        value: item.value ?? '',
        risk: item.risk ?? 'low',
        evidence: (item.evidence ?? []).map(entry => ({ sectionId: entry.sectionId ?? '', quote: entry.quote ?? '' })),
      })),
      starClauses: (index.parse?.starClauses ?? []).map(clause => ({
        id: clause.id,
        text: clause.text,
        category: clause.category,
        strategy: clause.strategy,
        sectionRef: matrixRef(index, clause.text),
      })),
      scoring: {
        technical: index.parse?.scoring?.technical ?? [],
        commercial: index.parse?.scoring?.commercial ?? [],
        price: index.parse?.scoring?.price ?? [],
      },
      lots: index.parse?.lots ?? [],
    },
    facts: (index.facts ?? []).map(fact => ({ key: fact.key, value: fact.value, lockedAt: fact.lockedAt })),
    outline: nodes.map(node => ({
      id: node.id,
      title: node.title,
      level: node.level,
      wordTarget: node.wordTarget ?? 0,
      status: index.sections?.[node.id]?.status ?? node.status ?? 'pending',
      scoreRefs: node.scoreRefs ?? [],
      starRefs: node.starRefs ?? [],
    })),
    sections: nodes.map(node => ({
      id: node.id,
      title: node.title,
      level: node.level,
      words: index.sections?.[node.id]?.words ?? 0,
      status: index.sections?.[node.id]?.status ?? 'pending',
      updatedAt: index.sections?.[node.id]?.updatedAt ?? null,
    })),
    figures: figures.map(figure => ({
      id: figure.id,
      title: figure.title,
      kind: figure.kind,
      sectionId: figure.sectionId,
      w: figure.w ?? 600,
      h: figure.h ?? 360,
    })),
    review: index.review ?? null,
    exports: (index.exports ?? []).map(entry => ({ file: entry.file, at: entry.at, bytes: entry.bytes })),
    stats: {
      words: nodes.reduce((total, node) => total + (index.sections?.[node.id]?.words ?? 0), 0),
      written: nodes.filter(node => (index.sections?.[node.id]?.words ?? 0) > 0).length,
      total: nodes.filter(node => (node.children ?? []).length === 0).length,
      targetWords: index.outline?.targetWords ?? 0,
      stars: (index.parse?.starClauses ?? []).length,
    },
  }
}

/**
 * Find the matrix section reference for a material clause.
 * @param {object} index - project index.
 * @param {string} text - clause text.
 * @returns {string|null} referenced section id.
 */
function matrixRef(index, text) {
  const row = (index.parse?.responseMatrix ?? []).find(entry => entry.type === 'material' && entry.requirement === text)
  return row?.sectionRef ?? null
}

/**
 * Read and parse a JSON request body.
 * @param {import('node:http').IncomingMessage} req - request.
 * @returns {Promise<Record<string, unknown>|null>} parsed body or null.
 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) return null
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {number} status - HTTP status.
 * @param {object} payload - JSON payload.
 * @returns {void}
 */
function writeJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': String(Buffer.byteLength(body)),
  })
  res.end(body)
}
