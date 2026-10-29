/**
 * BidKit runtime — the single implementation every surface shares.
 *
 * Both the agent tools and the workbench HTTP API call this class, so the model
 * and the person always see and change the same bytes. Nothing here holds
 * project state in memory: each operation reads `project.json` and the section
 * files it needs, then writes atomically. An interruption between any two calls
 * is therefore fully recoverable — the next call continues from disk, which is
 * what makes million-word bids practical.
 *
 * @module lib/runtime
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { BidStore, StoreError, countWords, flattenOutline, slugify } from './store.js'
import { TENDER_ITEMS, extractDocumentText, parseTender } from './parse.js'
import { planHandoff, planOutline, sumWords } from './outline.js'
import { indexKnowledgeBase, searchKb } from './kb.js'
import { createFigure } from './figure.js'
import { runReview } from './review.js'

/** Version reported by tools and the health route. */
export const VERSION = '0.1.0'

/** Statuses allowed on one structured item. */
const ITEM_STATUS = new Set(['filled', 'partial', 'missing'])

/** One bid project runtime. */
export class BidRuntime {
  /**
   * @param {{ root: string, allowWrite: boolean, defaultTargetWords: number, kbDir: string|null, logger?: (message: string, error?: unknown) => void }} options - resolved settings.
   */
  constructor(options) {
    this.store = new BidStore({ root: options.root })
    this.allowWrite = options.allowWrite
    this.defaultTargetWords = options.defaultTargetWords
    this.kbDir = options.kbDir
    this.log = options.logger ?? (() => undefined)
  }

  /**
   * Assert the plugin is allowed to modify projects.
   * @returns {void}
   * @throws {StoreError} when writes are disabled.
   */
  requireWrite() {
    if (!this.allowWrite) {
      throw new StoreError('read_only', 'BidKit 当前配置 allowWrite=false，所有写入操作被拒绝')
    }
  }

  /**
   * Create a project, optionally importing a tender document in the same call.
   * @param {{ name: string, id?: string, tenderPath?: string, tenderText?: string, tenderNo?: string }} input - creation input.
   * @returns {Promise<object>} the new index plus an import summary.
   */
  async createProject(input) {
    this.requireWrite()
    const name = String(input.name ?? '').trim()
    if (name === '') throw new StoreError('invalid_argument', '项目名称 name 不能为空')
    const id = input.id === undefined || input.id === '' ? uniqueId(slugify(name)) : String(input.id)
    let index = await this.store.create({ id, name, tenderNo: input.tenderNo ?? '' })
    this.log(`created project ${id}`)
    let imported = null
    if (input.tenderPath !== undefined && input.tenderPath !== '') {
      imported = await this.importTender(id, { path: input.tenderPath })
      index = await this.store.read(id)
    } else if (input.tenderText !== undefined && String(input.tenderText).trim() !== '') {
      imported = await this.importTender(id, { text: String(input.tenderText), filename: 'inline.md' })
      index = await this.store.read(id)
    }
    return { project: index, imported }
  }

  /**
   * Import (or replace) the tender document of a project.
   * @param {string} id - project id.
   * @param {{ path?: string, text?: string, filename?: string }} input - source document.
   * @returns {Promise<object>} import summary.
   */
  async importTender(id, input) {
    this.requireWrite()
    await this.store.requireDir(id)
    let text = ''
    let filename = input.filename ?? 'inline.md'
    if (input.path !== undefined && input.path !== '') {
      const absolute = isAbsolute(input.path) ? input.path : resolve(input.path)
      const info = await stat(absolute).catch(() => null)
      if (info === null) throw new StoreError('file_not_found', `招标文件不存在：${absolute}`)
      filename = basename(absolute)
      const bytes = await readFile(absolute)
      const extracted = extractDocumentText(filename, bytes)
      text = extracted.text
      filename = `${basename(filename, extname(filename))}.${extracted.format === 'docx' ? 'docx' : 'md'}`
    } else {
      text = String(input.text ?? '')
    }
    if (text.trim() === '') throw new StoreError('empty_document', '招标文件内容为空，无法解析')
    await this.store.writeTenderSource(id, text)
    const index = await this.store.read(id)
    const parsed = parseTender(text)
    const next = {
      ...index,
      tender: {
        title: guessTitle(text, filename),
        sourceFile: filename,
        sectionCount: parsed.sectionCount,
        importedAt: new Date().toISOString(),
        chars: text.length,
      },
      parse: parsed,
    }
    await this.store.write(next)
    return {
      project: id,
      file: filename,
      chars: text.length,
      sections: parsed.sectionCount,
      coverage: parsed.coverage,
      starClauses: parsed.starClauses.length,
      scoring: {
        technical: parsed.scoring.technical.length,
        commercial: parsed.scoring.commercial.length,
        price: parsed.scoring.price.length,
      },
      missingItems: parsed.items.filter(item => item.status === 'missing').map(item => item.label),
    }
  }

