/**
 * Enterprise knowledge base — the anti-hallucination layer.
 *
 * Bid writing fails when the model invents a certification it does not have or
 * a project it never delivered. The KB keeps the real enterprise material
 * (qualifications, past performance, staff, technical write-ups) indexed in the
 * project directory, and `searchKb` returns the exact source chunk with its file
 * and heading, so a section can quote it instead of inventing it.
 *
 * Chunking and scoring are deterministic (Chinese bigrams + BM25), so the same
 * query against the same corpus always returns the same evidence.
 *
 * @module lib/kb
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { atomicWrite } from './store.js'

/** File types the indexer reads. */
const READABLE = new Set(['.md', '.markdown', '.txt', '.csv'])
/** Target characters per chunk. */
const CHUNK_CHARS = 700
/** Maximum chunks kept per corpus. */
const MAX_CHUNKS = 4000
/** Directory holding the KB index inside a project. */
const KB_DIR = 'kb'
/** Index file name. */
const INDEX_FILE = 'index.json'

/**
 * Walk a directory and collect readable files.
 * @param {string} root - absolute directory.
 * @param {number} [depth] - recursion depth guard.
 * @returns {Promise<string[]>} absolute file paths.
 */
export async function collectFiles(root, depth = 0) {
  if (depth > 6) return []
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const files = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectFiles(full, depth + 1))
    } else if (READABLE.has(extname(entry.name).toLowerCase())) {
      files.push(full)
    }
  }
  return files
}

/**
 * Split a document into retrieval chunks on heading boundaries.
 * @param {string} text - document text.
 * @param {string} file - display path of the source.
 * @returns {Array<{ id: string, file: string, heading: string, text: string }>} chunks.
 */
export function chunkDocument(text, file) {
  const lines = String(text ?? '').replace(/\r\n?/gu, '\n').split('\n')
  const chunks = []
  let heading = ''
  let buffer = []
  const flush = () => {
    const body = buffer.join('\n').trim()
    if (body.length < 20) return
    const parts = body.length <= CHUNK_CHARS ? [body] : splitLong(body)
    for (const part of parts) {
      chunks.push({ id: `${file}#${chunks.length + 1}`, file, heading, text: part })
    }
  }
  for (const line of lines) {
    const match = /^#{1,4}\s+(.+)$/u.exec(line.trim())
    if (match !== null) {
      flush()
      heading = match[1].trim()
      buffer = []
      continue
    }
    buffer.push(line)
  }
  flush()
  return chunks
}

/**
 * Split an over-long chunk on paragraph boundaries.
 * @param {string} body - chunk body.
 * @returns {string[]} parts.
 */
function splitLong(body) {
  const paragraphs = body.split(/\n{2,}/u)
  const parts = []
  let current = ''
  for (const paragraph of paragraphs) {
    if (`${current}\n\n${paragraph}`.length > CHUNK_CHARS && current !== '') {
      parts.push(current.trim())
      current = paragraph
    } else {
      current = `${current}\n\n${paragraph}`.trim()
    }
  }
  if (current.trim() !== '') parts.push(current.trim())
  return parts
}

/**
 * Tokenize Chinese + latin text for retrieval.
 * @param {string} text - text.
 * @returns {string[]} tokens (CJK bigrams, lowercased latin words).
 */
export function tokenize(text) {
  const tokens = []
  const body = String(text ?? '').toLowerCase()
  for (const match of body.matchAll(/[a-z0-9][a-z0-9._-]*/gu)) tokens.push(match[0])
  const cjk = body.replace(/[^\u3400-\u4dbf\u4e00-\u9fff]/gu, ' ')
  for (const run of cjk.split(/\s+/u)) {
    if (run.length === 0) continue
    if (run.length === 1) tokens.push(run)
    for (let index = 0; index + 1 < run.length; index += 1) tokens.push(run.slice(index, index + 2))
  }
  return tokens
}

/**
 * Build (or rebuild) a project's knowledge base index.
 * @param {import('./store.js').BidStore} store - project store.
 * @param {string} projectId - project id.
 * @param {{ dirs: string[], label?: string }} input - directories to index.
 * @returns {Promise<{ files: number, chunks: number, bytes: number, sources: object[] }>} index summary.
 */
