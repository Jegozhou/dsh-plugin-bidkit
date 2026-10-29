/**
 * BidKit — browser half of the tender/bid workbench plugin.
 *
 * Loader format: `window.__ModuleLoader__.load({ id, factory })`. The factory
 * returns a Cordis Client plugin `{ inject: ['slots'], apply }`.
 *
 * Slots:
 * - `main` (keyed)             -> full-size workbench page, key `dsh-plugin-bidkit`.
 * - `sidebar.panellist` (list) -> icon that selects that page, id `dsh-plugin-bidkit`.
 *
 * Data: only the Host HTTP API under `/dsh-plugin-bidkit/api` (CONTRACT.md §2),
 * always same-origin with `credentials: 'same-origin'`. When a route or a
 * payload shape is missing the page renders a localized "unavailable" state and
 * never fabricates data.
 *
 * Styling: inline style objects whose colours come exclusively from
 * `--dsw-alias-*` theme tokens. The single injected `<style>` element only
 * carries pseudo-class states, scrollbars and the markdown typography reset, so
 * no DOM outside this component tree is touched; it is removed on dispose.
 *
 * Locale: registers the `bidkit` namespace with zh + en dictionaries through
 * `ctx.locale` when available, guarded with try/catch, and falls back to an
 * in-file dictionary so the page works even when the locale service is absent.
 *
 * Lifecycle: every registration is an `ctx.effect` (or a `ctx.slots.inject`
 * callback that returns the registration disposer), so uninstalling the plugin
 * leaves nothing behind. The page is wrapped in a hand-written React error
 * boundary: a render failure shows a localized recovery card instead of
 * blanking the whole slot.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-bidkit',
  factory(require) {
    'use strict'

    /** React is the only import; no Harness Client package is referenced. */
    const React = require('react')
    const h = React.createElement

    /** Page key in the `main` slot and icon id in `sidebar.panellist`. */
    const PANEL_ID = 'dsh-plugin-bidkit'
    /** Locale namespace owned by this plugin's Client half. */
    const LOCALE_NS = 'bidkit'
    /** Same-origin HTTP API base (CONTRACT.md §2). */
    const API_BASE = '/dsh-plugin-bidkit/api'
    /** Shown wherever a payload field is missing: never a made-up value. */
    const NOT_AVAILABLE = '—'

    /** Row statistics per severity, in display order. */
    const SEVERITIES = ['blocker', 'major', 'minor']
    /** Scoring categories in display order (CONTRACT.md §2.2). */
    const SCORE_CATEGORIES = [
      { key: 'technical', labelKey: 'scoringTechnical' },
      { key: 'commercial', labelKey: 'scoringCommercial' },
      { key: 'price', labelKey: 'scoringPrice' },
    ]
    /** Tabs in display order. */
    const TABS = [
      { key: 'parse', labelKey: 'tabParse' },
      { key: 'outline', labelKey: 'tabOutline' },
      { key: 'preview', labelKey: 'tabPreview' },
      { key: 'review', labelKey: 'tabReview' },
    ]

    /**
     * Built-in dictionaries. The `en` dictionary is the key contract: `zh` must
     * expose exactly the same keys so either language can render every string.
     */
    const DICTS = {
      en: {
        panel: 'BidKit',
        title: 'BidKit Workbench',
        subtitle: 'Tender parsing, outline planning, drafting and compliance review',
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
        updatedAt: 'Updated {value}',
        loadingProjects: 'Loading bid projects…',
        loadingProject: 'Loading the project…',
        loadingSection: 'Loading the section…',
        unavailable: 'Unavailable',
        unavailableHint: 'The Host API route is missing or unreadable in this composition, so this view shows no data instead of inventing it.',
        unavailableShape: 'The Host returned a payload that does not match the contract.',
        requestFailed: 'Request failed: {value}',
        unknownError: 'Unknown error',
        retry: 'Retry',
        projects: 'Projects',
        noProjects: 'No bid project yet.',
        noProjectsHint: 'Ask the agent to run bid_project_create to create one.',
        selectionHint: 'Select a project to open its workbench.',
        chipsCoverage: '18-item coverage',
        chipsSections: 'Sections',
        chipsWords: 'Words',
        chipsRisks: 'Risks',
        chipsStars: '★ clauses',
        progressTitle: 'Progress',
        tabParse: 'Tender parse',
        tabOutline: 'Outline',
        tabPreview: 'Section preview',
        tabReview: 'Risk review',
        parseItemsTitle: 'Structured tender items',
        parseCoverage: '{filled}/{total} covered',
        parseEmpty: 'This tender returned no structured item.',
        parseValueMissing: 'No extracted value',
        evidence: 'Evidence',
        evidenceCount: 'Evidence ({count})',
        hideEvidence: 'Hide evidence',
        evidenceEmpty: 'No evidence quote.',
        evidenceSection: 'Open section',
        starsTitle: '★ Substantive clauses',
        starsEmpty: 'No substantive (★) clause was detected.',
        starCategory: 'Category',
        starStrategy: 'Response strategy',
        starSection: 'Linked section',
        starNoSection: 'Not linked',
        scoringTitle: 'Scoring plan',
        scoringTechnical: 'Technical',
        scoringCommercial: 'Commercial',
        scoringPrice: 'Price',
        scoringEmpty: 'No scoring item was returned.',
        scoreItem: 'Item',
        scoreMax: 'Max score',
        scoreCriteria: 'Criteria',
        scoreSubtotal: 'Subtotal {value}',
        outlineTitle: 'Outline ({count} sections)',
        outlineEmpty: 'No outline yet. Ask the agent to plan the outline.',
        outlineHint: 'Click a section to preview it.',
        wordTarget: 'Target {value} words',
        writtenWords: '{value} words written',
        statusPending: 'Pending',
        statusWriting: 'Writing',
        statusDone: 'Done',
        riskLow: 'Low risk',
        riskMedium: 'Medium risk',
        riskHigh: 'High risk',
        statusFilled: 'Filled',
        statusPartial: 'Partial',
        statusMissing: 'Missing',
        previewEmpty: 'Pick a section in the outline.',
        previewNoContent: 'This section has no markdown body yet.',
        previewWords: '{value} words',
        previewFigures: 'Figures in this section',
        previewFigureMissing: 'Figure {value} is not available.',
        reviewTitle: 'Risk review',
        reviewRunAt: 'Run at {value}',
        reviewNever: 'No review has run yet. Ask the agent to run bid_review, or run it below.',
        reviewRerun: 'Re-run review',
        reviewRunning: 'Reviewing…',
        reviewFailed: 'Review failed: {value}',
        severityBlocker: 'Blocker',
        severityMajor: 'Major',
        severityMinor: 'Minor',
        reviewFindings: 'Findings ({count})',
        reviewNoFindings: 'No finding at any severity.',
        findingRule: 'Rule',
        findingEvidence: 'Evidence',
        findingSuggestion: 'Suggestion',
        findingSection: 'Section',
        findingJump: 'Open section',
        findingNoSection: 'Not tied to a section',
        contextTitle: 'Locked facts',
        contextEmpty: 'No locked fact yet.',
        contextLockedAt: 'Locked {value}',
        tenderInfo: 'Tender',
        tenderTitle: 'Title',
        tenderSourceFile: 'Source file',
        tenderSections: 'Split sections',
        exportsTitle: 'Exports',
        exportLatest: 'Download latest .docx',
        exportItem: '{file} · {bytes} bytes',
        crashed: 'The BidKit page hit an error.',
        crashedHint: 'The rest of the Harness UI keeps working. Rebuild the page to recover.',
        rebuild: 'Rebuild page',
      },
      zh: {
        panel: '标书工作台',
        title: 'BidKit 标书工作台',
        subtitle: '招标解析、目录编排、正文撰写与合规体检',
        refresh: '刷新',
        refreshing: '刷新中…',
        updatedAt: '更新于 {value}',
        loadingProjects: '正在读取标书项目…',
        loadingProject: '正在读取项目…',
        loadingSection: '正在读取章节…',
        unavailable: '不可用',
        unavailableHint: '当前组合中 Host API 路由缺失或无法读取，因此本页不展示任何编造的数据。',
        unavailableShape: 'Host 返回的数据结构不符合约定。',
        requestFailed: '请求失败：{value}',
        unknownError: '未知错误',
        retry: '重试',
        projects: '标书项目',
        noProjects: '尚无标书项目。',
        noProjectsHint: '请让智能体执行 bid_project_create 创建项目。',
        selectionHint: '请选择一个项目以打开工作台。',
        chipsCoverage: '18 项覆盖',
        chipsSections: '章节',
        chipsWords: '字数',
        chipsRisks: '风险',
        chipsStars: '★ 废标项',
        progressTitle: '进度',
        tabParse: '招标解析',
        tabOutline: '目录编排',
        tabPreview: '章节预览',
        tabReview: '风险审查',
        parseItemsTitle: '招标文件结构化条目',
        parseCoverage: '已覆盖 {filled}/{total}',
        parseEmpty: '该招标文件没有返回结构化条目。',
        parseValueMissing: '未提取到内容',
        evidence: '依据',
        evidenceCount: '依据（{count}）',
        hideEvidence: '收起依据',
        evidenceEmpty: '没有引文依据。',
        evidenceSection: '定位章节',
        starsTitle: '★ 实质性条款',
        starsEmpty: '未识别到 ★ 实质性条款。',
        starCategory: '类别',
        starStrategy: '响应策略',
        starSection: '关联章节',
        starNoSection: '未关联',
        scoringTitle: '评分方案',
        scoringTechnical: '技术分',
        scoringCommercial: '商务分',
        scoringPrice: '价格分',
        scoringEmpty: '没有返回评分项。',
        scoreItem: '评分项',
        scoreMax: '分值',
        scoreCriteria: '评分标准',
        scoreSubtotal: '小计 {value} 分',
        outlineTitle: '目录（{count} 节）',
        outlineEmpty: '尚无目录，请让智能体生成目录。',
        outlineHint: '点选章节即可预览正文。',
        wordTarget: '目标 {value} 字',
        writtenWords: '已写 {value} 字',
        statusPending: '待写',
        statusWriting: '写作中',
        statusDone: '已完成',
        riskLow: '低风险',
        riskMedium: '中风险',
        riskHigh: '高风险',
        statusFilled: '已覆盖',
        statusPartial: '部分',
        statusMissing: '缺失',
        previewEmpty: '请在目录中点选一个章节。',
        previewNoContent: '该章节还没有 Markdown 正文。',
        previewWords: '{value} 字',
        previewFigures: '本章图表',
        previewFigureMissing: '图表 {value} 不可用。',
        reviewTitle: '风险审查',
        reviewRunAt: '体检时间 {value}',
        reviewNever: '尚未体检，请让智能体执行 bid_review，或在下方重新体检。',
        reviewRerun: '重新体检',
        reviewRunning: '体检中…',
        reviewFailed: '体检失败：{value}',
        severityBlocker: '阻断',
        severityMajor: '重要',
        severityMinor: '提示',
        reviewFindings: '问题（{count}）',
        reviewNoFindings: '没有任何级别的问题。',
        findingRule: '规则',
        findingEvidence: '证据',
        findingSuggestion: '建议',
        findingSection: '章节',
        findingJump: '打开章节',
        findingNoSection: '未绑定章节',
        contextTitle: '全局事实锁定',
        contextEmpty: '暂无锁定事实。',
        contextLockedAt: '锁定于 {value}',
        tenderInfo: '招标信息',
        tenderTitle: '标题',
        tenderSourceFile: '源文件',
        tenderSections: '切分章节数',
        exportsTitle: '导出文件',
        exportLatest: '下载最新 .docx',
        exportItem: '{file} · {bytes} 字节',
        crashed: '标书工作台渲染出错。',
        crashedHint: 'Harness 其余界面不受影响，可重建本页恢复。',
        rebuild: '重建页面',
      },
    }

    /**
     * Pick a built-in language when the locale service is unavailable.
     * @returns {'zh'|'en'} best match for the browser, Chinese by default.
     */
    function detectLanguage() {
      try {
        if (typeof navigator === 'undefined' || navigator === null) return 'zh'
        const candidates = []
        if (Array.isArray(navigator.languages)) candidates.push(...navigator.languages)
        if (typeof navigator.language === 'string') candidates.push(navigator.language)
        for (const candidate of candidates) {
          const tag = String(candidate).toLowerCase()
          if (tag.startsWith('zh')) return 'zh'
          if (tag.startsWith('en')) return 'en'
        }
      } catch (_error) {
        /* navigator can be absent in SSR-like hosts; default below. */
      }
      return 'zh'
    }

    /**
     * Build a translator over one built-in dictionary.
     * @param {'zh'|'en'} language - dictionary to read first.
     * @returns {(key: string) => string} translator.
     */
    function makeDictionaryTranslator(language) {
      const primary = DICTS[language] ?? DICTS.zh
      return key => {
        const value = primary[key]
        if (typeof value === 'string') return value
        const fallback = DICTS.en[key]
        return typeof fallback === 'string' ? fallback : key
      }
    }

    /** Active translator; replaced by `locale.bind(NS)` when the service exists. */
    let translate = makeDictionaryTranslator(detectLanguage())

    /**
     * Translate one key with the active dictionary.
     * @param {string} key - dictionary key.
     * @returns {string} localized text (or the key when unknown).
     */
    function t(key) {
      try {
        return translate(key)
      } catch (_error) {
        return key
      }
    }

    /**
     * Translate one key and substitute `{name}` placeholders.
     * @param {string} key - dictionary key.
     * @param {Record<string, string|number>} vars - placeholder values.
     * @returns {string} localized, formatted text.
     */
    function tx(key, vars) {
      let text = t(key)
      if (!isObject(vars)) return text
      for (const [name, value] of Object.entries(vars)) {
        text = text.split(`{${name}}`).join(String(value))
      }
      return text
    }

    /**
     * Read a lazily provided Cordis service without letting a missing one throw.
     * @param {object} ctx - client plugin context.
     * @param {string} name - service name.
     * @returns {any} the service, or `undefined`.
     */
    function readService(ctx, name) {
      if (!isObject(ctx)) return undefined
      try {
        if (typeof ctx.get === 'function') {
          const service = ctx.get(name)
          if (service !== undefined && service !== null) return service
        }
      } catch (_error) {
        /* Cordis throws for undeclared services; treat as absent. */
      }
      return ctx[name]
    }

    /**
     * Run a registration inside a disposer effect, degrading to a plain call
     * when the context has no `effect` (keeps unit harnesses simple).
     * @param {object} ctx - client plugin context.
     * @param {() => (void|Function)} callback - effect body returning a disposer.
     * @param {string} label - effect label for diagnostics.
     * @returns {Function} disposer for the effect.
     */
    function registerEffect(ctx, callback, label) {
      if (isObject(ctx) && typeof ctx.effect === 'function') {
        const dispose = ctx.effect(callback, label)
        return typeof dispose === 'function' ? dispose : () => {}
      }
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    }

    /**
     * Register the `bidkit` locale namespace when the locale service is present.
     *
     * Two call shapes exist across Harness versions: the typed object form
     * `register(ns, { en, zh })` and the per-language form
     * `register(ns, language, dictionary)`. The first is attempted, the second
     * is used as a guarded fallback, and a total failure keeps the built-in
     * dictionary. `bind(NS)` then becomes the active translator.
     *
     * @param {object} ctx - client plugin context.
     */
    function registerLocale(ctx) {
      const locale = readService(ctx, 'locale')
      if (!isObject(locale) || typeof locale.register !== 'function') return
      let bound = null
      try {
        if (typeof locale.bind === 'function') bound = locale.bind(LOCALE_NS)
      } catch (error) {
        warn('locale bind failed', error)
      }
      if (typeof bound === 'function') {
        translate = key => {
          let value
          try {
            value = bound(key)
          } catch (_error) {
            value = undefined
          }
          if (typeof value === 'string' && value !== '' && value !== key) return value
          return makeDictionaryTranslator(detectLanguage())(key)
        }
      }
      registerEffect(ctx, () => {
        const disposers = []
        let registered = false
        try {
          const result = locale.register(LOCALE_NS, { en: DICTS.en, zh: DICTS.zh })
          if (typeof result === 'function') disposers.push(result)
          registered = true
        } catch (error) {
          warn('locale object registration failed, trying per-language form', error)
        }
        if (!registered) {
          for (const language of Object.keys(DICTS)) {
            try {
              const result = locale.register(LOCALE_NS, language, DICTS[language])
              if (typeof result === 'function') disposers.push(result)
            } catch (error) {
              warn(`locale registration failed for ${language}`, error)
            }
          }
        }
        return () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch (_error) {
              /* A failing disposer must not mask uninstall. */
            }
          }
        }
      }, 'dsh-plugin-bidkit: locale dictionaries')
    }

    /**
     * Log a diagnostic without ever throwing.
     * @param {string} message - human-readable context.
     * @param {unknown} error - the cause.
     */
    function warn(message, error) {
      try {
        if (typeof console !== 'undefined' && typeof console.warn === 'function') {
          console.warn(`[dsh-plugin-bidkit] ${message}`, error)
        }
      } catch (_error) {
        /* console may be missing in a sandboxed host. */
      }
    }

    /**
     * Stylesheet carrying only states inline styles cannot express: hover and
     * focus, scrollbars, and the markdown typography reset. Every colour is a
     * `--dsw-alias-*` token.
     */
    const CSS_TEXT = `
.dsh-bidkit-page, .dsh-bidkit-page *, .dsh-bidkit-page *::before, .dsh-bidkit-page *::after {
  box-sizing: border-box;
}
.dsh-bidkit-page { height: 100%; min-height: 0; }
.dsh-bidkit-page button { font: inherit; }
.dsh-bidkit-page :focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 1px;
}
.dsh-bidkit-scroll { scrollbar-width: thin; scrollbar-color: var(--dsw-alias-scrollbar-bg-l1) transparent; }
.dsh-bidkit-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.dsh-bidkit-scroll::-webkit-scrollbar-track { background: transparent; }
.dsh-bidkit-scroll::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-scrollbar-bg-l1);
  border-radius: 8px;
}
.dsh-bidkit-scroll::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-scrollbar-hover-l1); }
.dsh-bidkit-hoverable { transition: background-color 120ms ease, border-color 120ms ease; }
.dsh-bidkit-hoverable:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-bidkit-row { transition: background-color 120ms ease; }
.dsh-bidkit-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-bidkit-tab { transition: background-color 120ms ease, color 120ms ease; }
.dsh-bidkit-tab:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover); }
.dsh-bidkit-link:hover { color: var(--dsw-alias-brand-primary); text-decoration: underline; }
.dsh-bidkit-md {
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.8;
  word-break: break-word;
}
.dsh-bidkit-md > :first-child { margin-top: 0; }
.dsh-bidkit-md h1, .dsh-bidkit-md h2, .dsh-bidkit-md h3,
.dsh-bidkit-md h4, .dsh-bidkit-md h5, .dsh-bidkit-md h6 {
  margin: 18px 0 8px;
  line-height: 1.4;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.dsh-bidkit-md h1 { font-size: 20px; }
.dsh-bidkit-md h2 { font-size: 17px; }
.dsh-bidkit-md h3 { font-size: 15px; }
.dsh-bidkit-md h4, .dsh-bidkit-md h5, .dsh-bidkit-md h6 { font-size: 13px; }
.dsh-bidkit-md p { margin: 0 0 10px; }
.dsh-bidkit-md ul, .dsh-bidkit-md ol { margin: 0 0 10px; padding-left: 22px; }
.dsh-bidkit-md li { margin: 2px 0; }
.dsh-bidkit-md blockquote {
  margin: 0 0 12px;
  padding: 6px 12px;
  border-left: 3px solid var(--dsw-alias-border-l3);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  border-radius: 0 6px 6px 0;
}
.dsh-bidkit-md blockquote p:last-child { margin-bottom: 0; }
.dsh-bidkit-md pre {
  margin: 0 0 12px;
  padding: 12px;
  overflow: auto;
  background: var(--dsw-alias-markdown-code-block);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
}
.dsh-bidkit-md code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  background: var(--dsw-alias-markdown-inline-code);
  padding: 1px 4px;
  border-radius: 4px;
}
.dsh-bidkit-md pre code { background: transparent; padding: 0; }
.dsh-bidkit-md table {
  width: 100%;
  border-collapse: collapse;
  margin: 0 0 12px;
  font-size: 12px;
}
.dsh-bidkit-md th, .dsh-bidkit-md td {
  border: 1px solid var(--dsw-alias-border-l2);
  padding: 6px 8px;
  text-align: left;
  vertical-align: top;
}
.dsh-bidkit-md th {
  background: var(--dsw-alias-bg-layer-2);
  font-weight: 600;
}
.dsh-bidkit-md hr {
  border: none;
  border-top: 1px solid var(--dsw-alias-border-l2);
  margin: 16px 0;
}
.dsh-bidkit-md img {
  max-width: 100%;
  display: block;
  margin: 12px auto;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-bg-base);
}
@keyframes dsh-bidkit-spin {
  to { transform: rotate(360deg); }
}
`

    /**
     * Append the plugin stylesheet once and return its disposer. No other DOM
     * node is created outside the component tree.
     * @returns {Function} disposer removing the style element.
     */
    function installStyles() {
      if (typeof document === 'undefined' || document === null || !document.head) {
        return () => {}
      }
      const style = document.createElement('style')
      style.setAttribute('data-dsh-bidkit', '')
      style.textContent = CSS_TEXT
      document.head.append(style)
      return () => {
        try {
          style.remove()
        } catch (_error) {
          /* The element may already be gone on a hard uninstall. */
        }
      }
    }

    /** Shared inline style tokens. `/dsh-plugin-bidkit` rows are documented one by one. */
    const S = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
        fontSize: 13,
        fontFamily: 'inherit',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-base)',
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 14px',
        minHeight: 50,
        flex: '0 0 auto',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-base)',
      },
      headerText: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
      headerTitle: { fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', whiteSpace: 'nowrap' },
      headerSub: {
        fontSize: 11,
        color: 'var(--dsw-alias-label-secondary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      spacer: { flex: '1 1 auto' },
      updated: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap' },
      button: {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 7,
        fontSize: 12,
        padding: '5px 11px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      buttonPrimary: {
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-button-primary-fill)',
        color: 'var(--dsw-alias-label-primary-inverted)',
        borderRadius: 7,
        fontSize: 12,
        padding: '5px 12px',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        fontWeight: 600,
      },
      buttonGhost: {
        border: '1px solid transparent',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        borderRadius: 6,
        fontSize: 11,
        padding: '3px 7px',
        cursor: 'pointer',
      },
      buttonLink: {
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-link)',
        fontSize: 11,
        padding: 0,
        cursor: 'pointer',
        textAlign: 'left',
      },
      body: { display: 'flex', flex: '1 1 auto', minHeight: 0 },
      rail: {
        flex: '0 0 236px',
        width: 236,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        borderRight: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      railScroll: {
        flex: '1 1 auto',
        minHeight: 0,
        overflowY: 'auto',
        padding: '10px 10px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      },
      railBlock: { display: 'flex', flexDirection: 'column', gap: 6 },
      railTitle: {
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      projectButton: {
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        width: '100%',
        textAlign: 'left',
        padding: '7px 9px',
        borderRadius: 8,
        border: '1px solid transparent',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
      },
      projectButtonActive: {
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        width: '100%',
        textAlign: 'left',
        padding: '7px 9px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
      },
      projectName: {
        fontSize: 12,
        fontWeight: 600,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      projectMeta: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' },
      chipWrap: { display: 'flex', flexWrap: 'wrap', gap: 5 },
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 7px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        fontSize: 11,
        whiteSpace: 'nowrap',
      },
      chipLabel: { color: 'var(--dsw-alias-label-tertiary)' },
      chipValue: { fontWeight: 600 },
      center: { flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' },
      tabs: {
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '8px 12px',
        flex: '0 0 auto',
        overflowX: 'auto',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-base)',
      },
      tab: {
        border: '1px solid transparent',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        borderRadius: 999,
        padding: '5px 12px',
        fontSize: 12,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      tabActive: {
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 999,
        padding: '5px 12px',
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      content: { flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '14px 16px 28px' },
      context: {
        flex: '0 0 264px',
        width: 264,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        borderLeft: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      contextScroll: {
        flex: '1 1 auto',
        minHeight: 0,
        overflowY: 'auto',
        padding: '12px 12px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      },
      sectionTitle: {
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--dsw-alias-label-primary)',
        marginBottom: 6,
      },
      meta: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: 10,
        padding: '10px 12px',
      },
      cardBody: { display: 'flex', flexDirection: 'column', gap: 8 },
      factRow: { display: 'flex', flexDirection: 'column', gap: 2, padding: '5px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
      factKey: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' },
      factValue: { fontSize: 12, color: 'var(--dsw-alias-label-primary)', wordBreak: 'break-word' },
      empty: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        padding: '40px 20px',
        textAlign: 'center',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: 12,
      },
      emptyTitle: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      unavailable: {
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '12px 14px',
        margin: '0 0 12px',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-state-error-primary)',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      unavailableTitle: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-state-error-primary)' },
      unavailableDetail: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-word' },
      alert: {
        padding: '8px 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-state-error-primary)',
        color: 'var(--dsw-alias-state-error-primary)',
        fontSize: 11,
        wordBreak: 'break-word',
      },
      parseItem: {
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '9px 10px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      parseRow: { display: 'flex', alignItems: 'flex-start', gap: 8, minWidth: 0 },
      dot: { width: 7, height: 7, borderRadius: '50%', flex: '0 0 auto', marginTop: 5 },
      parseLabel: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      parseValue: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      badge: {
        display: 'inline-flex',
        alignItems: 'center',
        padding: '1px 6px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l2)',
        fontSize: 10,
        whiteSpace: 'nowrap',
      },
      evidence: {
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        margin: '2px 0 2px 15px',
        paddingLeft: 10,
        borderLeft: '2px solid var(--dsw-alias-border-l2)',
      },
      quote: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      scoringWrap: { display: 'flex', flexDirection: 'column', gap: 14 },
      scoringBlock: { display: 'flex', flexDirection: 'column', gap: 6 },
      scoringHeader: { display: 'flex', alignItems: 'baseline', gap: 8 },
      scoringName: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      scoringTotal: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 11 },
      th: {
        textAlign: 'left',
        padding: '5px 8px',
        borderBottom: '1px solid var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-tertiary)',
        fontWeight: 600,
        background: 'var(--dsw-alias-bg-layer-2)',
        whiteSpace: 'nowrap',
      },
      td: {
        textAlign: 'left',
        padding: '5px 8px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        color: 'var(--dsw-alias-label-secondary)',
        verticalAlign: 'top',
        wordBreak: 'break-word',
      },
      tdScore: {
        textAlign: 'right',
        padding: '5px 8px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        color: 'var(--dsw-alias-label-primary)',
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
      },
      starRow: {
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        padding: '9px 10px',
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      starHead: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
      starText: { fontSize: 12, color: 'var(--dsw-alias-label-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      kvLine: { display: 'flex', gap: 6, fontSize: 11, color: 'var(--dsw-alias-label-secondary)', flexWrap: 'wrap' },
      kvKey: { color: 'var(--dsw-alias-label-tertiary)', flex: '0 0 auto' },
      outlineRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        textAlign: 'left',
        padding: '5px 8px',
        borderRadius: 7,
        border: '1px solid transparent',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
      },
      outlineRowActive: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        textAlign: 'left',
        padding: '5px 8px',
        borderRadius: 7,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
      },
      outlineTitle: {
        fontSize: 12,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        flex: '1 1 auto',
        minWidth: 0,
      },
      outlineMeta: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap', flex: '0 0 auto' },
      previewHead: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 10 },
      previewTitle: { fontSize: 16, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', marginRight: 'auto' },
      figures: { display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 18 },
      figureCard: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        borderRadius: 10,
        padding: 8,
        maxWidth: '100%',
      },
      figureCaption: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary)', marginTop: 4 },
      severityGrid: { display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 12 },
      severityCard: {
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        minWidth: 96,
        padding: '8px 12px',
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      severityValue: { fontSize: 20, fontWeight: 700, lineHeight: 1.1 },
      severityLabel: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' },
      finding: {
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        padding: '10px 12px',
        marginBottom: 8,
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        cursor: 'default',
      },
      findingClickable: {
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        padding: '10px 12px',
        marginBottom: 8,
        borderRadius: 10,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        cursor: 'pointer',
      },
      findingHead: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      findingRule: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 10,
        color: 'var(--dsw-alias-label-tertiary)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      findingMessage: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', wordBreak: 'break-word' },
      findingBody: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      findingLabel: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' },
      findingFoot: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
      reviewHead: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 },
      reviewTitle: { fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', marginRight: 'auto' },
      loading: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '14px 4px',
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
      },
      spinner: {
        width: 12,
        height: 12,
        borderRadius: '50%',
        border: '2px solid var(--dsw-alias-border-l2)',
        borderTopColor: 'var(--dsw-alias-brand-primary)',
        animation: 'dsh-bidkit-spin 900ms linear infinite',
      },
      boundary: { padding: 20, display: 'flex', flexDirection: 'column', gap: 8, color: 'var(--dsw-alias-label-primary)' },
      boundaryTitle: { fontSize: 14, fontWeight: 600 },
      boundaryDetail: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'pre-wrap' },
    }

    /**
     * @param {unknown} value - candidate object.
     * @returns {boolean} true for a non-null, non-array object.
     */
    function isObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    }

    /**
     * @param {unknown} value - candidate array.
     * @returns {Array<any>} the array, or an empty array (never null).
     */
    function asArray(value) {
      return Array.isArray(value) ? value : []
    }

    /**
     * @param {unknown} value - candidate text.
     * @returns {string} text for strings and finite numbers, otherwise ''.
     */
    function asText(value) {
      if (typeof value === 'string') return value
      if (typeof value === 'number' && Number.isFinite(value)) return String(value)
      return ''
    }

    /**
     * @param {unknown} value - candidate number.
     * @returns {number|null} the number, or null when missing/invalid.
     */
    function asNumber(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : null
    }

    /**
     * Group digits without depending on the host locale.
     * @param {number} value - finite number.
     * @returns {string} grouped digits.
     */
    function numberText(value) {
      try {
        return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
      } catch (_error) {
        return String(value)
      }
    }

    /**
     * Format a count for display, or the localized em dash when missing.
     * @param {unknown} value - candidate count.
     * @returns {string} display text.
     */
    function countText(value) {
      const number = asNumber(value)
      if (number === null) return NOT_AVAILABLE
      return numberText(Math.max(0, number))
    }

    /**
     * Read a nested path defensively.
     * @param {unknown} source - root value.
     * @param {...string} keys - property names.
     * @returns {any} the value at the path, or undefined.
     */
    function readPath(source, ...keys) {
      let node = source
      for (const key of keys) {
        if (!isObject(node)) return undefined
        node = node[key]
      }
      return node
    }

    /**
     * Format an ISO timestamp for display; fall back to the raw string.
     * @param {unknown} value - ISO timestamp.
     * @returns {string} localized date-time, or '' when absent.
     */
    function formatDateTime(value) {
      const text = asText(value)
      if (text === '') return ''
      const date = new Date(text)
      if (Number.isNaN(date.getTime())) return text
      try {
        return date.toLocaleString()
      } catch (_error) {
        return text
      }
    }

    /**
     * Extract a printable message from any thrown value.
     * @param {unknown} error - thrown value.
     * @returns {string} message text.
     */
    function messageOf(error) {
      if (error instanceof Error && typeof error.message === 'string' && error.message !== '') {
        return error.message
      }
      if (typeof error === 'string' && error !== '') return error
      return t('unknownError')
    }

    /**
     * Build an id -> object index (last write wins, malformed entries ignored).
     * @param {unknown} list - candidate array.
     * @returns {Map<string, object>} index keyed by string id.
     */
    function indexById(list) {
      const index = new Map()
      for (const entry of asArray(list)) {
        if (!isObject(entry)) continue
        const id = asText(entry.id)
        if (id !== '') index.set(id, entry)
      }
      return index
    }

    /**
     * Colour token for an item/coverage status.
     * @param {string} status - filled|partial|missing|pending|writing|done.
     * @returns {string} CSS colour.
     */
    function statusColor(status) {
      if (status === 'filled' || status === 'done') return 'var(--dsw-alias-state-success-primary)'
      if (status === 'partial' || status === 'writing') return 'var(--dsw-alias-state-warn-primary)'
      if (status === 'missing') return 'var(--dsw-alias-state-error-primary)'
      return 'var(--dsw-alias-label-tertiary)'
    }

    /**
     * Colour token for an item risk level.
     * @param {string} risk - low|medium|high.
     * @returns {string} CSS colour.
     */
    function riskColor(risk) {
      if (risk === 'high') return 'var(--dsw-alias-state-error-primary)'
      if (risk === 'medium') return 'var(--dsw-alias-state-warn-primary)'
      if (risk === 'low') return 'var(--dsw-alias-state-success-primary)'
      return 'var(--dsw-alias-label-tertiary)'
    }

    /**
     * Colour token for a review severity.
     * @param {string} severity - blocker|major|minor.
     * @returns {string} CSS colour.
     */
    function severityColor(severity) {
      if (severity === 'blocker') return 'var(--dsw-alias-state-error-primary)'
      if (severity === 'major') return 'var(--dsw-alias-state-warn-primary)'
      return 'var(--dsw-alias-state-business-primary)'
    }

    /**
     * Localized label for an item/coverage status.
     * @param {string} status - filled|partial|missing|pending|writing|done.
     * @returns {string} localized label, or the raw status when unknown.
     */
    function statusLabel(status) {
      const keys = {
        filled: 'statusFilled',
        partial: 'statusPartial',
        missing: 'statusMissing',
        pending: 'statusPending',
        writing: 'statusWriting',
        done: 'statusDone',
      }
      const key = keys[status]
      return key === undefined ? asText(status) : t(key)
    }

    /**
     * Localized label for an item risk level.
     * @param {string} risk - low|medium|high.
     * @returns {string} localized label, or '' when unknown.
     */
    function riskLabel(risk) {
      if (risk === 'low') return t('riskLow')
      if (risk === 'medium') return t('riskMedium')
      if (risk === 'high') return t('riskHigh')
      return ''
    }

    /**
     * Localized label for a review severity.
     * @param {string} severity - blocker|major|minor.
     * @returns {string} localized label, or the raw severity when unknown.
     */
    function severityLabel(severity) {
      if (severity === 'blocker') return t('severityBlocker')
      if (severity === 'major') return t('severityMajor')
      if (severity === 'minor') return t('severityMinor')
      return asText(severity)
    }

    /**
     * Raised for any API failure so the caller can render the unavailable state.
     * @augments Error
     */
    class ApiFailure extends Error {
      /**
       * @param {string} message - printable message.
       * @param {{kind?: string, status?: number, code?: string}} [meta] - failure metadata.
       */
      constructor(message, meta) {
        super(message)
        this.name = 'BidKitApiFailure'
        this.kind = isObject(meta) ? asText(meta.kind) : ''
        this.status = isObject(meta) ? asNumber(meta.status) : null
        this.code = isObject(meta) ? asText(meta.code) : ''
      }
    }

    /**
     * Same-origin route builders. Every URL stays relative to the plugin API
     * base: the Client never targets another origin.
     */
    const ROUTES = {
      projects: `${API_BASE}/projects`,
      /**
       * @param {string} id - project id.
       * @returns {string} project route.
       */
      project(id) {
        return `${API_BASE}/projects/${encodeURIComponent(id)}`
      },
      /**
       * @param {string} id - project id.
       * @param {string} sectionId - section id.
       * @returns {string} section route.
       */
      section(id, sectionId) {
        return `${API_BASE}/projects/${encodeURIComponent(id)}/sections/${encodeURIComponent(sectionId)}`
      },
      /**
       * @param {string} id - project id.
       * @param {string} figureId - figure id.
       * @returns {string} figure route.
       */
      figure(id, figureId) {
        const suffix = figureId.toLowerCase().endsWith('.svg') ? '' : '.svg'
        return `${API_BASE}/projects/${encodeURIComponent(id)}/figures/${encodeURIComponent(figureId)}${suffix}`
      },
      /**
       * @param {string} id - project id.
       * @returns {string} review route.
       */
      review(id) {
        return `${API_BASE}/projects/${encodeURIComponent(id)}/review`
      },
      /**
       * @param {string} id - project id.
       * @returns {string} latest export route.
       */
      exportLatest(id) {
        return `${API_BASE}/projects/${encodeURIComponent(id)}/export/latest`
      },
    }

    /**
     * Fetch one JSON route with same-origin credentials.
     *
     * @param {string} path - plugin-relative API path.
     * @param {{method?: string, body?: object}} [init] - request options.
     * @returns {Promise<object>} the parsed `{ ok: true, ... }` payload.
     * @throws {ApiFailure} on transport, HTTP, or contract-shape failure.
     */
    async function requestJson(path, init) {
      const options = {
        method: isObject(init) && typeof init.method === 'string' ? init.method : 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { accept: 'application/json' },
      }
      if (isObject(init) && init.body !== undefined) {
        options.headers['content-type'] = 'application/json'
        options.body = JSON.stringify(init.body)
      }
      let response
      try {
        response = await fetch(path, options)
      } catch (error) {
        throw new ApiFailure(tx('requestFailed', { value: messageOf(error) }), { kind: 'network' })
      }
      let payload = null
      try {
        payload = await response.json()
      } catch (_error) {
        payload = null
      }
      if (!response.ok) {
        const message = asText(readPath(payload, 'error', 'message'))
        const code = asText(readPath(payload, 'error', 'code'))
        throw new ApiFailure(
          message !== '' ? message : tx('requestFailed', { value: `HTTP ${response.status}` }),
          { kind: 'http', status: response.status, code },
        )
      }
      if (!isObject(payload) || payload.ok !== true) {
        throw new ApiFailure(t('unavailableShape'), { kind: 'shape', status: response.status })
      }
      return payload
    }

    /**
     * Read the project list (CONTRACT.md §2.1).
     * @returns {Promise<Array<object>>} project summaries.
     * @throws {ApiFailure} when the route or payload is unusable.
     */
    async function listProjects() {
      const payload = await requestJson(ROUTES.projects)
      if (!Array.isArray(payload.projects)) {
        throw new ApiFailure(t('unavailableShape'), { kind: 'shape' })
      }
      return payload.projects.filter(isObject)
    }

    /**
     * Read one project view (CONTRACT.md §2.2).
     * @param {string} id - project id.
     * @returns {Promise<object>} the project view.
     * @throws {ApiFailure} when the route or payload is unusable.
     */
    async function readProject(id) {
      const payload = await requestJson(ROUTES.project(id))
      if (!isObject(payload.project)) {
        throw new ApiFailure(t('unavailableShape'), { kind: 'shape' })
      }
      return payload.project
    }

    /**
     * Read one section view (CONTRACT.md §2.4).
     * @param {string} id - project id.
     * @param {string} sectionId - section id.
     * @returns {Promise<object>} the section view.
     * @throws {ApiFailure} when the route or payload is unusable.
     */
    async function readSection(id, sectionId) {
      const payload = await requestJson(ROUTES.section(id, sectionId))
      if (!isObject(payload.section)) {
        throw new ApiFailure(t('unavailableShape'), { kind: 'shape' })
      }
      return payload.section
    }

    /**
     * Ask the Host to re-run the compliance review (CONTRACT.md §2.3).
     * @param {string} id - project id.
     * @returns {Promise<object>} the fresh review.
     * @throws {ApiFailure} when the route or payload is unusable.
     */
    async function runReview(id) {
      const payload = await requestJson(ROUTES.review(id), { method: 'POST', body: {} })
      if (!isObject(payload.review)) {
        throw new ApiFailure(t('unavailableShape'), { kind: 'shape' })
      }
      return payload.review
    }

    /**
     * Resolve the same-origin image source for a figure, preferring the URL the
     * Host reported and falling back to the documented figure route.
     * @param {string} projectId - project id.
     * @param {object} figure - SectionView figure entry.
     * @returns {string|null} relative image URL, or null when unresolvable.
     */
    function figureSource(projectId, figure) {
      if (!isObject(figure)) return null
      const reported = asText(figure.url)
      if (reported !== '' && reported.startsWith('/') && !reported.startsWith('//')) return reported
      const figureId = asText(figure.id)
      if (projectId === '' || figureId === '') return null
      return ROUTES.figure(projectId, figureId)
    }

    // ---------------------------------------------------------------------
    // Markdown subset renderer (CONTRACT.md §3 superset used by the preview)
    //
    // Supported: ATX headings, paragraphs, **bold** / *italic* / `code`,
    // bullet and ordered lists, blockquote, fenced code, pipe tables,
    // horizontal rule, and the inline figure token [[figure:<id>]]. Anything
    // else is rendered as literal text, never dropped and never invented.
    // ---------------------------------------------------------------------

    /**
     * @param {string} line - raw line.
     * @returns {boolean} true for an empty/whitespace-only line.
     */
    function isBlankLine(line) {
      return /^\s*$/.test(line)
    }

    /**
     * @param {string} line - raw line.
     * @returns {RegExpExecArray|null} heading match, if any.
     */
    function matchHeading(line) {
      return /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    }

    /**
     * @param {string} line - raw line.
     * @returns {RegExpExecArray|null} fenced-code opening match, if any.
     */
    function matchFenceStart(line) {
      return /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+#.-]*)\s*$/.exec(line)
    }

    /**
     * @param {string} line - raw line.
     * @returns {boolean} true for a closing code fence.
     */
    function isFenceEnd(line) {
      return /^\s*(`{3,}|~{3,})\s*$/.test(line)
    }

    /**
     * @param {string} line - raw line.
     * @returns {boolean} true for `---`, `***`, `___` separators.
     */
    function isHorizontalRule(line) {
      return /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)
    }

    /**
     * @param {string} line - raw line.
     * @returns {boolean} true for a blockquote line.
     */
    function isBlockquoteLine(line) {
      return /^\s{0,3}>\s?/.test(line)
    }

    /**
     * @param {string} line - raw line.
     * @returns {RegExpExecArray|null} bullet-list item match, if any.
     */
    function matchBullet(line) {
      return /^(\s*)[-*+]\s+(.*)$/.exec(line)
    }

    /**
     * @param {string} line - raw line.
     * @returns {RegExpExecArray|null} ordered-list item match, if any.
     */
    function matchOrdered(line) {
      return /^(\s*)(\d{1,9})[.)]\s+(.*)$/.exec(line)
    }

    /**
     * Split one pipe-table row into trimmed cells, tolerating optional edge pipes.
     * @param {string} line - raw table row.
     * @returns {Array<string>} trimmed cells.
     */
    function splitTableRow(line) {
      let text = String(line).trim()
      if (text.startsWith('|')) text = text.slice(1)
      if (text.endsWith('|')) text = text.slice(0, -1)
      return text.split('|').map(cell => cell.trim())
    }

    /**
     * @param {string} line - raw line.
     * @returns {boolean} true for a pipe-table delimiter row (`|---|---|`).
     */
    function isTableDelimiter(line) {
      const cells = splitTableRow(line)
      if (cells.length === 0) return false
      return cells.every(cell => /^:?-{3,}:?$/.test(cell))
    }

    /**
     * @param {string} line - raw line.
     * @returns {boolean} true when the line could start a table.
     */
    function looksLikeTableRow(line) {
      return line.includes('|')
    }

    /**
     * @param {string} line - raw line.
     * @returns {boolean} true when the line starts a non-paragraph block.
     */
    function isBlockStart(line) {
      return (
        matchHeading(line) !== null ||
        matchFenceStart(line) !== null ||
        isHorizontalRule(line) ||
        isBlockquoteLine(line) ||
        matchBullet(line) !== null ||
        matchOrdered(line) !== null
      )
    }

    /**
     * Build the `<img>` for one inline figure token, or a localized placeholder
     * when the section payload does not carry that figure.
     * @param {string} figureId - id after `[[figure:`.
     * @param {{figure?: (id: string) => ({source: string, title?: string}|null)}} options - render options.
     * @param {string} key - React key.
     * @returns {object} React element.
     */
    function renderFigureToken(figureId, options, key) {
      const resolve = isObject(options) && typeof options.figure === 'function' ? options.figure : null
      const resolved = resolve === null ? null : resolve(figureId)
      if (isObject(resolved) && asText(resolved.source) !== '') {
        return h('img', {
          key,
          src: asText(resolved.source),
          alt: asText(resolved.title) !== '' ? asText(resolved.title) : figureId,
          loading: 'lazy',
          decoding: 'async',
          style: {
            maxWidth: '100%',
            display: 'block',
            margin: '12px auto',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: 8,
            background: 'var(--dsw-alias-bg-base)',
          },
        })
      }
      return h('span', {
        key,
        style: {
          display: 'inline-block',
          padding: '2px 6px',
          borderRadius: 6,
          border: '1px dashed var(--dsw-alias-border-l3)',
          color: 'var(--dsw-alias-label-tertiary)',
          fontSize: 11,
        },
      }, tx('previewFigureMissing', { value: figureId }))
    }

    /**
     * Render the supported inline markdown of one text run.
     * @param {string} text - inline markdown.
     * @param {{figure?: Function}} options - render options.
     * @param {number} [depth] - recursion guard for emphasis nesting.
     * @returns {Array<any>} React children.
     */
    function renderInline(text, options, depth) {
      const source = asText(text)
      const level = typeof depth === 'number' ? depth : 0
      const nodes = []
      let cursor = 0
      while (cursor < source.length) {
        const rest = source.slice(cursor)
        const figure = /^\[\[figure:([^\]\s]+)\]\]/.exec(rest)
        if (figure !== null) {
          nodes.push(renderFigureToken(figure[1], options, `figure-${cursor}`))
          cursor += figure[0].length
          continue
        }
        const code = /^`([^`\n]+)`/.exec(rest)
        if (code !== null) {
          nodes.push(h('code', { key: `code-${cursor}` }, code[1]))
          cursor += code[0].length
          continue
        }
        if (level < 4) {
          const strong = /^\*\*([\s\S]+?)\*\*/.exec(rest) ?? /^__([\s\S]+?)__/.exec(rest)
          if (strong !== null && strong[1] !== '') {
            nodes.push(h('strong', { key: `strong-${cursor}` }, ...renderInline(strong[1], options, level + 1)))
            cursor += strong[0].length
            continue
          }
          const emphasis = /^\*([^*\s][\s\S]*?)\*/.exec(rest) ?? /^_([^_\s][\s\S]*?)_/.exec(rest)
          if (emphasis !== null && emphasis[1] !== '') {
            nodes.push(h('em', { key: `em-${cursor}` }, ...renderInline(emphasis[1], options, level + 1)))
            cursor += emphasis[0].length
            continue
          }
        }
        const nextSpecial = rest.search(/[*_`[]/)
        const take = nextSpecial <= 0 ? 1 : nextSpecial
        const chunk = rest.slice(0, take)
        const last = nodes[nodes.length - 1]
        if (typeof last === 'string') nodes[nodes.length - 1] = last + chunk
        else nodes.push(chunk)
        cursor += take
      }
      return nodes
    }

    /**
     * Read a pipe table starting at `start`.
     * @param {Array<string>} lines - document lines.
     * @param {number} start - index of the header row.
     * @param {{figure?: Function}} options - render options.
     * @param {string} key - React key for the table element.
     * @returns {{element: object, next: number}|null} table element and next index.
     */
    function readTable(lines, start, options, key) {
      if (start + 1 >= lines.length) return null
      if (!looksLikeTableRow(lines[start]) || !isTableDelimiter(lines[start + 1])) return null
      const header = splitTableRow(lines[start])
      const delimiters = splitTableRow(lines[start + 1])
      const alignmentOf = column => {
        const delimiter = delimiters[column] ?? ''
        const left = delimiter.startsWith(':')
        const right = delimiter.endsWith(':')
        if (left && right) return 'center'
        if (right) return 'right'
        return 'left'
      }
      const rows = []
      let cursor = start + 2
      while (cursor < lines.length && looksLikeTableRow(lines[cursor]) && !isBlankLine(lines[cursor])) {
        rows.push(splitTableRow(lines[cursor]))
        cursor += 1
      }
      const cellStyle = column => ({ textAlign: alignmentOf(column) })
      const headRow = h('tr', { key: 'head' }, header.map((cell, column) =>
        h('th', { key: `h${column}`, style: cellStyle(column) }, ...renderInline(cell, options))))
      const bodyRows = rows.map((row, rowIndex) =>
        h('tr', { key: `r${rowIndex}` }, row.map((cell, column) =>
          h('td', { key: `c${column}`, style: cellStyle(column) }, ...renderInline(cell, options)))))
      return {
        element: h('table', { key },
          h('thead', null, headRow),
          bodyRows.length === 0 ? null : h('tbody', null, ...bodyRows)),
        next: cursor,
      }
    }

    /**
     * Render the supported markdown subset to React elements.
     * @param {string} markdown - markdown source.
     * @param {{figure?: (id: string) => ({source: string, title?: string}|null)}} [options] - render options.
     * @returns {Array<any>} block-level React elements.
     */
    function renderMarkdown(markdown, options) {
      const blocks = []
      const source = asText(markdown)
      if (source === '') return blocks
      const lines = source.replace(/\r\n?/g, '\n').split('\n')
      const renderOptions = isObject(options) ? options : {}
      let index = 0
      let seed = 0
      while (index < lines.length) {
        const line = lines[index]
        if (isBlankLine(line)) {
          index += 1
          continue
        }
        const fence = matchFenceStart(line)
        if (fence !== null) {
          const language = fence[2]
          const body = []
          index += 1
          while (index < lines.length && !isFenceEnd(lines[index])) {
            body.push(lines[index])
            index += 1
          }
          if (index < lines.length) index += 1
          blocks.push(h('pre', { key: `block-${seed++}` },
            h('code', { 'data-language': language === '' ? undefined : language }, body.join('\n'))))
          continue
        }
        const heading = matchHeading(line)
        if (heading !== null) {
          const level = Math.min(6, Math.max(1, heading[1].length))
          blocks.push(h(`h${level}`, { key: `block-${seed++}` }, ...renderInline(heading[2], renderOptions)))
          index += 1
          continue
        }
        if (isHorizontalRule(line)) {
          blocks.push(h('hr', { key: `block-${seed++}` }))
          index += 1
          continue
        }
        if (isBlockquoteLine(line)) {
          const quoted = []
          while (index < lines.length && isBlockquoteLine(lines[index])) {
            quoted.push(lines[index].replace(/^\s{0,3}>\s?/, ''))
            index += 1
          }
          blocks.push(h('blockquote', { key: `block-${seed++}` },
            ...renderMarkdown(quoted.join('\n'), renderOptions)))
          continue
        }
        const table = readTable(lines, index, renderOptions, `block-${seed++}`)
        if (table !== null) {
          blocks.push(table.element)
          index = table.next
          continue
        }
        const bullet = matchBullet(line)
        const ordered = matchOrdered(line)
        if (bullet !== null || ordered !== null) {
          const listTag = bullet !== null ? 'ul' : 'ol'
          const startNumber = bullet !== null ? 1 : Math.max(1, Number.parseInt(ordered[2], 10))
          const items = []
          while (index < lines.length) {
            const currentBullet = matchBullet(lines[index])
            const currentOrdered = matchOrdered(lines[index])
            const match = listTag === 'ul' ? currentBullet : currentOrdered
            if (match === null) break
            const indent = match[1].replace(/\t/g, '    ').length
            const itemText = match[match.length - 1]
            items.push(h('li', {
              key: `item-${index}`,
              style: indent > 0 ? { marginLeft: Math.min(48, indent * 4) } : undefined,
            }, ...renderInline(itemText, renderOptions)))
            index += 1
          }
          if (items.length === 0) {
            index += 1
            continue
          }
          blocks.push(h(listTag, { key: `block-${seed++}`, start: listTag === 'ol' ? startNumber : undefined }, ...items))
          continue
        }
        const paragraph = []
        while (index < lines.length) {
          const current = lines[index]
          if (isBlankLine(current) || isBlockStart(current)) break
          const nextLine = index + 1 < lines.length ? lines[index + 1] : ''
          if (looksLikeTableRow(current) && isTableDelimiter(nextLine)) break
          paragraph.push(current.trim())
          index += 1
        }
        if (paragraph.length === 0) {
          /* Defensive: an unrecognized block-starter must still advance. */
          index += 1
          continue
        }
        blocks.push(h('p', {
          key: `block-${seed++}`,
          style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
        }, ...renderInline(paragraph.join('\n'), renderOptions)))
      }
      return blocks
    }

    // ---------------------------------------------------------------------
    // Primitive presentation components
    // ---------------------------------------------------------------------

    /**
     * Localized loading row.
     * @param {{label: string}} props - already localized label.
     * @returns {object} React element.
     */
    function Loading({ label }) {
      return h('div', { style: S.loading, role: 'status', 'aria-live': 'polite' },
        h('span', { 'aria-hidden': true, style: S.spinner }),
        h('span', null, label))
    }

    /**
     * Localized empty state.
     * @param {{title: string, hint?: string}} props - localized copy.
     * @returns {object} React element.
     */
    function EmptyState({ title, hint }) {
      return h('div', { style: S.empty },
        h('div', { style: S.emptyTitle }, title),
        typeof hint === 'string' && hint !== '' ? h('div', null, hint) : null)
    }

    /**
     * Explicit "unavailable" card: used whenever a Host route or a payload shape
     * is missing, so the UI states the gap instead of inventing data.
     * @param {{detail?: string, onRetry?: Function}} props - failure detail and retry handler.
     * @returns {object} React element.
     */
    function Unavailable({ detail, onRetry }) {
      return h('div', { style: S.unavailable, role: 'alert' },
        h('div', { style: S.unavailableTitle }, t('unavailable')),
        typeof detail === 'string' && detail !== ''
          ? h('div', { style: S.unavailableDetail }, detail)
          : null,
        h('div', { style: S.unavailableDetail }, t('unavailableHint')),
        typeof onRetry === 'function'
          ? h('button', {
            type: 'button',
            onClick: onRetry,
            style: S.button,
            className: 'dsh-bidkit-hoverable',
          }, t('retry'))
          : null)
    }

    /**
     * Small label/value pill.
     * @param {{label: string, value: string, tone?: string, title?: string}} props - chip content.
     * @returns {object} React element.
     */
    function Chip({ label, value, tone, title }) {
      return h('span', { style: S.chip, title },
        h('span', { style: S.chipLabel }, label),
        h('span', { style: { ...S.chipValue, color: asText(tone) === '' ? 'var(--dsw-alias-label-primary)' : tone } }, value))
    }

    /**
     * Status dot shared by parse items and outlines.
     * @param {{status: string}} props - data status.
     * @returns {object} React element.
     */
    function StatusDot({ status }) {
      return h('span', { 'aria-hidden': true, style: { ...S.dot, background: statusColor(asText(status)) } })
    }

    /**
     * Status badge shared by parse items and outlines.
     * @param {{status: string}} props - data status.
     * @returns {object} React element.
     */
    function StatusBadge({ status }) {
      const value = asText(status)
      const text = statusLabel(value)
      if (text === '') return null
      return h('span', {
        style: { ...S.badge, color: statusColor(value), borderColor: statusColor(value) },
        title: text,
      }, text)
    }

    /**
     * Risk badge for one parsed tender item.
     * @param {{risk: string}} props - low|medium|high.
     * @returns {object|null} React element, or null when the payload lacks a risk.
     */
    function RiskBadge({ risk }) {
      const value = asText(risk)
      const text = riskLabel(value)
      if (text === '') return null
      return h('span', {
        style: { ...S.badge, color: riskColor(value), borderColor: riskColor(value) },
        title: text,
      }, text)
    }

    /**
     * Severity badge for one review finding.
     * @param {{severity: string}} props - blocker|major|minor.
     * @returns {object} React element.
     */
    function SeverityBadge({ severity }) {
      const value = asText(severity)
      return h('span', {
        style: { ...S.badge, color: severityColor(value), borderColor: severityColor(value), fontWeight: 600 },
      }, severityLabel(value))
    }

    // ---------------------------------------------------------------------
    // Left rail, right context panel and the four tab views
    // ---------------------------------------------------------------------

    /**
     * Progress chips shown under the project selector.
     * Values come from the payload only; a missing field renders as "—".
     * @param {object|null} project - ProjectView, may be null.
     * @param {object|null} summary - ProjectSummary, may be null.
     * @returns {Array<{key: string, label: string, value: string, tone: string}>} chips.
     */
    function buildProgressChips(project, summary) {
      const chips = []
      const progress = isObject(readPath(summary, 'progress')) ? summary.progress : null
      const parse = isObject(readPath(project, 'parse')) ? project.parse : null

      const coverage = isObject(readPath(progress, 'coverage'))
        ? progress.coverage
        : isObject(readPath(parse, 'coverage')) ? parse.coverage : null
      const filled = asNumber(readPath(coverage, 'filled'))
      const total = asNumber(readPath(coverage, 'total'))
      let coverageTone = ''
      if (coverage !== null) {
        if (total !== null && total > 0 && filled !== null && filled >= total) {
          coverageTone = 'var(--dsw-alias-state-success-primary)'
        } else if (filled !== null && filled > 0) {
          coverageTone = 'var(--dsw-alias-state-warn-primary)'
        } else {
          coverageTone = 'var(--dsw-alias-state-error-primary)'
        }
      }
      chips.push({
        key: 'coverage',
        label: t('chipsCoverage'),
        value: coverage === null ? NOT_AVAILABLE : `${countText(filled)}/${countText(total)}`,
        tone: coverageTone,
      })

      const writtenSections = asNumber(readPath(progress, 'sections'))
      const totalSections = asNumber(readPath(progress, 'sectionsTotal'))
      const sectionViews = asArray(readPath(project, 'sections'))
      let sectionsValue = NOT_AVAILABLE
      if (totalSections !== null) sectionsValue = `${countText(writtenSections)}/${countText(totalSections)}`
      else if (writtenSections !== null) sectionsValue = countText(writtenSections)
      else if (sectionViews.length > 0) sectionsValue = countText(sectionViews.length)
      chips.push({ key: 'sections', label: t('chipsSections'), value: sectionsValue, tone: '' })

      const words = asNumber(readPath(progress, 'words'))
      chips.push({
        key: 'words',
        label: t('chipsWords'),
        value: words === null ? NOT_AVAILABLE : countText(words),
        tone: '',
      })

      const reviewSummary = readPath(project, 'review', 'summary')
      const risks = isObject(readPath(progress, 'risks'))
        ? progress.risks
        : isObject(reviewSummary) ? reviewSummary : null
      const blocker = asNumber(readPath(risks, 'blocker'))
      const major = asNumber(readPath(risks, 'major'))
      const minor = asNumber(readPath(risks, 'minor'))
      let riskTone = ''
      if (blocker !== null && blocker > 0) riskTone = 'var(--dsw-alias-state-error-primary)'
      else if (major !== null && major > 0) riskTone = 'var(--dsw-alias-state-warn-primary)'
      chips.push({
        key: 'risks',
        label: t('chipsRisks'),
        value: risks === null ? NOT_AVAILABLE : `${countText(blocker)}/${countText(major)}/${countText(minor)}`,
        tone: riskTone,
      })

      const starCount = asNumber(readPath(progress, 'stars'))
      const starClauses = asArray(readPath(parse, 'starClauses'))
      chips.push({
        key: 'stars',
        label: t('chipsStars'),
        value: starCount !== null ? countText(starCount) : parse === null ? NOT_AVAILABLE : countText(starClauses.length),
        tone: 'var(--dsw-alias-state-warn-primary)',
      })
      return chips
    }

    /**
     * Left rail: project selector and progress chips.
     * @param {{
     *   list: {phase: string, projects: Array<object>, error: string},
     *   selectedId: string|null,
     *   chips: Array<object>,
     *   onSelect: (id: string) => void,
     *   onRetry: Function,
     * }} props - rail state and callbacks.
     * @returns {object} React element.
     */
    function ProjectRail({ list, selectedId, chips, onSelect, onRetry }) {
      const projects = asArray(list.projects)
      const loading = list.phase === 'loading' && projects.length === 0
      return h('aside', { style: S.rail, 'aria-label': t('projects') },
        h('div', { style: S.railScroll, className: 'dsh-bidkit-scroll' },
          h('div', { style: S.railBlock },
            h('div', { style: S.railTitle }, t('projects')),
            loading ? h('div', { style: S.meta }, t('loadingProjects')) : null,
            list.phase === 'unavailable'
              ? h(Unavailable, { detail: asText(list.error), onRetry })
              : null,
            list.phase === 'ready' && projects.length === 0
              ? h('div', { style: S.railBlock },
                h('div', { style: S.meta }, t('noProjects')),
                h('div', { style: S.meta }, t('noProjectsHint')))
              : null,
            projects.map((entry, index) => {
              const id = asText(entry.id)
              const active = id !== '' && id === selectedId
              const progress = isObject(entry.progress) ? entry.progress : null
              const sectionsTotal = asNumber(readPath(progress, 'sectionsTotal'))
              const words = asNumber(readPath(progress, 'words'))
              const metaParts = []
              if (sectionsTotal !== null) metaParts.push(`${t('chipsSections')} ${countText(sectionsTotal)}`)
              if (words !== null) metaParts.push(`${t('chipsWords')} ${countText(words)}`)
              return h('button', {
                key: id !== '' ? id : `project-${index}`,
                type: 'button',
                onClick: () => {
                  if (typeof onSelect === 'function') onSelect(id)
                },
                style: active ? S.projectButtonActive : S.projectButton,
                className: active ? undefined : 'dsh-bidkit-hoverable',
                'aria-pressed': active,
                title: asText(entry.name),
              },
              h('span', { style: S.projectName }, asText(entry.name) !== '' ? asText(entry.name) : id),
              metaParts.length > 0 ? h('span', { style: S.projectMeta }, metaParts.join(' · ')) : null)
            })),
          chips.length > 0
            ? h('div', { style: S.railBlock },
              h('div', { style: S.railTitle }, t('progressTitle')),
              h('div', { style: S.chipWrap }, chips.map(chip =>
                h(Chip, {
                  key: chip.key,
                  label: chip.label,
                  value: chip.value,
                  tone: chip.tone,
                  title: `${chip.label}: ${chip.value}`,
                }))))
            : null))
    }

    /**
     * Right context panel: locked global facts, tender identity, exports.
     * @param {{project: object|null}} props - the selected project view.
     * @returns {object} React element.
     */
    function ContextPanel({ project }) {
      const facts = asArray(readPath(project, 'facts')).filter(isObject)
      const tender = isObject(readPath(project, 'tender')) ? project.tender : null
      const exportsList = asArray(readPath(project, 'exports')).filter(isObject)
      const projectId = asText(readPath(project, 'id'))
      return h('aside', { style: S.context, 'aria-label': t('contextTitle') },
        h('div', { style: S.contextScroll, className: 'dsh-bidkit-scroll' },
          h('div', { style: S.railBlock },
            h('div', { style: S.railTitle }, t('contextTitle')),
            facts.length === 0
              ? h('div', { style: S.meta }, t('contextEmpty'))
              : h('div', { style: { display: 'flex', flexDirection: 'column' } }, facts.map((fact, index) => {
                const lockedAt = formatDateTime(fact.lockedAt)
                return h('div', { key: asText(fact.key) !== '' ? `${asText(fact.key)}-${index}` : `fact-${index}`, style: S.factRow },
                  h('div', { style: S.factKey }, asText(fact.key)),
                  h('div', { style: S.factValue }, asText(fact.value) !== '' ? asText(fact.value) : NOT_AVAILABLE),
                  lockedAt !== '' ? h('div', { style: S.factKey }, tx('contextLockedAt', { value: lockedAt })) : null)
              }))),
          tender !== null
            ? h('div', { style: S.railBlock },
              h('div', { style: S.railTitle }, t('tenderInfo')),
              h('div', { style: { display: 'flex', flexDirection: 'column' } },
                h('div', { style: S.factRow },
                  h('div', { style: S.factKey }, t('tenderTitle')),
                  h('div', { style: S.factValue }, asText(tender.title) !== '' ? asText(tender.title) : NOT_AVAILABLE)),
                h('div', { style: S.factRow },
                  h('div', { style: S.factKey }, t('tenderSourceFile')),
                  h('div', { style: S.factValue }, asText(tender.sourceFile) !== '' ? asText(tender.sourceFile) : NOT_AVAILABLE)),
                h('div', { style: S.factRow },
                  h('div', { style: S.factKey }, t('tenderSections')),
                  h('div', { style: S.factValue }, countText(tender.sectionCount)))))
            : null,
          exportsList.length > 0 && projectId !== ''
            ? h('div', { style: S.railBlock },
              h('div', { style: S.railTitle }, t('exportsTitle')),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                exportsList.map((entry, index) => h('div', { key: `${asText(entry.file)}-${index}`, style: S.factRow },
                  h('div', { style: S.factValue }, tx('exportItem', {
                    file: asText(entry.file) !== '' ? asText(entry.file) : NOT_AVAILABLE,
                    bytes: countText(entry.bytes),
                  })),
                  h('div', { style: S.factKey }, formatDateTime(entry.at)))),
                h('a', {
                  href: ROUTES.exportLatest(projectId),
                  download: '',
                  style: { ...S.buttonLink, display: 'inline-block', marginTop: 2 },
                  className: 'dsh-bidkit-link',
                }, t('exportLatest'))))
            : null))
    }

    /**
     * Tab bar for the four workbench views.
     * @param {{tab: string, onSelect: (key: string) => void}} props - active tab and setter.
     * @returns {object} React element.
     */
    function TabBar({ tab, onSelect }) {
      return h('div', { style: S.tabs, role: 'tablist', 'aria-label': t('title') },
        TABS.map(entry => {
          const active = entry.key === tab
          return h('button', {
            key: entry.key,
            type: 'button',
            role: 'tab',
            'aria-selected': active,
            className: 'dsh-bidkit-tab',
            style: active ? S.tabActive : S.tab,
            onClick: () => {
              if (typeof onSelect === 'function') onSelect(entry.key)
            },
          }, t(entry.labelKey))
        }))
    }

    /**
     * One scoring category table (`technical`, `commercial`, `price`).
     * @param {{category: {key: string, labelKey: string}, items: Array<object>}} props - category and items.
     * @returns {object|null} React element, or null when the category is empty.
     */
    function ScoringBlock({ category, items }) {
      if (items.length === 0) return null
      let total = 0
      let known = false
      for (const item of items) {
        const score = asNumber(item.maxScore)
        if (score !== null) {
          total += score
          known = true
        }
      }
      return h('div', { style: S.scoringBlock },
        h('div', { style: S.scoringHeader },
          h('span', { style: S.scoringName }, t(category.labelKey)),
          h('span', { style: S.scoringTotal },
            known ? tx('scoreSubtotal', { value: numberText(total) }) : NOT_AVAILABLE)),
        h('table', { style: S.table },
          h('thead', null,
            h('tr', null,
              h('th', { style: S.th }, t('scoreItem')),
              h('th', { style: { ...S.th, textAlign: 'right' } }, t('scoreMax')),
              h('th', { style: S.th }, t('scoreCriteria')))),
          h('tbody', null, items.map((item, index) => h('tr', { key: `score-${index}` },
            h('td', { style: S.td }, asText(item.item) !== '' ? asText(item.item) : NOT_AVAILABLE),
            h('td', { style: S.tdScore }, countText(item.maxScore)),
            h('td', { style: S.td }, asText(item.criteria) !== '' ? asText(item.criteria) : NOT_AVAILABLE))))))
    }

    /**
     * 招标解析 tab: structured items, ★ substantive clauses and scoring.
     * @param {{project: object, onOpenSection: (id: string) => void}} props - project and navigation.
     * @returns {object} React element.
     */
    function ParseTab({ project, onOpenSection }) {
      const [expanded, setExpanded] = React.useState({})
      const parse = isObject(readPath(project, 'parse')) ? project.parse : null
      const items = asArray(readPath(parse, 'items')).filter(isObject)
      const stars = asArray(readPath(parse, 'starClauses')).filter(isObject)
      const scoring = isObject(readPath(parse, 'scoring')) ? parse.scoring : null
      const coverage = isObject(readPath(parse, 'coverage')) ? parse.coverage : null
      const sectionsById = indexById(readPath(project, 'sections'))

      /**
       * @param {string} sectionId - section id.
       * @returns {string} section title, or the id when the index lacks it.
       */
      const sectionTitleOf = sectionId => {
        const section = sectionsById.get(sectionId)
        const title = asText(readPath(section, 'title'))
        return title !== '' ? title : sectionId
      }

      /**
       * @param {string} itemKey - item identity.
       */
      const toggleEvidence = itemKey => {
        setExpanded(previous => ({ ...previous, [itemKey]: previous[itemKey] !== true }))
      }

      const scoringBlocks = SCORE_CATEGORIES.map(category => ({
        category,
        items: asArray(readPath(scoring, category.key)).filter(isObject),
      }))
      const hasScoring = scoringBlocks.some(block => block.items.length > 0)

      return h('div', null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 } },
          h('div', { style: { ...S.sectionTitle, marginBottom: 0, marginRight: 'auto' } }, t('parseItemsTitle')),
          coverage === null
            ? null
            : h(Chip, {
              label: t('chipsCoverage'),
              value: tx('parseCoverage', { filled: countText(coverage.filled), total: countText(coverage.total) }),
            })),
        items.length === 0
          ? h(EmptyState, { title: t('parseEmpty') })
          : h('div', { style: { ...S.card, padding: 0, overflow: 'hidden' } }, items.map((item, index) => {
            const itemKey = asText(item.key) !== '' ? asText(item.key) : `item-${index}`
            const evidence = asArray(item.evidence).filter(isObject)
            const open = expanded[itemKey] === true
            const value = asText(item.value)
            return h('div', { key: itemKey, style: S.parseItem },
              h('div', { style: S.parseRow },
                h(StatusDot, { status: asText(item.status) }),
                h('span', { style: { ...S.parseLabel, flex: '1 1 auto', minWidth: 0 } },
                  asText(item.label) !== '' ? asText(item.label) : itemKey),
                h(StatusBadge, { status: asText(item.status) }),
                h(RiskBadge, { risk: asText(item.risk) }),
                evidence.length > 0
                  ? h('button', {
                    type: 'button',
                    onClick: () => toggleEvidence(itemKey),
                    style: S.buttonLink,
                    className: 'dsh-bidkit-link',
                    'aria-expanded': open,
                  }, open ? t('hideEvidence') : tx('evidenceCount', { count: numberText(evidence.length) }))
                  : null),
              h('div', { style: value === '' ? { ...S.parseValue, color: 'var(--dsw-alias-label-tertiary)' } : S.parseValue },
                value === '' ? t('parseValueMissing') : value),
              open
                ? h('div', { style: S.evidence }, evidence.map((quote, quoteIndex) => {
                  const sectionId = asText(quote.sectionId)
                  const quoteText = asText(quote.quote)
                  return h('div', { key: `quote-${quoteIndex}`, style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                    quoteText !== ''
                      ? h('div', { style: S.quote }, `“${quoteText}”`)
                      : h('div', { style: S.meta }, t('evidenceEmpty')),
                    sectionId !== ''
                      ? h('button', {
                        type: 'button',
                        style: S.buttonLink,
                        className: 'dsh-bidkit-link',
                        onClick: () => {
                          if (typeof onOpenSection === 'function') onOpenSection(sectionId)
                        },
                      }, `${t('evidenceSection')}: ${sectionTitleOf(sectionId)}`)
                      : null)
                }))
                : null)
          })),
        h('div', { style: { marginTop: 18 } },
          h('div', { style: S.sectionTitle }, t('starsTitle')),
          stars.length === 0
            ? h('div', { style: S.meta }, t('starsEmpty'))
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } }, stars.map((star, index) => {
              const starId = asText(star.id) !== '' ? asText(star.id) : `star-${index}`
              const sectionRef = asText(star.sectionRef)
              const category = asText(star.category)
              const strategy = asText(star.strategy)
              const starText = asText(star.text)
              return h('div', { key: starId, style: S.starRow },
                h('div', { style: S.starHead },
                  h('span', {
                    style: {
                      ...S.badge,
                      color: 'var(--dsw-alias-state-warn-primary)',
                      borderColor: 'var(--dsw-alias-state-warn-primary)',
                    },
                  }, '★'),
                  category !== ''
                    ? h('span', { style: { ...S.badge, color: 'var(--dsw-alias-label-secondary)' } },
                      `${t('starCategory')}: ${category}`)
                    : null,
                  sectionRef !== ''
                    ? h('button', {
                      type: 'button',
                      style: S.buttonLink,
                      className: 'dsh-bidkit-link',
                      onClick: () => {
                        if (typeof onOpenSection === 'function') onOpenSection(sectionRef)
                      },
                    }, `${t('starSection')}: ${sectionTitleOf(sectionRef)}`)
                    : h('span', { style: S.meta }, t('starNoSection'))),
                h('div', { style: S.starText }, starText !== '' ? starText : NOT_AVAILABLE),
                strategy !== ''
                  ? h('div', { style: S.kvLine },
                    h('span', { style: S.kvKey }, t('starStrategy')),
                    h('span', null, strategy))
                  : null)
            }))),
        h('div', { style: { marginTop: 18 } },
          h('div', { style: S.sectionTitle }, t('scoringTitle')),
          hasScoring
            ? h('div', { style: S.scoringWrap },
              ...scoringBlocks.map(block => h(ScoringBlock, {
                key: block.category.key,
                category: block.category,
                items: block.items,
              })))
            : h('div', { style: S.meta }, t('scoringEmpty'))))
    }

    /**
     * 目录编排 tab: depth-first outline tree with indentation, status and targets.
     * @param {{project: object, selectedSectionId: string|null, onOpenSection: Function}} props - project state.
     * @returns {object} React element.
     */
    function OutlineTab({ project, selectedSectionId, onOpenSection }) {
      const outline = asArray(readPath(project, 'outline')).filter(isObject)
      const sectionsById = indexById(readPath(project, 'sections'))
      let baseLevel = 1
      let baseLevelSet = false
      for (const entry of outline) {
        const level = asNumber(entry.level)
        if (level === null) continue
        if (!baseLevelSet || level < baseLevel) {
          baseLevel = level
          baseLevelSet = true
        }
      }
      if (outline.length === 0) {
        return h(EmptyState, { title: t('outlineEmpty') })
      }
      return h('div', null,
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 8 } },
          h('div', { style: { ...S.sectionTitle, marginBottom: 0 } },
            tx('outlineTitle', { count: numberText(outline.length) })),
          h('div', { style: S.meta }, t('outlineHint'))),
        h('div', { style: { ...S.card, padding: 4 } }, outline.map((entry, index) => {
          const id = asText(entry.id)
          const level = asNumber(entry.level)
          const depth = level === null ? 0 : Math.max(0, level - baseLevel)
          const active = id !== '' && id === selectedSectionId
          const section = sectionsById.get(id)
          const written = asNumber(readPath(section, 'words'))
          const wordTarget = asNumber(entry.wordTarget)
          const starRefs = asArray(entry.starRefs)
          const metaParts = []
          if (wordTarget !== null && wordTarget > 0) metaParts.push(tx('wordTarget', { value: numberText(wordTarget) }))
          if (written !== null) metaParts.push(tx('writtenWords', { value: numberText(written) }))
          return h('button', {
            key: id !== '' ? id : `outline-${index}`,
            type: 'button',
            disabled: id === '',
            onClick: () => {
              if (typeof onOpenSection === 'function') onOpenSection(id)
            },
            style: {
              ...(active ? S.outlineRowActive : S.outlineRow),
              paddingLeft: 8 + Math.min(120, depth * 18),
            },
            className: active ? undefined : 'dsh-bidkit-hoverable',
            'aria-pressed': active,
            title: asText(entry.title),
          },
          h(StatusDot, { status: asText(entry.status) }),
          h('span', { style: S.outlineTitle }, asText(entry.title) !== '' ? asText(entry.title) : id),
          starRefs.length > 0
            ? h('span', {
              style: { ...S.outlineMeta, color: 'var(--dsw-alias-state-warn-primary)' },
              title: t('starsTitle'),
            }, `★ ${countText(starRefs.length)}`)
            : null,
          metaParts.length > 0 ? h('span', { style: S.outlineMeta }, metaParts.join(' · ')) : null,
          h(StatusBadge, { status: asText(entry.status) }))
        })))
    }

    /**
     * 章节预览 tab: renders the section markdown subset, inline figures and the
     * word count. Missing markdown/figures are stated, never synthesized.
     * @param {{project: object, sectionState: {phase: string, section: object|null, error: string}, onRetry: Function}} props
     * @returns {object} React element.
     */
    function PreviewTab({ project, sectionState, onRetry }) {
      const phase = asText(sectionState.phase)
      const section = isObject(sectionState.section) ? sectionState.section : null
      if (phase === 'loading') return h(Loading, { label: t('loadingSection') })
      if (phase === 'unavailable') {
        return h(Unavailable, { detail: asText(sectionState.error), onRetry })
      }
      if (section === null) {
        return h(EmptyState, { title: t('previewEmpty') })
      }
      const projectId = asText(readPath(project, 'id'))
      const figures = asArray(section.figures).filter(isObject)
      const figureIndex = new Map()
      for (const figure of figures) {
        const figureId = asText(figure.id)
        if (figureId !== '') figureIndex.set(figureId, figure)
      }
      const referenced = new Set()

      /**
       * @param {string} figureId - figure token id.
       * @returns {{source: string, title: string}|null} inline figure source.
       */
      const resolveFigure = figureId => {
        const figure = figureIndex.get(figureId)
        if (!isObject(figure)) return null
        const source = figureSource(projectId, figure)
        if (source === null) return null
        referenced.add(figureId)
        return { source, title: asText(figure.title) }
      }

      const markdown = asText(section.markdown)
      const blocks = renderMarkdown(markdown, { figure: resolveFigure })
      const unreferenced = figures.filter(figure => !referenced.has(asText(figure.id)))
      const words = asNumber(section.words)

      return h('div', null,
        h('div', { style: S.previewHead },
          h('div', { style: S.previewTitle }, asText(section.title) !== '' ? asText(section.title) : asText(section.id)),
          h(StatusBadge, { status: asText(section.status) }),
          h(Chip, { label: t('chipsWords'), value: words === null ? NOT_AVAILABLE : countText(words) })),
        blocks.length === 0
          ? h(EmptyState, { title: t('previewNoContent') })
          : h('div', { className: 'dsh-bidkit-md' }, ...blocks),
        unreferenced.length > 0
          ? h('div', null,
            h('div', { style: { ...S.sectionTitle, marginTop: 20 } }, t('previewFigures')),
            h('div', { style: S.figures }, unreferenced.map((figure, index) => {
              const source = figureSource(projectId, figure)
              const title = asText(figure.title)
              return h('div', { key: asText(figure.id) !== '' ? asText(figure.id) : `figure-${index}`, style: S.figureCard },
                source === null
                  ? h('div', { style: S.meta }, tx('previewFigureMissing', { value: asText(figure.id) }))
                  : h('img', {
                    src: source,
                    alt: title !== '' ? title : asText(figure.id),
                    loading: 'lazy',
                    decoding: 'async',
                    style: { maxWidth: 320, display: 'block', borderRadius: 6 },
                  }),
                title !== '' ? h('div', { style: S.figureCaption }, title) : null)
            })))
          : null)
    }

    /**
     * 风险审查 tab: run summary, findings grouped by severity, re-run action.
     * @param {{
     *   project: object|null,
     *   reviewRun: {phase: string, error: string},
     *   onRerun: Function,
     *   onOpenSection: Function,
     * }} props - review state and callbacks.
     * @returns {object} React element.
     */
    function ReviewTab({ project, reviewRun, onRerun, onOpenSection }) {
      const review = isObject(readPath(project, 'review')) ? project.review : null
      const findings = asArray(readPath(review, 'findings')).filter(isObject)
      const running = asText(reviewRun.phase) === 'running'
      const failure = asText(reviewRun.error)
      const runAt = formatDateTime(readPath(review, 'runAt'))
      const sectionsById = indexById(readPath(project, 'sections'))

      /**
       * @param {string} sectionId - section id.
       * @returns {string} section title, or the id when unknown.
       */
      const sectionTitleOf = sectionId => {
        const section = sectionsById.get(sectionId)
        const title = asText(readPath(section, 'title'))
        return title !== '' ? title : sectionId
      }

      const groups = []
      for (const severity of SEVERITIES) {
        const list = findings.filter(finding => asText(finding.severity) === severity)
        if (list.length > 0) groups.push({ severity, list })
      }
      const knownSeverities = new Set(SEVERITIES)
      const other = findings.filter(finding => !knownSeverities.has(asText(finding.severity)))
      if (other.length > 0) groups.push({ severity: 'other', list: other })

      let summary = isObject(readPath(review, 'summary')) ? review.summary : null
      if (summary === null && review !== null) {
        summary = {
          blocker: findings.filter(finding => asText(finding.severity) === 'blocker').length,
          major: findings.filter(finding => asText(finding.severity) === 'major').length,
          minor: findings.filter(finding => asText(finding.severity) === 'minor').length,
        }
      }

      const header = h('div', { style: S.reviewHead },
        h('div', { style: S.reviewTitle },
          t('reviewTitle'),
          review !== null && runAt !== ''
            ? h('span', { style: { ...S.meta, display: 'block', fontWeight: 400 } },
              tx('reviewRunAt', { value: runAt }))
            : null),
        h('button', {
          type: 'button',
          onClick: () => {
            if (typeof onRerun === 'function' && !running) onRerun()
          },
          disabled: running,
          style: running ? { ...S.button, opacity: 0.6, cursor: 'default' } : S.button,
          className: running ? undefined : 'dsh-bidkit-hoverable',
        }, running ? t('reviewRunning') : t('reviewRerun')))

      const failureCard = failure !== ''
        ? h('div', { style: { ...S.alert, marginBottom: 12 }, role: 'alert' }, tx('reviewFailed', { value: failure }))
        : null

      if (review === null) {
        return h('div', null, header, failureCard,
          h(EmptyState, { title: t('reviewNever') }))
      }

      return h('div', null,
        header,
        failureCard,
        h('div', { style: S.severityGrid }, SEVERITIES.map(severity => {
          const count = asNumber(readPath(summary, severity))
          return h('div', { key: severity, style: S.severityCard },
            h('div', { style: { ...S.severityValue, color: severityColor(severity) } },
              count === null ? NOT_AVAILABLE : countText(count)),
            h('div', { style: S.severityLabel }, severityLabel(severity)))
        })),
        findings.length === 0
          ? h(EmptyState, { title: t('reviewNoFindings') })
          : h('div', null,
            h('div', { style: { ...S.sectionTitle, marginTop: 4 } },
              tx('reviewFindings', { count: numberText(findings.length) })),
            groups.map(group => h('div', { key: group.severity },
              h('div', {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  margin: '12px 0 8px',
                  fontSize: 12,
                  fontWeight: 600,
                  color: severityColor(group.severity),
                },
              },
              severityLabel(group.severity),
              h('span', { style: S.meta }, countText(group.list.length))),
              group.list.map((finding, index) => {
                const findingId = asText(finding.id) !== '' ? asText(finding.id) : `finding-${index}`
                const sectionId = asText(finding.sectionId)
                const clickable = sectionId !== '' && typeof onOpenSection === 'function'
                const rule = asText(finding.rule)
                const message = asText(finding.message)
                const evidence = asText(finding.evidence)
                const suggestion = asText(finding.suggestion)
                const sectionTitle = asText(finding.sectionTitle)
                /**
                 * Navigate to the finding's section when it has one.
                 */
                const open = () => {
                  if (clickable) onOpenSection(sectionId)
                }
                return h('div', {
                  key: findingId,
                  style: clickable ? S.findingClickable : S.finding,
                  className: clickable ? 'dsh-bidkit-row' : undefined,
                  role: clickable ? 'button' : undefined,
                  tabIndex: clickable ? 0 : undefined,
                  'aria-label': clickable
                    ? `${severityLabel(finding.severity)}: ${message !== '' ? message : rule} — ${t('findingJump')}`
                    : undefined,
                  onClick: clickable ? open : undefined,
                  onKeyDown: clickable ? event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      open()
                    }
                  } : undefined,
                },
                h('div', { style: S.findingHead },
                  h(SeverityBadge, { severity: asText(finding.severity) }),
                  h('span', { style: S.findingRule, title: rule }, rule !== '' ? rule : NOT_AVAILABLE),
                  h('span', { style: S.findingMessage }, message !== '' ? message : NOT_AVAILABLE)),
                evidence !== ''
                  ? h('div', null,
                    h('div', { style: S.findingLabel }, t('findingEvidence')),
                    h('div', { style: S.findingBody }, evidence))
                  : null,
                suggestion !== ''
                  ? h('div', null,
                    h('div', { style: S.findingLabel }, t('findingSuggestion')),
                    h('div', { style: S.findingBody }, suggestion))
                  : null,
                h('div', { style: S.findingFoot },
                  sectionId !== ''
                    ? h('span', { style: { ...S.badge, color: 'var(--dsw-alias-label-secondary)' } },
                      `${t('findingSection')}: ${sectionTitle !== '' ? sectionTitle : sectionTitleOf(sectionId)}`)
                    : h('span', { style: S.meta }, t('findingNoSection')),
                  clickable ? h('span', { style: { ...S.meta, color: 'var(--dsw-alias-link)' } }, t('findingJump')) : null))
              })))))
    }

    // ---------------------------------------------------------------------
    // The workbench page, its error boundary and the plugin body
    // ---------------------------------------------------------------------

    /** Base class for the error boundary; falls back when React.Component is absent. */
    const ReactComponent = typeof React.Component === 'function'
      ? React.Component
      : class {
        /**
         * @param {object} props - React props.
         */
        constructor(props) {
          this.props = props
          this.state = { error: null }
        }

        /**
         * Minimal `setState` for non-React harnesses.
         * @param {object} next - partial state.
         */
        setState(next) {
          this.state = { ...this.state, ...next }
        }

        /**
         * @returns {null} nothing renders without React.
         */
        render() {
          return null
        }
      }

    /**
     * Hand-written error boundary: a throwing page body must not blank the slot.
     * @augments ReactComponent
     */
    class BidKitBoundary extends ReactComponent {
      /**
       * @param {object} props - React props.
       */
      constructor(props) {
        super(props)
        this.state = { error: null }
        this.handleRebuild = this.handleRebuild.bind(this)
      }

      /**
       * @param {Error} error - the thrown error.
       * @returns {{error: string}} next state.
       */
      static getDerivedStateFromError(error) {
        return { error: messageOf(error) }
      }

      /**
       * @param {Error} error - the thrown error.
       * @param {{componentStack?: string}} info - React component stack.
       */
      componentDidCatch(error, info) {
        warn('workbench page crashed', { error, info })
      }

      /** Clear the error so React retries the subtree. */
      handleRebuild() {
        this.setState({ error: null })
      }

      /**
       * @returns {object|null} fallback card or the page subtree.
       */
      render() {
        if (this.state !== null && this.state.error !== null) {
          return h('div', { style: S.boundary, role: 'alert' },
            h('div', { style: S.boundaryTitle }, t('crashed')),
            h('div', { style: S.boundaryDetail }, asText(this.state.error)),
            h('div', { style: S.boundaryDetail }, t('crashedHint')),
            h('button', {
              type: 'button',
              onClick: this.handleRebuild,
              style: S.button,
              className: 'dsh-bidkit-hoverable',
            }, t('rebuild')))
        }
        return this.props.children ?? null
      }
    }

    /**
     * The BidKit workbench page: project rail, four tabs, locked-facts panel.
     * Loads on mount, on explicit refresh, and never polls.
     * @returns {object} React element.
     */
    function WorkbenchPage() {
      const [tab, setTab] = React.useState('parse')
      const [list, setList] = React.useState({ phase: 'loading', projects: [], error: '' })
      const [selectedId, setSelectedId] = React.useState(null)
      const [detail, setDetail] = React.useState({ phase: 'idle', project: null, error: '' })
      const [sectionId, setSectionId] = React.useState(null)
      const [sectionState, setSectionState] = React.useState({ phase: 'idle', section: null, error: '' })
      const [reviewRun, setReviewRun] = React.useState({ phase: 'idle', error: '' })

      const listToken = React.useRef(0)
      const projectToken = React.useRef(0)
      const sectionToken = React.useRef(0)

      /** Load the project list; keeps the current selection when still present. */
      const loadProjects = React.useCallback(async () => {
        const token = listToken.current + 1
        listToken.current = token
        setList(previous => ({ phase: 'loading', projects: previous.projects, error: '' }))
        try {
          const projects = await listProjects()
          if (listToken.current !== token) return
          setList({ phase: 'ready', projects, error: '' })
          setSelectedId(current => {
            if (current !== null && projects.some(entry => asText(entry.id) === current)) return current
            return projects.length > 0 ? asText(projects[0].id) : null
          })
        } catch (error) {
          if (listToken.current !== token) return
          setList({ phase: 'unavailable', projects: [], error: messageOf(error) })
        }
      }, [])

      /**
       * Load one project view.
       * @param {string} id - project id.
       */
      const loadProject = React.useCallback(async id => {
        const token = projectToken.current + 1
        projectToken.current = token
        setDetail(previous => ({
          phase: 'loading',
          project: isObject(previous.project) && asText(previous.project.id) === id ? previous.project : null,
          error: '',
        }))
        try {
          const project = await readProject(id)
          if (projectToken.current !== token) return
          setDetail({ phase: 'ready', project, error: '' })
        } catch (error) {
          if (projectToken.current !== token) return
          setDetail({ phase: 'unavailable', project: null, error: messageOf(error) })
        }
      }, [])

      /**
       * Load one section view.
       * @param {string} projectIdValue - project id.
       * @param {string} nextSectionId - section id.
       */
      const loadSection = React.useCallback(async (projectIdValue, nextSectionId) => {
        const token = sectionToken.current + 1
        sectionToken.current = token
        setSectionState(previous => ({
          phase: 'loading',
          section: isObject(previous.section) && asText(previous.section.id) === nextSectionId ? previous.section : null,
          error: '',
        }))
        try {
          const section = await readSection(projectIdValue, nextSectionId)
          if (sectionToken.current !== token) return
          setSectionState({ phase: 'ready', section, error: '' })
        } catch (error) {
          if (sectionToken.current !== token) return
          setSectionState({ phase: 'unavailable', section: null, error: messageOf(error) })
        }
      }, [])

      React.useEffect(() => {
        void loadProjects()
      }, [loadProjects])

      React.useEffect(() => {
        if (selectedId === null) {
          setDetail({ phase: 'idle', project: null, error: '' })
          return
        }
        void loadProject(selectedId)
      }, [selectedId, loadProject])

      React.useEffect(() => {
        if (selectedId === null || sectionId === null) {
          setSectionState({ phase: 'idle', section: null, error: '' })
          return
        }
        void loadSection(selectedId, sectionId)
      }, [selectedId, sectionId, loadSection])

      /** Reload everything visible; the only refresh trigger besides actions. */
      const refresh = React.useCallback(() => {
        void loadProjects()
        if (selectedId !== null) void loadProject(selectedId)
        if (selectedId !== null && sectionId !== null) void loadSection(selectedId, sectionId)
      }, [loadProjects, loadProject, loadSection, selectedId, sectionId])

      /**
       * Switch project and clear the section selection tied to the old project.
       * @param {string} id - project id.
       */
      const selectProject = React.useCallback(id => {
        const value = asText(id)
        if (value === '') return
        setSelectedId(current => (current === value ? current : value))
        setSectionId(null)
        setSectionState({ phase: 'idle', section: null, error: '' })
      }, [])

      /**
       * Select a section and jump to the preview tab.
       * @param {string} nextSectionId - section id.
       */
      const openSection = React.useCallback(nextSectionId => {
        const value = asText(nextSectionId)
        if (value === '') return
        setSectionId(value)
        setTab('preview')
      }, [])

      /** Re-run the Host compliance review and merge the fresh result. */
      const rerunReview = React.useCallback(async () => {
        const projectIdValue = selectedId
        if (projectIdValue === null) return
        setReviewRun({ phase: 'running', error: '' })
        try {
          const review = await runReview(projectIdValue)
          setDetail(previous => {
            if (!isObject(previous.project) || asText(previous.project.id) !== projectIdValue) return previous
            return { ...previous, project: { ...previous.project, review } }
          })
          setReviewRun({ phase: 'idle', error: '' })
          void loadProjects()
        } catch (error) {
          setReviewRun({ phase: 'error', error: messageOf(error) })
        }
      }, [selectedId, loadProjects])

      const project = isObject(detail.project) ? detail.project : null
      const selectedSummary = asArray(list.projects).find(entry => asText(entry.id) === selectedId) ?? null
      const chips = buildProgressChips(project, selectedSummary)
      const busy = list.phase === 'loading' || detail.phase === 'loading' ||
        sectionState.phase === 'loading' || reviewRun.phase === 'running'

      /**
       * Render the active tab, including its loading/unavailable/empty states.
       * @returns {object} React element.
       */
      const renderContent = () => {
        if (selectedId === null) {
          if (list.phase === 'loading') return h(Loading, { label: t('loadingProjects') })
          if (list.phase === 'unavailable') return h(Unavailable, { detail: asText(list.error), onRetry: refresh })
          if (list.phase === 'ready') {
            return h(EmptyState, {
              title: t('noProjects'),
              hint: t('noProjectsHint'),
            })
          }
          return h(EmptyState, { title: t('selectionHint') })
        }
        if (project === null && detail.phase === 'unavailable') {
          return h(Unavailable, {
            detail: asText(detail.error),
            onRetry: () => {
              void loadProject(selectedId)
            },
          })
        }
        if (project === null) return h(Loading, { label: t('loadingProject') })
        if (tab === 'outline') {
          return h(OutlineTab, {
            key: `${asText(project.id)}:outline`,
            project,
            selectedSectionId: sectionId,
            onOpenSection: openSection,
          })
        }
        if (tab === 'preview') {
          return h(PreviewTab, {
            key: `${asText(project.id)}:preview`,
            project,
            sectionState,
            onRetry: () => {
              if (selectedId !== null && sectionId !== null) void loadSection(selectedId, sectionId)
            },
          })
        }
        if (tab === 'review') {
          return h(ReviewTab, {
            key: `${asText(project.id)}:review`,
            project,
            reviewRun,
            onRerun: rerunReview,
            onOpenSection: openSection,
          })
        }
        return h(ParseTab, {
          key: `${asText(project.id)}:parse`,
          project,
          onOpenSection: openSection,
        })
      }

      return h('div', { 'data-dsh-bidkit': 'page', className: 'dsh-bidkit-page', style: S.page },
        h('header', { style: S.header },
          h('div', { style: S.headerText },
            h('div', { style: S.headerTitle }, t('title')),
            h('div', { style: S.headerSub },
              project !== null && asText(project.name) !== '' ? asText(project.name) : t('subtitle'))),
          h('div', { style: S.spacer }),
          project !== null && formatDateTime(project.updatedAt) !== ''
            ? h('span', { style: S.updated }, tx('updatedAt', { value: formatDateTime(project.updatedAt) }))
            : null,
          h('button', {
            type: 'button',
            onClick: refresh,
            disabled: busy,
            style: busy ? { ...S.button, opacity: 0.6, cursor: 'default' } : S.button,
            className: busy ? undefined : 'dsh-bidkit-hoverable',
            'aria-label': t('refresh'),
          }, busy ? t('refreshing') : t('refresh'))),
        h('div', { style: S.body },
          h(ProjectRail, {
            list,
            selectedId,
            chips,
            onSelect: selectProject,
            onRetry: refresh,
          }),
          h('main', { style: S.center },
            h(TabBar, { tab, onSelect: setTab }),
            h('div', {
              style: S.content,
              className: 'dsh-bidkit-scroll',
              role: 'tabpanel',
              'aria-label': t(TABS.find(entry => entry.key === tab)?.labelKey ?? 'title'),
            }, renderContent())),
          h(ContextPanel, { project })))
    }

    /**
     * Slot entry for the `main` panel: the workbench behind an error boundary.
     * @returns {object} React element.
     */
    function BidKitPage() {
      return h(BidKitBoundary, null, h(WorkbenchPage))
    }

    /**
     * Sidebar glyph: a document with a checkmark, drawn in `currentColor`.
     * @param {{size?: number}} props - icon size supplied by the sidebar.
     * @returns {object} React element.
     */
    function BidKitIcon({ size }) {
      const dimension = typeof size === 'number' && Number.isFinite(size) && size > 0
        ? Math.min(64, Math.round(size))
        : 16
      return h('svg', {
        width: dimension,
        height: dimension,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
      h('path', { d: 'M6 3.5h6.9L18.5 9v11a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 19V5A1.5 1.5 0 0 1 6 3.5Z' }),
      h('path', { d: 'M12.7 3.7V9h5.6' }),
      h('path', { d: 'M8.3 14.1l2.1 2.1 3.7-4.1' }))
    }

    return {
      inject: ['slots'],
      /**
       * Register locale dictionaries, styles and the two slot entries.
       * @param {object} ctx - Client plugin context (`slots` injected).
       */
      apply(ctx) {
        registerLocale(ctx)
        registerEffect(ctx, () => installStyles(), 'dsh-plugin-bidkit: styles')
        if (!isObject(ctx) || !isObject(ctx.slots) ||
          typeof ctx.slots.inject !== 'function' || typeof ctx.slots.register !== 'function') {
          warn('slots service unavailable; the BidKit page was not registered')
          return
        }
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: LOCALE_NS,
        }, BidKitPage))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 26,
          locale: LOCALE_NS,
          label: () => t('panel'),
        }, BidKitIcon))
      },
    }
  },
})
