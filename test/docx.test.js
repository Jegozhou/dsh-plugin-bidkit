/**
 * lib/docx.js 的验收测试。
 *
 * 测试自己实现了一个最小 ZIP 读取器（解析 EOCD → 中央目录 → 本地文件头，
 * 用 node:zlib 解压），因此“导出的 zip 是否合法”不依赖任何第三方库：
 *  - 每个条目的 CRC 由测试用独立实现重新计算并与中央目录 / 本地头比对；
 *  - 每个 XML 部件都做“去命名空间前缀 + 标签配平”的良构性检查；
 *  - [Content_Types].xml、.rels 的覆盖关系与 r:id 引用都做交叉校验。
 *
 * 运行：node --test test/docx.test.js
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { inflateRawSync } from 'node:zlib'

import { buildDocx } from '../lib/docx.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, 'out')

/* ==================================================================== *
 * 1. 测试内置：CRC32 与 ZIP 读取（与实现无关的独立版本）
 * ==================================================================== */

/**
 * 独立实现的 CRC32（用于校验导出器写入的 CRC）。
 * @param {Uint8Array} data 数据。
 * @returns {number} CRC32。
 */
function crc32(data) {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i += 1) {
    crc ^= data[i]
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** 把任意 Uint8Array/Buffer 视图转成 Buffer。 */
function toBuffer(source) {
  if (Buffer.isBuffer(source)) return source
  assert.ok(source instanceof Uint8Array, '期望 Uint8Array')
  return Buffer.from(source.buffer, source.byteOffset, source.byteLength)
}

/**
 * 解析 ZIP：从 EOCD 找到中央目录，再按本地文件头定位数据。
 * @param {Uint8Array} source docx 字节。
 * @returns {{ entries: Map<string, object>, count: number, order: string[] }} 解析结果。
 */
function readZip(source) {
  const buf = toBuffer(source)
  assert.ok(buf.length > 22, 'ZIP 太短')

  let eocd = -1
  const minOffset = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= minOffset; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  assert.ok(eocd >= 0, '未找到 EOCD（文件尾签名 0x06054b50）')

  const diskNumber = buf.readUInt16LE(eocd + 4)
  const cdDisk = buf.readUInt16LE(eocd + 6)
  const countOnDisk = buf.readUInt16LE(eocd + 8)
  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  const commentLength = buf.readUInt16LE(eocd + 20)

  assert.equal(diskNumber, 0, 'EOCD 磁盘号应为 0')
  assert.equal(cdDisk, 0, 'EOCD 中央目录磁盘号应为 0')
  assert.equal(countOnDisk, count, 'EOCD 条目数应自洽')
  assert.equal(commentLength, 0, 'ZIP 注释长度应为 0')
  assert.equal(eocd + 22 + commentLength, buf.length, 'EOCD 之后不应有多余字节')
  assert.ok(cdOffset + cdSize <= buf.length, '中央目录不应越界')

  /** @type {Map<string, object>} */
  const entries = new Map()
  /** @type {string[]} */
  const order = []
  let pointer = cdOffset

  for (let index = 0; index < count; index += 1) {
    assert.equal(buf.readUInt32LE(pointer), 0x02014b50, `第 ${index} 个中央目录条目签名错误`)
    const flags = buf.readUInt16LE(pointer + 8)
    const method = buf.readUInt16LE(pointer + 10)
    const time = buf.readUInt16LE(pointer + 12)
    const date = buf.readUInt16LE(pointer + 14)
    const crc = buf.readUInt32LE(pointer + 16)
    const compressedSize = buf.readUInt32LE(pointer + 20)
    const rawSize = buf.readUInt32LE(pointer + 24)
    const nameLength = buf.readUInt16LE(pointer + 28)
    const extraLength = buf.readUInt16LE(pointer + 30)
    const commentLen = buf.readUInt16LE(pointer + 32)
    const localOffset = buf.readUInt32LE(pointer + 42)
    const name = buf.toString('utf8', pointer + 46, pointer + 46 + nameLength)

    assert.ok(name.length > 0, '条目名不能为空')
    assert.ok(!entries.has(name), `条目名重复：${name}`)

    // 本地文件头
    assert.equal(buf.readUInt32LE(localOffset), 0x04034b50, `${name} 本地文件头签名错误`)
    const localFlags = buf.readUInt16LE(localOffset + 6)
    const localMethod = buf.readUInt16LE(localOffset + 8)
    const localTime = buf.readUInt16LE(localOffset + 10)
    const localDate = buf.readUInt16LE(localOffset + 12)
    const localCrc = buf.readUInt32LE(localOffset + 14)
    const localCompressed = buf.readUInt32LE(localOffset + 18)
    const localRaw = buf.readUInt32LE(localOffset + 22)
    const localNameLength = buf.readUInt16LE(localOffset + 26)
    const localExtraLength = buf.readUInt16LE(localOffset + 28)
    const localName = buf.toString('utf8', localOffset + 30, localOffset + 30 + localNameLength)

    assert.equal(localName, name, '本地文件头的文件名必须与中央目录一致')
    assert.equal(localFlags, flags, '本地/中央目录 flags 不一致')
    assert.equal(localMethod, method, '本地/中央目录压缩方法不一致')
    assert.equal(localTime, time, '本地/中央目录时间不一致')
    assert.equal(localDate, date, '本地/中央目录日期不一致')
    assert.equal(localCrc, crc, '本地/中央目录 CRC 不一致')
    assert.equal(localCompressed, compressedSize, '本地/中央目录压缩长度不一致')
    assert.equal(localRaw, rawSize, '本地/中央目录原始长度不一致')
    assert.ok((flags & 0x0800) !== 0, `${name} 未设置 UTF-8 文件名标志位`)
    assert.ok(method === 0 || method === 8, `${name} 压缩方法非法：${method}`)

    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const payload = buf.subarray(dataStart, dataStart + compressedSize)
    const data = method === 0 ? Buffer.from(payload) : inflateRawSync(payload)

    entries.set(name, {
      name,
      flags,
      method,
      crc,
      compressedSize,
      rawSize,
      data,
      localCrc,
    })
    order.push(name)
    pointer += 46 + nameLength + extraLength + commentLen
  }

  assert.equal(pointer, cdOffset + cdSize, '中央目录长度应与 EOCD 一致')
  return { entries, count, order }
}

/* ==================================================================== *
 * 2. 测试内置：XML 良构性检查（去命名空间前缀 + 标签配平）
 * ==================================================================== */

/**
 * 检查文本/属性中没有未转义的 `&`。
 * @param {string} text 待检查文本。
 * @param {string} label 上下文标签。
 */
function assertNoBareAmpersand(text, label) {
  const bare = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.exec(text)
  assert.equal(bare, null, `${label}: 存在未转义的 & → ${bare ? bare.input.slice(bare.index, bare.index + 30) : ''}`)
}

/**
 * 极简 XML 良构性检查：忽略命名空间前缀（按 local name 配平），
 * 处理注释 / CDATA / 处理指令，并要求单一根元素。
 * @param {string} xml XML 文本。
 * @param {string} label 部件名（用于断言信息）。
 * @returns {string} 根元素 local name。
 */
function assertWellFormed(xml, label) {
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8" standalone="yes"\?>/, `${label}: 缺少 XML 声明`)

  /** @type {string[]} */
  const stack = []
  /** @type {string[]} */
  const roots = []
  let i = 0

  while (i < xml.length) {
    const lt = xml.indexOf('<', i)
    if (lt === -1) {
      const tail = xml.slice(i)
      assert.equal(tail.trim(), '', `${label}: 根元素之后存在文本`)
      break
    }
    const text = xml.slice(i, lt)
    if (stack.length === 0) {
      assert.equal(text.trim(), '', `${label}: 根元素之前存在文本`)
    }
    assertNoBareAmpersand(text, label)

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt)
      assert.ok(end > 0, `${label}: 注释未结束`)
      i = end + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt)
      assert.ok(end > 0, `${label}: CDATA 未结束`)
      i = end + 3
      continue
    }
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt)
      assert.ok(end > 0, `${label}: 处理指令未结束`)
      i = end + 2
      continue
    }
    if (xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt)
      assert.ok(end > 0, `${label}: DOCTYPE 未结束`)
      i = end + 1
      continue
    }

    // 找到标签结束的 '>'，期间不能越过引号内的字符
    let j = lt + 1
    let quote = null
    while (j < xml.length) {
      const ch = xml[j]
      if (quote) {
        if (ch === quote) quote = null
        else assert.notEqual(ch, '<', `${label}: 属性值中出现裸 <`)
      } else if (ch === '"' || ch === "'") {
        quote = ch
      } else if (ch === '>') {
        break
      }
      j += 1
    }
    assert.ok(j < xml.length, `${label}: 标签未闭合`)
    assert.equal(quote, null, `${label}: 属性引号未闭合`)

    const raw = xml.slice(lt + 1, j)
    assertNoBareAmpersand(raw, label)
    const closing = raw.startsWith('/')
    const selfClosing = raw.endsWith('/')
    const body = raw.replace(/\/$/, '').trim()
    const name = (closing ? body.slice(1) : body).trim().split(/[\s/]/)[0]
    assert.match(name, /^[A-Za-z_][\w.:-]*$/, `${label}: 非法标签名 ${name}`)
    const local = name.includes(':') ? name.split(':').pop() : name

    if (closing) {
      const open = stack.pop()
      assert.equal(open, local, `${label}: 结束标签 </${name}> 与 <${open}> 不匹配`)
    } else if (!selfClosing) {
      if (stack.length === 0) roots.push(local)
      stack.push(local)
    } else if (stack.length === 0) {
      roots.push(local)
    }
    i = j + 1
  }

  assert.deepEqual(stack, [], `${label}: 存在未闭合标签 ${stack.join(' > ')}`)
  assert.equal(roots.length, 1, `${label}: 应恰好有一个根元素，实际 ${roots.join(',')}`)
  return roots[0]
}

