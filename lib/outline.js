/**
 * Score-aligned outline planning.
 *
 * A bid outline is not a table of contents copied from the tender: it is the
 * cheapest way to convert scoring weight into earned points. This module maps
 * every scoring item and every material (★) clause onto exactly one chapter,
 * allocates word targets in proportion to the weight each chapter can earn, and
 * emits a stable section id per node so chapters written in parallel by
 * subagents can never collide.
 *
 * Pure and deterministic: the same parse always yields the same outline, which
 * is what makes a re-plan after an interruption safe.
 *
 * @module lib/outline
 */

/** Per-point word target used to size a scoring chapter. */
const WORDS_PER_POINT = 140
/** Minimum words for a scored subsection. */
const MIN_SECTION_WORDS = 600
/** Maximum words one subsection may be asked to produce in a single turn. */
const MAX_SECTION_WORDS = 8000
/** Words for one material-clause response subsection. */
const STAR_SECTION_WORDS = 700
/** Words for a fixed boilerplate chapter. */
const BOILERPLATE_WORDS = 800

/**
 * Fixed chapter templates.
 *
 * `subsections` are the chapters that do not map one-to-one onto a scoring
 * table: their content is defined by the bid process itself. `bucket` is the
 * single scoring bucket a chapter consumes — a scoring item is never duplicated
 * across chapters, which is what keeps a 100-point tender from producing a
 * meaningless 700k-word outline.
 */
const CHAPTER_TEMPLATES = Object.freeze([
  {
    key: 'letter',
    title: '投标函及投标函附录',
    level: 1,
    words: 800,
    match: () => true,
    strategy: '按招标文件给定格式逐字填写，报价大写与小写一致，签字盖章齐全。',
    subsections: [],
  },
  {
    key: 'authorization',
    title: '法定代表人身份证明及授权委托书',
    level: 1,
    words: 600,
    match: () => true,
    strategy: '身份证明、授权书、被授权人身份证三件套，授权期限覆盖投标有效期。',
    subsections: [],
  },
  {
    key: 'bond',
    title: '投标保证金',
    level: 1,
    words: 500,
    match: parse => parse.starClauses.some(clause => /保证金|保函/u.test(clause.category)) || hasItem(parse, 'bid_bond'),
    strategy: '保函/回单原件扫描，金额、有效期、收款账户逐项核对。',
    subsections: [],
  },
  {
    key: 'qualification',
    title: '投标人资格证明文件',
    level: 1,
    words: 1200,
    match: parse => hasItem(parse, 'qualification') || parse.starClauses.some(clause => /资格文件/u.test(clause.category)),
    strategy: '按资格要求顺序编排证照与承诺函，逐项编号引用招标文件条款。',
    subsections: [
      { title: '营业执照与主体资格证明', words: 1200 },
      { title: '企业资质证书', words: 1600 },
      { title: '财务报告与纳税社保证明', words: 1200 },
      { title: '无重大违法记录声明', words: 800 },
    ],
  },
  {
    key: 'commercial',
    title: '商务响应与偏离表',
    level: 1,
    words: 1600,
    match: parse => hasItem(parse, 'commercial_scoring') || parse.starClauses.some(clause => /商务/u.test(clause.category)),
    strategy: '商务条款逐条响应，全部标注"无偏离"；★条款单独成表并引用证明页码。',
    bucket: 'commercial',
    subsections: [{ title: '商务条款响应与偏离说明', words: 1600 }],
  },
  {
    key: 'technical',
    title: '技术方案',
    level: 1,
    words: 2000,
    match: () => true,
    strategy: '对应技术评分细则逐项展开，先结论后论证，配架构图与流程图。',
    bucket: 'technical',
    subsections: [{ title: '总体设计原则与响应总述', words: 1600 }],
  },
  {
    key: 'implementation',
    title: '项目实施与进度计划',
    level: 1,
    words: 2400,
    match: parse => hasItem(parse, 'delivery') || hasItem(parse, 'procurement_list'),
    strategy: '里程碑+甘特图+资源配置表，工期承诺必须严于招标要求。',
    subsections: [
      { title: '项目组织架构与资源投入', words: 1600 },
      { title: '实施步骤与进度计划', words: 2400 },
      { title: '关键里程碑与交付物清单', words: 1200 },
      { title: '风险识别与应对措施', words: 1400 },
    ],
  },
  {
    key: 'quality',
    title: '质量保证措施',
    level: 1,
    words: 1800,
    match: () => true,
    strategy: '质量目标可量化、过程控制有记录、验收标准与招标文件一致。',
    subsections: [
      { title: '质量目标与质量体系', words: 1200 },
      { title: '过程质量控制措施', words: 1400 },
      { title: '测试与验收方案', words: 1400 },
    ],
  },
  {
    key: 'service',
    title: '售后服务与运维方案',
    level: 1,
    words: 1600,
    match: parse => hasItem(parse, 'warranty') || parse.starClauses.some(clause => /售后服务/u.test(clause.category)),
    strategy: '响应时限、备件库存、驻场安排、升级机制全部量化承诺。',
    subsections: [
      { title: '服务响应机制与 SLA 承诺', words: 1400 },
      { title: '驻场与备件保障', words: 1200 },
      { title: '培训与知识转移方案', words: 1000 },
    ],
  },
  {
    key: 'price',
    title: '投标报价文件',
    level: 1,
    words: 900,
    match: () => true,
    strategy: '开标一览表、分项报价表、价格构成说明保持三处一致。',
    bucket: 'price',
    subsections: [{ title: '分项报价与价格构成说明', words: 1200 }],
  },
  {
    key: 'performance',
    title: '企业业绩与信誉证明',
    level: 1,
    words: 1200,
    match: parse => parse.scoring.commercial.length > 0 || parse.starClauses.some(clause => /业绩/u.test(clause.category)),
    strategy: '同类项目合同+验收证明，按评分细则的时间/金额/行业口径筛选。',
    subsections: [
      { title: '同类项目业绩清单与证明', words: 1800 },
      { title: '客户评价与企业信誉', words: 900 },
    ],
  },
  {
    key: 'appendix',
    title: '其他材料与附件',
    level: 1,
    words: 700,
    match: () => true,
    strategy: '招标文件要求但未在正文覆盖的材料统一编号附后。',
    subsections: [],
  },
])

