/**
 * Figure rendering for bid bodies.
 *
 * A technical bid needs architecture and flow diagrams, and they must survive
 * into Word. So a figure is built as a small *diagram model* (boxes, arrows,
 * labels in a point coordinate system) first, then rendered twice from that
 * same model: to SVG for the workbench and to native Word shapes by the
 * exporter. Chinese labels therefore always render with a real system font
 * instead of being rasterized.
 *
 * Supported inputs:
 * - `mermaid` — a documented subset of `flowchart TB|LR` (`A[标签] --> B[标签]`,
 *   `A --> B`, `A -- 说明 --> B`, `A{判断}`), which is what a model writes most
 *   naturally;
 * - `flow` — explicit step list `{ steps: [{ title, detail }] }`;
 * - `architecture` — `{ layers: [{ name, items: [{ label, note }] }] }`;
 * - `svg` — a caller-supplied, sanitized standalone SVG (shown as-is).
 *
 * @module lib/figure
 */

/** Canvas geometry, in points. */
const PAD = 24
const GAP_X = 44
const GAP_Y = 34
const MIN_BOX_W = 132
const NODE_H = 52
const FONT = 12

/** Print-friendly palette (figures may use their own colors per Harness rules). */
const PALETTE = Object.freeze({
  box: '#eef3fd',
  boxStroke: '#3b6fd4',
  accent: '#f4f7fb',
  accentStroke: '#8aa4cc',
  text: '#1b2430',
  muted: '#5b6b7f',
  arrow: '#4a5a70',
})

/**
 * Count display width: CJK counts double.
 * @param {string} text - label.
 * @returns {number} width in character units.
 */
export function textWidth(text) {
  let width = 0
  for (const char of String(text)) width += /[\u3400-\u9fff\uf900-\ufaff]/u.test(char) ? 2 : 1
  return width
}

/**
 * Wrap a label into lines of at most `max` character units.
 * @param {string} label - raw label.
 * @param {number} max - maximum units per line.
 * @returns {string[]} lines.
 */
export function wrapLabel(label, max = 18) {
  const lines = []
  let current = ''
  let width = 0
  for (const char of String(label)) {
    const size = /[\u3400-\u9fff\uf900-\ufaff]/u.test(char) ? 2 : 1
    if (width + size > max && current !== '') {
      lines.push(current)
      current = char
      width = size
    } else {
      current += char
      width += size
    }
  }
  if (current !== '') lines.push(current)
  return lines.length === 0 ? [''] : lines
}

/**
 * Build a diagram model from a figure specification.
 * @param {{ kind: string, source?: string, steps?: object[], layers?: object[], title?: string }} spec - figure input.
 * @returns {{ width: number, height: number, nodes: object[], arrows: object[], notes: object[] }} diagram model.
 */
export function buildDiagram(spec) {
  switch (spec.kind) {
    case 'flow':
      return buildFlow(spec.steps ?? [])
    case 'architecture':
      return buildArchitecture(spec.layers ?? [])
    case 'mermaid':
    default:
      return buildMermaid(spec.source ?? '')
  }
}

/**
 * Lay out an explicit vertical flow.
 * @param {Array<{ title: string, detail?: string }>} steps - flow steps.
 * @returns {object} diagram model.
 */
function buildFlow(steps) {
  const nodes = []
  const arrows = []
  const width = Math.max(320, ...steps.map(step => textWidth(step.title) * 6 + 120))
  let y = PAD
  for (const [index, step] of steps.entries()) {
    const label = step.title ?? `步骤 ${index + 1}`
    const detail = step.detail ?? ''
    const lines = wrapLabel(label, Math.max(12, Math.floor(width / 7)))
    const detailLines = detail === '' ? [] : wrapLabel(detail, Math.max(14, Math.floor(width / 6.5)))
    const boxWidth = Math.min(width - PAD * 2, Math.max(MIN_BOX_W, Math.max(...lines.map(line => textWidth(line))) * 6 + 40))
    const boxHeight = NODE_H + detailLines.length * 16
    nodes.push({
      id: `n${index}`,
      x: PAD,
      y,
      width: boxWidth,
      height: boxHeight,
      shape: 'roundrect',
      lines,
      detailLines,
      fill: index % 2 === 0 ? PALETTE.box : PALETTE.accent,
      stroke: index % 2 === 0 ? PALETTE.boxStroke : PALETTE.accentStroke,
    })
    if (index > 0) {
      const previous = nodes[index - 1]
      arrows.push({
        points: [
          [previous.x + previous.width / 2, previous.y + previous.height],
          [PAD + boxWidth / 2, y],
        ],
        label: '',
      })
    }
    y += boxHeight + GAP_Y
  }
  const height = Math.max(NODE_H + PAD * 2, y - GAP_Y + PAD)
  return { width: width + PAD, height, nodes, arrows, notes: [] }
}