  /**
   * Re-run the deterministic parse on the stored tender source.
   * @param {string} id - project id.
   * @returns {Promise<object>} parse summary.
   */
  async reparse(id) {
    this.requireWrite()
    const text = await this.store.readTenderSource(id)
    const index = await this.store.read(id)
    const parsed = parseTender(text)
    await this.store.write({ ...index, parse: parsed })
    return summarizeParse(parsed)
  }

  /**
   * Merge a model-authored parse into the deterministic skeleton.
   *
   * The model may correct values and add clauses, but coverage is re-measured:
   * an item claimed `filled` without a non-empty value is downgraded, and an
   * evidence quote that does not occur in the tender source is marked unverified.
   * @param {string} id - project id.
   * @param {object} patch - `{ items?, starClauses?, scoring?, lots?, responseMatrix? }`.
   * @returns {Promise<object>} the merged parse summary.
   */
  async commitParse(id, patch) {
    this.requireWrite()
    const index = await this.store.read(id)
    const source = await this.store.readTenderSource(id).catch(() => '')
    const current = index.parse ?? parseTender(source)
    const next = {
      ...current,
      parsedAt: new Date().toISOString(),
      items: mergeItems(current.items, patch.items, source),
      starClauses: mergeClauses(current.starClauses, patch.starClauses),
      scoring: mergeScoring(current.scoring, patch.scoring),
      lots: Array.isArray(patch.lots) ? patch.lots.slice(0, 40) : current.lots,
      responseMatrix: mergeMatrix(current.responseMatrix, patch.responseMatrix),
    }
    next.coverage = {
      filled: next.items.filter(item => item.status === 'filled').length,
      total: TENDER_ITEMS.length,
    }
    const written = await this.store.write({ ...index, parse: next })
    return { ...summarizeParse(written.parse), committed: true }
  }

  /**
   * Lock the global facts every chapter must agree with.
   * @param {string} id - project id.
   * @param {Array<{ key: string, value: string, source?: string }>} facts - facts to lock.
   * @param {{ replace?: boolean }} [options] - replace the whole set.
   * @returns {Promise<object[]>} the locked set.
   */
  async lockFacts(id, facts, options = {}) {
    this.requireWrite()
    const index = await this.store.read(id)
    const now = new Date().toISOString()
    const incoming = (facts ?? []).map(fact => ({
      key: String(fact.key ?? '').trim(),
      value: String(fact.value ?? '').trim(),
      source: String(fact.source ?? '').trim(),
      lockedAt: now,
    })).filter(fact => fact.key !== '' && fact.value !== '')
    if (incoming.length === 0) throw new StoreError('invalid_argument', 'facts 不能为空：至少提供一条 { key, value }')
    const merged = options.replace === true ? [] : [...(index.facts ?? [])]
    for (const fact of incoming) {
      const position = merged.findIndex(entry => entry.key === fact.key)
      if (position >= 0) merged[position] = fact
      else merged.push(fact)
    }
    await this.store.write({ ...index, facts: merged })
    return merged
  }

