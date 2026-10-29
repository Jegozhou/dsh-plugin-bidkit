/**
 * Tender document parsing.
 *
 * The parser is deterministic and evidence-first: it splits the tender into
 * numbered sections, finds the material clauses, reads the scoring tables and
 * maps every one of the 18 required structured items to the exact section and
 * quote that answers it. It never invents a value — an item the document does
 * not state is reported `missing` with the reason, which is exactly what the
 * response matrix and the compliance review need.
 *
 * The model can then refine the result through `bid_commit_parse`; the parser's
 * output is the skeleton that keeps that refinement honest (coverage is
 * re-measured against the document, not trusted from the model).
 *
 * @module lib/parse
 */

import { inflateRawSync } from 'node:zlib'

/** The 18 structured items every tender parse must account for. */
export const TENDER_ITEMS = Object.freeze([
  { key: 'project_overview', label: '项目概况', risk: 'low', keywords: [/项目(概况|背景|简介|概述)/u, /采购项目(名称|内容)/u, /项目名称/u] },
  { key: 'qualification', label: '投标人资格要求', risk: 'high', keywords: [/资格(要求|条件|审查)/u, /投标人(资格|资质)/u, /供应商资格/u] },
  { key: 'star_clauses', label: '★实质性废标条款', risk: 'high', keywords: [/★/u, /实质性(要求|条款|响应)/u, /否决(投标|条款)/u, /废标/u] },
  { key: 'technical_scoring', label: '技术评分标准', risk: 'high', keywords: [/技术(评分|评审|部分).{0,6}(标准|办法|细则)/u, /技术分/u] },
  { key: 'commercial_scoring', label: '商务评分标准', risk: 'high', keywords: [/商务(评分|评审|部分).{0,6}(标准|办法|细则)/u, /商务分/u] },
  { key: 'price_scoring', label: '价格评分标准', risk: 'high', keywords: [/价格(评分|评审|分).{0,8}(标准|办法|公式|基准价)/u, /报价(评分|得分)/u, /评标基准价/u] },
  { key: 'procurement_list', label: '采购清单与技术参数', risk: 'high', keywords: [/采购(清单|内容|需求|标的)/u, /货物(清单|需求)一览表/u, /技术(参数|规格|要求)/u, /设备清单/u] },
  { key: 'delivery', label: '交货期与地点', risk: 'medium', keywords: [/交货(期|时间|地点|方式)/u, /交付(期|时间|地点)/u, /工期/u, /实施(周期|地点)/u] },
  { key: 'payment', label: '付款方式', risk: 'medium', keywords: [/付款(方式|条件|比例|进度)/u, /结算方式/u, /支付(方式|条款)/u] },
  { key: 'warranty', label: '质保与售后要求', risk: 'medium', keywords: [/质保(期|要求|服务)/u, /售后(服务|要求)/u, /保修/u, /运维服务/u] },
  { key: 'performance_bond', label: '履约保证金', risk: 'high', keywords: [/履约(保证金|担保)/u, /履约保函/u] },
  { key: 'bid_bond', label: '投标保证金', risk: 'high', keywords: [/投标保证金/u, /投标保函/u, /保证金(缴纳|退还)/u] },
  { key: 'bid_format', label: '投标文件格式与装订要求', risk: 'medium', keywords: [/投标文件(格式|编制|装订|组成)/u, /装订(要求|方式)/u, /正本|副本/u, /密封/u] },
  { key: 'submission', label: '投标截止时间与递交地点', risk: 'high', keywords: [/投标截止(时间|日期)/u, /递交(截止|时间|地点)/u, /开标(时间|地点)/u] },
  { key: 'evaluation_method', label: '评标方法', risk: 'high', keywords: [/评标(方法|办法|方式)/u, /综合评分法/u, /最低(评标)?价法/u, /评审方法/u] },
  { key: 'lots', label: '标段划分与投标阶段', risk: 'medium', keywords: [/标段(划分|名称|编号)/u, /包号|分包/u, /标包/u, /阶段/u] },
  { key: 'contract_terms', label: '合同主要条款', risk: 'medium', keywords: [/合同(主要)?条款/u, /合同(签订|履行|变更)/u, /违约责任/u] },
  { key: 'disqualification', label: '废标项（否决项）汇总', risk: 'high', keywords: [/废标(项|条款|情形)/u, /否决(项|情形)/u, /无效投标/u, /不予受理/u] },
])