/**
 * Lay out a layered architecture diagram.
 * @param {Array<{ name: string, items: Array<{ label: string, note?: string }> }>} layers - layers bottom-up.
 * @returns {object} diagram model.
 */
function buildArchitecture(layers) {
  const nodes = []
  const arrows = []
  const columns = Math.max(1, ...layers.map(layer => (layer.items ?? []).length))
  // Reserve a left gutter for the layer name so item boxes never cover it.
  const labelGutter = 78
  const boxWidth = Math.max(MIN_BOX_W, Math.floor((620 - labelGutter) / columns))
  const width = PAD * 2 + labelGutter + columns * boxWidth + (columns - 1) * GAP_X
  const layerHeight = 76
  let y = PAD
  for (const [layerIndex, layer] of layers.entries()) {
    nodes.push({
      id: `layer-${layerIndex}`,
      x: PAD,
      y,
      width: labelGutter + columns * boxWidth + (columns - 1) * GAP_X,
      height: layerHeight,
      shape: 'rect',
      lines: [layer.name ?? `层 ${layerIndex + 1}`],
      detailLines: [],
      fill: PALETTE.accent,
      stroke: PALETTE.accentStroke,
      labelOnly: true,
      align: 'left',
    })
    const items = layer.items ?? []
    for (const [itemIndex, item] of items.entries()) {
      const x = PAD + labelGutter + itemIndex * (boxWidth + GAP_X)
      nodes.push({
        id: `n-${layerIndex}-${itemIndex}`,
        x: x + 12,
        y: y + 10,
        width: boxWidth - 28,
        height: layerHeight - 20,
        shape: 'roundrect',
        lines: wrapLabel(item.label ?? '', Math.max(8, Math.floor((boxWidth - 48) / 6.6))),
        detailLines: item.note === undefined ? [] : wrapLabel(item.note, Math.max(10, Math.floor((boxWidth - 48) / 6))),
        fill: '#ffffff',
        stroke: PALETTE.boxStroke,
      })
    }
    if (layerIndex > 0) {
      const previousY = y - GAP_Y
      arrows.push({ points: [[PAD + 30, previousY], [PAD + 30, y]], label: '' })
    }
    y += layerHeight + GAP_Y
  }
  const height = Math.max(160, y - GAP_Y + PAD)
  return { width, height, nodes, arrows, notes: [] }
}

/**
 * Parse the supported Mermaid `flowchart` subset and lay it out by rank.
 * @param {string} source - mermaid source.
 * @returns {object} diagram model.
 */