  /**
   * Plan and persist a score-aligned outline.
   * @param {string} id - project id.
   * @param {{ totalWords?: number }} [options] - sizing.
   * @returns {Promise<object>} outline summary.
   */
  async planOutline(id, options = {}) {
    this.requireWrite()
    const index = await this.store.read(id)
    const plan = planOutline(index.parse ?? {}, {
      totalWords: options.totalWords ?? this.defaultTargetWords * 40,
      defaultTargetWords: this.defaultTargetWords,
    })
    const outline = {
      nodes: plan.nodes,
      targetWords: plan.targetWords,
      perPoint: plan.perPoint,
      plannedAt: plan.plannedAt,
      rationale: plan.rationale,
    }
    const sections = {}
    for (const node of flattenOutline(plan.nodes)) {
      sections[node.id] = {
        id: node.id,
        title: node.title,
        level: node.level,
        words: 0,
        status: 'pending',
        updatedAt: null,
      }
    }
    await this.store.write({ ...index, outline, sections })
    return {
      targetWords: outline.targetWords,
      perPoint: outline.perPoint,
      chapters: plan.nodes.map(node => ({
        id: node.id,
        title: node.title,
        wordTarget: node.wordTarget,
        scoreRefs: node.scoreRefs.length,
        starRefs: node.starRefs.length,
        children: (node.children ?? []).map(child => ({ id: child.id, title: child.title, wordTarget: child.wordTarget })),
      })),
      rationale: plan.rationale,
    }
  }

  /**
   * Replace the outline with a model-authored tree (validated and normalized).
   * @param {string} id - project id.
   * @param {object[]} nodes - nested outline nodes.
   * @returns {Promise<object>} outline summary.
   */
  async setOutline(id, nodes) {
    this.requireWrite()
    const index = await this.store.read(id)
    const normalized = normalizeOutline(nodes ?? [])
    if (normalized.length === 0) throw new StoreError('invalid_argument', 'nodes 不能为空')
    const sections = {}
    for (const node of flattenOutline(normalized)) {
      const previous = index.sections?.[node.id]
      sections[node.id] = {
        id: node.id,
        title: node.title,
        level: node.level,
        words: previous?.words ?? 0,
        status: previous?.status ?? 'pending',
        updatedAt: previous?.updatedAt ?? null,
      }
    }
    const outline = { ...index.outline, nodes: normalized, targetWords: sumWords(normalized), plannedAt: new Date().toISOString(), source: 'model' }
    await this.store.write({ ...index, outline, sections })
    return { targetWords: outline.targetWords, sections: Object.keys(sections).length }
  }

  /**
   * Write or append one section body.
   * @param {string} id - project id.
   * @param {string} sectionId - section id.
   * @param {string} markdown - body.
   * @param {'replace'|'append'} [mode] - write mode.
   * @returns {Promise<object>} section summary with anchoring warnings.
   */
  async writeSection(id, sectionId, markdown, mode = 'replace') {
    this.requireWrite()
    const index = await this.store.read(id)
    const node = flattenOutline(index.outline?.nodes ?? []).find(entry => entry.id === sectionId)
    if (node === undefined) {
      throw new StoreError('section_not_found', `章节 ${sectionId} 不在当前目录中；请先 bid_outline_plan 或使用正确 id`)
    }
    const body = String(markdown ?? '')
    if (body.trim() === '') throw new StoreError('invalid_argument', 'markdown 不能为空')
    const previous = await this.store.readSection(id, sectionId)
    const nextBody = mode === 'append' && previous.trim() !== '' ? `${previous.replace(/\s+$/u, '')}\n\n${body}` : body
    await this.store.writeSection(id, sectionId, nextBody)
    const words = countWords(nextBody)
    const target = Number(node.wordTarget) || 0
    const status = target > 0 && words >= target * 0.6 ? 'done' : 'writing'
    const sections = { ...(index.sections ?? {}) }
    sections[sectionId] = { id: sectionId, title: node.title, level: node.level, words, status, updatedAt: new Date().toISOString() }
    updateNodeStatus(index.outline?.nodes ?? [], sectionId, status)
    const anchoring = checkAnchoring(nextBody, index.facts ?? [])
    await this.store.write({ ...index, sections })
    return {
      sectionId,
      title: node.title,
      words,
      target,
      status,
      anchoring,
      figures: (index.figures ?? []).filter(figure => figure.sectionId === sectionId).map(figure => figure.id),
    }
  }