/**
 * Map a material clause category to the fixed chapter key that answers it.
 * @param {string} category - clause category from the parser.
 * @returns {string} chapter template key.
 */
export function chapterForCategory(category) {
  if (/资格/u.test(category)) return 'qualification'
  if (/保证金/u.test(category)) return 'bond'
  if (/签署/u.test(category)) return 'letter'
  if (/装订/u.test(category)) return 'appendix'
  if (/时间/u.test(category)) return 'letter'
  if (/技术参数/u.test(category)) return 'technical'
  if (/报价/u.test(category)) return 'price'
  if (/业绩/u.test(category)) return 'performance'
  if (/售后/u.test(category)) return 'service'
  return 'commercial'
}

/**
 * Build a score-aligned outline.
 * @param {object} parse - parse document from `parseTender` / `bid_commit_parse`.
 * @param {{ totalWords?: number, defaultTargetWords?: number, includeSubtrees?: boolean }} [options] - sizing options.
 * @returns {{ nodes: object[], targetWords: number, rationale: object[] }} outline and its scoring rationale.
 */
export function planOutline(parse, options = {}) {
  const scoring = parse?.scoring ?? { technical: [], commercial: [], price: [] }
  const stars = Array.isArray(parse?.starClauses) ? parse.starClauses : []
  const totalScore = sumScore(scoring)
  const requested = Number(options.totalWords) || 0
  const perPoint = totalScore > 0 && requested > 0
    ? Math.max(120, Math.min(600, Math.round(requested / totalScore)))
    : WORDS_PER_POINT
  const nodes = []
  const rationale = []
  let counter = 0

  for (const template of CHAPTER_TEMPLATES) {
    if (!template.match(parse)) continue
    counter += 1
    const chapter = {
      id: `sec-${counter}`,
      title: template.title,
      level: template.level,
      wordTarget: template.words,
      status: 'pending',
      scoreRefs: [],
      starRefs: [],
      strategy: template.strategy,
      children: [],
    }

    // 1) scoring items — allocated to exactly one chapter (the bucket owner)
    if (template.bucket !== undefined) {
      for (const item of scoring[template.bucket]) {
        const weight = Number(item.maxScore) || 0
        chapter.children.push({
          id: `${chapter.id}-${chapter.children.length + 1}`,
          title: cleanTitle(item.item),
          level: 2,
          wordTarget: clampWords(weight * perPoint),
          status: 'pending',
          scoreRefs: [`${template.bucket}:${item.item}`],
          starRefs: [],
          strategy: item.criteria === '' ? '按评分细则逐项响应' : item.criteria,
          children: [],
        })
        chapter.scoreRefs.push(`${template.bucket}:${item.item}`)
      }
    }

    // 2) fixed process subsections
    for (const sub of template.subsections ?? []) {
      chapter.children.push({
        id: `${chapter.id}-${chapter.children.length + 1}`,
        title: sub.title,
        level: 2,
        wordTarget: clampWords(sub.words),
        status: 'pending',
        scoreRefs: [],
        starRefs: [],
        strategy: template.strategy,
        children: [],
      })
    }

    // 3) one subsection per material clause this chapter owns
    for (const clause of stars) {
      if (chapterForCategory(clause.category) !== template.key) continue
      chapter.starRefs.push(clause.id)
      chapter.children.push({
        id: `${chapter.id}-${chapter.children.length + 1}`,
        title: `★响应：${cleanTitle(clause.text).slice(0, 34)}`,
        level: 2,
        wordTarget: STAR_SECTION_WORDS,
        status: 'pending',
        scoreRefs: [],
        starRefs: [clause.id],
        strategy: clause.strategy,
        children: [],
      })
    }

    if (chapter.children.length > 0) chapter.wordTarget = 0
    nodes.push(chapter)
    rationale.push({
      chapter: chapter.title,
      scoreWeight: chapter.scoreRefs.length,
      starClauses: chapter.starRefs.length,
      subSections: chapter.children.length,
      wordTarget: chapter.children.reduce((total, child) => total + child.wordTarget, 0),
      reason: chapter.children.length > 0
        ? `对应 ${chapter.scoreRefs.length} 项评分细则与 ${chapter.starRefs.length} 条★条款，按分值配吨位`
        : '格式性必备章节，按招标文件规定篇幅编制',
    })
  }

  return {
    nodes,
    targetWords: sumWords(nodes),
    perPoint,
    rationale,
    plannedAt: new Date().toISOString(),
  }
}

