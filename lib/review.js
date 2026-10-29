/**
 * Compliance and risk review engine.
 *
 * Every finding is produced by a deterministic rule over the same bytes the
 * exporter will publish, so running the review twice yields the same result and
 * a reviewer can reproduce each finding from its evidence string. Rules are
 * grouped by what actually loses a bid:
 *
 * - disqualification (★ clause unanswered, missing mandatory item, placeholder);
 * - consistency (locked-fact contradictions, conflicting promised numbers);
 * - quality (short sections, unwritten sections, self-duplication, typos);
 * - collusion (near-duplicate content against another bid, for 围标/串标 risk).
 *
 * @module lib/review
 */

import { countWords, flattenOutline } from './store.js'

/** Severity order used for sorting and for the workbench summary. */
const SEVERITY_RANK = { blocker: 0, major: 1, minor: 2 }

/** Common Chinese business typos, applied as literal pairs. */
const TYPO_PAIRS = Object.freeze([
  ['帐号', '账号'], ['做为', '作为'], ['按装', '安装'], ['布署', '部署'],
  ['签定', '签订'], ['予计', '预计'], ['侯选', '候选'], ['部份', '部分'],
  ['竣工险', '竣工险'], ['合谐', '和谐'], ['检查院', '检察院'], ['既使', '即使'],
  ['必竟', '毕竟'], ['竞然', '竟然'], ['截然不同', '截然不同'], ['治制', '整治'],
  ['剖晰', '剖析'], ['按排', '安排'], ['供献', '贡献'], ['圆满的完成', '圆满完成'],
  ['受到好评', '获得好评'], ['既便是', '即便是'], ['无庸置疑', '毋庸置疑'],
  ['相形见拙', '相形见绌'], ['急待', '亟待'], ['精减', '精简'], ['严竣', '严峻'],
])

/** Placeholder markers that must never ship inside a bid. */
const PLACEHOLDER_PATTERNS = [
  { pattern: /X{2,}|x{3,}/u, label: 'XX 占位符' },
  { pattern: /【[^】]{0,20}】/u, label: '【】待填占位' },
  { pattern: /待补充|待填写|待定|此处填写|此处插入|TODO|TBD/iu, label: '待补/待定标记' },
  { pattern: /\[(?:公司名称|项目名称|日期|金额)\]/u, label: '方括号模板变量' },
]

/** Negative promises that contradict a bid's own compliance. */
const NEGATIVE_COMMITMENTS = /我方(?:不能|无法|不承诺|不予|不响应|不同意|不接受)/u

/** Rules whose absence is itself a blocker, keyed by parse item key. */
const MANDATORY_ITEMS = new Set([
  'star_clauses', 'qualification', 'submission', 'evaluation_method', 'bid_bond', 'performance_bond', 'price_scoring',
])

/**
 * Run every rule over one project.
 * @param {object} index - project index (`project.json`).
 * @param {Record<string, string>} bodies - section id to markdown.
 * @param {{ compare?: { id: string, name: string, bodies: Record<string, string> }, trigger?: string }} [options] - comparison project for collusion checks.
 * @returns {object} review document.
 */