  /**
   * Read one section body plus metadata.
   * @param {string} id - project id.
   * @param {string} sectionId - section id.
   * @returns {Promise<object>} section view.
   */
  async readSection(id, sectionId) {
    const index = await this.store.read(id)
    const node = flattenOutline(index.outline?.nodes ?? []).find(entry => entry.id === sectionId)
    if (node === undefined) throw new StoreError('section_not_found', `章节 ${sectionId} 不存在`)
    const markdown = await this.store.readSection(id, sectionId)
    return {
      id: sectionId,
      title: node.title,
      level: node.level,
      wordTarget: node.wordTarget,
      markdown,
      words: countWords(markdown),
      status: index.sections?.[sectionId]?.status ?? 'pending',
      figures: (index.figures ?? []).filter(figure => figure.sectionId === sectionId),
    }
  }

  /**
   * Render and register a figure for a section.
   * @param {string} id - project id.
   * @param {{ sectionId: string, kind: string, source?: string, steps?: object[], layers?: object[], title?: string }} input - figure input.
   * @returns {Promise<object>} figure record.
   */
  async addFigure(id, input) {
    this.requireWrite()
    const index = await this.store.read(id)
    const sectionId = String(input.sectionId ?? '')
    const node = flattenOutline(index.outline?.nodes ?? []).find(entry => entry.id === sectionId)
    if (node === undefined) throw new StoreError('section_not_found', `章节 ${sectionId} 不存在，无法挂图`)
    const figureId = uniqueFigureId(index.figures ?? [], sectionId)
    const rendered = createFigure({
      kind: String(input.kind ?? 'mermaid'),
      source: input.source,
      steps: input.steps,
      layers: input.layers,
      title: input.title,
    }, { title: input.title })
    await this.store.writeFigure(id, figureId, rendered.svg)
    const record = {
      id: figureId,
      title: String(input.title ?? node.title).slice(0, 80),
      kind: rendered.kind,
      sectionId,
      file: `${figureId}.svg`,
      w: rendered.width,
      h: rendered.height,
      model: rendered.model,
      createdAt: new Date().toISOString(),
    }
    await this.store.write({ ...index, figures: [...(index.figures ?? []), record] })
    return {
      figureId,
      sectionId,
      url: `/dsh-plugin-bidkit/api/projects/${id}/figures/${figureId}.svg`,
      token: `[[figure:${figureId}]]`,
      width: rendered.width,
      height: rendered.height,
      bytes: rendered.svg.length,
    }
  }

  /**
   * Run the compliance review, optionally against another bid.
   * @param {string} id - project id.
   * @param {{ compareWith?: string }} [options] - collusion comparison.
   * @returns {Promise<object>} review document.
   */
  async review(id, options = {}) {
    const index = await this.store.read(id)
    const bodies = await this.readBodies(index)
    let compare
    if (options.compareWith !== undefined && options.compareWith !== '') {
      const other = await this.store.read(options.compareWith).catch(() => null)
      if (other === null) throw new StoreError('project_not_found', `对比项目 ${options.compareWith} 不存在`)
      compare = { id: other.id, name: other.name, bodies: await this.readBodies(other) }
    }
    const review = runReview(index, bodies, { compare })
    await this.store.write({ ...index, review })
    return review
  }

  /**
   * Export the project to `.docx`.
   * @param {string} id - project id.
   * @param {{ outPath?: string, filename?: string }} [options] - export target.
   * @returns {Promise<object>} export summary.
   */
  async exportDocx(id, options = {}) {
    this.requireWrite()
    const index = await this.store.read(id)
    const bodies = await this.readBodies(index)
    if (Object.values(bodies).every(text => text.trim() === '')) {
      throw new StoreError('empty_document', '所有章节均为空，拒绝导出空标书')
    }
    const { buildDocx } = await import('./docx.js')
    const model = buildDocxModel(index, bodies)
    // Hydrate each figure with its rendered SVG so the exporter can rebuild it
    // as native Word shapes (vector text, no rasterization).
    for (const section of model.sections) {
      for (const figure of section.figures) {
        figure.svg = await this.store.readFigure(id, figure.id).catch(() => '')
      }
    }
    const result = await buildDocx(model)
    const filename = sanitizeFilename(options.filename ?? `${index.name}-投标文件-${dateStamp()}`)
    const file = await this.store.writeExport(id, filename, result.buffer)
    const relative = join('exports', file)
    let copied = null
    if (options.outPath !== undefined && options.outPath !== '') {
      const target = isAbsolute(options.outPath) ? options.outPath : resolve(options.outPath)
      await import('node:fs/promises').then(({ writeFile }) => writeFile(target, result.buffer))
      copied = target
    }
    const entry = {
      file,
      at: new Date().toISOString(),
      bytes: result.buffer.byteLength ?? result.buffer.length,
      sections: model.sections.length,
      words: model.sections.reduce((total, section) => total + countWords(section.markdown), 0),
      warnings: result.warnings ?? [],
    }
    await this.store.write({ ...index, exports: [entry, ...(index.exports ?? [])].slice(0, 20) })
    return { ...entry, path: join(this.store.dir(id), relative), exportedTo: copied }
  }

