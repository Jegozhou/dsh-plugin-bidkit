/**
 * Durable project store.
 *
 * The source of truth is the filesystem, never plugin memory: one directory per
 * bid project, `project.json` as the index and `sections/<id>.md` as the body.
 * That keeps very long documents out of the Host heap, makes every write
 * resumable after a crash or a session restart (the next tool call reads the
 * same directory), and lets the workbench read the same bytes the agent wrote.
 *
 * Writes are atomic: `writeFile(tmp)` then `rename(tmp, target)`, so an
 * interrupted write can only leave the previous revision intact.
 *
 * @module lib/store
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'

/** File that holds the project index. */
export const PROJECT_FILE = 'project.json'
/** Directory holding one markdown file per section. */
export const SECTION_DIR = 'sections'

/**
 * Error with a stable machine-readable code, returned to the model verbatim.
 */
export class StoreError extends Error {
  /**
   * @param {string} code - stable code such as `project_not_found`.
   * @param {string} message - human-readable reason.
   * @param {Record<string, unknown>} [details] - extra evidence.
   */
  constructor(code, message, details) {
    super(message)
    this.name = 'StoreError'
    this.code = code
    this.details = details
  }
}

/**
 * Turn arbitrary text into a safe single path segment.
 * @param {string} value - raw user input.
 * @returns {string} lowercase slug made of `[a-z0-9-]`.
 */
export function slugify(value) {
  const ascii = String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  const readable = ascii.replace(/[^a-z0-9-]+/gu, '').replace(/-{2,}/gu, '-').replace(/^-+|-+$/gu, '')
  return (/[a-z0-9]/u.test(readable) ? readable : `p-${randomUUID().slice(0, 8)}`).slice(0, 48)
}

/**
 * Count document words the way a Chinese bid reviewer does: every CJK
 * ideograph counts as one word, a run of latin/digit characters counts as one.
 * @param {string} text - markdown body.
 * @returns {number} word count.
 */
export function countWords(text) {
  const body = String(text ?? '')
  const cjk = body.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu)
  const latin = body.replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu, ' ').match(/[A-Za-z0-9][A-Za-z0-9._%+-]*/gu)
  return (cjk?.length ?? 0) + (latin?.length ?? 0)
}

/** One bid project store bound to a root directory. */
export class BidStore {
  /**
   * @param {{ root: string }} options - `root` is the absolute projects directory.
   */
  constructor(options) {
    this.root = resolve(options.root)
  }

  /**
   * Ensure the projects root exists.
   * @returns {Promise<void>} resolves once the directory is usable.
   */
  async ready() {
    await mkdir(this.root, { recursive: true })
  }

  /**
   * Absolute directory of one project.
   * @param {string} id - project id.
   * @returns {string} directory path.
   */
  dir(id) {
    return join(this.root, assertSegment(id, 'project id'))
  }

  /**
   * Fail unless a project directory exists.
   * @param {string} id - project id.
   * @returns {Promise<string>} project directory.
   */
  async requireDir(id) {
    const dir = this.dir(id)
    const info = await stat(dir).catch(() => null)
    if (info === null || !info.isDirectory()) {
      throw new StoreError('project_not_found', `bid project "${id}" does not exist under ${this.root}`)
    }
    return dir
  }