export async function indexKnowledgeBase(store, projectId, input) {
  const projectDir = await store.requireDir(projectId)
  const chunks = []
  const sources = []
  let bytes = 0
  for (const dir of input.dirs ?? []) {
    const info = await stat(dir).catch(() => null)
    if (info === null || !info.isDirectory()) continue
    const files = await collectFiles(dir)
    for (const file of files) {
      const text = await readFile(file, 'utf8').catch(() => '')
      if (text.trim() === '') continue
      bytes += text.length
      const display = relative(dir, file) || file
      const produced = chunkDocument(text, display)
      chunks.push(...produced)
      sources.push({ dir, file: display, chunks: produced.length })
    }
  }
  const capped = chunks.slice(0, MAX_CHUNKS)
  await atomicWrite(join(projectDir, KB_DIR, INDEX_FILE), `${JSON.stringify({ builtAt: new Date().toISOString(), sources, chunks: capped }, null, 2)}\n`).catch(async () => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(projectDir, KB_DIR), { recursive: true })
    await atomicWrite(join(projectDir, KB_DIR, INDEX_FILE), `${JSON.stringify({ builtAt: new Date().toISOString(), sources, chunks: capped }, null, 2)}\n`)
  })
  return { files: sources.length, chunks: capped.length, bytes, sources }
}

/**
 * Load a project's KB index.
 * @param {import('./store.js').BidStore} store - project store.
 * @param {string} projectId - project id.
 * @returns {Promise<{ builtAt: string, sources: object[], chunks: object[] }|null>} index or null.
 */
export async function loadKnowledgeBase(store, projectId) {
  const projectDir = await store.requireDir(projectId)
  const text = await readFile(join(projectDir, KB_DIR, INDEX_FILE), 'utf8').catch(() => null)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Search the project KB with BM25 over bigram tokens.
 * @param {import('./store.js').BidStore} store - project store.
 * @param {string} projectId - project id.
 * @param {string} query - natural-language query.
 * @param {{ limit?: number, file?: string }} [options] - result options.
 * @returns {Promise<{ hits: object[], total: number, builtAt: string|null }>} ranked hits.
 */
export async function searchKb(store, projectId, query, options = {}) {
  const index = await loadKnowledgeBase(store, projectId)
  if (index === null) {
    return { hits: [], total: 0, builtAt: null, note: '知识库尚未建立，请先调用 bid_kb_index。' }
  }
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 6), 1), 20)
  const queryTokens = [...new Set(tokenize(query))]
  if (queryTokens.length === 0) return { hits: [], total: 0, builtAt: index.builtAt }

  const docs = index.chunks
    .filter(chunk => options.file === undefined || chunk.file.includes(options.file))
    .map(chunk => {
      const tokens = tokenize(`${chunk.heading} ${chunk.text}`)
      const tf = new Map()
      for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1)
      return { chunk, tf, length: tokens.length }
    })
  if (docs.length === 0) return { hits: [], total: 0, builtAt: index.builtAt }

  const averageLength = docs.reduce((total, doc) => total + doc.length, 0) / docs.length || 1
  const df = new Map()
  for (const token of queryTokens) {
    let count = 0
    for (const doc of docs) if (doc.tf.has(token)) count += 1
    df.set(token, count)
  }
  const k1 = 1.4
  const b = 0.72
  const scored = docs.map(doc => {
    let score = 0
    for (const token of queryTokens) {
      const frequency = doc.tf.get(token) ?? 0
      if (frequency === 0) continue
      const docsWithToken = df.get(token) ?? 0
      const idf = Math.log(1 + (docs.length - docsWithToken + 0.5) / (docsWithToken + 0.5))
      score += idf * ((frequency * (k1 + 1)) / (frequency + k1 * (1 - b + (b * doc.length) / averageLength)))
    }
    return { score, chunk: doc.chunk }
  })
  scored.sort((left, right) => right.score - left.score)
  const hits = scored.filter(entry => entry.score > 0).slice(0, limit).map(entry => ({
    score: Number(entry.score.toFixed(3)),
    file: entry.chunk.file,
    heading: entry.chunk.heading,
    text: entry.chunk.text.slice(0, 900),
    chunkId: entry.chunk.id,
  }))
  return { hits, total: scored.filter(entry => entry.score > 0).length, builtAt: index.builtAt }
}