  /**
   * Build the compact status view used by tools and the workbench.
   * @param {string} id - project id.
   * @returns {Promise<object>} status.
   */
  async status(id) {
    const index = await this.store.read(id)
    const nodes = flattenOutline(index.outline?.nodes ?? [])
    // A level-1 chapter with children is a structural container: its heading is
    // emitted by the exporter, it is not expected to carry a separate body.
    // Progress is therefore measured over content-bearing (leaf) sections only.
    const leaves = nodes.filter(node => (node.children ?? []).length === 0)
    const writtenNodes = leaves.filter(node => (index.sections?.[node.id]?.words ?? 0) > 0)
    const words = writtenNodes.reduce((total, node) => total + (index.sections?.[node.id]?.words ?? 0), 0)
    const review = index.review ?? null
    return {
      project: { id: index.id, name: index.name, updatedAt: index.updatedAt },
      tender: index.tender,
      parse: {
        coverage: index.parse?.coverage ?? { filled: 0, total: TENDER_ITEMS.length },
        stars: (index.parse?.starClauses ?? []).length,
        scoring: {
          technical: index.parse?.scoring?.technical?.length ?? 0,
          commercial: index.parse?.scoring?.commercial?.length ?? 0,
          price: index.parse?.scoring?.price?.length ?? 0,
        },
      },
      facts: (index.facts ?? []).length,
      outline: { sections: nodes.length, contentSections: leaves.length, targetWords: index.outline?.targetWords ?? 0 },
      writing: {
        totalSections: leaves.length,
        writtenSections: writtenNodes.length,
        pendingSections: leaves.length - writtenNodes.length,
        words,
        progress: leaves.length === 0 ? 0 : Number((writtenNodes.length / leaves.length).toFixed(3)),
        nextSections: leaves.filter(node => (index.sections?.[node.id]?.words ?? 0) === 0).slice(0, 6).map(node => ({ id: node.id, title: node.title, wordTarget: node.wordTarget })),
      },
      figures: (index.figures ?? []).length,
      review: review === null ? null : { runAt: review.runAt, summary: review.summary },
      exports: (index.exports ?? []).slice(0, 3),
    }
  }

  /**
   * Plan parallel authoring batches for subagents.
   * @param {string} id - project id.
   * @param {{ batchSize?: number, sectionIds?: string[] }} [options] - batch options.
   * @returns {Promise<object>} hand-off plan.
   */
  async handoff(id, options = {}) {
    const index = await this.store.read(id)
    return planHandoff(index, options)
  }

  /**
   * Build or rebuild the project knowledge base.
   * @param {string} id - project id.
   * @param {{ dirs?: string[] }} [options] - extra source directories.
   * @returns {Promise<object>} index summary.
   */
  async indexKb(id, options = {}) {
    this.requireWrite()
    const dirs = [...(options.dirs ?? [])]
    if (this.kbDir !== null) dirs.push(this.kbDir)
    const projectKb = join(this.store.dir(id), 'kb', 'source')
    dirs.push(projectKb)
    const summary = await indexKnowledgeBase(this.store, id, { dirs })
    const index = await this.store.read(id)
    await this.store.write({ ...index, kb: summary.sources })
    return summary
  }

  /**
   * Search the project knowledge base.
   * @param {string} id - project id.
   * @param {string} query - query text.
   * @param {{ limit?: number, file?: string }} [options] - result options.
   * @returns {Promise<object>} hits.
   */
  async searchKb(id, query, options = {}) {
    return searchKb(this.store, id, query, options)
  }