/**
 * 校验整个包的结构：必需部件、XML 良构、内容类型覆盖、关系目标、r:id 引用。
 * @param {Uint8Array} bytes docx 字节。
 * @param {{ required: string[], allowsNumbering?: boolean }} options 期望。
 * @returns {Map<string, object>} 包内条目。
 */
function assertPackage(bytes, options) {
  const { entries, count, order } = readZip(bytes)

  for (const name of options.required) {
    assert.ok(entries.has(name), `缺少必需部件：${name}`)
  }
  assert.equal(count, entries.size, 'EOCD 条目数应等于实际条目数')
  assert.equal(order[0], '[Content_Types].xml', '首个条目应为 [Content_Types].xml')

  // ---- 每个 XML 部件：解压 + CRC 校验 + 良构性 ----------------------
  for (const [name, entry] of entries) {
    assert.equal(entry.rawSize, entry.data.length, `${name}: 中央目录原始长度与实际不符`)
    assert.equal(crc32(entry.data), entry.crc, `${name}: CRC32 与写入值不一致`)
    assert.equal(entry.localCrc, entry.crc, `${name}: 本地头/中央目录 CRC 不一致`)
    if (name.endsWith('.xml') || name.endsWith('.rels')) {
      const xml = entry.data.toString('utf8')
      assert.ok(xml.length > 0, `${name}: 空部件`)
      assertWellFormed(xml, name)
    }
  }

  // ---- [Content_Types].xml 与部件对应 ------------------------------
  const typesXml = entries.get('[Content_Types].xml').data.toString('utf8')
  assert.match(typesXml, /<Default Extension="rels" /)
  assert.match(typesXml, /<Default Extension="xml" /)
  const overrides = new Map()
  for (const match of typesXml.matchAll(/<Override PartName="([^"]+)" ContentType="([^"]+)"\/>/g)) {
    overrides.set(match[1], match[2])
  }
  for (const [partName, part] of entries) {
    if (partName === '[Content_Types].xml') continue
    if (partName.endsWith('.rels')) {
      assert.match(typesXml, /Extension="rels"/, `${partName}: 缺少 rels 扩展名映射`)
      continue
    }
    if (partName.endsWith('.xml')) {
      assert.ok(
        overrides.has(`/${partName}`),
        `${partName}: [Content_Types].xml 缺少 Override`,
      )
    }
  }
  for (const partName of overrides.keys()) {
    assert.ok(entries.has(partName.slice(1)), `Content Types 指向不存在的部件：${partName}`)
  }

  // ---- 关系文件：target 必须存在，r:id 必须可解析 -------------------
  const relIds = new Map()
  for (const [name, entry] of entries) {
    if (!name.endsWith('.rels')) continue
    const xml = entry.data.toString('utf8')
    const baseDir = name === '_rels/.rels'
      ? ''
      : name.slice(0, name.indexOf('_rels/'))
    const ids = new Set()
    for (const match of xml.matchAll(/<Relationship Id="([^"]+)" Type="([^"]+)" Target="([^"]+)"\/>/g)) {
      const [, id, , target] = match
      ids.add(id)
      assert.ok(!relIds.has(`${name}:${id}`), `关系 id 重复：${name} ${id}`)
      const resolved = target.startsWith('/')
        ? target.slice(1)
        : joinPath(baseDir, target)
      assert.ok(entries.has(resolved), `${name}: 关系目标不存在 ${target} → ${resolved}`)
      relIds.set(`${name}:${id}`, resolved)
    }
    assert.ok(ids.size > 0, `${name}: 关系文件为空`)
  }

  const documentXml = entries.get('word/document.xml').data.toString('utf8')
  const documentRels = entries.get('word/_rels/document.xml.rels').data.toString('utf8')
  const declaredIds = new Set()
  for (const match of documentRels.matchAll(/<Relationship Id="([^"]+)"/g)) declaredIds.add(match[1])
  for (const match of documentXml.matchAll(/r:id="([^"]+)"/g)) {
    assert.ok(declaredIds.has(match[1]), `document.xml 引用了未声明的关系 id：${match[1]}`)
  }

  // ---- document.xml 根元素的命名空间必须齐全 ------------------------
  const rootMatch = /<w:document\b([^>]*)>/.exec(documentXml)
  assert.ok(rootMatch, 'document.xml 缺少 w:document 根元素')
  for (const prefix of ['w', 'r', 'v', 'o', 'wp', 'a', 'pic', 'mc']) {
    assert.match(rootMatch[1], new RegExp(`xmlns:${prefix}="`), `document.xml 缺少 xmlns:${prefix}`)
  }

  return entries
}

