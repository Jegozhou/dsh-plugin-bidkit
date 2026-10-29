/**
 * Agent tools.
 *
 * Seventeen typed tools cover the whole bid lifecycle: import and parse the
 * tender, lock the global facts, plan a score-aligned outline, write sections
 * (one file per call, so length is bounded only by disk), attach figures, index
 * and search the enterprise knowledge base, run the compliance review, plan
 * parallel subagent hand-offs, and export a typeset `.docx`.
 *
 * Every tool returns `{ ok: true, ... }` or `{ ok: false, error: { code,
 * message } }`; a model sees a stable code and the exact reason instead of a
 * transport exception. Every tool delegates to `BidRuntime`, which the
 * workbench HTTP API uses too, so agent and person cannot diverge.
 *
 * @module lib/tools
 */

import { StoreError } from './store.js'

/** JSON Schema helpers. */
const STRING = { type: 'string' }
const NUMBER = { type: 'number' }
const OBJECT = { type: 'object' }

/**
 * Register every BidKit tool; returns disposers.
 * @param {{ tools: { register: (definition: object) => () => void } }} ctx - plugin context.
 * @param {import('./runtime.js').BidRuntime} runtime - shared runtime.
 * @returns {Array<() => void>} disposers.
 */
export function registerTools(ctx, runtime) {
  if (typeof ctx.tools?.register !== 'function') return []
  const disposers = []

  /**
   * Register one tool with uniform error mapping and JSON output.
   * @param {string} name - tool name.
   * @param {string} description - model-facing description.
   * @param {object} parameters - object-rooted JSON Schema.
   * @param {string} title - card title.
   * @param {(args: Record<string, any>) => Promise<object>} run - implementation.
   * @returns {void}
   */
  const tool = (name, description, parameters, title, run) => {
    disposers.push(ctx.tools.register({
      name,
      description,
      parameters,
      output: {
        schema: {},
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      presentCall: args => ({ card: 'generic', title, kind: 'other', rawInput: args }),
      async execute(args) {
        try {
          return await run(args ?? {})
        } catch (error) {
          if (error instanceof StoreError) {
            return { ok: false, error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } }
          }
          return { ok: false, error: { code: 'internal', message: error instanceof Error ? error.message : String(error) } }
        }
      },
    }))
  }

  tool(
    'bid_project_create',
    'Create a bid project. Optionally import the tender document at the same time (path to .md/.txt/.docx). Returns the project id and, when imported, the deterministic parse summary. Use bid_project_list first to avoid duplicates.',
    {
      type: 'object',
      properties: {
        name: { ...STRING, description: '项目名称，例如「XX市政务云平台建设项目」。' },
        id: { ...STRING, description: '可选的项目 id（字母数字与 - _ .），省略时由项目名派生。' },
        tender_path: { ...STRING, description: '可选：招标文件绝对路径（.md/.txt/.docx）。' },
        tender_text: { ...STRING, description: '可选：直接传入招标文件正文（与 tender_path 二选一）。' },
        tender_no: { ...STRING, description: '可选：招标编号。' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    'Create bid project',
    async args => {
      if (args.tender_path !== undefined && args.tender_path !== '' && String(args.tender_path).toLowerCase().endsWith('.pdf')) {
        throw new StoreError('unsupported_format', 'PDF 招标文件请先用 bid_import_tender 之外的方式转换为 .docx/.md；当前仅支持 markdown/纯文本/docx')
      }
      const result = await runtime.createProject({
        name: args.name,
        id: args.id,
        tenderPath: args.tender_path,
        tenderText: args.tender_text,
        tenderNo: args.tender_no,
      })
      return { ok: true, project: { id: result.project.id, name: result.project.name }, imported: result.imported }
    },
  )

  tool(
    'bid_project_list',
    'List every bid project with writing progress, 18-item coverage, risk counts and whether a .docx was exported. Read-only.',
    { type: 'object', properties: {}, additionalProperties: false },
    'List bid projects',
    async () => {
      const projects = await runtime.store.list()
      const items = []
      for (const project of projects) {
        const status = await runtime.status(project.id).catch(() => null)
        items.push({
          id: project.id,
          name: project.name,
          updatedAt: project.updatedAt,
          coverage: status?.parse.coverage ?? { filled: 0, total: 18 },
          stars: status?.parse.stars ?? 0,
          sections: status?.outline.sections ?? 0,
          written: status?.writing.writtenSections ?? 0,
          words: status?.writing.words ?? 0,
          risks: status?.review?.summary ?? null,
          exported: (status?.exports ?? []).length > 0,
        })
      }
      return { ok: true, total: items.length, root: runtime.store.root, projects: items }
    },
  )

  tool(
    'bid_project_status',
    'Read one project status: tender import, 18-item coverage, locked facts, outline size/target words, writing progress and the next sections to write, figure count, last review summary and exports. Call it before resuming work after an interruption.',
    { type: 'object', properties: { project: { ...STRING, description: '项目 id。' } }, required: ['project'], additionalProperties: false },
    'Bid project status',
    async args => ({ ok: true, ...await runtime.status(args.project) }),
  )

  tool(
    'bid_import_tender',
    'Import or replace the tender document of an existing project and run the deterministic 18-item parse. Accepts a path (.md/.txt/.docx) or inline text. Replaces any previous parse.',
    {
      type: 'object',
      properties: {
        project: { ...STRING, description: '项目 id。' },
        path: { ...STRING, description: '招标文件绝对路径。' },
        text: { ...STRING, description: '或直接传入正文。' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    'Import tender document',
    async args => ({ ok: true, ...await runtime.importTender(args.project, { path: args.path, text: args.text }) }),
  )

  tool(
    'bid_parse_tender',
    'Re-run the deterministic parse on the stored tender source (for example after the source file changed). Returns coverage, material clauses, scoring counts and the missing items that need attention.',
    { type: 'object', properties: { project: { ...STRING, description: '项目 id。' } }, required: ['project'], additionalProperties: false },
    'Parse tender',
    async args => ({ ok: true, ...await runtime.reparse(args.project) }),
  )

  tool(
    'bid_commit_parse',
    'Merge your own structured 18-item reading into the deterministic parse. Supply corrected item values/status, extra material clauses, scoring tables or matrix mappings. Coverage is re-measured, and an evidence quote that does not occur in the tender source is marked unverified — so never fabricate a quote.',
    {
      type: 'object',
      properties: {
        project: { ...STRING, description: '项目 id。' },
        items: {
          type: 'array',
          description: '18 项中的部分或全部：key/label/status/value/risk/evidence/sectionId。',
          items: {
            type: 'object',
            properties: {
              key: { ...STRING, description: '固定 18 个 key 之一。' },
              status: { ...STRING, enum: ['filled', 'partial', 'missing'] },
              value: { ...STRING, description: '结构化后的内容要点（不是原文照抄也可以，但需忠于原文）。' },
              risk: { ...STRING, enum: ['low', 'medium', 'high'] },
              sectionId: { ...STRING },
              evidence: { type: 'array', items: { type: 'object', properties: { sectionId: STRING, sectionTitle: STRING, quote: STRING } } },
            },
            required: ['key'],
          },
        },
        starClauses: { type: 'array', items: OBJECT, description: '补充的★条款：text/category/strategy。' },
        scoring: {
          type: 'object',
          properties: {
            technical: { type: 'array', items: OBJECT },
            commercial: { type: 'array', items: OBJECT },
            price: { type: 'array', items: OBJECT },
          },
        },
        lots: { type: 'array', items: OBJECT },
        responseMatrix: { type: 'array', items: OBJECT, description: '把矩阵行映射到章节：id/sectionRef/status/response。' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    'Commit structured parse',
    async args => {
      const result = await runtime.commitParse(args.project, {
        items: args.items,
        starClauses: args.starClauses,
        scoring: args.scoring,
        lots: args.lots,
        responseMatrix: args.responseMatrix,
      })
      return { ok: true, ...result }
    },
  )

  tool(
    'bid_facts_lock',
    'Lock the global facts every chapter must agree with (bidder legal name, qualification numbers, certification scope, past-performance amounts, promised delivery period, warranty, key personnel, price totals). Write them once; later bid_section_write reports which facts each section used or missed, and bid_review flags contradictions. Use replace=true to reset the whole set.',
    {
      type: 'object',
      properties: {
        project: { ...STRING, description: '项目 id。' },
        facts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { ...STRING, description: '例如 投标人名称 / 资质证书编号 / 承诺工期 / 质保期。' },
              value: { ...STRING, description: '必须逐字出现在正文中的固定值。' },
              source: { ...STRING, description: '事实来源，例如营业执照/业绩合同编号/KB 文件。' },
            },
            required: ['key', 'value'],
          },
        },
        replace: { type: 'boolean', description: 'true 时用本次集合整体替换旧事实。' },
      },
      required: ['project', 'facts'],
      additionalProperties: false,
    },
    'Lock global facts',
    async args => {
      const facts = await runtime.lockFacts(args.project, args.facts ?? [], { replace: args.replace === true })
      return { ok: true, facts }
    },
  )

  tool(
    'bid_outline_plan',
    'Generate a score-aligned multi-level outline from the parsed scoring tables and material clauses: one chapter per risk area, one subsection per scoring item, ★ clauses attached to the chapter that must answer them, and word targets allocated in proportion to scoring weight. Persists the outline and returns it.',
    {
      type: 'object',
      properties: {
        project: { ...STRING, description: '项目 id。' },
        total_words: { ...NUMBER, description: '可选：全文目标字数（默认按评分权重推导）。' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    'Plan score-aligned outline',
    async args => ({ ok: true, ...await runtime.planOutline(args.project, { totalWords: args.total_words }) }),
  )

  tool(
    'bid_outline_set',
    'Replace the outline with a custom multi-level tree (id/title/level/wordTarget/scoreRefs/starRefs/strategy/children). Use it when the tender demands a fixed chapter order instead of the generated one.',
    {
      type: 'object',
      properties: { project: { ...STRING }, nodes: { type: 'array', items: OBJECT } },
      required: ['project', 'nodes'],
      additionalProperties: false,
    },
    'Set custom outline',
    async args => ({ ok: true, ...await runtime.setOutline(args.project, args.nodes ?? []) }),
  )

  tool(
    'bid_section_write',
    'Write one section body (markdown). mode=replace overwrites, mode=append continues a long chapter across multiple calls — this is how a document of unbounded length is produced without ever holding it in memory. Returns word count, target, status and which locked facts the text used or missed. Reference a figure with the token [[figure:<figureId>]] on its own line.',
    {
      type: 'object',
      properties: {
        project: { ...STRING, description: '项目 id。' },
        section_id: { ...STRING, description: '目录中的章节 id，例如 sec-6-1。' },
        markdown: { ...STRING, description: '章节正文（Markdown；支持标题/列表/表格/加粗/图 token）。' },
        mode: { ...STRING, enum: ['replace', 'append'], description: '默认 replace。' },
      },
      required: ['project', 'section_id', 'markdown'],
      additionalProperties: false,
    },
    'Write section',
    async args => ({ ok: true, ...await runtime.writeSection(args.project, args.section_id, args.markdown, args.mode === 'append' ? 'append' : 'replace') }),
  )

  tool(
    'bid_section_read',
    'Read one section body with its target words, current words, status and figures. Read-only.',
    {
      type: 'object',
      properties: { project: { ...STRING }, section_id: { ...STRING } },
      required: ['project', 'section_id'],
      additionalProperties: false,
    },
    'Read section',
    async args => ({ ok: true, section: await runtime.readSection(args.project, args.section_id) }),
  )

  tool(
    'bid_figure_add',
    'Render a technical figure into the project and return the [[figure:<id>]] token to place in a section. kind=mermaid accepts the documented flowchart subset (`flowchart TB`, `A[标签] --> B[标签]`, `A -- 说明 --> B`, `A{判断}`); kind=flow takes steps[{title,detail}]; kind=architecture takes layers[{name,items[{label,note}]}]; kind=svg embeds a sanitized standalone SVG. Chinese labels stay vector text in the exported .docx.',
    {
      type: 'object',
      properties: {
        project: { ...STRING, description: '项目 id。' },
        section_id: { ...STRING, description: '图所属章节 id。' },
        kind: { ...STRING, enum: ['mermaid', 'flow', 'architecture', 'svg'] },
        source: { ...STRING, description: 'mermaid / svg 源码。' },
        steps: { type: 'array', items: OBJECT, description: 'flow 步骤。' },
        layers: { type: 'array', items: OBJECT, description: 'architecture 层。' },
        title: { ...STRING, description: '图题，例如「图 6-1 系统总体架构」。' },
      },
      required: ['project', 'section_id', 'kind'],
      additionalProperties: false,
    },
    'Add figure',
    async args => ({ ok: true, ...await runtime.addFigure(args.project, {
      sectionId: args.section_id,
      kind: args.kind,
      source: args.source,
      steps: args.steps,
      layers: args.layers,
      title: args.title,
    }) }),
  )

  tool(
    'bid_kb_index',
    'Build or rebuild the enterprise knowledge base index for a project from directories of qualifications, past performance and technical write-ups (.md/.txt/.csv). Each chunk is retrievable with its file and heading so a section quotes real material instead of inventing it.',
    {
      type: 'object',
      properties: {
        project: { ...STRING, description: '项目 id。' },
        dirs: { type: 'array', items: STRING, description: '额外素材目录绝对路径（插件配置的 kbDir 与项目 kb/source 始终会被索引）。' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    'Index knowledge base',
    async args => ({ ok: true, ...await runtime.indexKb(args.project, { dirs: args.dirs ?? [] }) }),
  )

  tool(
    'bid_kb_search',
    'Search the project knowledge base (BM25 over Chinese bigrams) and return the exact source chunk, file and heading. Use it before writing any claim about qualifications, certificates, staff or past projects.',
    {
      type: 'object',
      properties: {
        project: { ...STRING, description: '项目 id。' },
        query: { ...STRING, description: '检索词，例如「信息系统集成 二级 资质」。' },
        limit: { ...NUMBER, description: '返回条数，1-20，默认 6。' },
        file: { ...STRING, description: '可选：只在文件名包含该子串的素材中检索。' },
      },
      required: ['project', 'query'],
      additionalProperties: false,
    },
    'Search knowledge base',
    async args => ({ ok: true, ...await runtime.searchKb(args.project, args.query, { limit: args.limit, file: args.file }) }),
  )

  tool(
    'bid_review',
    'Run the full compliance review: ★ clause coverage, mandatory item gaps, placeholders, locked-fact contradictions, unwritten/short sections, negative commitments, typos, self-duplication, missing figures, and — when compare_with is given — cross-bid similarity for 围标/串标 risk. Persists the review and returns findings grouped by severity.',
    {
      type: 'object',
      properties: {
        project: { ...STRING, description: '项目 id。' },
        compare_with: { ...STRING, description: '可选：另一份标书的项目 id，用于查重对比。' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    'Run compliance review',
    async args => ({ ok: true, review: await runtime.review(args.project, { compareWith: args.compare_with }) }),
  )

  tool(
    'bid_export_docx',
    'Export the project to a typeset Word .docx (cover, automatic TOC field, Chinese heading/body fonts, page numbers, tables, native vector figures). out_path writes a copy to an absolute path in addition to the project exports directory.',
    {
      type: 'object',
      properties: {
        project: { ...STRING, description: '项目 id。' },
        out_path: { ...STRING, description: '可选：额外写一份到该绝对路径（例如工作区内的交付文件）。' },
        filename: { ...STRING, description: '可选：文件名（不含扩展名）。' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    'Export .docx',
    async args => ({ ok: true, ...await runtime.exportDocx(args.project, { outPath: args.out_path, filename: args.filename }) }),
  )

  tool(
    'bid_handoff_plan',
    'Plan parallel long-form authoring: groups the unwritten sections into batches, carries the locked global facts and each chapter strategy into a ready-to-paste subagent prompt, and states the exact per-section write call. Nothing is executed — you spawn the subagents (Harness subagent/PTC) with these prompts, then re-run bid_review.',
    {
      type: 'object',
      properties: {
        project: { ...STRING, description: '项目 id。' },
        batch_size: { ...NUMBER, description: '每个子智能体负责的章节数，1-12，默认 3。' },
        section_ids: { type: 'array', items: STRING, description: '可选：只规划这些章节。' },
      },
      required: ['project'],
      additionalProperties: false,
    },
    'Plan subagent hand-off',
    async args => ({ ok: true, ...await runtime.handoff(args.project, { batchSize: args.batch_size, sectionIds: args.section_ids }) }),
  )

  return disposers
}