  /**
   * Read every section body keyed by id.
   * @param {object} index - project index.
   * @returns {Promise<Record<string, string>>} bodies.
   */
  async readBodies(index) {
    const bodies = {}
    for (const node of flattenOutline(index.outline?.nodes ?? [])) {
      bodies[node.id] = await this.store.readSection(index.id, node.id)
    }
    return bodies
  }
}

/**
 * Build the docx exporter model from the project index and bodies.
 * @param {object} index - project index.
 * @param {Record<string, string>} bodies - section bodies.
 * @returns {object} exporter model (see docs/CONTRACT.md §3).
 */
export function buildDocxModel(index, bodies) {
  const nodes = flattenOutline(index.outline?.nodes ?? [])
  const figures = index.figures ?? []
  const hasContent = node => (bodies[node.id] ?? '').trim() !== '' || (node.children ?? []).some(hasContent)
  const sections = nodes
    .filter(node => hasContent(node))
    .map(node => ({
      id: node.id,
      title: node.title,
      level: node.level,
      markdown: bodies[node.id],
      figures: figures
        .filter(figure => figure.sectionId === node.id)
        .map(figure => ({
          id: figure.id,
          // The exporter numbers captions itself ("图 N 标题"); drop a leading
          // "图 X" from the stored title so the caption is not doubled.
          title: String(figure.title).replace(/^图\s*\d+[\.、:：]?\s*/u, ''),
          svg: '',
          model: figure.model,
        })),
    }))
  const bidder = (index.facts ?? []).find(fact => /公司|单位|名称/u.test(fact.key))?.value ?? ''
  return {
    meta: {
      title: index.tender?.title ?? index.name,
      subtitle: '投标文件',
      tenderNo: index.tenderNo ?? '',
      bidder,
      date: new Date().toISOString().slice(0, 10),
    },
    cover: {
      enabled: true,
      projectName: index.tender?.title ?? index.name,
      bidder,
      date: new Date().toISOString().slice(0, 10),
      tenderNo: index.tenderNo ?? '',
    },
    toc: { enabled: true, maxLevel: 3 },
    header: { text: `${index.name} 投标文件` },
    footer: { pageNumber: true },
    facts: (index.facts ?? []).map(fact => ({ key: fact.key, value: fact.value })),
    sections,
  }
}

/**
 * Report which locked facts a freshly written body contains or misses.
 * @param {string} text - section body.
 * @param {Array<{ key: string, value: string }>} facts - locked facts.
 * @returns {{ used: string[], missing: string[] }} anchoring report.
 */
export function checkAnchoring(text, facts) {
  const used = []
  const missing = []
  for (const fact of facts) {
    if (String(text).includes(String(fact.value))) used.push(fact.key)
    else missing.push(fact.key)
  }
  return { used, missing }
}

/**
 * Merge model-authored items into the parser skeleton.
 * @param {object[]} current - parser items.
 * @param {object[]|undefined} patch - model items.
 * @param {string} source - tender source for evidence verification.
 * @returns {object[]} merged items.
 */
function mergeItems(current, patch, source) {
  const base = new Map((current ?? []).map(item => [item.key, item]))
  if (!Array.isArray(patch)) return current ?? []
  const merged = []
  for (const spec of TENDER_ITEMS) {
    const previous = base.get(spec.key) ?? {
      key: spec.key, label: spec.label, status: 'missing', risk: spec.risk, value: '', evidence: [], sectionId: null,
    }
    const update = patch.find(entry => entry !== null && typeof entry === 'object' && entry.key === spec.key)
    if (update === undefined) {
      merged.push(previous)
      continue
    }
    const value = String(update.value ?? previous.value ?? '').trim()
    let status = ITEM_STATUS.has(update.status) ? update.status : previous.status
    if (status === 'filled' && value === '') status = previous.evidence?.length > 0 ? 'partial' : 'missing'
    const evidence = Array.isArray(update.evidence) && update.evidence.length > 0
      ? update.evidence.slice(0, 6).map(entry => ({
        sectionId: String(entry.sectionId ?? previous.sectionId ?? ''),
        sectionTitle: String(entry.sectionTitle ?? ''),
        quote: String(entry.quote ?? '').slice(0, 500),
        verified: String(entry.quote ?? '') === '' ? false : source.includes(String(entry.quote ?? '').slice(0, 40)),
      }))
      : previous.evidence
    merged.push({
      key: spec.key,
      label: spec.label,
      status,
      risk: ['low', 'medium', 'high'].includes(update.risk) ? update.risk : previous.risk,
      value: value === '' ? previous.value : value,
      evidence,
      sectionId: update.sectionId ?? previous.sectionId ?? null,
    })
  }
  return merged
}