/**
 * Clamp one section's word target.
 * @param {number} value - raw target.
 * @returns {number} clamped target.
 */
function clampWords(value) {
  return Math.min(MAX_SECTION_WORDS, Math.max(MIN_SECTION_WORDS, Math.round(Number(value) || 0)))
}

/**
 * Whether the parse contains a filled item.
 * @param {object} parse - parse document.
 * @param {string} key - item key.
 * @returns {boolean} true when the item has evidence.
 */
function hasItem(parse, key) {
  const item = (parse?.items ?? []).find(entry => entry.key === key)
  return item !== undefined && item.status !== 'missing'
}

/**
 * Sum scoring weights.
 * @param {{technical: object[], commercial: object[], price: object[]}} scoring - buckets.
 * @returns {number} total weight.
 */
function sumScore(scoring) {
  return ['technical', 'commercial', 'price'].reduce((total, bucket) => {
    return total + (scoring?.[bucket] ?? []).reduce((sum, item) => sum + (Number(item.maxScore) || 0), 0)
  }, 0)
}

/**
 * Sum word targets of a nested outline.
 * @param {object[]} nodes - outline nodes.
 * @returns {number} total.
 */
export function sumWords(nodes) {
  return (nodes ?? []).reduce((total, node) => total + (Number(node.wordTarget) || 0) + sumWords(node.children), 0)
}

/**
 * Normalize a scoring-item title into a chapter title an evaluator can scan.
 * @param {string} value - raw item text.
 * @returns {string} cleaned title.
 */
export function cleanTitle(value) {
  const text = String(value ?? '')
    .replace(/[★☆]/gu, '')
    .replace(/^[\d.\s、）)]+/u, '')
    .replace(/\s{2,}/gu, ' ')
    .replace(/[。；;]$/u, '')
    .trim()
  return text === '' ? '其他响应内容' : text.slice(0, 40)
}

/**
 * Flatten a nested outline into depth-first order (stable ids preserved).
 * @param {object[]} nodes - outline nodes.
 * @returns {object[]} flat nodes.
 */