export function runReview(index, bodies, options = {}) {
  const findings = []
  const push = finding => {
    findings.push({
      id: `f-${findings.length + 1}`,
      severity: finding.severity,
      rule: finding.rule,
      sectionId: finding.sectionId ?? null,
      sectionTitle: finding.sectionTitle ?? null,
      message: finding.message,
      evidence: String(finding.evidence ?? '').slice(0, 400),
      suggestion: finding.suggestion ?? '',
    })
  }

  const nodes = flattenOutline(index.outline?.nodes ?? [])
  const written = nodes.filter(node => (bodies[node.id] ?? '').trim() !== '')
  const titleOf = id => nodes.find(node => node.id === id)?.title ?? null

  reviewMandatoryItems(index, push)
  reviewMaterialClauses(index, bodies, nodes, push)
  reviewPlaceholders(written, bodies, titleOf, push)
  reviewFacts(index, written, bodies, titleOf, push)
  reviewLength(nodes, written, bodies, titleOf, push)
  reviewNegatives(written, bodies, titleOf, push)
  reviewTypos(written, bodies, titleOf, push)
  reviewDuplication(written, bodies, titleOf, push)
  reviewFigures(index, bodies, titleOf, push)
  if (options.compare !== undefined) reviewCollusion(index, bodies, options.compare, push)

  const summary = { blocker: 0, major: 0, minor: 0 }
  for (const finding of findings) summary[finding.severity] += 1
  findings.sort((left, right) => SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] || left.id.localeCompare(right.id))

  return {
    runAt: new Date().toISOString(),
    trigger: options.trigger ?? 'manual',
    comparedWith: options.compare === undefined ? null : { id: options.compare.id, name: options.compare.name },
    sectionsReviewed: written.length,
    wordsReviewed: written.reduce((total, node) => total + countWords(bodies[node.id] ?? ''), 0),
    summary,
    findings,
  }
}

/**
 * Rule 1 — every mandatory structured item must be present in the tender parse.
 * @param {object} index - project index.
 * @param {(finding: object) => void} push - finding sink.
 * @returns {void}
 */
function reviewMandatoryItems(index, push) {
  for (const item of index.parse?.items ?? []) {
    if (item.status !== 'missing') continue
    const mandatory = MANDATORY_ITEMS.has(item.key)
    push({
      severity: mandatory ? 'blocker' : 'major',
      rule: 'item-missing',
      message: `招标解析缺少「${item.label}」，无法形成响应依据`,
      evidence: `18 项结构化解析中 ${item.label} 未在招标文件中定位到内容`,
      suggestion: '补充解析或向招标人澄清；响应矩阵中不得留空该项',
    })
  }
  if ((index.parse?.starClauses ?? []).length === 0) {
    push({
      severity: 'major',
      rule: 'item-missing',
      message: '未识别到任何 ★ 实质性条款，需人工确认招标文件是否含星号条款',
      evidence: '解析结果 starClauses 为空',
      suggestion: '复核招标文件中"★/实质性/否决"标记，必要时用 bid_commit_parse 补充',
    })
  }
}

/**
 * Rule 2 — every material clause must be answered by a real section.
 * @param {object} index - project index.
 * @param {Record<string, string>} bodies - section bodies.
 * @param {object[]} nodes - flat outline.
 * @param {(finding: object) => void} push - finding sink.
 * @returns {void}
 */
function reviewMaterialClauses(index, bodies, nodes, push) {
  const matrix = index.parse?.responseMatrix ?? []
  const candidates = nodes
    .map(node => ({ id: node.id, text: `${node.title}\n${bodies[node.id] ?? ''}` }))
    .filter(entry => entry.text.trim().length > 0)
  for (const clause of index.parse?.starClauses ?? []) {
    const row = matrix.find(entry => entry.type === 'material' && entry.requirement === clause.text)
    const reference = row?.sectionRef ?? null
    const answered = candidates.some(entry => answerScore(clause.text, entry.text) >= 0.55)
      || (reference !== null && answerScore(clause.text, candidates.find(entry => entry.id === reference)?.text ?? '') >= 0.35)
    if (answered) continue
    push({
      severity: 'blocker',
      rule: 'star-unanswered',
      sectionId: reference,
      sectionTitle: reference === null ? null : nodes.find(node => node.id === reference)?.title ?? null,
      message: `★实质性条款未被逐条响应，存在废标风险：${clause.category}`,
      evidence: clause.text,
      suggestion: `在响应矩阵中将该条款指向具体章节，并在该章节写明"完全响应、无偏离"并附证明索引（${clause.strategy}）`,
    })
  }
}

