# BidKit internal contract (Host ↔ Client ↔ exporter)

This file is the single agreement between the three halves of the bundle. Values
are normative: change them in one place and update all three.

## 0. Bundle shape

| Half | File | Owner |
| --- | --- | --- |
| Host plugin (Cordis function plugin) | `index.js` + `lib/*.js` | host |
| Browser module (`window.__ModuleLoader__`) | `client.js` | client |
| Word exporter (pure JS, zero deps) | `lib/docx.js` | exporter |

- Package id / module id / slot keys: `dsh-plugin-bidkit`.
- No runtime dependencies. Node built-ins only on the Host; browser globals only
  in `client.js`. No external agent runtime, no SQLite, no bridge process.
- Every registration is a `ctx.effect` disposer so uninstall leaves nothing.

## 1. On-disk project store (source of truth)

```
<dataDir>/<projectId>/
  project.json          # the whole index (parse, outline, facts, review, exports)
  tender/source.md      # exact copy of the imported tender file
  tender/sections.json  # deterministic split used by the parser
  sections/<id>.md      # one file per chapter — long documents never live in memory
  figures/<id>.svg      # rendered diagram assets
  exports/<file>.docx   # produced Word files
```

`project.json` is rewritten atomically (temp file + rename). Lost write = the
previous `project.json` remains intact; `sections/*.md` are the durable body and
`project.json` only indexes them.

## 2. HTTP API (Host `webServer` prefix route)

All routes are **same-origin**, JSON except the asset/download routes, and are
admitted by the Harness `connection` service. Base: `/dsh-plugin-bidkit/api`.
Errors: `{ "ok": false, "error": { "code": string, "message": string } }`.

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/health` | – | `{ ok:true, version, projectCount }` |
| GET | `/projects` | – | `{ ok:true, projects: ProjectSummary[] }` |
| GET | `/projects/:id` | – | `{ ok:true, project: ProjectView }` |
| GET | `/projects/:id/sections/:sid` | – | `{ ok:true, section: SectionView }` |
| GET | `/projects/:id/figures/:fid.svg` | – | `image/svg+xml` |
| GET | `/projects/:id/export/latest` | – | `.docx` download |
| POST | `/projects/:id/review` | `{}` | `{ ok:true, review: Review }` |

### 2.1 ProjectSummary

```ts
{ id: string, name: string, updatedAt: string,
  progress: { sections: number, sectionsTotal: number, words: number,
              coverage: { filled: number, total: number }, stars: number,
              risks: { blocker: number, major: number, minor: number },
              exported: boolean } }
```

### 2.2 ProjectView

```ts
{ id: string, name: string, updatedAt: string,
  tender: { title: string, sourceFile: string, sectionCount: number },
  parse: {
    coverage: { filled: number, total: number },
    items: Array<{ key: string, label: string,
                   status: 'filled'|'partial'|'missing',
                   value: string, risk: 'low'|'medium'|'high',
                   evidence: Array<{ sectionId: string, quote: string }> }>,
    starClauses: Array<{ id: string, text: string, category: string,
                         strategy: string, sectionRef: string|null }>,
    scoring: { technical: ScoreItem[], commercial: ScoreItem[], price: ScoreItem[] },
    lots: Array<{ id: string, name: string, stage: string }>
  },
  facts: Array<{ key: string, value: string, lockedAt: string }>,
  outline: Array<{ id: string, title: string, level: number,
                   wordTarget: number, status: 'pending'|'writing'|'done',
                   scoreRefs: string[], starRefs: string[] }>,   // depth-first order
  sections: Array<{ id: string, title: string, level: number, words: number,
                    status: 'pending'|'writing'|'done', updatedAt: string|null }>,
  figures: Array<{ id: string, title: string, kind: string,
                   sectionId: string, w: number, h: number }>,
  review: Review | null,
  exports: Array<{ file: string, at: string, bytes: number }> }

type ScoreItem = { item: string, maxScore: number, criteria: string }
```

### 2.3 Review

```ts
{ runAt: string,
  summary: { blocker: number, major: number, minor: number },
  findings: Array<{ id: string, rule: string,
                    severity: 'blocker'|'major'|'minor',
                    sectionId: string|null, sectionTitle: string|null,
                    message: string, evidence: string, suggestion: string }> }
```

### 2.4 SectionView

```ts
{ id: string, title: string, markdown: string, words: number,
  status: 'pending'|'writing'|'done',
  figures: Array<{ id: string, title: string, url: string }> }
```

## 3. Word exporter contract

`lib/docx.js` exports exactly:

```js
export async function buildDocx(model, options = {}) => Promise<{ buffer: Uint8Array, warnings: string[], bytes: number }>
```

`model` (all fields optional except `sections`; exporter must clamp/sanitize):

```ts
{ meta: { title?: string, subtitle?: string, tenderNo?: string, bidder?: string, date?: string },
  cover: { enabled?: boolean, projectName?: string, bidder?: string, date?: string, tenderNo?: string },
  page: { widthTwips?: number, heightTwips?: number,
          margins?: { top?: number, bottom?: number, left?: number, right?: number } },
  fonts: { body?: string, heading?: string, latin?: string, bodySizePt?: number },
  header: { text?: string },
  footer: { pageNumber?: boolean, text?: string },
  toc: { enabled?: boolean, maxLevel?: number },
  facts?: Array<{ key: string, value: string }>,
  sections: Array<{ id: string, title: string, level: number,   // 1..4
                    markdown: string,
                    figures?: Array<{ id: string, title: string, svg: string, model?: object }> }> }
```

Markdown subset the exporter must support: ATX headings (`#`..`####`), paragraphs,
bullet and ordered lists, blockquote, fenced code, pipe tables (with header row),
`**bold**`/`*italic*`/`` `code` ``, horizontal rule `---`, and the inline figure
token `[[figure:<id>]]` which must embed the matching entry of that section's
`figures` array at that exact position.

Figure caption numbering is the exporter's job: it prefixes `图 N　` in document
order, so callers must pass a title without a leading `图 X` (the Host strips it
when building the model). `svg` is required for native rendering; `model` is an
optional authoring hint.

Output requirements: valid OOXML `.docx` (ZIP with `[Content_Types].xml`,
`_rels/.rels`, `word/document.xml`, `word/styles.xml`, `word/settings.xml`,
`word/_rels/document.xml.rels`, `word/footer1.xml`, optional `word/media/*`);
Chinese east-asian fonts set through `w:rFonts/@w:eastAsia`; heading styles
linked to outline levels; automatic TOC field; page numbers as fields; figures
embedded as native Word drawings (Chinese labels must render with system fonts —
do **not** rasterize text).

## 4. Browser half contract

`client.js` is the loader-format bundle:

```js
window.__ModuleLoader__.load({ id: 'dsh-plugin-bidkit', factory(require) { /* returns Cordis client plugin */ } })
```

- Registers `main` slot key `dsh-plugin-bidkit` (full workbench page) and one
  `sidebar.panellist` icon with the same id, so the page is reachable from the
  left column and removable on uninstall.
- Four tabs: tender parse (18-item tree + ★ clauses + scoring), outline
  (multi-level tree + status + word targets), section preview (markdown,
  rendered figures, word count), risk review (findings grouped by severity,
  click jumps to the section; a "re-run review" action posts `/review`).
- Data comes only from the HTTP API in §2; when a route/field is missing the UI
  states that explicitly and never invents data.
- Styling: only `--dsw-alias-*` theme tokens; no Harness Client package import.
- All listeners/timers/styles are effects with disposers.