function buildMermaid(source) {
  const direction = /flowchart\s+(TB|TD|BT|LR|RL)/iu.exec(source)?.[1]?.toUpperCase() ?? 'TB'
  const nodes = new Map()
  const edges = []
  const lines = String(source ?? '').split('\n').map(line => line.trim()).filter(line => line !== '' && !/^flowchart|^graph/iu.test(line))

  for (const line of lines) {
    const edgeMatch = /^(?<from>[A-Za-z0-9_]+)\s*(?:\[(?<fromLabel>[^\]]*)\]|\((?<fromParen>[^)]*)\)|\{(?<fromDiamond>[^}]*)\})?\s*(?:--\s*(?<edgeLabel>[^->]+?)\s*)?-->\s*(?:\|(?<pipeLabel>[^|]*)\|\s*)?(?<to>[A-Za-z0-9_]+)\s*(?:\[(?<toLabel>[^\]]*)\]|\((?<toParen>[^)]*)\)|\{(?<toDiamond>[^}]*)\})?\s*$/u.exec(line)
    if (edgeMatch !== null) {
      const groups = edgeMatch.groups
      registerNode(nodes, groups.from, groups.fromLabel ?? groups.fromParen ?? groups.fromDiamond, groups.fromDiamond !== undefined ? 'diamond' : groups.fromParen !== undefined ? 'roundrect' : 'rect')
      registerNode(nodes, groups.to, groups.toLabel ?? groups.toParen ?? groups.toDiamond, groups.toDiamond !== undefined ? 'diamond' : groups.toParen !== undefined ? 'roundrect' : 'rect')
      edges.push({ from: groups.from, to: groups.to, label: (groups.edgeLabel ?? groups.pipeLabel ?? '').trim() })
      continue
    }
    const nodeMatch = /^(?<id>[A-Za-z0-9_]+)\s*(?:\[(?<label>[^\]]*)\]|\((?<paren>[^)]*)\)|\{(?<diamond>[^}]*)\})$/u.exec(line)
    if (nodeMatch !== null && nodeMatch.groups !== undefined) {
      registerNode(nodes, nodeMatch.groups.id, nodeMatch.groups.label ?? nodeMatch.groups.paren ?? nodeMatch.groups.diamond, nodeMatch.groups.diamond !== undefined ? 'diamond' : 'rect')
    }
  }

  const ranks = rankNodes(nodes, edges)
  return layoutRanks(nodes, edges, ranks, direction)
}

/**
 * Register a Mermaid node.
 * @param {Map<string, object>} nodes - node map.
 * @param {string} id - node id.
 * @param {string|undefined} label - label text.
 * @param {string} shape - shape kind.
 * @returns {void}
 */
function registerNode(nodes, id, label, shape) {
  if (nodes.has(id)) {
    const existing = nodes.get(id)
    if (label !== undefined && label !== '' && existing.label === id) existing.label = label
    return
  }
  nodes.set(id, { id, label: label === undefined || label === '' ? id : label, shape })
}

/**
 * Assign a rank to every node with a BFS from roots (cycles cut safely).
 * @param {Map<string, object>} nodes - node map.
 * @param {Array<{ from: string, to: string }>} edges - edges.
 * @returns {Map<string, number>} rank per node id.
 */
function rankNodes(nodes, edges) {
  const incoming = new Map([...nodes.keys()].map(id => [id, 0]))
  for (const edge of edges) incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
  const ranks = new Map()
  const queue = []
  for (const [id, count] of incoming) {
    if (count === 0) {
      ranks.set(id, 0)
      queue.push(id)
    }
  }
  if (queue.length === 0 && nodes.size > 0) {
    const first = [...nodes.keys()][0]
    ranks.set(first, 0)
    queue.push(first)
  }
  // Longest-path ranking with a hard rank cap: a cycle (A → B → A) would
  // otherwise keep raising ranks forever and explode the canvas.
  const cap = Math.max(1, nodes.size - 1)
  let guard = 0
  while (queue.length > 0 && guard < nodes.size * nodes.size + 16) {
    guard += 1
    const id = queue.shift()
    const rank = ranks.get(id) ?? 0
    for (const edge of edges) {
      if (edge.from !== id) continue
      const next = Math.min(cap, Math.max(ranks.get(edge.to) ?? 0, rank + 1))
      if ((ranks.get(edge.to) ?? -1) < next) {
        ranks.set(edge.to, next)
        queue.push(edge.to)
      }
    }
  }
  for (const id of nodes.keys()) if (!ranks.has(id)) ranks.set(id, 0)
  return ranks
}

/**
 * Place ranked nodes on a canvas.
 * @param {Map<string, object>} nodes - nodes.
 * @param {Array<{ from: string, to: string, label: string }>} edges - edges.
 * @param {Map<string, number>} ranks - rank per node.
 * @param {string} direction - mermaid direction.
 * @returns {object} diagram model.
 */