/**
 * Rule 3 — no placeholder may survive into the exported document.
 * @param {object[]} written - written nodes.
 * @param {Record<string, string>} bodies - bodies.
 * @param {(id: string) => string|null} titleOf - title lookup.
 * @param {(finding: object) => void} push - finding sink.
 * @returns {void}
 */
function reviewPlaceholders(written, bodies, titleOf, push) {
  for (const node of written) {
    const text = bodies[node.id] ?? ''
    for (const marker of PLACEHOLDER_PATTERNS) {
      const match = marker.pattern.exec(text)
      if (match === null) continue
      push({
        severity: marker.label.includes('占位') ? 'blocker' : 'major',
        rule: 'placeholder',
        sectionId: node.id,
        sectionTitle: titleOf(node.id),
        message: `正文残留${marker.label}`,
        evidence: contextAround(text, match.index, 80),
        suggestion: '用真实企业数据替换占位符；无法确认的数据应改为可验证的承诺表述',
      })
      break
    }
  }
}

/**
 * Rule 4 — locked global facts must not contradict the body.
 * @param {object} index - project index.
 * @param {object[]} written - written nodes.
 * @param {Record<string, string>} bodies - bodies.
 * @param {(id: string) => string|null} titleOf - title lookup.
 * @param {(finding: object) => void} push - finding sink.
 * @returns {void}
 */
function reviewFacts(index, written, bodies, titleOf, push) {
  const facts = index.facts ?? []
  if (facts.length === 0) {
    push({
      severity: 'major',
      rule: 'facts-unlocked',
      message: '尚未锁定全局事实（Global Fact Anchoring），长文分章写作极易前后不一致',
      evidence: 'project.facts 为空',
      suggestion: '先调用 bid_facts_lock 锁定企业名称、资质编号、业绩金额、承诺工期与质保期',
    })
    return
  }
  const allText = written.map(node => bodies[node.id] ?? '').join('\n')
  for (const fact of facts) {
    const value = String(fact.value ?? '').trim()
    if (value === '') continue
    if (!allText.includes(value)) {
      push({
        severity: 'major',
        rule: 'fact-unused',
        message: `已锁定事实「${fact.key}」未在正文中出现，存在事实漂移`,
        evidence: `${fact.key}=${value}`,
        suggestion: `在相关章节（投标函/资格证明/商务响应）中按锁定值引用：${value}`,
      })
    }
    const rival = findRivalValue(fact, allText)
    if (rival !== null) {
      push({
        severity: 'major',
        rule: 'fact-conflict',
        message: `正文出现与锁定事实「${fact.key}」不一致的表述`,
        evidence: `锁定值「${value}」 vs 正文「${rival}」`,
        suggestion: '统一替换为锁定值；全局事实一旦锁定，全文不得再出现第二套口径',
      })
    }
  }
}

/**
 * Find a conflicting value for one locked fact.
 * @param {{ key: string, value: string }} fact - locked fact.
 * @param {string} text - all body text.
 * @returns {string|null} conflicting value or null.
 */