  /**
   * List every project index, newest first.
   * @returns {Promise<object[]>} project indexes.
   */
  async list() {
    await this.ready()
    const entries = await readdir(this.root, { withFileTypes: true })
    const projects = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const index = await this.read(entry.name).catch(() => null)
      if (index !== null) projects.push(index)
    }
    projects.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    return projects
  }

  /**
   * Read one project index.
   * @param {string} id - project id.
   * @returns {Promise<object>} parsed index.
   */
  async read(id) {
    const dir = await this.requireDir(id)
    const text = await readFile(join(dir, PROJECT_FILE), 'utf8')
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new StoreError('project_corrupt', `project.json of "${id}" is not valid JSON: ${messageOf(error)}`)
    }
  }

  /**
   * Write one project index atomically.
   * @param {object} index - complete index document.
   * @returns {Promise<object>} the written index.
   */
  async write(index) {
    const dir = this.dir(index.id)
    await mkdir(join(dir, SECTION_DIR), { recursive: true })
    await mkdir(join(dir, 'figures'), { recursive: true })
    await mkdir(join(dir, 'exports'), { recursive: true })
    await mkdir(join(dir, 'tender'), { recursive: true })
    const next = { ...index, updatedAt: new Date().toISOString() }
    await atomicWrite(join(dir, PROJECT_FILE), `${JSON.stringify(next, null, 2)}\n`)
    return next
  }

  /**
   * Create a project directory and its empty index.
   * @param {{ id: string, name: string, tenderNo?: string }} input - identity of the project.
   * @returns {Promise<object>} the new index.
   */
  async create(input) {
    const id = assertSegment(input.id, 'project id')
    const dir = this.dir(id)
    const existing = await stat(dir).catch(() => null)
    if (existing !== null) throw new StoreError('project_exists', `bid project "${id}" already exists`)
    const now = new Date().toISOString()
    /** @type {object} */
    const index = {
      schemaVersion: 1,
      id,
      name: input.name,
      tenderNo: input.tenderNo ?? '',
      createdAt: now,
      updatedAt: now,
      tender: { title: input.name, sourceFile: '', sectionCount: 0, importedAt: null },
      parse: emptyParse(),
      facts: [],
      outline: { nodes: [], plannedAt: null, targetWords: 0 },
      sections: {},
      figures: [],
      kb: [],
      review: null,
      exports: [],
      history: [],
    }
    return this.write(index)
  }

  /**
   * Read one section body.
   * @param {string} id - project id.
   * @param {string} sectionId - section id.
   * @returns {Promise<string>} markdown body (empty when never written).
   */
  async readSection(id, sectionId) {
    const dir = await this.requireDir(id)
    const file = join(dir, SECTION_DIR, `${assertSegment(sectionId, 'section id')}.md`)
    return readFile(file, 'utf8').catch(error => {
      if (error && error.code === 'ENOENT') return ''
      throw error
    })
  }

  /**
   * Write one section body atomically.
   * @param {string} id - project id.
   * @param {string} sectionId - section id.
   * @param {string} markdown - body.
   * @returns {Promise<string>} absolute file path.
   */
  async writeSection(id, sectionId, markdown) {
    const dir = await this.requireDir(id)
    const target = join(dir, SECTION_DIR, `${assertSegment(sectionId, 'section id')}.md`)
    await mkdir(dirname(target), { recursive: true })
    await atomicWrite(target, markdown)
    return target
  }

  /**
   * Write a figure asset (SVG) and return its file name.
   * @param {string} id - project id.
   * @param {string} figureId - figure id.
   * @param {string} svg - SVG source.
   * @returns {Promise<string>} file name relative to `figures/`.
   */
  async writeFigure(id, figureId, svg) {
    const dir = await this.requireDir(id)
    const file = `${assertSegment(figureId, 'figure id')}.svg`
    await atomicWrite(join(dir, 'figures', file), svg)
    return file
  }

  /**
   * Read a figure asset.
   * @param {string} id - project id.
   * @param {string} figureId - figure id.
   * @returns {Promise<string>} SVG source.
   */
  async readFigure(id, figureId) {
    const dir = await this.requireDir(id)
    return readFile(join(dir, 'figures', `${assertSegment(figureId, 'figure id')}.svg`), 'utf8')
  }

  /**
   * Copy the imported tender document into the project for provenance.
   * @param {string} id - project id.
   * @param {string} text - raw document text.
   * @returns {Promise<void>} resolves after the copy is durable.
   */
  async writeTenderSource(id, text) {
    const dir = await this.requireDir(id)
    await atomicWrite(join(dir, 'tender', 'source.md'), text)
  }

  /**
   * Read the imported tender document.
   * @param {string} id - project id.
   * @returns {Promise<string>} raw document text.
   */
  async readTenderSource(id) {
    const dir = await this.requireDir(id)
    return readFile(join(dir, 'tender', 'source.md'), 'utf8')
  }

  /**
   * Absolute path inside a project, refusing traversal.
   * @param {string} id - project id.
   * @param {string} rel - relative path segments.
   * @returns {Promise<string>} absolute path.
   */
  async path(id, rel) {
    const dir = await this.requireDir(id)
    const target = resolve(dir, ...rel.split('/').filter(Boolean))
    const root = resolve(dir)
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      throw new StoreError('path_escape', `path "${rel}" escapes project "${id}"`)
    }
    return target
  }

  /**
   * Write an .docx export and return its file name.
   * @param {string} id - project id.
   * @param {string} name - file base name.
   * @param {Uint8Array} bytes - document bytes.
   * @returns {Promise<string>} file name inside `exports/`.
   */
  async writeExport(id, name, bytes) {
    const dir = await this.requireDir(id)
    const file = `${assertFileName(name)}.docx`
    await atomicWrite(join(dir, 'exports', file), bytes)
    return file
  }

  /**
   * Remove a project directory.
   * @param {string} id - project id.
   * @returns {Promise<void>} resolves after removal.
   */
  async remove(id) {
    const dir = await this.requireDir(id)
    await rm(dir, { recursive: true, force: true })
  }

  /**
   * Read every section body of a project in outline order.
   * @param {object} index - project index.
   * @returns {Promise<Array<{ id: string, title: string, level: number, markdown: string }>>} bodies.
   */
  async readAllSections(index) {
    const ordered = flattenOutline(index.outline?.nodes ?? [])
    const result = []
    for (const node of ordered) {
      const markdown = await this.readSection(index.id, node.id)
      result.push({ id: node.id, title: node.title, level: node.level, markdown })
    }
    return result
  }
}