export function flatten(nodes) {
  const flat = []
  const visit = list => {
    for (const node of list ?? []) {
      flat.push({ ...node, children: undefined })
      visit(node.children)
    }
  }
  visit(nodes)
  return flat
}

/**
 * Build a hand-off plan for parallel long-form authoring.
 *
 * The plan groups leaf sections into batches small enough for one subagent
 * turn, carries the locked facts and the chapter strategy into each batch, and
 * states the exact tool call the subagent must make. Nothing here executes
 * anything: subagents are the Harness-native way to write concurrently, so the
 * plugin only prepares the work units.
 * @param {object} index - project index.
 * @param {{ batchSize?: number, sectionIds?: string[] }} [options] - batch options.
 * @returns {{ batches: object[], stats: object }} hand-off plan.
 */
export function planHandoff(index, options = {}) {
  const batchSize = Math.min(Math.max(Math.trunc(options.batchSize ?? 3), 1), 12)
  const selected = new Set(options.sectionIds ?? [])
  const leaves = []
  for (const node of flatten(index.outline?.nodes ?? [])) {
    if (node.status === 'done') continue
    if (selected.size > 0 && !selected.has(node.id)) continue
    leaves.push(node)
  }
  const facts = (index.facts ?? []).map(fact => `${fact.key}：${fact.value}`)
  const batches = []
  for (let start = 0; start < leaves.length; start += batchSize) {
    const slice = leaves.slice(start, start + batchSize)
    batches.push({
      index: batches.length + 1,
      sectionIds: slice.map(node => node.id),
      title: slice.length === 1 ? slice[0].title : `${slice[0].title} 等 ${slice.length} 节`,
      targetWords: slice.reduce((total, node) => total + (Number(node.wordTarget) || 0), 0),
      expectedWords: slice.reduce((total, node) => total + countLeaves(node), 0),
      facts,
      instructions: slice.map(node => ({
        sectionId: node.id,
        title: node.title,
        wordTarget: node.wordTarget,
        strategy: node.strategy ?? '',
        scoreRefs: node.scoreRefs ?? [],
        starRefs: node.starRefs ?? [],
      })),
      prompt: buildSubagentPrompt(index, slice, facts),
    })
  }
  return {
    batches,
    stats: {
      pendingSections: leaves.length,
      batchSize,
      batchCount: batches.length,
      factsLocked: facts.length,
      estimatedWords: leaves.reduce((total, node) => total + (Number(node.wordTarget) || 0), 0),
      note: '每个 batch 交给一个子智能体（subagent/PTC）；正文通过 bid_section_write 落盘，主智能体只需汇总 bid_review。',
    },
  }
}

/**
 * Count leaves under a node.
 * @param {object} node - outline node.
 * @returns {number} leaf count.
 */
function countLeaves(node) {
  const children = node.children ?? []
  return children.length === 0 ? 1 : children.reduce((total, child) => total + countLeaves(child), 0)
}

/**
 * Build one subagent prompt from the batch plan.
 * @param {object} index - project index.
 * @param {object[]} slice - sections in the batch.
 * @param {string[]} facts - locked facts as `key：value`.
 * @returns {string} prompt text.
 */
function buildSubagentPrompt(index, slice, facts) {
  const lines = [
    `你是「${index.name}」标书写作子智能体。只写下面列出的章节，不要改动其他章节。`,
    `项目：${index.name}（id: ${index.id}）`,
    '',
    '必须遵守的全局事实（不得改写、不得与之矛盾）：',
    ...(facts.length === 0 ? ['（未锁定任何事实；请先向主智能体确认）'] : facts.map(fact => `- ${fact}`)),
    '',
    '本次章节：',
  ]
  for (const node of slice) {
    lines.push(`- ${node.id}｜${node.title}｜目标 ${node.wordTarget} 字｜策略：${node.strategy ?? '按评分细则展开'}`)
  }
  lines.push(
    '',
    '写作要求：',
    '1. 每节先给结论段，再分点论证，最后给证明材料/承诺索引；不得出现占位符。',
    '2. 涉及星号实质性条款的章节，必须逐条正面响应并写明"无偏离"。',
    '3. 完成后对每节调用一次：bid_section_write(project, section_id, markdown, mode="replace")。',
    '4. 不要调用 bid_export_docx、bid_review，也不要修改 project.json 的其他字段。',
  )
  return lines.join('\n')
}