/** 简易 POSIX 路径拼接（测试内）。 */
function joinPath(base, target) {
  const parts = `${base}/${target}`.split('/')
  const out = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

/* ==================================================================== *
 * 3. 测试数据
 * ==================================================================== */

const FIXED_TIME = new Date('2026-10-29T09:00:00+08:00')

/** 仅用于测试的 SVG：矩形 + 连线 + 箭头 + 中文标签 + defs/transform。 */
const SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 300" width="720" height="300">
  <defs>
    <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
      <path d="M0,0 L6,3 L0,6 Z" fill="#3B5A9A"/>
    </marker>
  </defs>
  <g transform="translate(0,0)">
    <rect x="20" y="100" width="180" height="80" rx="10" fill="#D9E2F3" stroke="#3B5A9A" stroke-width="1.5"/>
    <text x="110" y="145" font-size="20" text-anchor="middle" fill="#1F3864" font-weight="bold">数据采集层</text>
    <rect x="270" y="100" width="180" height="80" rx="10" fill="#E2EFDA" stroke="#548235" stroke-width="1.5"/>
    <text x="360" y="145" font-size="20" text-anchor="middle" fill="#375623">数据治理层</text>
    <rect x="520" y="100" width="180" height="80" rx="10" fill="#FFF2CC" stroke="#BF8F00" stroke-width="1.5"/>
    <text x="610" y="145" font-size="20" text-anchor="middle" fill="#7F6000">应用服务层</text>
    <line x1="200" y1="140" x2="270" y2="140" stroke="#3B5A9A" stroke-width="2"/>
    <path d="M450 140 L520 140" stroke="#3B5A9A" stroke-width="2" marker-end="url(#arrow)"/>
  </g>
  <text x="360" y="40" font-size="22" text-anchor="middle" fill="#000000">政务云平台总体架构</text>
</svg>`

/** 最小文档：封面 + 目录 + 两级标题 + 段落。 */
const MINIMAL_MODEL = {
  meta: {
    title: 'XX市政务云平台建设项目',
    subtitle: '投标文件（技术标）',
    tenderNo: 'ZB-2026-001',
    bidder: '示例科技有限公司',
    date: '2026年10月29日',
  },
  sections: [
    {
      id: 's1',
      title: '第一章 项目理解',
      level: 1,
      markdown: '我方已充分理解本项目的建设背景与业务目标。\n\n## 1.1 建设目标\n\n建设统一、安全、可扩展的政务云平台。',
    },
    {
      id: 's2',
      title: '第二章 技术方案',
      level: 1,
      markdown: '## 2.1 总体架构\n\n采用分层架构设计。',
    },
  ],
}

/** 完整文档：4 级标题、表格、列表、行内样式、引用、代码块、分隔线、图。 */
const FULL_MODEL = {
  meta: {
    title: 'XX市政务云平台建设项目',
    subtitle: '投标文件（技术标）',
    tenderNo: 'ZB-2026-001',
    bidder: '示例科技有限公司',
    date: '2026年10月29日',
  },
  cover: {
    enabled: true,
    projectName: 'XX市政务云平台建设项目',
    bidder: '示例科技有限公司',
    date: '2026年10月29日',
    tenderNo: 'ZB-2026-001',
  },
  page: {
    widthTwips: 11906,
    heightTwips: 16838,
    margins: { top: 1440, bottom: 1440, left: 1701, right: 1701 },
  },
  fonts: { body: '宋体', heading: '黑体', latin: 'Times New Roman', bodySizePt: 10.5 },
  header: { text: 'XX市政务云平台建设项目 · 技术标' },
  footer: { pageNumber: true, text: '示例科技有限公司' },
  toc: { enabled: true, maxLevel: 3 },
  facts: [
    { key: '投标人名称', value: '示例科技有限公司' },
    { key: '项目编号', value: 'ZB-2026-001' },
    { key: '投标报价', value: '人民币壹仟贰佰万元整' },
  ],
  sections: [
    {
      id: 's1',
      title: '第一章 项目理解与需求分析',
      level: 1,
      markdown: [
        '我方已充分理解本项目的建设背景、业务目标与约束条件。',
        '',
        '## 1.1 建设目标',
        '',
        '本项目建设目标如下：**总体可用性**不低于 *99.95%*，接口采用 `RESTful` 规范。',
        '',
        '### 1.1.1 目标分解',
        '',
        '1. 建设统一数据底座',
        '2. 建设统一身份认证',
        '3. 建设统一运维监控',
        '',
        '- 支持国产化芯片与操作系统',
        '- 支持国密算法（SM2/SM3/SM4）',
        '  - 数据传输加密',
        '  - 数据存储加密',
        '',
        '> 说明：投标人须在投标文件中逐条响应，不得遗漏。',
        '',
        '#### 1.1.1.1 关键指标',
        '',
        '| 指标 | 目标值 | 说明 |',
        '| --- | :---: | ---: |',
        '| 系统可用性 | 99.95% | 年度统计口径 |',
        '| 并发用户数 | 5000 | 峰值并发 |',
        '| 数据一致性 | 强一致 | 分布式事务 |',
        '',
        '---',
        '',
        '```js',
        "function hello(name) {",
        "  return `你好，${name}`",
        '}',
        '```',
        '',
        '[[figure:fig-arch]]',
        '',
        '总体架构如上图所示，各层之间通过标准接口解耦。',
      ].join('\n'),
      figures: [{ id: 'fig-arch', title: '系统总体架构', svg: SAMPLE_SVG }],
    },
    {
      id: 's2',
      title: '1.1.2 总体技术路线',
      level: 2,
      markdown: '采用云原生技术栈，容器化部署。',
    },
    {
      id: 's3',
      title: '1.1.2.1 数据治理方案',
      level: 3,
      markdown: '建立数据标准、数据质量与数据安全三位一体的治理体系。',
    },
    {
      id: 's4',
      title: '1.1.2.1.1 数据标准管理',
      level: 4,
      markdown: '统一元数据模型，形成数据资产目录。',
    },
    {
      id: 's5',
      title: '第二章 实施方案',
      level: 1,
      markdown: '按阶段推进实施。',
    },
  ],
}