function findRivalValue(fact, text) {
  const value = String(fact.value).trim()
  if (/(公司|集团|研究院|事务所)/u.test(value)) {
    const names = new Set()
    for (const match of text.matchAll(/([\u4e00-\u9fff]{2,18}(?:有限公司|股份有限公司|集团有限公司|公司))/gu)) {
      const name = match[1]
      if (name === value || value.includes(name) || name.includes(value)) continue
      if (/^我(?:方|公司)/u.test(name)) continue
      names.add(name)
    }
    const rival = [...names].find(name => name.length >= 4 && text.split(name).length > 2)
    return rival ?? null
  }
  const numberMatch = /(\d+(?:\.\d+)?)\s*(天|日|年|个月|%|万元|元)/u.exec(value)
  if (numberMatch !== null) {
    const [, expected, unit] = numberMatch
    const keyTokens = String(fact.key).match(/[\u4e00-\u9fff]{2}/gu) ?? []
    const pattern = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${unit === '%' ? '%' : unit}`, 'gu')
    for (const match of text.matchAll(pattern)) {
      if (match[1] === expected) continue
      // Only a number in the same context counts as a contradiction: "有效期至
      // 2028 年" is not a rival for the 3-年 warranty commitment.
      const start = Math.max(0, (match.index ?? 0) - 16)
      const window = text.slice(start, (match.index ?? 0) + match[0].length + 4)
      if (keyTokens.length > 0 && !keyTokens.some(token => window.includes(token))) continue
      return `${match[1]}${unit}`
    }
  }
  return null
}

/**
 * Rule 5 — sections must reach their planned weight and none may be unwritten.
 * @param {object[]} nodes - outline nodes.
 * @param {object[]} written - written nodes.
 * @param {Record<string, string>} bodies - bodies.
 * @param {(id: string) => string|null} titleOf - title lookup.
 * @param {(finding: object) => void} push - finding sink.
 * @returns {void}
 */
function reviewLength(nodes, written, bodies, titleOf, push) {
  const leaves = nodes.filter(node => (node.children ?? []).length === 0)
  const totalTarget = leaves.reduce((total, node) => total + (Number(node.wordTarget) || 0), 0)
  const totalWords = leaves.reduce((total, node) => total + countWords(bodies[node.id] ?? ''), 0)
  for (const node of nodes) {
    const text = bodies[node.id] ?? ''
    const words = countWords(text)
    if (words === 0) {
      if ((node.children ?? []).length > 0) continue
      push({
        severity: node.level === 1 ? 'blocker' : 'major',
        rule: 'section-unwritten',
        sectionId: node.id,
        sectionTitle: titleOf(node.id),
        message: `章节「${node.title}」尚未撰写`,
        evidence: `目标 ${node.wordTarget || 0} 字，当前 0 字`,
        suggestion: '对未完成章节调用 bid_handoff_plan 分批交给子智能体并写回 bid_section_write',
      })
      continue
    }
    if (node.wordTarget > 0 && words < node.wordTarget * 0.6) {
      push({
        severity: 'major',
        rule: 'section-short',
        sectionId: node.id,
        sectionTitle: titleOf(node.id),
        message: `章节篇幅不足目标值的 60%`,
        evidence: `目标 ${node.wordTarget} 字，实际 ${words} 字`,
        suggestion: '优先补充评分细则逐条响应、证明材料索引与量化承诺，而不是空泛修辞',
      })
    }
  }
  if (totalTarget > 0 && totalWords < totalTarget * 0.5) {
    push({
      severity: 'major',
      rule: 'document-short',
      message: '全文篇幅不足规划的 50%，可能丢分于完整性',
      evidence: `规划 ${totalTarget} 字，实际 ${totalWords} 字`,
      suggestion: '按 bid_project_status 中每章缺口补齐，再重新 bid_review',
    })
  }
}

/**
 * Rule 6 — a bid must never include a negative commitment.
 * @param {object[]} written - written nodes.
 * @param {Record<string, string>} bodies - bodies.
 * @param {(id: string) => string|null} titleOf - title lookup.
 * @param {(finding: object) => void} push - finding sink.
 * @returns {void}
 */
function reviewNegatives(written, bodies, titleOf, push) {
  for (const node of written) {
    const text = bodies[node.id] ?? ''
    const match = NEGATIVE_COMMITMENTS.exec(text)
    if (match === null) continue
    push({
      severity: 'blocker',
      rule: 'negative-commitment',
      sectionId: node.id,
      sectionTitle: titleOf(node.id),
      message: '正文出现否定性承诺，评标时可被判定为负偏离/不响应',
      evidence: contextAround(text, match.index, 90),
      suggestion: '改用"完全响应"表述；确需说明差异时放入偏离表并单独论证',
    })
  }
}

/**
 * Rule 7 — typo and formatting defects.
 * @param {object[]} written - written nodes.
 * @param {Record<string, string>} bodies - bodies.
 * @param {(id: string) => string|null} titleOf - title lookup.
 * @param {(finding: object) => void} push - finding sink.
 * @returns {void}
 */
function reviewTypos(written, bodies, titleOf, push) {
  for (const node of written) {
    const text = bodies[node.id] ?? ''
    const issues = []
    for (const [wrong, right] of TYPO_PAIRS) {
      if (wrong === right) continue
      if (text.includes(wrong)) issues.push(`「${wrong}」应为「${right}」`)
    }
    for (const match of text.matchAll(/([\u4e00-\u9fff])\1{2,}/gu)) {
      issues.push(`重复字「${match[0].slice(0, 4)}」`)
    }
    for (const match of text.matchAll(/[，。；：、]{2,}/gu)) issues.push(`连续标点「${match[0]}」`)
    if (issues.length === 0) continue
    push({
      severity: 'minor',
      rule: 'typo',
      sectionId: node.id,
      sectionTitle: titleOf(node.id),
      message: '存在错别字或标点问题',
      evidence: [...new Set(issues)].slice(0, 6).join('；'),
      suggestion: '逐处修正后再导出',
    })
  }
}

/**
 * Rule 8 — identical paragraphs inside one bid (自我重复) are a quality signal.
 * @param {object[]} written - written nodes.
 * @param {Record<string, string>} bodies - bodies.
 * @param {(id: string) => string|null} titleOf - title lookup.
 * @param {(finding: object) => void} push - finding sink.
 * @returns {void}
 */
function reviewDuplication(written, bodies, titleOf, push) {
  const owner = new Map()
  for (const node of written) {
    for (const paragraph of paragraphsOf(bodies[node.id] ?? '')) {
      if (paragraph.length < 80) continue
      const key = paragraph.slice(0, 60)
      const previous = owner.get(key)
      if (previous === undefined) {
        owner.set(key, node.id)
        continue
      }
      push({
        severity: 'minor',
        rule: 'self-duplicate',
        sectionId: node.id,
        sectionTitle: titleOf(node.id),
        message: '与其它章节存在整段重复，评标时显得内容注水',
        evidence: `${paragraph.slice(0, 90)}…（首次出现于 ${titleOf(previous) ?? previous}）`,
        suggestion: '改写为针对本章评分点的差异化论述，或压缩为交叉引用',
      })
    }
  }
}

/**
 * Rule 9 — figure tokens must resolve to a rendered asset.
 * @param {object} index - project index.
 * @param {Record<string, string>} bodies - bodies.
 * @param {(id: string) => string|null} titleOf - title lookup.
 * @param {(finding: object) => void} push - finding sink.
 * @returns {void}
 */
function reviewFigures(index, bodies, titleOf, push) {
  const known = new Set((index.figures ?? []).map(figure => figure.id))
  for (const [sectionId, text] of Object.entries(bodies)) {
    for (const match of text.matchAll(/\[\[figure:([A-Za-z0-9._-]+)\]\]/gu)) {
      if (known.has(match[1])) continue
      push({
        severity: 'minor',
        rule: 'figure-missing',
        sectionId,
        sectionTitle: titleOf(sectionId),
        message: `正文引用了不存在的配图 ${match[1]}`,
        evidence: match[0],
        suggestion: '用 bid_figure_add 生成该图，或删除该引用',
      })
    }
  }
}

/**
 * Rule 10 — near-duplicate content against another bid (围标/串标 risk).
 * @param {object} index - project index.
 * @param {Record<string, string>} bodies - this project's bodies.
 * @param {{ id: string, name: string, bodies: Record<string, string> }} compare - the other project.
 * @param {(finding: object) => void} push - finding sink.
 * @returns {void}
 */
function reviewCollusion(index, bodies, compare, push) {
  const mine = new Set(allShingles(bodies))
  const theirs = new Set(allShingles(compare.bodies))
  if (mine.size === 0 || theirs.size === 0) return
  let shared = 0
  for (const shingle of mine) if (theirs.has(shingle)) shared += 1
  const union = mine.size + theirs.size - shared
  const similarity = union === 0 ? 0 : shared / union
  if (similarity >= 0.35) {
    push({
      severity: 'blocker',
      rule: 'collusion-similarity',
      message: `与另一份标书「${compare.name}」相似度 ${(similarity * 100).toFixed(1)}%，存在围标/串标雷同风险`,
      evidence: `共享 ${shared} 个文段指纹（8 字窗口），Jaccard=${similarity.toFixed(3)}`,
      suggestion: '逐章重写重复文段，确保技术路线、组织方案与用词具有独立原创性',
    })
    return
  }
  if (similarity >= 0.2) {
    push({
      severity: 'major',
      rule: 'collusion-similarity',
      message: `与「${compare.name}」有 ${(similarity * 100).toFixed(1)}% 的文段相似度，建议人工复核`,
      evidence: `共享 ${shared} 个文段指纹`,
      suggestion: '重点检查技术方案与实施计划章节的措辞是否过于一致',
    })
  }
}

/**
 * Extract 8-character shingles from every section body.
 * @param {Record<string, string>} bodies - bodies.
 * @returns {string[]} shingles.
 */
function allShingles(bodies) {
  const shingles = []
  for (const text of Object.values(bodies)) {
    const clean = String(text).replace(/[\s#*|>`\-_]/gu, '')
    const step = 2
    for (let index = 0; index + 8 <= clean.length && shingles.length < 4000; index += step) {
      shingles.push(clean.slice(index, index + 8))
    }
  }
  return shingles
}

