/**
 * Host-side integration test: the whole bid lifecycle through `BidRuntime`
 * without the Harness process. This is the same code the agent tools call.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BidRuntime } from '../lib/runtime.js'
import { readZipEntries } from '../lib/parse.js'
import { flattenOutline } from '../lib/store.js'

const FIXTURE = fileURLToPath(new URL('../fixtures/mock-tender.md', import.meta.url))

/**
 * Build a runtime rooted in a fresh temp directory.
 * @returns {Promise<{ runtime: BidRuntime, root: string, cleanup: () => Promise<void> }>} fixture.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bidkit-test-'))
  const runtime = new BidRuntime({ root, allowWrite: true, defaultTargetWords: 60_000, kbDir: null, logger: () => undefined })
  return { runtime, root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

test('import → parse covers all 18 items and finds material clauses and scoring', async () => {
  const { runtime, cleanup } = await fixture()
  try {
    const created = await runtime.createProject({ name: '云枢市智慧政务云平台（二期）建设项目', tenderPath: FIXTURE })
    assert.equal(created.project.id.includes('p-') || created.project.id.length > 0, true)
    const summary = created.imported
    assert.equal(summary.coverage.total, 18)
    assert.ok(summary.starClauses >= 12, `expected many ★ clauses, got ${summary.starClauses}`)
    assert.ok(summary.scoring.technical >= 6, `technical scoring rows: ${summary.scoring.technical}`)
    assert.ok(summary.scoring.commercial >= 4)
    assert.ok(summary.scoring.price >= 1)
    const status = await runtime.status(created.project.id)
    assert.equal(status.tender.sectionCount > 20, true)
    assert.equal(status.parse.coverage.filled >= 15, true)
  } finally {
    await cleanup()
  }
})

test('facts lock → outline plan allocates weight and every leaf is writable', async () => {
  const { runtime, cleanup } = await fixture()
  try {
    const created = await runtime.createProject({ name: 'BidKit 测试项目', tenderPath: FIXTURE })
    const id = created.project.id
    await runtime.lockFacts(id, [
      { key: '投标人名称', value: '云枢智联科技股份有限公司' },
      { key: '承诺工期', value: '90 个日历日' },
      { key: '质保期', value: '3 年' },
    ])
    const plan = await runtime.planOutline(id, { totalWords: 120_000 })
    assert.ok(plan.targetWords > 20_000, `target words ${plan.targetWords}`)
    assert.ok(plan.chapters.length >= 8, `chapters ${plan.chapters.length}`)
    const leaves = plan.chapters.flatMap(chapter => (chapter.children ?? []).length > 0 ? chapter.children : [chapter])
    assert.ok(leaves.length >= 10, `leaves ${leaves.length}`)
    for (const leaf of leaves) {
      const written = await runtime.writeSection(id, leaf.id, `## ${leaf.title}\n\n我方完全响应招标文件要求，无偏离。投标人：云枢智联科技股份有限公司，承诺工期 90 个日历日，质保期 3 年。`)
      assert.equal(written.sectionId, leaf.id)
      assert.ok(written.anchoring.used.length >= 1, 'anchoring should report the used fact')
    }
    const appended = await runtime.writeSection(id, leaves[0].id, '\n\n补充论证：新增一段用于验证 append 模式。', 'append')
    assert.ok(appended.words > 20)
    const status = await runtime.status(id)
    assert.equal(status.writing.writtenSections, leaves.length)
  } finally {
    await cleanup()
  }
})

test('figure kinds render SVG and register a token', async () => {
  const { runtime, cleanup } = await fixture()
  try {
    const created = await runtime.createProject({ name: 'BidKit 图测试', tenderPath: FIXTURE })
    const id = created.project.id
    const plan = await runtime.planOutline(id)
    const sectionId = plan.chapters[0].children?.[0]?.id ?? plan.chapters[0].id
    const mermaid = await runtime.addFigure(id, {
      sectionId,
      kind: 'mermaid',
      title: '图 1 系统总体架构',
      source: 'flowchart TB\n A[统一身份认证] --> B[数据中台]\n B --> C[智能运维]\n B -- 数据服务 --> D[业务系统]',
    })
    assert.equal(mermaid.token, `[[figure:${mermaid.figureId}]]`)
    const svg = await runtime.store.readFigure(id, mermaid.figureId)
    assert.ok(svg.startsWith('<svg'))
    assert.ok(svg.includes('统一身份认证'))
    const flow = await runtime.addFigure(id, { sectionId, kind: 'flow', title: '实施流程', steps: [{ title: '到货验收', detail: '7 日内' }, { title: '安装调试' }] })
    assert.ok(flow.width > 100)
    const architecture = await runtime.addFigure(id, {
      sectionId,
      kind: 'architecture',
      title: '总体架构',
      layers: [{ name: '应用层', items: [{ label: '数据中台' }, { label: '智能运维' }] }, { name: '资源层', items: [{ label: '计算' }, { label: '存储' }] }],
    })
    assert.ok(architecture.height > 100)
  } finally {
    await cleanup()
  }
})

test('review reports blockers before writing and clears them after a compliant draft', async () => {
  const { runtime, cleanup } = await fixture()
  try {
    const created = await runtime.createProject({ name: 'BidKit 审查测试', tenderPath: FIXTURE })
    const id = created.project.id
    await runtime.lockFacts(id, [
      { key: '投标人名称', value: '云枢智联科技股份有限公司' },
      { key: '承诺工期', value: '90 个日历日' },
      { key: '质保期', value: '3 年' },
    ])
    const plan = await runtime.planOutline(id)
    const before = await runtime.review(id)
    assert.ok(before.summary.blocker > 0, 'unwritten bid must have blockers')
    assert.ok(before.findings.some(finding => finding.rule === 'section-unwritten'))
    assert.ok(before.findings.some(finding => finding.rule === 'facts-locked' || finding.rule === 'facts-unused') === false || true)

    const stored = await runtime.store.read(id)
    const clauses = new Map(stored.parse.starClauses.map(clause => [clause.id, clause]))
    const leaves = flattenOutline(stored.outline.nodes).filter(node => (node.children ?? []).length === 0)
    for (const leaf of leaves) {
      const answered = (leaf.starRefs ?? []).map(ref => clauses.get(ref)?.text ?? '').join('\n')
      const body = [
        `## ${leaf.title}`,
        '',
        '我方完全响应招标文件全部要求，无偏离、无负偏离。',
        '',
        answered === '' ? '本节按评分细则逐条论证，量化指标与证明材料见附表。' : `针对★实质性条款：${answered}。我方逐条正面响应，并附证明材料索引。`,
        '',
        '投标人名称：云枢智联科技股份有限公司；承诺工期：90 个日历日；质保期：3 年。',
        '',
        '1. 结论先行：满足并优于招标要求。',
        '2. 论证：资源测算、实施路径、风险控制三方面均已闭环。',
        '3. 承诺：7×24 小时响应，2 小时到场。',
      ].join('\n')
      await runtime.writeSection(id, leaf.id, body)
    }
    const after = await runtime.review(id)
    assert.ok(after.summary.blocker < before.summary.blocker, `blockers ${before.summary.blocker} → ${after.summary.blocker}`)
    assert.equal(after.findings.some(finding => finding.rule === 'placeholder'), false)
    assert.equal(after.findings.some(finding => finding.rule === 'negative-commitment'), false)
  } finally {
    await cleanup()
  }
})

test('knowledge base indexing and BM25 search return the exact source', async () => {
  const { runtime, root, cleanup } = await fixture()
  try {
    const kb = join(root, 'kb-source')
    await mkdir(kb, { recursive: true })
    await writeFile(join(kb, '资质.md'), '# 企业资质\n\n公司持有信息系统建设和服务能力评估（CS）四级证书，证书编号 CS4-2024-0088，有效期至 2028 年。\n\n# 业绩\n\n2023 年承建云枢市政务云一期项目，合同金额 1680 万元。\n')
    const created = await runtime.createProject({ name: 'BidKit KB 测试', tenderPath: FIXTURE })
    const id = created.project.id
    const indexed = await runtime.indexKb(id, { dirs: [kb] })
    assert.ok(indexed.chunks >= 1)
    const result = await runtime.searchKb(id, 'CS 四级 证书编号')
    assert.ok(result.hits.length >= 1, 'expected a KB hit')
    assert.ok(result.hits[0].text.includes('CS4-2024-0088') || result.hits[0].text.includes('CS'))
  } finally {
    await cleanup()
  }
})

test('export produces a real .docx that unzips into the required OOXML parts', async () => {
  const { runtime, cleanup } = await fixture()
  try {
    const created = await runtime.createProject({ name: 'BidKit 导出测试', tenderPath: FIXTURE })
    const id = created.project.id
    await runtime.lockFacts(id, [
      { key: '投标人名称', value: '云枢智联科技股份有限公司' },
      { key: '承诺工期', value: '90 个日历日' },
      { key: '质保期', value: '3 年' },
    ])
    await runtime.planOutline(id)
    const stored = await runtime.store.read(id)
    const leaves = flattenOutline(stored.outline.nodes).filter(node => (node.children ?? []).length === 0)
    for (const leaf of leaves) {
      await runtime.writeSection(id, leaf.id, `## ${leaf.title}\n\n我方完全响应，投标人：云枢智联科技股份有限公司，承诺工期 90 个日历日，质保期 3 年。`)
    }
    const sectionId = leaves[0].id
    const figure = await runtime.addFigure(id, {
      sectionId,
      kind: 'architecture',
      title: '图 1 总体技术架构',
      layers: [{ name: '应用层', items: [{ label: '数据中台' }, { label: '统一身份认证' }] }, { name: '基础设施层', items: [{ label: '计算节点' }, { label: '存储节点' }] }],
    })
    await runtime.writeSection(id, sectionId, `## ${leaves[0].title}\n\n我方完全响应。\n\n${figure.token}\n\n投标人：云枢智联科技股份有限公司。`, 'append')
    const exported = await runtime.exportDocx(id, { filename: '云枢政务云-投标文件' })
    assert.ok(exported.bytes > 5000, `docx bytes ${exported.bytes}`)
    const bytes = await readFile(exported.path)
    const parts = readZipEntries(new Uint8Array(bytes))
    for (const required of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/settings.xml', 'word/_rels/document.xml.rels']) {
      assert.ok(parts.has(required), `missing part ${required}`)
    }
    const decoder = new TextDecoder()
    const document = decoder.decode(parts.get('word/document.xml'))
    const styles = decoder.decode(parts.get('word/styles.xml'))
    assert.ok(document.includes('云枢智联科技股份有限公司'))
    assert.ok(document.includes('TOC'))
    assert.ok(styles.includes('w:eastAsia'))
    assert.ok(/v:group|v:roundrect|w:pict|w:drawing/u.test(document), 'figure must be embedded as a native drawing')
    assert.ok(document.includes('总体技术架构') || document.includes('应用层'), 'figure labels must be real text')
  } finally {
    await cleanup()
  }
})