/* ==================================================================== *
 * 4. 测试
 * ==================================================================== */

test('最小文档：封面 + TOC + 两级标题 + 段落，包结构合法', async () => {
  const { buffer, warnings, bytes } = await buildDocx(MINIMAL_MODEL, { modifiedAt: FIXED_TIME })

  assert.ok(buffer instanceof Uint8Array, 'buffer 必须是 Uint8Array')
  assert.equal(bytes, buffer.length, 'bytes 必须等于 buffer.length')
  assert.ok(Array.isArray(warnings), 'warnings 必须是数组')
  assert.equal(warnings.length, 0, `最小文档不应产生警告，实际：${warnings.join(' / ')}`)

  const entries = assertPackage(buffer, {
    required: [
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
      'word/styles.xml',
      'word/settings.xml',
      'word/_rels/document.xml.rels',
      'word/footer1.xml',
    ],
  })

  const documentXml = entries.get('word/document.xml').data.toString('utf8')
  const stylesXml = entries.get('word/styles.xml').data.toString('utf8')
  const settingsXml = entries.get('word/settings.xml').data.toString('utf8')

  // 封面
  assert.match(documentXml, /XX市政务云平台建设项目/, '封面应包含项目名称')
  assert.match(documentXml, /示例科技有限公司/, '封面应包含投标人')
  assert.match(documentXml, /ZB-2026-001/, '封面应包含招标编号')

  // 两级标题：style 与直接 outlineLvl 都要有
  for (const level of [1, 2]) {
    assert.match(
      documentXml,
      new RegExp(`<w:pStyle w:val="Heading${level}"/>\\s*<w:outlineLvl w:val="${level - 1}"/>`),
      `章节标题应带 Heading${level} 与 outlineLvl=${level - 1}`,
    )
    assert.match(
      stylesXml,
      new RegExp(`w:styleId="Heading${level}"[\\s\\S]*?<w:outlineLvl w:val="${level - 1}"/>`),
      `styles.xml 中 Heading${level} 应声明 outlineLvl`,
    )
  }

  // TOC 域指令 + 打开时刷新
  assert.match(documentXml, /<w:fldSimple w:instr=" TOC \\o &quot;1-3&quot; \\h \\z \\u "/, 'TOC 域指令不正确')
  assert.match(settingsXml, /<w:updateFields w:val="true"\/>/, 'settings.xml 缺少 updateFields')
  assert.match(documentXml, /目　　录/, '缺少目录标题')

  // 中文字体 / 行距 / 首行缩进
  assert.match(stylesXml, /w:eastAsia="宋体"/, '正文应设置 eastAsia 宋体')
  assert.match(stylesXml, /w:eastAsia="黑体"/, '标题应设置 eastAsia 黑体')
  assert.match(stylesXml, /w:line="360" w:lineRule="auto"/, '正文应 1.5 倍行距')
  assert.match(stylesXml, /w:firstLineChars="200"/, '正文应首行缩进 2 字符')

  // 页码域在页脚
  const footerXml = entries.get('word/footer1.xml').data.toString('utf8')
  assert.match(footerXml, /<w:fldSimple w:instr=" PAGE ">/, '页脚应有 PAGE 域')
  assert.match(footerXml, /<w:fldSimple w:instr=" NUMPAGES ">/, '页脚应有 NUMPAGES 域')

  // 前置部分单独成节，正文页码从 1 开始
  assert.match(documentXml, /<w:sectPr><w:type w:val="nextPage"\/>/, '缺少前置节分隔')
  assert.match(documentXml, /<w:pgNumType w:start="1"\/>/, '正文页码应从 1 开始')
  assert.match(documentXml, /<w:footerReference w:type="default" r:id="rId3"\/>/, '正文节应引用页脚')

  // 页面尺寸来自模型
  assert.match(documentXml, /<w:pgSz w:w="11906" w:h="16838"\/>/, '页面尺寸应为 A4')
  assert.match(documentXml, /<w:pgMar w:top="1440"[^>]*w:left="1800"/, '默认页边距应生效')

  // 最小文档没有列表，不应产生 numbering 部件
  assert.ok(!entries.has('word/numbering.xml'), '无列表时不应生成 numbering.xml')
})