/** Heading detectors, ordered from most to least specific. */
const HEADING_PATTERNS = [
  { level: 1, pattern: /^#{1}\s+(.+)$/u },
  { level: 2, pattern: /^#{2}\s+(.+)$/u },
  { level: 3, pattern: /^#{3,6}\s+(.+)$/u },
  { level: 2, pattern: /^第[一二三四五六七八九十百零〇\d]+[章部分篇]\s*[、.．:：]?\s*(.+)$/u },
  { level: 2, pattern: /^[一二三四五六七八九十]+[、.．]\s*(.{2,80})$/u },
  { level: 3, pattern: /^（[一二三四五六七八九十]+）\s*(.{2,80})$/u },
  { level: 3, pattern: /^\([一二三四五六七八九十]+\)\s*(.{2,80})$/u },
  { level: 3, pattern: /^\d+[、.．]\s*(.{2,80})$/u },
  { level: 4, pattern: /^\d+\.\d+(\.\d+)?\s+(.{2,80})$/u },
]

/** Maximum characters quoted as evidence for one item. */
const EVIDENCE_CHARS = 360

/**
 * Split a tender document into numbered sections.
 * @param {string} text - raw document text.
 * @returns {Array<{ id: string, title: string, level: number, line: number, text: string }>} sections.
 */
export function splitTender(text) {
  const lines = String(text ?? '').replace(/\r\n?/gu, '\n').split('\n')
  /** @type {Array<{ id: string, title: string, level: number, line: number, body: string[] }>} */
  const sections = []
  let current = { id: 's0', title: '前言', level: 1, line: 0, body: [] }
  sections.push(current)

  for (let line = 0; line < lines.length; line += 1) {
    const raw = lines[line]
    const trimmed = raw.trim()
    if (trimmed === '') {
      current.body.push('')
      continue
    }
    const heading = detectHeading(trimmed)
    if (heading !== null) {
      current = { id: `s${sections.length}`, title: heading.title, level: heading.level, line, body: [] }
      sections.push(current)
      continue
    }
    current.body.push(raw)
  }

  return sections.map(section => ({
    id: section.id,
    title: section.title,
    level: section.level,
    line: section.line,
    text: section.body.join('\n').trim(),
  }))
}

/**
 * Detect a heading line.
 * @param {string} line - trimmed line.
 * @returns {{ title: string, level: number }|null} detected heading.
 */
function detectHeading(line) {
  for (const rule of HEADING_PATTERNS) {
    const match = rule.pattern.exec(line)
    if (match === null) continue
    const title = (rule.level === 4 ? match[2] : match[1]) ?? ''
    const clean = String(title).trim().replace(/[：:。.;；]$/u, '')
    if (clean.length === 0 || clean.length > 80) continue
    if (/^[\d\s.]+$/u.test(clean)) continue
    return { title: clean, level: rule.level }
  }
  return null
}

/**
 * Find every material clause (★ / 实质性 / 否决) with its source section.
 * @param {Array<{ id: string, title: string, text: string }>} sections - parsed sections.
 * @returns {Array<{ id: string, text: string, category: string, strategy: string, sectionId: string, sectionTitle: string }>} clauses.
 */
export function extractStarClauses(sections) {
  const clauses = []
  const seen = new Set()
  const marker = /[★☆]/u
  const material = /实质性(要求|条款|响应)|否决(投标|条款)|废标|不得偏离|不允许负偏离/u

  for (const section of sections) {
    const lines = section.text.split('\n')
    for (const raw of lines) {
      const line = raw.trim().replace(/^[-*>\s]+/u, '')
      if (line.length < 6) continue
      if (!marker.test(line) && !material.test(line)) continue
      const text = line.replace(/^[★☆\s]+/u, '').trim()
      const key = normalizeKey(text)
      if (key.length < 4 || seen.has(key)) continue
      seen.add(key)
      clauses.push({
        id: `star-${clauses.length + 1}`,
        text: text.slice(0, 500),
        category: categorizeStar(text),
        strategy: strategyForStar(text),
        sectionId: section.id,
        sectionTitle: section.title,
      })
    }
  }
  return clauses
}

/**
 * Classify a material clause by the risk area it belongs to.
 * @param {string} text - clause text.
 * @returns {string} category label.
 */
export function categorizeStar(text) {
  if (/资格|资质|营业执照|许可证|认证/u.test(text)) return '资格文件'
  if (/保证金|保函/u.test(text)) return '保证金'
  if (/签字|盖章|签署|法定代表人|授权/u.test(text)) return '签署盖章'
  if (/密封|装订|正本|副本|份数/u.test(text)) return '装订密封'
  if (/时间|截止|递交|上传|开标/u.test(text)) return '时间节点'
  if (/技术|参数|指标|性能|配置/u.test(text)) return '技术参数'
  if (/报价|价格|税率|折扣/u.test(text)) return '报价'
  if (/业绩|案例|合同/u.test(text)) return '业绩'
  if (/售后|质保|服务|响应时间/u.test(text)) return '售后服务'
  return '其他实质性'
}

/**
 * Suggest how a bid must answer one material clause.
 * @param {string} text - clause text.
 * @returns {string} response strategy.
 */
export function strategyForStar(text) {
  if (/不得|不允许|禁止|否则(按)?(废标|否决)/u.test(text)) return '负偏离即废标：逐条正面响应，禁止出现否定表述'
  if (/必须|应当|须提供|需提供/u.test(text)) return '必须逐字响应并附证明文件，缺失即否决'
  if (/不低于|不少于|不高于|不超过|≥|≤/u.test(text)) return '量化响应并列明实测值/承诺值，确保落在区间内'
  return '在响应矩阵中逐条映射到对应章节并给出证明材料索引'
}

/**
 * Extract markdown tables that look like scoring tables.
 * @param {Array<{ id: string, title: string, text: string }>} sections - parsed sections.
 * @returns {Array<{ sectionId: string, sectionTitle: string, headers: string[], rows: string[][] }>} tables.
 */
export function extractTables(sections) {
  const tables = []
  for (const section of sections) {
    const lines = section.text.split('\n')
    let start = -1
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim()
      const isRow = line.startsWith('|') && line.endsWith('|')
      if (!isRow) {
        start = -1
        continue
      }
      if (start === -1) {
        start = index
        continue
      }
      if (!/^\|[\s:|-]+\|$/u.test(line)) continue
      const headers = splitRow(lines[start])
      const rows = []
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const candidate = lines[cursor].trim()
        if (!candidate.startsWith('|') || !candidate.endsWith('|')) break
        rows.push(splitRow(candidate))
      }
      tables.push({ sectionId: section.id, sectionTitle: section.title, headers, rows })
      index += rows.length
      start = -1
    }
  }
  return tables
}

/**
 * Split one markdown table row.
 * @param {string} line - row line.
 * @returns {string[]} cells.
 */
function splitRow(line) {
  return line.replace(/^\|/u, '').replace(/\|$/u, '').split('|').map(cell => cell.trim())
}

/**
 * Parse a numeric score out of a cell.
 * @param {string} value - cell text.
 * @returns {number} score or 0.
 */
export function scoreOf(value) {
  const match = /(\d+(?:\.\d+)?)/u.exec(value ?? '')
  return match === null ? 0 : Number(match[1])
}

/**
 * Read scoring items out of the detected tables.
 * @param {Array<{ sectionId: string, sectionTitle: string, headers: string[], rows: string[][] }>} tables - tables.
 * @returns {{ technical: object[], commercial: object[], price: object[] }} scoring buckets.
 */
export function extractScoring(tables, sections = []) {
  const scoring = { technical: [], commercial: [], price: [] }
  for (const table of tables) {
    const headerText = table.headers.join(' ')
    if (!/评分|分值|得分|评审|标准/u.test(headerText) && !/评分|评审/u.test(table.sectionTitle)) continue
    const scoreIndex = table.headers.findIndex(header => /分值|分数|得分|权重/u.test(header))
    const itemIndex = Math.min(...table.headers.map((header, index) => (/评分|评审|内容|项目|因素/u.test(header) ? index : 99)))
    const criteriaIndex = table.headers.findIndex(header => /标准|细则|说明|要求/u.test(header))
    const bucket = bucketOf(`${table.sectionTitle} ${headerText}`)
    if (bucket === null) continue
    for (const row of table.rows) {
      const item = (itemIndex === 99 ? row[0] : row[itemIndex]) ?? ''
      if (item === '' || /合计|小计|总分/u.test(item)) continue
      const maxScore = scoreOf(scoreIndex === -1 ? row.join(' ') : row[scoreIndex])
      const criteria = criteriaIndex === -1 ? row.slice(1).join('；') : row[criteriaIndex]
      scoring[bucket].push({
        item: item.slice(0, 120),
        maxScore: Number.isFinite(maxScore) ? maxScore : 0,
        criteria: String(criteria ?? '').slice(0, 400),
        sectionId: table.sectionId,
      })
    }
  }
  // A price formula is usually prose, not a table: synthesize the price item
  // from the section that defines it so the outline can still allocate weight.
  if (scoring.price.length === 0) {
    const priceSection = sections.find(section => /价格(评分|评审|分)/u.test(section.title))
    if (priceSection !== undefined) {
      const maxScore = /(\d+(?:\.\d+)?)\s*分/u.exec(priceSection.title)?.[1]
        ?? /(\d+(?:\.\d+)?)\s*分/u.exec(priceSection.text)?.[1]
      scoring.price.push({
        item: '投标报价得分',
        maxScore: maxScore === undefined ? 30 : Number(maxScore),
        criteria: excerpt(priceSection.text, 300),
        sectionId: priceSection.id,
      })
    }
  }
  return scoring
}

/**
 * Choose a scoring bucket from a heading.
 * @param {string} text - heading text.
 * @returns {'technical'|'commercial'|'price'|null} bucket.
 */
function bucketOf(text) {
  if (/价格|报价|投标报价/u.test(text)) return 'price'
  if (/商务|资质|业绩|信誉|财务/u.test(text)) return 'commercial'
  if (/技术|方案|实施|服务/u.test(text)) return 'technical'
  return null
}

/**
 * Extract lot / package structure.
 * @param {Array<{ id: string, title: string, text: string }>} sections - parsed sections.
 * @returns {Array<{ id: string, name: string, stage: string }>} lots.
 */
export function extractLots(sections) {
  const lots = []
  const seen = new Set()
  const patterns = [
    /标段\s*([一二三四五六七八九十\d A-Za-z]{1,8})[:：\s]*(.{0,40})/gu,
    /(?:包|标包)\s*(?:号|件)?\s*([\d A-Za-z一二三四五六七八九十]{1,6})[:：\s]*(.{0,40})/gu,
    /第\s*([一二三四五六七八九十\d]{1,3})\s*标段/gu,
  ]
  for (const section of sections) {
    for (const pattern of patterns) {
      for (const match of section.text.matchAll(pattern)) {
        const id = String(match[1] ?? '').trim()
        const name = String(match[2] ?? '').replace(/[|*#]/gu, '').trim()
        const key = `${id}:${name}`.toLowerCase()
        if (seen.has(key) || id === '') continue
        seen.add(key)
        lots.push({ id: `lot-${id}`.replace(/\s+/gu, ''), name: name === '' ? `标段${id}` : name.slice(0, 80), stage: stageOf(section.text) })
      }
    }
  }
  return lots.slice(0, 20)
}

/**
 * Detect the bid stage described by a text block.
 * @param {string} text - source text.
 * @returns {string} stage label.
 */
function stageOf(text) {
  if (/资格预审/u.test(text)) return '资格预审'
  if (/两阶段|第一阶段|第二阶段/u.test(text)) return '两阶段'
  if (/竞争性磋商/u.test(text)) return '竞争性磋商'
  if (/竞价/u.test(text)) return '竞价'
  return '一次性投标'
}

/**
 * Build the full deterministic parse document.
 * @param {string} text - tender document text.
 * @returns {object} parse document compatible with `project.json`.
 */
export function parseTender(text) {
  const sections = splitTender(text)
  const tables = extractTables(sections)
  const scoring = extractScoring(tables, sections)
  const starClauses = extractStarClauses(sections)
  const lots = extractLots(sections)

  const items = TENDER_ITEMS.map(spec => {
    const hits = matchSections(sections, spec.keywords)
    const best = hits[0] ?? null
    const quote = best === null ? '' : excerpt(best.section.text || best.section.title, EVIDENCE_CHARS)
    const starInside = best !== null && starClauses.some(clause => clause.sectionId === best.section.id)
    const filled = best !== null && (best.section.text.length >= 20 || starInside)
    const status = filled ? 'filled' : best !== null ? 'partial' : 'missing'
    return {
      key: spec.key,
      label: spec.label,
      status,
      risk: status === 'missing' ? 'high' : spec.risk,
      value: filled ? quote : '',
      evidence: best === null ? [] : [{ sectionId: best.section.id, sectionTitle: best.section.title, quote }],
      sectionId: best === null ? null : best.section.id,
    }
  })

  const filledCount = items.filter(item => item.status === 'filled').length
  const coverage = { filled: filledCount, total: TENDER_ITEMS.length }

  return {
    parsedAt: new Date().toISOString(),
    heading: sections[0]?.title ?? '',
    sectionCount: sections.length,
    sections: sections.map(section => ({ id: section.id, title: section.title, level: section.level, words: section.text.length })),
    coverage,
    items,
    starClauses,
    scoring,
    lots,
    tables: tables.slice(0, 60).map(table => ({ sectionId: table.sectionId, sectionTitle: table.sectionTitle, headers: table.headers, rowCount: table.rows.length })),
    responseMatrix: buildResponseMatrix(items, starClauses, scoring),
  }
}

/**
 * Score sections against a keyword set.
 * @param {Array<{ id: string, title: string, text: string }>} sections - sections.
 * @param {RegExp[]} keywords - keywords for the item.
 * @returns {Array<{ section: object, score: number }>} ranked hits.
 */
function matchSections(sections, keywords) {
  const hits = []
  for (const section of sections) {
    let score = 0
    const title = section.title
    const body = section.text
    for (const keyword of keywords) {
      if (keyword.test(title)) score += 4
      const flags = [...new Set(`${keyword.flags.replace(/[gy]/gu, '')}gu`.split(''))].join('')
      const matches = body.match(new RegExp(keyword.source, flags))
      if (matches !== null) score += Math.min(matches.length, 3)
    }
    if (score > 0) hits.push({ section, score })
  }
  hits.sort((left, right) => right.score - left.score)
  return hits
}

/**
 * Build the response matrix: one row per material/scored requirement.
 * @param {object[]} items - parsed items.
 * @param {object[]} starClauses - material clauses.
 * @param {{technical: object[], commercial: object[], price: object[]}} scoring - scoring buckets.
 * @returns {object[]} matrix rows.
 */
export function buildResponseMatrix(items, starClauses, scoring) {
  const rows = []
  for (const clause of starClauses) {
    rows.push({
      id: `m-${rows.length + 1}`,
      type: 'material',
      requirement: clause.text,
      source: clause.sectionTitle,
      weight: 0,
      response: clause.strategy,
      sectionRef: null,
      status: 'open',
    })
  }
  const pushScores = (bucket, label) => {
    for (const entry of scoring[bucket]) {
      rows.push({
        id: `m-${rows.length + 1}`,
        type: 'score',
        requirement: `${label}：${entry.item}`,
        source: `评分表 ${entry.maxScore} 分`,
        weight: entry.maxScore,
        response: entry.criteria,
        sectionRef: null,
        status: 'open',
      })
    }
  }
  pushScores('technical', '技术')
  pushScores('commercial', '商务')
  pushScores('price', '价格')
  for (const item of items) {
    if (item.status !== 'missing') continue
    rows.push({
      id: `m-${rows.length + 1}`,
      type: 'missing_item',
      requirement: `${item.label}：招标文件未给出可直接引用的内容`,
      source: item.label,
      weight: 0,
      response: '需人工补充或向招标人澄清',
      sectionRef: null,
      status: 'open',
    })
  }
  return rows
}

/**
 * Excerpt a quote, collapsing whitespace.
 * @param {string} text - source text.
 * @param {number} limit - maximum characters.
 * @returns {string} excerpt.
 */
export function excerpt(text, limit = EVIDENCE_CHARS) {
  const collapsed = String(text ?? '').replace(/[ \t]+/gu, ' ').replace(/\n{2,}/gu, '\n').trim()
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}…`
}

/**
 * Normalize a text fragment for de-duplication.
 * @param {string} text - raw text.
 * @returns {string} normalized key.
 */
function normalizeKey(text) {
  return String(text).replace(/[\s★☆，。；、：:（）()【】\[\]""''"']/gu, '').toLowerCase()
}

/**
 * Extract plain text from an uploaded document.
 *
 * Supports `.md`/`.txt` directly and `.docx` through a minimal in-process ZIP
 * reader. PDF is rejected with an explicit code rather than a guessed parse.
 * @param {string} name - file name, used for the extension.
 * @param {Uint8Array|string} data - raw file content.
 * @returns {{ text: string, format: string }} extracted text and format.
 * @throws {Error & { code?: string }} unsupported or corrupt input.
 */
export function extractDocumentText(name, data) {
  const lower = String(name ?? '').toLowerCase()
  if (lower.endsWith('.docx')) {
    return { text: docxToText(toBytes(data)), format: 'docx' }
  }
  if (lower.endsWith('.pdf')) {
    const error = new Error('PDF 招标文件需要先转换为 .docx 或 .md 再解析（当前环境不内置 PDF 光栅化/文本抽取运行时）')
    error.code = 'unsupported_format'
    throw error
  }
  const text = typeof data === 'string' ? data : new TextDecoder('utf-8').decode(toBytes(data))
  return { text, format: lower.endsWith('.md') ? 'markdown' : 'text' }
}

/**
 * Coerce to bytes.
 * @param {Uint8Array|string} data - input.
 * @returns {Uint8Array} bytes.
 */
function toBytes(data) {
  return typeof data === 'string' ? new TextEncoder().encode(data) : data
}

/**
 * Minimal ZIP entry reader for OOXML documents (central directory based).
 * @param {Uint8Array} bytes - .docx bytes.
 * @returns {Map<string, Uint8Array>} entries keyed by name.
 */
export function readZipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (view.getUint32(offset, true) === 0x0605_4b50) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw Object.assign(new Error('not a ZIP/OOXML container: end of central directory not found'), { code: 'bad_docx' })
  const count = view.getUint16(eocd + 10, true)
  const directoryOffset = view.getUint32(eocd + 16, true)
  const entries = new Map()
  let cursor = directoryOffset
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(cursor, true) !== 0x0201_4b50) break
    const method = view.getUint16(cursor + 10, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength)
    const name = new TextDecoder().decode(nameBytes)
    cursor += 46 + nameLength + extraLength + commentLength

    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const payload = bytes.subarray(dataStart, dataStart + compressedSize)
    if (method === 0) entries.set(name, payload)
    else if (method === 8) entries.set(name, new Uint8Array(inflateRawSync(payload)))
  }
  return entries
}

/**
 * Convert `.docx` bytes into readable plain text.
 * @param {Uint8Array} bytes - document bytes.
 * @returns {string} text with paragraph breaks and heading markers.
 */
export function docxToText(bytes) {
  const entries = readZipEntries(bytes)
  const document = entries.get('word/document.xml')
  if (document === undefined) throw Object.assign(new Error('word/document.xml missing from .docx'), { code: 'bad_docx' })
  const xml = new TextDecoder('utf-8').decode(document)
  const body = xml.replace(/<w:tbl[ >]/gu, '\n|table|')
  const paragraphs = body.split(/<\/w:p>/u)
  const lines = []
  for (const paragraph of paragraphs) {
    const style = /w:val="([^"]*)"/u.exec(/<w:pStyle[^>]*>/u.exec(paragraph)?.[0] ?? '')?.[1] ?? ''
    const texts = [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gu)].map(match => decodeXml(match[1]))
    const line = texts.join('')
    if (line.trim() === '') continue
    const headingMatch = /^Heading(\d)$/u.exec(style)
    if (headingMatch !== null) lines.push(`${'#'.repeat(Number(headingMatch[1]))} ${line}`)
    else if (/^(Title|Subtitle)$/u.test(style)) lines.push(`# ${line}`)
    else lines.push(line)
  }
  return lines.join('\n').replace(/\n{3,}/gu, '\n\n')
}

/**
 * Decode the five XML entities.
 * @param {string} text - encoded text.
 * @returns {string} decoded text.
 */
function decodeXml(text) {
  return text
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&')
}