function layoutRanks(nodes, edges, ranks, direction) {
  const maxRank = Math.max(0, ...ranks.values())
  const groups = Array.from({ length: maxRank + 1 }, () => [])
  for (const node of nodes.values()) groups[ranks.get(node.id) ?? 0].push(node)

  const boxWidthFor = node => Math.max(MIN_BOX_W, Math.min(240, Math.max(...wrapLabel(node.label, 16).map(line => textWidth(line))) * 6.6 + 36))
  const rowHeights = groups.map(group => group.reduce((height, node) => Math.max(height, NODE_H + 14), NODE_H))
  const maxRowWidth = Math.max(...groups.map(group => group.reduce((width, node) => width + boxWidthFor(node) + GAP_X, -GAP_X)))
  const vertical = direction === 'TB' || direction === 'TD' || direction === 'BT'

  const placed = []
  const positions = new Map()
  let cursor = PAD
  for (const [rank, group] of groups.entries()) {
    const rowWidth = group.reduce((width, node) => width + boxWidthFor(node) + GAP_X, -GAP_X)
    let x = PAD + Math.max(0, (maxRowWidth - rowWidth) / 2)
    for (const node of group) {
      const width = boxWidthFor(node)
      const item = {
        id: node.id,
        x: vertical ? x : cursor,
        y: vertical ? cursor : PAD + rank * 0,
        width,
        height: rowHeights[rank],
        shape: node.shape,
        lines: wrapLabel(node.label, Math.max(6, Math.floor(width / 6.6))),
        detailLines: [],
        fill: PALETTE.box,
        stroke: PALETTE.boxStroke,
      }
      placed.push(item)
      positions.set(node.id, item)
      x += width + GAP_X
    }
    cursor += rowHeights[rank] + GAP_Y
  }

  if (!vertical) {
    // Horizontal layout: rank -> column, node index -> row.
    let columnX = PAD
    for (const [rank, group] of groups.entries()) {
      const columnWidth = Math.max(...group.map(node => boxWidthFor(node)))
      let y = PAD
      for (const node of group) {
        const item = positions.get(node.id)
        item.x = columnX
        item.y = y
        item.width = columnWidth
        y += item.height + GAP_Y
      }
      columnX += columnWidth + GAP_X * 2
      void rank
    }
  }

  const arrows = []
  for (const edge of edges) {
    const from = positions.get(edge.from)
    const to = positions.get(edge.to)
    if (from === undefined || to === undefined) continue
    if (vertical) {
      arrows.push({
        points: [
          [from.x + from.width / 2, from.y + from.height],
          [to.x + to.width / 2, to.y],
        ],
        label: edge.label,
      })
    } else {
      arrows.push({
        points: [
          [from.x + from.width, from.y + from.height / 2],
          [to.x, to.y + to.height / 2],
        ],
        label: edge.label,
      })
    }
  }
  const width = PAD * 2 + Math.max(...placed.map(item => item.x + item.width))
  const height = PAD * 2 + Math.max(...placed.map(item => item.y + item.height))
  return { width, height, nodes: placed, arrows, notes: [] }
}

/**
 * Render a diagram model to a standalone SVG document.
 *
 * Only the primitive set below is emitted (`rect`, `path`, `text`), which is
 * also the set the Word exporter understands when it converts the same model
 * into native shapes.
 * @param {object} model - diagram model.
 * @param {{ title?: string }} [options] - render options.
 * @returns {string} SVG source.
 */