/**
 * Merge model-authored material clauses.
 * @param {object[]} current - parser clauses.
 * @param {object[]|undefined} patch - model clauses.
 * @returns {object[]} merged clauses.
 */
function mergeClauses(current, patch) {
  if (!Array.isArray(patch) || patch.length === 0) return current ?? []
  const merged = [...(current ?? [])]
  const seen = new Set(merged.map(clause => String(clause.text).replace(/\s+/gu, '')))
  for (const clause of patch) {
    const text = String(clause.text ?? '').trim()
    if (text === '') continue
    const key = text.replace(/\s+/gu, '')
    if (seen.has(key)) continue
    seen.add(key)
    merged.push({
      id: String(clause.id ?? `star-${merged.length + 1}`),
      text: text.slice(0, 500),
      category: String(clause.category ?? '其他实质性'),
      strategy: String(clause.strategy ?? '逐条正面响应并附证明索引'),
      sectionId: String(clause.sectionId ?? ''),
      sectionTitle: String(clause.sectionTitle ?? ''),
    })
  }
  return merged
}

/**
 * Merge model-authored scoring buckets.
 * @param {{technical: object[], commercial: object[], price: object[]}} current - parser scoring.
 * @param {{technical?: object[], commercial?: object[], price?: object[]}} patch - model scoring.
 * @returns {{technical: object[], commercial: object[], price: object[]}} merged scoring.
 */
function mergeScoring(current, patch) {
  const bucketOf = value => (Array.isArray(value)
    ? value.filter(entry => entry !== null && typeof entry === 'object').map(entry => ({
      item: String(entry.item ?? '').slice(0, 120),
      maxScore: Number(entry.maxScore) || 0,
      criteria: String(entry.criteria ?? '').slice(0, 400),
      sectionId: String(entry.sectionId ?? ''),
    })).filter(entry => entry.item !== '')
    : null)
  return {
    technical: bucketOf(patch?.technical) ?? current?.technical ?? [],
    commercial: bucketOf(patch?.commercial) ?? current?.commercial ?? [],
    price: bucketOf(patch?.price) ?? current?.price ?? [],
  }
}

/**
 * Merge response-matrix mappings (the model only supplies section references).
 * @param {object[]} current - parser matrix.
 * @param {object[]|undefined} patch - model matrix rows.
 * @returns {object[]} merged matrix.
 */
function mergeMatrix(current, patch) {
  const rows = [...(current ?? [])]
  if (!Array.isArray(patch)) return rows
  for (const update of patch) {
    if (update === null || typeof update !== 'object') continue
    const row = update.id === undefined ? undefined : rows.find(entry => entry.id === update.id)
    const target = row ?? rows.find(entry => entry.requirement === update.requirement)
    if (target === undefined) continue
    if (update.sectionRef !== undefined) target.sectionRef = update.sectionRef === null ? null : String(update.sectionRef)
    if (update.status !== undefined) target.status = String(update.status)
    if (update.response !== undefined && String(update.response).trim() !== '') target.response = String(update.response).slice(0, 400)
  }
  return rows
}

/**
 * Normalize a model-authored outline tree.
 * @param {object[]} nodes - raw nodes.
 * @returns {object[]} normalized nodes.
 */
function normalizeOutline(nodes) {
  const seen = new Set()
  const visit = (list, level, prefix) => list.filter(node => node !== null && typeof node === 'object' && String(node.title ?? '').trim() !== '')
    .slice(0, 40)
    .map((node, index) => {
      const id = String(node.id ?? `${prefix}${index + 1}`)
      if (seen.has(id)) {
        const unique = `${prefix}${index + 1}-${seen.size}`
        seen.add(unique)
        return buildNode(node, unique, level, visit)
      }
      seen.add(id)
      return buildNode(node, id, level, visit)
    })
  return visit(nodes, 1, 'sec-')
}