test('完整文档：4 级大纲 + 表格 + 列表 + 行内样式 + 引用 + 代码 + 分隔线 + 图', async () => {
  const { buffer, warnings, bytes } = await buildDocx(FULL_MODEL, { modifiedAt: FIXED_TIME })

  assert.equal(bytes, buffer.length)
  assert.equal(warnings.length, 0, `完整文档不应产生警告，实际：${warnings.join(' / ')}`)

  const entries = assertPackage(buffer, {
    required: [
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
      'word/styles.xml',
      'word/settings.xml',
      'word/_rels/document.xml.rels',
      'word/footer1.xml',
      'word/header1.xml',
      'word/numbering.xml',
    ],
  })

  const documentXml = entries.get('word/document.xml').data.toString('utf8')
  const stylesXml = entries.get('word/styles.xml').data.toString('utf8')
  const numberingXml = entries.get('word/numbering.xml').data.toString('utf8')

  // ---- 4 级标题（章节 level 1..4 + markdown 标题）-------------------
  for (const level of [1, 2, 3, 4]) {
    assert.match(
      documentXml,
      new RegExp(`<w:pStyle w:val="Heading${level}"/>\\s*<w:outlineLvl w:val="${level - 1}"/>`),
      `应有 Heading${level} 段落且带 outlineLvl=${level - 1}`,
    )
    assert.match(
      stylesXml,
      new RegExp(`w:styleId="Heading${level}"[\\s\\S]*?w:name w:val="heading ${level}"/`),
      `styles.xml 应有 heading ${level} 样式`,
    )
  }

  // ---- 表格：真实 w:tbl + 表头底纹 + 边框 + 列宽 + 中文 + 对齐 -------
  assert.match(documentXml, /<w:tbl>/, '缺少 w:tbl 表格')
  assert.match(documentXml, /<w:tblGrid><w:gridCol w:w="\d+"\/>/, '缺少 tblGrid 列宽')
  assert.match(documentXml, /w:fill="D9E2F3"/, '表头缺少底纹')
  assert.match(documentXml, /<w:insideH w:val="single"/, '表格缺少内部横线')
  assert.match(documentXml, /<w:tblLayout w:type="fixed"\/>/, '表格应为固定布局')
  assert.match(documentXml, /<w:jc w:val="center"\/><\/w:pPr>[\s\S]*?99\.95%/, '居中列应有 jc=center')
  assert.match(documentXml, /系统可用性/, '表格缺少中文表头/内容')
  assert.match(documentXml, /年度统计口径/, '表格缺少中文单元格')
  assert.match(documentXml, /<w:tcW w:w="\d+" w:type="dxa"\/>/, '单元格缺少宽度')

  // ---- 列表：项目符号 + 有序（numbering.xml）------------------------
  assert.match(numberingXml, /<w:abstractNum w:abstractNumId="0">/, '缺少项目符号 abstractNum')
  assert.match(numberingXml, /<w:abstractNum w:abstractNumId="1">/, '缺少有序列表 abstractNum')
  assert.match(numberingXml, /<w:numFmt w:val="bullet"\/>/, '缺少 bullet 编号格式')
  assert.match(numberingXml, /<w:numFmt w:val="decimal"\/>/, '缺少 decimal 编号格式')
  assert.match(numberingXml, /<w:startOverride w:val="1"\/>/, '有序列表应重置编号')
  assert.match(documentXml, /<w:numPr><w:ilvl w:val="0"\/><w:numId w:val="\d+"\/><\/w:numPr>/, '缺少列表段落')
  assert.match(documentXml, /<w:ilvl w:val="1"\/>/, '缺少二级列表缩进')

  // ---- 行内样式 -----------------------------------------------------
  assert.match(documentXml, /<w:b\/>/, '缺少粗体')
  assert.match(documentXml, /<w:i\/>/, '缺少斜体')
  assert.match(documentXml, /<w:rStyle w:val="CodeChar"\/>/, '缺少行内代码字符样式')
  assert.match(documentXml, /RESTful/, '缺少行内代码文本')

  // ---- 引用 / 代码块 / 分隔线 ---------------------------------------
  assert.match(documentXml, /<w:pStyle w:val="Quote"\/>/, '缺少引用块')
  assert.match(documentXml, /<w:pStyle w:val="CodeBlock"\/>/, '缺少代码块')
  assert.match(documentXml, /function hello\(name\) \{/, '缺少代码块内容')
  assert.match(documentXml, /<w:pStyle w:val="HorizontalRule"\/>/, '缺少水平分隔线')

  // ---- 图：原生 VML，中文标签、文本框、eastAsia 字体、不位图化 -------
  assert.ok(!documentXml.includes('[[figure:'), 'figure token 不应残留到文档正文')
  assert.match(documentXml, /<w:pict>/, '图应使用 w:pict 原生绘图')
  assert.match(documentXml, /<v:group /, '图应使用 v:group 组合')
  // 图元统一用 v:rect（Word 与 Apple 的 Word 转换器都能正确定位）；
  // 圆角视觉通过 arcsize 保留，脚本生成的图中原 SVG 带 rx 的框也落在这里。
  assert.match(documentXml, /<v:rect [^>]*fillcolor="#D9E2F3"/, '图应包含带填充的矩形图元')
  assert.match(documentXml, /<v:rect [^>]*arcsize="/, '带圆角的框应保留 arcsize')
  assert.ok(!documentXml.includes('<v:roundrect'), '不应再使用 v:roundrect（Apple 转换器会错位）')
  assert.match(documentXml, /<v:textbox/, '图文字应使用 VML 文本框')
  assert.match(documentXml, /<w:txbxContent>/, '图文字应落在 w:txbxContent（真正的文字）')
  assert.match(documentXml, /<v:line /, '图应包含连线')
  assert.match(documentXml, /endarrow="block"/, '连线应带箭头')
  assert.match(documentXml, /数据采集层/, '图中缺少中文标签「数据采集层」')
  assert.match(documentXml, /数据治理层/, '图中缺少中文标签「数据治理层」')
  assert.match(documentXml, /应用服务层/, '图中缺少中文标签「应用服务层」')
  assert.match(documentXml, /w:eastAsia="黑体"/, '图内文字应使用 eastAsia 中文字体')
  assert.ok(!documentXml.includes('a:blip'), '图不应被位图化（不应出现 a:blip）')
  assert.match(documentXml, /图 1　系统总体架构/, '缺少中文图题')
  // coordsize / coordorigin 让 VML 坐标可缩放
  assert.match(documentXml, /coordsize="\d+,\d+" coordorigin="0,0"/, 'v:group 缺少 coordsize')

  // ---- facts 表 -----------------------------------------------------
  assert.match(documentXml, /项目基本信息/, '缺少 facts 标题')
  assert.match(documentXml, /投标人名称/, 'facts 表缺少条目')

  // ---- 页眉 ---------------------------------------------------------
  const headerXml = entries.get('word/header1.xml').data.toString('utf8')
  assert.match(headerXml, /XX市政务云平台建设项目 · 技术标/, '页眉文本缺失')
  assert.match(documentXml, /<w:headerReference w:type="default" r:id="rId4"\/>/, '正文节应引用页眉')
})

test('测试样本写入 test/out/*.docx', async () => {
  await mkdir(OUT_DIR, { recursive: true })
  const minimal = await buildDocx(MINIMAL_MODEL, { modifiedAt: FIXED_TIME })
  const full = await buildDocx(FULL_MODEL, { modifiedAt: FIXED_TIME })
  const minimalPath = join(OUT_DIR, 'minimal.docx')
  const fullPath = join(OUT_DIR, 'full.docx')
  await writeFile(minimalPath, minimal.buffer)
  await writeFile(fullPath, full.buffer)

  assert.ok(minimal.bytes > 2500, `minimal.docx 字节数异常：${minimal.bytes}`)
  assert.ok(full.bytes > 5000, `full.docx 字节数异常：${full.bytes}`)
  assert.ok(full.bytes > minimal.bytes, '完整文档应大于最小文档')

  // 固定时间戳 → 同模型两次构建字节完全一致（可复现）
  const again = await buildDocx(FULL_MODEL, { modifiedAt: FIXED_TIME })
  assert.deepEqual(Buffer.from(again.buffer), Buffer.from(full.buffer), '相同输入与时间戳应产生相同字节')
  assert.equal(again.warnings.length, 0)

  console.log(`minimal.docx = ${minimal.bytes} bytes, full.docx = ${full.bytes} bytes`)
})

test('退化输入不抛异常，只返回 warnings，且仍产出可打开的包', async () => {
  const cases = [
    { label: 'null', model: null },
    { label: 'undefined', model: undefined },
    { label: '空对象', model: {} },
    { label: '错误类型', model: 'not-a-model' },
    { label: 'sections 非数组', model: { sections: 'oops' } },
    { label: '非法字段', model: { meta: 42, page: 'x', fonts: [], toc: 'y', sections: [{ level: 9 }, null, { title: 7, markdown: 42, figures: 'no' }] } },
  ]
  for (const { label, model } of cases) {
    const result = await buildDocx(model, { modifiedAt: FIXED_TIME })
    assert.ok(result.buffer instanceof Uint8Array, `${label}: 应返回 buffer`)
    assert.equal(result.bytes, result.buffer.length, `${label}: bytes 不一致`)
    assert.ok(result.warnings.length > 0, `${label}: 应产生可读的警告`)
    for (const message of result.warnings) {
      assert.equal(typeof message, 'string')
      assert.ok(message.length > 0 && message.length <= 500, `${label}: 警告长度异常`)
    }
    // 仍然是一个结构合法的 docx
    const { entries } = readZip(result.buffer)
    for (const part of [
      '[Content_Types].xml',
      'word/document.xml',
      'word/styles.xml',
      'word/settings.xml',
      'word/footer1.xml',
    ]) {
      assert.ok(entries.has(part), `${label}: 缺少 ${part}`)
    }
    assertWellFormed(entries.get('word/document.xml').data.toString('utf8'), `${label}: document.xml`)
  }
})

test('文本转义：<>& 引号与控制字符不会破坏 XML', async () => {
  const nasty = '<script>alert("x")</script> & </w:t> \u0000\u0001\u0007 正常中文'
  const { buffer, warnings } = await buildDocx(
    {
      meta: {
        title: `项目 ${nasty}`,
        subtitle: '副标题 & <测试>',
        tenderNo: 'A&B-<1>',
        date: '2026年10月29日',
      },
      footer: { text: '页脚 & <文本>' },
      header: { text: '页眉 <注入> & 测试' },
      sections: [
        {
          id: 's1',
          title: `章节 ${nasty}`,
          level: 1,
          markdown: `段落 & <b>粗体</b> **真正粗体** \`code & <x>\`\n\n| 列A | 列B |\n| --- | --- |\n| <值> & x | "引号" |`,
        },
      ],
    },
    { modifiedAt: FIXED_TIME },
  )

  assert.ok(warnings.length === 0, `不应产生警告：${warnings.join(' / ')}`)
  const { entries } = readZip(buffer)
  const documentXml = entries.get('word/document.xml').data.toString('utf8')

  // 原始尖括号/裸 & 不得出现在正文文本里
  assert.ok(!documentXml.includes('<script>'), '未转义的 <script> 泄漏到 XML')
  assert.ok(!documentXml.includes('</w:t> 正常中文'), '未转义的结束标签泄漏到 XML')
  assert.ok(documentXml.includes('&lt;script&gt;'), '尖括号应被转义')
  assert.ok(documentXml.includes('&amp;'), '& 应被转义')
  assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(documentXml), '控制字符应被剔除')
  assertWellFormed(documentXml, 'document.xml（转义用例）')
  assertWellFormed(entries.get('word/header1.xml').data.toString('utf8'), 'header1.xml（转义用例）')

  // 引用块/表格中的中文仍然存在
  assert.ok(documentXml.includes('正常中文'))
})

test('图：缺少 SVG 时回退为占位框，缺失/未引用的图产生警告', async () => {
  const { buffer, warnings } = await buildDocx(
    {
      cover: { enabled: false },
      toc: { enabled: false },
      sections: [
        {
          id: 's1',
          title: '第一章 方案',
          level: 1,
          markdown: '引用不存在的图：[[figure:fig-missing]]\n\n![img](x.png)',
          figures: [
            { id: 'fig-empty', title: '空图', svg: '' },
            { id: 'fig-unused', title: '未引用图', svg: SAMPLE_SVG },
          ],
        },
      ],
    },
    { modifiedAt: FIXED_TIME },
  )

  const { entries } = readZip(buffer)
  const documentXml = entries.get('word/document.xml').data.toString('utf8')

  assert.ok(warnings.some((w) => w.includes('fig-missing')), '应警告缺失的图 id')
  assert.ok(warnings.some((w) => w.includes('空图')), '应警告无法解析的 SVG')
  assert.ok(warnings.some((w) => w.includes('未被') || w.includes('追加')), '应警告未引用的图')

  // 缺失图 → 占位段落；空 SVG → 标题占位框；未引用图 → 追加
  assert.match(documentXml, /［缺少图：fig-missing］/, '缺少图应插入占位段落')
  assert.match(documentXml, /（占位）/, '空 SVG 应回退为占位图题')
  assert.match(documentXml, /空图/, '占位框内应包含图题')
  assert.match(documentXml, /未引用图/, '未引用的图应被追加')
  assert.match(documentXml, /数据采集层/, '追加的图应包含中文标签')

  // 无封面/目录时不应有前置节
  assert.ok(!documentXml.includes('<w:type w:val="nextPage"/>'), '关闭封面与目录时不应有前置节')
  assert.ok(!documentXml.includes('TOC \\o'), '关闭目录时不应有 TOC 域')
})

test('有序列表按段重启：每个列表块分配独立 numId', async () => {
  const { buffer } = await buildDocx(
    {
      cover: { enabled: false },
      toc: { enabled: false },
      sections: [
        {
          id: 's1',
          title: '第一章',
          level: 1,
          markdown: [
            '1. 第一组第一项',
            '2. 第一组第二项',
            '',
            '中间段落。',
            '',
            '1. 第二组第一项',
            '2. 第二组第二项',
            '',
            '- 无序项一',
            '- 无序项二',
          ].join('\n'),
        },
      ],
    },
    { modifiedAt: FIXED_TIME },
  )

  const { entries } = readZip(buffer)
  const numberingXml = entries.get('word/numbering.xml').data.toString('utf8')
  const documentXml = entries.get('word/document.xml').data.toString('utf8')

  const orderedNums = [...numberingXml.matchAll(/<w:num w:numId="(\d+)"><w:abstractNumId w:val="1"\/>/g)].map(
    (m) => m[1],
  )
  assert.equal(orderedNums.length, 2, `两个有序列表应各自分配 numId，实际：${orderedNums.join(',')}`)
  assert.notEqual(orderedNums[0], orderedNums[1])
  for (const id of orderedNums) {
    assert.match(
      numberingXml,
      new RegExp(`<w:num w:numId="${id}">[\\s\\S]*?<w:startOverride w:val="1"/>`),
      `numId=${id} 应带 startOverride 以从 1 重新编号`,
    )
  }
  const usedIds = new Set([...documentXml.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => m[1]))
  for (const id of orderedNums) assert.ok(usedIds.has(id), `文档未使用 numId=${id}`)
})

test('页脚可关闭页码；自定义页边距与字号进入 styles/sectPr', async () => {
  const { buffer } = await buildDocx(
    {
      cover: { enabled: false },
      toc: { enabled: false },
      footer: { pageNumber: false, text: '自定义页脚' },
      fonts: { body: '仿宋', heading: '微软雅黑', latin: 'Arial', bodySizePt: 12 },
      page: { margins: { top: 1000, bottom: 1000, left: 1200, right: 1200 } },
      sections: [{ id: 's1', title: '第一章', level: 1, markdown: '正文内容。' }],
    },
    { modifiedAt: FIXED_TIME },
  )

  const { entries } = readZip(buffer)
  const footerXml = entries.get('word/footer1.xml').data.toString('utf8')
  const stylesXml = entries.get('word/styles.xml').data.toString('utf8')
  const documentXml = entries.get('word/document.xml').data.toString('utf8')

  assert.match(footerXml, /自定义页脚/, '页脚文本缺失')
  assert.ok(!footerXml.includes('PAGE'), '关闭页码后不应有 PAGE 域')
  assert.match(stylesXml, /w:eastAsia="仿宋"/, '正文字体应可配置')
  assert.match(stylesXml, /w:eastAsia="微软雅黑"/, '标题字体应可配置')
  assert.match(stylesXml, /<w:sz w:val="24"\/>/, '12pt 正文应写成 sz=24')
  assert.match(documentXml, /w:top="1000"[^>]*w:left="1200"/, '页边距应来自模型')
})