/**
 * Write bytes through a temporary file, then rename over the target.
 * @param {string} target - absolute destination.
 * @param {string|Uint8Array} data - content.
 * @returns {Promise<void>} resolves after the rename.
 */
export async function atomicWrite(target, data) {
  const temp = `${target}.${randomUUID().slice(0, 8)}.tmp`
  await writeFile(temp, data)
  await rename(temp, target)
}

/**
 * Flatten a nested outline into depth-first order.
 * @param {Array<object>} nodes - outline nodes with optional `children`.
 * @returns {Array<object>} flat nodes.
 */
export function flattenOutline(nodes) {
  const flat = []
  const visit = list => {
    for (const node of list ?? []) {
      flat.push(node)
      visit(node.children)
    }
  }
  visit(nodes)
  return flat
}

/**
 * Empty parse document.
 * @returns {object} parse skeleton.
 */
export function emptyParse() {
  return {
    parsedAt: null,
    coverage: { filled: 0, total: 18 },
    items: [],
    starClauses: [],
    scoring: { technical: [], commercial: [], price: [] },
    lots: [],
    responseMatrix: [],
  }
}

/**
 * Reject a value that is not a safe single path segment.
 * @param {string} value - candidate.
 * @param {string} label - field name for the error.
 * @returns {string} the validated segment.
 */
export function assertSegment(value, label) {
  const text = String(value ?? '')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(text)) {
    throw new StoreError('invalid_id', `${label} "${text}" must match [A-Za-z0-9][A-Za-z0-9._-]*`)
  }
  return text
}

/**
 * Validate a human-facing file base name (Chinese is allowed; traversal is not).
 * @param {string} value - candidate base name.
 * @returns {string} safe base name.
 */
export function assertFileName(value) {
  const text = String(value ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_').replace(/^\.+/u, '').trim()
  if (text === '' || text.length > 120 || text.includes('..')) {
    throw new StoreError('invalid_id', `文件名 "${String(value ?? '')}" 不合法`)
  }
  return text
}

/**
 * Relative path helper for diagnostics.
 * @param {string} root - base directory.
 * @param {string} target - absolute path.
 * @returns {string} relative path.
 */
export function displayPath(root, target) {
  return relative(root, target) || '.'
}

/**
 * Extract a message from an unknown error.
 * @param {unknown} error - thrown value.
 * @returns {string} message.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