/**
 * Build one normalized outline node.
 * @param {object} node - raw node.
 * @param {string} id - node id.
 * @param {number} level - level.
 * @param {Function} visit - recursion helper.
 * @returns {object} normalized node.
 */
function buildNode(node, id, level, visit) {
  return {
    id: /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id) ? id : `sec-${Math.abs(hash(id))}`,
    title: String(node.title).trim().slice(0, 80),
    level: Number.isFinite(Number(node.level)) ? Math.min(Math.max(Number(node.level), 1), 4) : level,
    wordTarget: Math.max(0, Math.trunc(Number(node.wordTarget) || 0)),
    status: ['pending', 'writing', 'done'].includes(node.status) ? node.status : 'pending',
    scoreRefs: Array.isArray(node.scoreRefs) ? node.scoreRefs.map(String).slice(0, 20) : [],
    starRefs: Array.isArray(node.starRefs) ? node.starRefs.map(String).slice(0, 20) : [],
    strategy: String(node.strategy ?? '').slice(0, 400),
    children: visit(node.children ?? [], level + 1, `${id}-`),
  }
}

/**
 * Update one node's status inside a nested outline.
 * @param {object[]} nodes - outline nodes.
 * @param {string} id - section id.
 * @param {string} status - new status.
 * @returns {boolean} whether the node was found.
 */
function updateNodeStatus(nodes, id, status) {
  for (const node of nodes ?? []) {
    if (node.id === id) {
      node.status = status
      return true
    }
    if (updateNodeStatus(node.children ?? [], id, status)) return true
  }
  return false
}

/**
 * Summarize a parse document for tool output.
 * @param {object} parse - parse document.
 * @returns {object} compact summary.
 */
function summarizeParse(parse) {
  return {
    coverage: parse.coverage,
    stars: (parse.starClauses ?? []).length,
    items: (parse.items ?? []).map(item => ({ key: item.key, label: item.label, status: item.status, risk: item.risk })),
    scoring: {
      technical: parse.scoring?.technical?.length ?? 0,
      commercial: parse.scoring?.commercial?.length ?? 0,
      price: parse.scoring?.price?.length ?? 0,
    },
    lots: (parse.lots ?? []).length,
    matrixRows: (parse.responseMatrix ?? []).length,
    missing: (parse.items ?? []).filter(item => item.status === 'missing').map(item => item.label),
    partial: (parse.items ?? []).filter(item => item.status === 'partial').map(item => item.label),
  }
}

/**
 * Guess a tender title from its text.
 * @param {string} text - document text.
 * @param {string} filename - source name.
 * @returns {string} title.
 */
function guessTitle(text, filename) {
  const firstHeading = /^#{1,2}\s+(.+)$/mu.exec(text)
  if (firstHeading !== null) return firstHeading[1].trim().slice(0, 80)
  const firstLine = text.split('\n').map(line => line.trim()).find(line => line.length >= 4)
  if (firstLine !== undefined) return firstLine.replace(/^[#\s]+/u, '').slice(0, 80)
  return basename(filename, extname(filename))
}

/**
 * Produce a unique project id.
 * @param {string} base - slug base.
 * @returns {string} unique id.
 */
function uniqueId(base) {
  return `${base}-${Date.now().toString(36).slice(-4)}`
}

/**
 * Produce a unique figure id for a section.
 * @param {object[]} figures - existing figures.
 * @param {string} sectionId - section id.
 * @returns {string} figure id.
 */
function uniqueFigureId(figures, sectionId) {
  const count = figures.filter(figure => figure.sectionId === sectionId).length + 1
  return `${sectionId}-fig${count}`
}

/**
 * Sanitize a file base name.
 * @param {string} name - raw name.
 * @returns {string} safe name.
 */
function sanitizeFilename(name) {
  return String(name).replace(/[\\/:*?"<>|\s]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, 80) || 'bid'
}

/**
 * Compact date stamp for file names.
 * @returns {string} `YYYYMMDD-HHmm`.
 */
function dateStamp() {
  const now = new Date()
  const pad = value => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

/**
 * Small deterministic string hash.
 * @param {string} value - input.
 * @returns {number} hash.
 */
function hash(value) {
  let result = 0
  for (let index = 0; index < String(value).length; index += 1) {
    result = (result * 31 + String(value).charCodeAt(index)) | 0
  }
  return result
}