export function renderSvg(model, options = {}) {
  const parts = []
  const width = Math.max(160, Math.ceil(model.width))
  const height = Math.max(90, Math.ceil(model.height))
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="PingFang SC, Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="${FONT}" role="img">`)
  if (options.title !== undefined) parts.push(`<title>${escapeXml(options.title)}</title>`)
  parts.push('<defs><marker id="arrowhead" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto"><path d="M0,0 L9,3.5 L0,7 z" fill="#4a5a70"/></marker></defs>')
  for (const node of model.nodes) {
    const rx = node.shape === 'roundrect' ? 8 : 0
    parts.push(`<rect x="${round(node.x)}" y="${round(node.y)}" width="${round(node.width)}" height="${round(node.height)}" rx="${rx}" fill="${node.fill}" stroke="${node.stroke}" stroke-width="1.2"/>`)
    const lines = node.lines ?? []
    const totalLines = lines.length + (node.detailLines?.length ?? 0)
    const lineHeight = 16
    const startY = node.y + node.height / 2 - ((totalLines - 1) * lineHeight) / 2 + FONT / 2 - 2
    const anchor = node.align === 'left' ? 'start' : 'middle'
    const textX = node.align === 'left' ? node.x + 12 : node.x + node.width / 2
    lines.forEach((line, index) => {
      parts.push(`<text x="${round(textX)}" y="${round(startY + index * lineHeight)}" fill="${PALETTE.text}" font-size="${FONT + 1}" font-weight="${node.labelOnly === true ? 600 : 500}" text-anchor="${anchor}">${escapeXml(line)}</text>`)
    })
    ;(node.detailLines ?? []).forEach((line, index) => {
      parts.push(`<text x="${round(textX)}" y="${round(startY + (lines.length + index) * lineHeight)}" fill="${PALETTE.muted}" font-size="${FONT - 1}" text-anchor="${anchor}">${escapeXml(line)}</text>`)
    })
  }
  for (const arrow of model.arrows) {
    const points = arrow.points
    const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${round(point[0])},${round(point[1])}`).join(' ')
    parts.push(`<path d="${path}" fill="none" stroke="${PALETTE.arrow}" stroke-width="1.3" marker-end="url(#arrowhead)"/>`)
    if (arrow.label !== '') {
      const middle = points[Math.floor(points.length / 2)]
      parts.push(`<text x="${round(middle[0] + 8)}" y="${round(middle[1] - 6)}" fill="${PALETTE.muted}" font-size="${FONT - 1}">${escapeXml(arrow.label)}</text>`)
    }
  }
  parts.push('</svg>')
  return `${parts.join('\n')}\n`
}

/**
 * Build a figure from a specification and return both representations.
 * @param {{ kind: string, source?: string, steps?: object[], layers?: object[], title?: string }} spec - figure input.
 * @param {{ title?: string }} [options] - render options.
 * @returns {{ svg: string, model: object, width: number, height: number, kind: string }} rendered figure.
 */
export function createFigure(spec, options = {}) {
  if (spec.kind === 'svg') {
    const svg = sanitizeSvg(String(spec.source ?? ''))
    return { svg, model: { width: 600, height: 360, nodes: [], arrows: [], notes: [] }, width: 600, height: 360, kind: 'svg' }
  }
  const model = buildDiagram(spec)
  const svg = renderSvg(model, { title: options.title ?? spec.title })
  return {
    svg,
    model: {
      width: Math.ceil(model.width),
      height: Math.ceil(model.height),
      nodes: model.nodes.map(node => ({
        x: round(node.x), y: round(node.y), width: round(node.width), height: round(node.height),
        shape: node.shape, lines: node.lines, detailLines: node.detailLines ?? [],
        fill: node.fill, stroke: node.stroke, align: node.align ?? 'center',
      })),
      arrows: model.arrows,
    },
    width: Math.ceil(model.width),
    height: Math.ceil(model.height),
    kind: spec.kind,
  }
}

/**
 * Reject an SVG that carries script or foreign content.
 * @param {string} svg - candidate source.
 * @returns {string} the accepted source.
 * @throws {Error} on unsafe or malformed input.
 */
export function sanitizeSvg(svg) {
  const text = String(svg ?? '').trim()
  if (!/^<svg[\s>]/iu.test(text)) throw new Error('kind=svg 需要以 <svg ...> 开头的独立 SVG 文档')
  if (/<script|javascript:|onload=|onerror=|foreignObject/iu.test(text)) {
    throw new Error('SVG 中包含脚本或外部内容，已拒绝（只接受纯图形 SVG）')
  }
  return text
}

/**
 * Round to one decimal for stable output.
 * @param {number} value - number.
 * @returns {number} rounded number.
 */
function round(value) {
  return Math.round(value * 10) / 10
}

/**
 * Escape XML text.
 * @param {string} text - raw text.
 * @returns {string} escaped text.
 */
export function escapeXml(text) {
  return String(text)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;')
}