/**
 * Paragraphs of at least one sentence.
 * @param {string} text - markdown body.
 * @returns {string[]} paragraphs.
 */
function paragraphsOf(text) {
  return String(text).split(/\n{2,}/u).map(paragraph => paragraph.replace(/^[#>\-*\d.\s]+/u, '').trim())
}

/**
 * Score how much of a material clause a candidate body actually answers.
 *
 * The comparison is a coverage ratio over distinctive CJK bigrams plus any
 * identifier/number the clause names, so an answer does not have to quote the
 * clause verbatim — it has to address the substance.
 * @param {string} clause - material clause text.
 * @param {string} text - candidate section text.
 * @returns {number} coverage in [0, 1].
 */
export function answerScore(clause, text) {
  const clean = String(clause).replace(/[★☆\s，。；：、（）()【】"'"'。]/gu, '')
  const bigrams = new Set()
  for (let index = 0; index + 1 < clean.length; index += 1) bigrams.add(clean.slice(index, index + 2))
  const probes = [...bigrams].filter(bigram => !/^[0-9一二三四五六七八九十]{2}$/u.test(bigram))
  if (probes.length === 0) return 0
  const sample = probes.length <= 10 ? probes : probes.filter((_, index) => index % Math.ceil(probes.length / 10) === 0).slice(0, 10)
  const haystack = String(text)
  let hit = 0
  for (const probe of sample) if (haystack.includes(probe)) hit += 1
  let score = hit / sample.length
  const identifiers = [...clean.matchAll(/[A-Za-z]{1,6}[-_]?\d{2,}|\d+(?:\.\d+)?/gu)].map(match => match[0])
  for (const identifier of identifiers.slice(0, 3)) {
    if (haystack.includes(identifier)) score = Math.min(1, score + 0.2)
  }
  return score
}

/**
 * Quote a window around an index for evidence display.
 * @param {string} text - source text.
 * @param {number} index - match position.
 * @param {number} radius - characters on each side.
 * @returns {string} contextual quote.
 */
function contextAround(text, index, radius) {
  const start = Math.max(0, index - Math.floor(radius / 2))
  return String(text).slice(start, start + radius).replace(/\s+/gu, ' ')
}
