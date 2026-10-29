/**
 * BidKit Word 导出器 —— 纯 ESM、零运行时依赖的 `.docx` 生成器。
 *
 * 设计目标（见 docs/CONTRACT.md §3）：
 *  - 只使用 Node 内置模块（`node:zlib` 的 `deflateRawSync` 与 `node:buffer`），
 *    自己实现 ZIP 容器（本地文件头 / 中央目录 / EOCD / CRC32 表）；
 *  - 生成符合 OOXML（ECMA-376 Transitional）的 WordprocessingML；
 *  - 面向中文投标文件：宋体正文、黑体标题、1.5 倍行距、首行缩进 2 字符、
 *    标题样式带 `w:outlineLvl`，因此自动目录域（TOC field）可以直接使用；
 *  - 图（figure）以 VML 原生绘图对象嵌入（`w:pict` + `v:group` +
 *    `v:rect` + `v:textbox` + `w:txbxContent`），中文标签是真正的文字，
 *    用系统字体渲染，**不做位图化**；
 *  - 所有输入都被清洗与钳制，缺少可选字段只产生 `warnings`，不抛异常。
 *
 * 唯一对外导出：`buildDocx(model, options)`。
 *
 * @module lib/docx
 */

import { deflateRawSync } from 'node:zlib'

/* ==================================================================== *
 * 0. 命名空间与常量
 * ==================================================================== */

const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS_WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const NS_PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture'
const NS_MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
const NS_V = 'urn:schemas-microsoft-com:vml'
const NS_O = 'urn:schemas-microsoft-com:office:office'
const NS_W10 = 'urn:schemas-microsoft-com:office:word'
const NS_CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'

/** A4 页面（twips）与中文公文常用页边距。 */
const DEFAULT_PAGE = Object.freeze({
  widthTwips: 11906,
  heightTwips: 16838,
  marginTop: 1440,
  marginBottom: 1440,
  marginLeft: 1800,
  marginRight: 1800,
  headerTwips: 851,
  footerTwips: 992,
})

/** 默认字体（中文标书习惯：正文宋体，标题黑体）。 */
const DEFAULT_FONTS = Object.freeze({
  body: '宋体',
  heading: '黑体',
  latin: 'Times New Roman',
  bodySizePt: 10.5,
})

/** 标题层级 1..4 的字号（half-points）与段间距（twips）。 */
const HEADING_SPEC = Object.freeze([
  { sizeHalfPoints: 44, before: 480, after: 240 }, // 22pt
  { sizeHalfPoints: 32, before: 360, after: 180 }, // 16pt
  { sizeHalfPoints: 28, before: 240, after: 120 }, // 14pt
  { sizeHalfPoints: 24, before: 240, after: 120 }, // 12pt
])

/** 表格头行底色（浅蓝，与投标文件常用配色一致）。 */
const TABLE_HEADER_FILL = 'D9E2F3'
const TABLE_BORDER_COLOR = '8EA9DB'
const MAX_TABLE_COLUMNS = 10
const MAX_LIST_LEVEL = 2

/* ==================================================================== *
 * 1. 基础工具：清洗、转义、钳制
 * ==================================================================== */

/** 匹配 XML 1.0 非法字符（含未成对代理项与 BOM 类字符）。 */
const INVALID_XML_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/** 不需要保留的控制字符（保留 \t \n \r 由调用方处理）。 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

/**
 * 把任意值安全地转成字符串。
 * @param {unknown} value 任意输入。
 * @param {string} [fallback] 非字符串/非数值时的回退值。
 * @returns {string}
 */
function toStr(value, fallback = '') {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'bigint') return value.toString()
  if (value == null) return fallback
  return fallback
}

/**
 * 清洗文本：去掉 XML 非法字符与控制字符，规范换行符，首尾去空白并限长。
 * @param {unknown} value 原始值。
 * @param {number} [maxLength] 最大字符数（超出截断）。
 * @returns {string}
 */
function cleanText(value, maxLength = 8000) {
  let text = toStr(value)
  if (!text) return ''
  text = text.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS, '')
  text = text.replace(INVALID_XML_CHARS, '')
  if (text.length > maxLength) text = text.slice(0, maxLength)
  return text.trim()
}

/**
 * 清洗多行文本（代码块 / 引用），保留换行与行内缩进。
 * @param {unknown} value 原始值。
 * @param {number} [maxLength] 最大字符数。
 * @returns {string}
 */
function cleanBlockText(value, maxLength = 20000) {
  let text = toStr(value)
  if (!text) return ''
  text = text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '')
  text = text.replace(INVALID_XML_CHARS, '')
  if (text.length > maxLength) text = text.slice(0, maxLength)
  return text.replace(/^\n+|\n+$/g, '')
}

/**
 * XML 文本转义（同时兜底剔除非法字符）。
 * @param {string} text 已清洗文本。
 * @returns {string}
 */
function xmlEscape(text) {
  return toStr(text)
    .replace(INVALID_XML_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * XML 属性值转义（额外处理双引号）。
 * @param {string} text 已清洗文本。
 * @returns {string}
 */
function xmlAttr(text) {
  return xmlEscape(text).replace(/"/g, '&quot;')
}

/**
 * 把数值钳制到整数区间；非法值返回回退值。
 * @param {unknown} value 原始值。
 * @param {number} min 下限。
 * @param {number} max 上限。
 * @param {number} fallback 回退值。
 * @returns {number}
 */
function clampInt(value, min, max, fallback) {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * pt → half-points（OOXML 的 `w:sz` 单位），并钳制到合理范围。
 * @param {number} pt 磅值。
 * @param {number} [min] 最小磅值。
 * @param {number} [max] 最大磅值。
 * @returns {number}
 */
function halfPoints(pt, min = 6, max = 36) {
  const safe = clampInt(pt * 2, min * 2, max * 2, 21)
  return Math.round(safe)
}

/**
 * 布尔归一化（`!== false` 视为真，与契约中“可选字段默认开启”一致）。
 * @param {unknown} value 原始值。
 * @param {boolean} [fallback] 未提供时的值。
 * @returns {boolean}
 */
function toBool(value, fallback = true) {
  if (typeof value === 'boolean') return value
  if (value === 0 || value === '0' || value === 'false') return false
  if (value === 1 || value === '1' || value === 'true') return true
  return fallback
}

/**
 * 判断字符是否为 CJK（用于软换行拼接：中文之间不加空格）。
 * @param {string} ch 单个字符。
 * @returns {boolean}
 */
function isCjkChar(ch) {
  return /[\u2E80-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/.test(ch)
}

/**
 * 软换行拼接：中英混排时决定是否补空格。
 * @param {string[]} lines 行数组。
 * @returns {string}
 */
function joinSoftLines(lines) {
  let out = ''
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (!out) {
      out = line
      continue
    }
    const prev = out[out.length - 1]
    const next = line[0]
    const needSpace = !isCjkChar(prev) && !isCjkChar(next) && !/[\s\p{P}]/u.test(prev)
    out += (needSpace ? ' ' : '') + line
  }
  return out
}

/**
 * 对 URL/颜色等需要严格的短字符串做白名单清洗。
 * @param {unknown} value 原始值。
 * @param {number} [maxLength] 最大长度。
 * @returns {string}
 */
function cleanToken(value, maxLength = 120) {
  return cleanText(value, maxLength).replace(/[^\w\u4e00-\u9fa5.#:/-]/g, '')
}

/* ==================================================================== *
 * 2. CRC32 与 ZIP 容器（自实现，无第三方依赖）
 * ==================================================================== */

/** 预计算 CRC32 查找表（多项式 0xEDB88320）。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

/**
 * 计算 CRC32（ZIP 使用的标准反射算法）。
 * @param {Uint8Array} data 数据。
 * @returns {number} 无符号 32 位 CRC。
 */
function crc32(data) {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * 生成 ZIP 使用的 DOS 时间/日期。
 * @param {Date} when 时间。
 * @returns {{ time: number, date: number }}
 */
function dosDateTime(when) {
  const d = when instanceof Date && !Number.isNaN(when.getTime()) ? when : new Date()
  const year = Math.min(2107, Math.max(1980, d.getFullYear()))
  return {
    time:
      (Math.floor(d.getSeconds() / 2) & 0x1f) |
      ((d.getMinutes() & 0x3f) << 5) |
      ((d.getHours() & 0x1f) << 11),
    date:
      (d.getDate() & 0x1f) |
      (((d.getMonth() + 1) & 0x0f) << 5) |
      ((year - 1980) << 9),
  }
}

/**
 * 自行组装 ZIP 归档（deflate / store，含本地文件头、中央目录与 EOCD）。
 *
 * 文件条目按写入顺序生成；小于 64 字节的条目若压缩后反而变大则直接存储，
 * 避免出现“负压缩”的怪异字节。
 *
 * @param {Array<{ name: string, data: Buffer, compress?: boolean }>} entries 条目。
 * @param {Date} when 归档时间戳。
 * @returns {Buffer} 完整的 ZIP 字节。
 */
function buildZip(entries, when) {
  const { time, date } = dosDateTime(when)
  const chunks = []
  /** @type {Array<{ nameBuf: Buffer, crc: number, method: number, payloadLen: number, rawLen: number, offset: number }>} */
  const central = []
  let offset = 0

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const raw = entry.data
    const deflated = raw.length > 0 ? deflateRawSync(raw, { level: 9 }) : Buffer.alloc(0)
    const useDeflate = entry.compress !== false && deflated.length < raw.length
    const payload = useDeflate ? deflated : raw
    const method = useDeflate ? 8 : 0
    const crc = crc32(raw)

    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0) // 本地文件头签名
    local.writeUInt16LE(20, 4) // 解压所需版本 2.0
    local.writeUInt16LE(0x0800, 6) // bit 11：文件名 UTF-8
    local.writeUInt16LE(method, 8) // 0 = store, 8 = deflate
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // 无 extra field
    nameBuf.copy(local, 30)

    chunks.push(local, payload)
    central.push({
      nameBuf,
      crc,
      method,
      payloadLen: payload.length,
      rawLen: raw.length,
      offset,
    })
    offset += local.length + payload.length
  }

  const centralStart = offset
  for (const e of central) {
    const header = Buffer.alloc(46 + e.nameBuf.length)
    header.writeUInt32LE(0x02014b50, 0) // 中央目录签名
    header.writeUInt16LE(20, 4) // version made by（2.0 / MS-DOS）
    header.writeUInt16LE(20, 6) // version needed
    header.writeUInt16LE(0x0800, 8)
    header.writeUInt16LE(e.method, 10)
    header.writeUInt16LE(time, 12)
    header.writeUInt16LE(date, 14)
    header.writeUInt32LE(e.crc, 16)
    header.writeUInt32LE(e.payloadLen, 20)
    header.writeUInt32LE(e.rawLen, 24)
    header.writeUInt16LE(e.nameBuf.length, 28)
    header.writeUInt16LE(0, 30) // extra
    header.writeUInt16LE(0, 32) // comment
    header.writeUInt16LE(0, 34) // 起始磁盘
    header.writeUInt16LE(0, 36) // 内部属性
    header.writeUInt32LE(0, 38) // 外部属性
    header.writeUInt32LE(e.offset, 42)
    e.nameBuf.copy(header, 46)
    chunks.push(header)
    offset += header.length
  }

  const centralSize = offset - centralStart
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0) // EOCD 签名
  eocd.writeUInt16LE(0, 4) // 本磁盘编号
  eocd.writeUInt16LE(0, 6) // 中央目录起始磁盘
  eocd.writeUInt16LE(central.length, 8) // 本磁盘条目数
  eocd.writeUInt16LE(central.length, 10) // 总条目数
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(centralStart, 16)
  eocd.writeUInt16LE(0, 20) // 注释长度
  chunks.push(eocd)

  return Buffer.concat(chunks)
}

/* ==================================================================== *
 * 3. styles.xml —— 中文标书样式体系
 * ==================================================================== */

/**
 * 生成 `w:rFonts`，同时写 ascii / hAnsi / latin / eastAsia / cs，
 * 这是中英混排在 Word 里正确取字的关键。
 * @param {string} latin 西文字体名。
 * @param {string} eastAsia 中文字体名。
 * @returns {string}
 */
function rFontsXml(latin, eastAsia) {
  const l = xmlAttr(latin)
  const e = xmlAttr(eastAsia)
  return `<w:rFonts w:ascii="${l}" w:hAnsi="${l}" w:eastAsia="${e}" w:cs="${l}"/>`
}

/**
 * 段落缩进：`firstLineChars` 保证“首行缩进 2 字符”随字号自适应，
 * `firstLine` 是给不认 chars 单位的老版本 Word 的 twips 兜底。
 * @param {number} chars 首行缩进字符数（0 表示取消）。
 * @param {number} bodyHalfPoints 正文字号 half-points。
 * @returns {string}
 */
function firstLineIndentXml(chars, bodyHalfPoints) {
  const twips = Math.round(chars * (bodyHalfPoints / 2) * 20)
  return `<w:ind w:firstLineChars="${chars * 100}" w:firstLine="${twips}"/>`
}

/**
 * 构建 `word/styles.xml`。
 * @param {{
 *   fonts: { body: string, heading: string, latin: string, bodySizePt: number },
 *   contentWidth: number,
 *   headingSpec: ReadonlyArray<{ sizeHalfPoints: number, before: number, after: number }>,
 * }} ctx 版式上下文。
 * @returns {string} styles.xml 全文。
 */
function buildStylesXml(ctx) {
  const { fonts, contentWidth } = ctx
  const bodySz = halfPoints(fonts.bodySizePt)
  const bodyFont = rFontsXml(fonts.latin, fonts.body)
  const headingFont = rFontsXml('Arial', fonts.heading)

  /** @type {string[]} */
  const styles = []

  // ---- 文档默认值 -------------------------------------------------
  styles.push(
    '<w:docDefaults><w:rPrDefault><w:rPr>' +
      bodyFont +
      `<w:sz w:val="${bodySz}"/><w:szCs w:val="${bodySz}"/>` +
      '<w:lang w:val="en-US" w:eastAsia="zh-CN" w:bidi="ar-SA"/>' +
      '</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>' +
      '<w:spacing w:line="360" w:lineRule="auto"/>' +
      '</w:pPr></w:pPrDefault></w:docDefaults>',
  )

  // ---- Normal：正文基线（1.5 倍行距 + 首行缩进 2 字符）------------
  styles.push(
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">' +
      '<w:name w:val="Normal"/><w:qFormat/><w:pPr>' +
      '<w:spacing w:line="360" w:lineRule="auto" w:before="0" w:after="0"/>' +
      firstLineIndentXml(2, bodySz) +
      '<w:jc w:val="both"/>' +
      '</w:pPr><w:rPr>' +
      bodyFont +
      `<w:sz w:val="${bodySz}"/><w:szCs w:val="${bodySz}"/>` +
      '</w:rPr></w:style>',
  )

  // ---- 正文段落 ---------------------------------------------------
  styles.push(
    '<w:style w:type="paragraph" w:styleId="BodyText">' +
      '<w:name w:val="Body Text"/><w:basedOn w:val="Normal"/><w:next w:val="BodyText"/><w:qFormat/><w:pPr>' +
      '<w:snapToGrid w:val="0"/>' +
      '<w:spacing w:line="360" w:lineRule="auto" w:before="0" w:after="0"/>' +
      firstLineIndentXml(2, bodySz) +
      '<w:jc w:val="both"/>' +
      '</w:pPr><w:rPr>' +
      bodyFont +
      `<w:sz w:val="${bodySz}"/><w:szCs w:val="${bodySz}"/>` +
      '</w:rPr></w:style>',
  )

  // ---- 标题 1..4：黑体 + outlineLvl（TOC 域据此收集） -------------
  ctx.headingSpec.forEach((spec, index) => {
    const level = index + 1
    styles.push(
      `<w:style w:type="paragraph" w:styleId="Heading${level}">` +
        `<w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="BodyText"/>` +
        '<w:qFormat/><w:pPr>' +
        '<w:keepNext/><w:keepLines/>' +
        `<w:spacing w:before="${spec.before}" w:after="${spec.after}" w:line="360" w:lineRule="auto"/>` +
        '<w:ind w:firstLineChars="0" w:firstLine="0"/><w:jc w:val="left"/>' +
        `<w:outlineLvl w:val="${index}"/>` +
        '</w:pPr><w:rPr>' +
        headingFont +
        '<w:b/>' +
        `<w:sz w:val="${spec.sizeHalfPoints}"/><w:szCs w:val="${spec.sizeHalfPoints}"/>` +
        '</w:rPr></w:style>',
    )
  })

  // ---- 封面 -------------------------------------------------------
  styles.push(
    '<w:style w:type="paragraph" w:styleId="CoverTitle">' +
      '<w:name w:val="Cover Title"/><w:basedOn w:val="Normal"/><w:next w:val="CoverSubtitle"/><w:qFormat/><w:pPr>' +
      '<w:spacing w:before="1200" w:after="480" w:line="480" w:lineRule="auto"/>' +
      '<w:ind w:firstLineChars="0" w:firstLine="0"/><w:jc w:val="center"/>' +
      '</w:pPr><w:rPr>' +
      headingFont +
      '<w:b/><w:sz w:val="60"/><w:szCs w:val="60"/>' +
      '</w:rPr></w:style>',
  )
  styles.push(
    '<w:style w:type="paragraph" w:styleId="CoverSubtitle">' +
      '<w:name w:val="Cover Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="CoverInfo"/><w:qFormat/><w:pPr>' +
      '<w:spacing w:before="240" w:after="960" w:line="480" w:lineRule="auto"/>' +
      '<w:ind w:firstLineChars="0" w:firstLine="0"/><w:jc w:val="center"/>' +
      '</w:pPr><w:rPr>' +
      headingFont +
      '<w:sz w:val="36"/><w:szCs w:val="36"/>' +
      '</w:rPr></w:style>',
  )
  styles.push(
    '<w:style w:type="paragraph" w:styleId="CoverInfo">' +
      '<w:name w:val="Cover Info"/><w:basedOn w:val="Normal"/><w:next w:val="CoverInfo"/><w:qFormat/><w:pPr>' +
      '<w:spacing w:before="120" w:after="120" w:line="480" w:lineRule="auto"/>' +
      '<w:ind w:firstLineChars="0" w:firstLine="0"/><w:jc w:val="center"/>' +
      '</w:pPr><w:rPr>' +
      bodyFont +
      `<w:sz w:val="32"/><w:szCs w:val="32"/>` +
      '</w:rPr></w:style>',
  )
  styles.push(
    '<w:style w:type="paragraph" w:styleId="CoverBlank">' +
      '<w:name w:val="Cover Blank"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr>' +
      '<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>' +
      '<w:ind w:firstLineChars="0" w:firstLine="0"/><w:jc w:val="center"/>' +
      '</w:pPr></w:style>',
  )

  // ---- 目录 -------------------------------------------------------
  styles.push(
    '<w:style w:type="paragraph" w:styleId="TOCTitle">' +
      '<w:name w:val="TOC Title"/><w:basedOn w:val="Normal"/><w:next w:val="TOC1"/><w:qFormat/><w:pPr>' +
      '<w:spacing w:before="240" w:after="360" w:line="480" w:lineRule="auto"/>' +
      '<w:ind w:firstLineChars="0" w:firstLine="0"/><w:jc w:val="center"/>' +
      '</w:pPr><w:rPr>' +
      headingFont +
      '<w:b/><w:sz w:val="44"/><w:szCs w:val="44"/>' +
      '</w:rPr></w:style>',
  )
  for (let level = 1; level <= 4; level += 1) {
    const indent = (level - 1) * 420
    styles.push(
      `<w:style w:type="paragraph" w:styleId="TOC${level}">` +
        `<w:name w:val="toc ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="TOC${level}"/><w:qFormat/><w:pPr>` +
        '<w:tabs>' +
        `<w:tab w:val="right" w:leader="dot" w:pos="${contentWidth}"/>` +
        '</w:tabs>' +
        `<w:spacing w:before="60" w:after="60" w:line="300" w:lineRule="auto"/>` +
        `<w:ind w:left="${indent}" w:firstLineChars="0" w:firstLine="0"/><w:jc w:val="left"/>` +
        '</w:pPr><w:rPr>' +
        bodyFont +
        `<w:sz w:val="${bodySz}"/><w:szCs w:val="${bodySz}"/>` +
        '</w:rPr></w:style>',
    )
  }

  // ---- 列表 -------------------------------------------------------
  styles.push(
    '<w:style w:type="paragraph" w:styleId="ListParagraph">' +
      '<w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr>' +
      '<w:spacing w:before="0" w:after="0" w:line="360" w:lineRule="auto"/>' +
      '<w:ind w:firstLineChars="0" w:firstLine="0"/>' +
      '<w:jc w:val="both"/>' +
      '</w:pPr><w:rPr>' +
      bodyFont +
      `<w:sz w:val="${bodySz}"/><w:szCs w:val="${bodySz}"/>` +
      '</w:rPr></w:style>',
  )

  // ---- 引用块（标书里的“说明/备注”） ------------------------------
  styles.push(
    '<w:style w:type="paragraph" w:styleId="Quote">' +
      '<w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr>' +
      '<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="BFBFBF"/></w:pBdr>' +
      '<w:spacing w:before="120" w:after="120" w:line="360" w:lineRule="auto"/>' +
      '<w:ind w:left="420" w:right="240" w:firstLineChars="0" w:firstLine="0"/><w:jc w:val="both"/>' +
      '</w:pPr><w:rPr>' +
      rFontsXml(fonts.latin, '楷体') +
      '<w:color w:val="404040"/>' +
      `<w:sz w:val="${bodySz}"/><w:szCs w:val="${bodySz}"/>` +
      '</w:rPr></w:style>',
  )

  // ---- 代码块 -----------------------------------------------------
  styles.push(
    '<w:style w:type="paragraph" w:styleId="CodeBlock">' +
      '<w:name w:val="Code Block"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr>' +
      '<w:pBdr>' +
      '<w:top w:val="single" w:sz="4" w:space="4" w:color="D0D0D0"/>' +
      '<w:left w:val="single" w:sz="4" w:space="4" w:color="D0D0D0"/>' +
      '<w:bottom w:val="single" w:sz="4" w:space="4" w:color="D0D0D0"/>' +
      '<w:right w:val="single" w:sz="4" w:space="4" w:color="D0D0D0"/>' +
      '</w:pBdr>' +
      '<w:shd w:val="clear" w:color="auto" w:fill="F7F7F7"/>' +
      '<w:snapToGrid w:val="0"/>' +
      '<w:spacing w:before="120" w:after="120" w:line="264" w:lineRule="auto"/>' +
      '<w:ind w:left="240" w:right="120" w:firstLineChars="0" w:firstLine="0"/><w:jc w:val="left"/>' +
      '</w:pPr><w:rPr>' +
      rFontsXml('Consolas', fonts.body) +
      '<w:color w:val="1F2328"/>' +
      '<w:sz w:val="18"/><w:szCs w:val="18"/>' +
      '</w:rPr></w:style>',
  )
  styles.push(
    '<w:style w:type="character" w:styleId="CodeChar">' +
      '<w:name w:val="Code Char"/><w:qFormat/><w:rPr>' +
      rFontsXml('Consolas', fonts.body) +
      '<w:color w:val="1F2328"/>' +
      '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' +
      '</w:rPr></w:style>',
  )

  // ---- 表格 -------------------------------------------------------
  styles.push(
    '<w:style w:type="paragraph" w:styleId="TableParagraph">' +
      '<w:name w:val="Table Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr>' +
      '<w:snapToGrid w:val="0"/>' +
      '<w:spacing w:before="20" w:after="20" w:line="276" w:lineRule="auto"/>' +
      '<w:ind w:firstLineChars="0" w:firstLine="0"/><w:jc w:val="left"/>' +
      '</w:pPr><w:rPr>' +
      bodyFont +
      '<w:sz w:val="20"/><w:szCs w:val="20"/>' +
      '</w:rPr></w:style>',
  )
  styles.push(
    '<w:style w:type="paragraph" w:styleId="TableHeaderText">' +
      '<w:name w:val="Table Header Text"/><w:basedOn w:val="TableParagraph"/><w:qFormat/><w:pPr>' +
      '<w:jc w:val="center"/>' +
      '</w:pPr><w:rPr>' +
      headingFont +
      '<w:b/><w:sz w:val="20"/><w:szCs w:val="20"/>' +
      '</w:rPr></w:style>',
  )

  // ---- 图题 / 图内文字 / 分隔线 -----------------------------------
  styles.push(
    '<w:style w:type="paragraph" w:styleId="Caption">' +
      '<w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr>' +
      '<w:spacing w:before="80" w:after="240" w:line="276" w:lineRule="auto"/>' +
      '<w:ind w:firstLineChars="0" w:firstLine="0"/><w:jc w:val="center"/>' +
      '</w:pPr><w:rPr>' +
      headingFont +
      '<w:sz w:val="18"/><w:szCs w:val="18"/>' +
      '</w:rPr></w:style>',
  )
  styles.push(
    '<w:style w:type="paragraph" w:styleId="FigureLabel">' +
      '<w:name w:val="Figure Label"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr>' +
      '<w:snapToGrid w:val="0"/>' +
      '<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>' +
      '<w:ind w:firstLineChars="0" w:firstLine="0"/><w:jc w:val="center"/>' +
      '</w:pPr><w:rPr>' +
      headingFont +
      '<w:sz w:val="18"/><w:szCs w:val="18"/>' +
      '</w:rPr></w:style>',
  )
  styles.push(
    '<w:style w:type="paragraph" w:styleId="HorizontalRule">' +
      '<w:name w:val="Horizontal Rule"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr>' +
      '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFBFBF"/></w:pBdr>' +
      '<w:spacing w:before="180" w:after="180" w:line="240" w:lineRule="auto"/>' +
      '<w:ind w:firstLineChars="0" w:firstLine="0"/><w:jc w:val="left"/>' +
      '</w:pPr><w:rPr><w:sz w:val="4"/><w:szCs w:val="4"/></w:rPr></w:style>',
  )

  // ---- 图 / 表格间隙 -----------------------------------------------
  styles.push(
    '<w:style w:type="paragraph" w:styleId="FigureParagraph">' +
      '<w:name w:val="Figure Paragraph"/><w:basedOn w:val="Normal"/><w:next w:val="Caption"/><w:qFormat/><w:pPr>' +
      '<w:keepNext/><w:keepLines/>' +
      '<w:snapToGrid w:val="0"/>' +
      '<w:spacing w:before="180" w:after="60" w:line="240" w:lineRule="auto"/>' +
      '<w:ind w:firstLineChars="0" w:firstLine="0"/><w:jc w:val="center"/>' +
      '</w:pPr></w:style>',
  )
  styles.push(
    '<w:style w:type="paragraph" w:styleId="TableGap">' +
      '<w:name w:val="Table Gap"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr>' +
      '<w:spacing w:before="0" w:after="120" w:line="240" w:lineRule="auto"/>' +
      '<w:ind w:firstLineChars="0" w:firstLine="0"/><w:jc w:val="left"/>' +
      '</w:pPr><w:rPr><w:sz w:val="8"/><w:szCs w:val="8"/></w:rPr></w:style>',
  )

  styles.push(
    '<w:style w:type="paragraph" w:styleId="PageBreak">' +
      '<w:name w:val="Page Break"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr>' +
      '<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>' +
      '<w:ind w:firstLineChars="0" w:firstLine="0"/><w:jc w:val="left"/>' +
      '</w:pPr><w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr></w:style>',
  )

  // ---- 页眉 / 页脚 -------------------------------------------------
  styles.push(
    '<w:style w:type="paragraph" w:styleId="HeaderText">' +
      '<w:name w:val="Header Text"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr>' +
      '<w:pBdr><w:bottom w:val="single" w:sz="4" w:space="1" w:color="BFBFBF"/></w:pBdr>' +
      '<w:tabs><w:tab w:val="right" w:pos="' + contentWidth + '"/></w:tabs>' +
      '<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>' +
      '<w:ind w:firstLineChars="0" w:firstLine="0"/><w:jc w:val="right"/>' +
      '</w:pPr><w:rPr>' +
      bodyFont +
      '<w:color w:val="595959"/><w:sz w:val="18"/><w:szCs w:val="18"/>' +
      '</w:rPr></w:style>',
  )
  styles.push(
    '<w:style w:type="paragraph" w:styleId="FooterText">' +
      '<w:name w:val="Footer Text"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr>' +
      '<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>' +
      '<w:ind w:firstLineChars="0" w:firstLine="0"/><w:jc w:val="center"/>' +
      '</w:pPr><w:rPr>' +
      bodyFont +
      `<w:sz w:val="18"/><w:szCs w:val="18"/>` +
      '</w:rPr></w:style>',
  )

  return (
    XML_DECL +
    `<w:styles xmlns:w="${NS_W}" xmlns:r="${NS_R}">` +
    styles.join('') +
    '</w:styles>'
  )
}

/* ==================================================================== *
 * 4. settings.xml / footer / header
 * ==================================================================== */

/**
 * 构建 `word/settings.xml`。
 *
 * `w:updateFields` 让 Word 打开文档时刷新 TOC / PAGE / NUMPAGES 域。
 * 元素顺序遵循 CT_Settings 的 schema 序列（updateFields 在 compat 之前）。
 *
 * @param {{ tocEnabled: boolean }} ctx 上下文。
 * @returns {string} settings.xml 全文。
 */
function buildSettingsXml(ctx) {
  const parts = [
    '<w:zoom w:percent="100"/>',
    '<w:defaultTabStop w:val="420"/>',
    '<w:characterSpacingControl w:val="compressPunctuation"/>',
  ]
  if (ctx.tocEnabled) parts.push('<w:updateFields w:val="true"/>')
  parts.push(
    '<w:compat><w:compatSetting w:name="compatibilityMode" ' +
      'w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>',
    '<w:themeFontLang w:val="en-US" w:eastAsia="zh-CN"/>',
    '<w:decimalSymbol w:val="."/>',
    '<w:listSeparator w:val=","/>',
  )
  return XML_DECL + `<w:settings xmlns:w="${NS_W}" xmlns:r="${NS_R}">${parts.join('')}</w:settings>`
}

/**
 * 构建页脚：`第 N 页 共 M 页`，页码本身是域（field），不是硬编码文本。
 * @param {{ text: string, pageNumber: boolean, fonts: { latin: string, body: string } }} ctx 页脚配置。
 * @returns {string} footer1.xml 全文。
 */
function buildFooterXml(ctx) {
  const sz = 18
  const runs = []
  if (ctx.text) {
    runs.push(
      `<w:r><w:rPr><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr>` +
        `<w:t xml:space="preserve">${xmlEscape(ctx.text)}　　</w:t></w:r>`,
    )
  }
  if (ctx.pageNumber) {
    runs.push(
      `<w:r><w:rPr><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr>` +
        '<w:t xml:space="preserve">第 </w:t></w:r>' +
        `<w:fldSimple w:instr=" PAGE "><w:r><w:rPr><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr>` +
        '<w:t>1</w:t></w:r></w:fldSimple>' +
        `<w:r><w:rPr><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr>` +
        '<w:t xml:space="preserve"> 页　共 </w:t></w:r>' +
        `<w:fldSimple w:instr=" NUMPAGES "><w:r><w:rPr><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr>` +
        '<w:t>1</w:t></w:r></w:fldSimple>' +
        `<w:r><w:rPr><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr>` +
        '<w:t xml:space="preserve"> 页</w:t></w:r>',
    )
  }
  if (runs.length === 0) {
    runs.push('<w:r><w:t xml:space="preserve"></w:t></w:r>')
  }
  return (
    XML_DECL +
    `<w:ftr xmlns:w="${NS_W}" xmlns:r="${NS_R}">` +
    '<w:p><w:pPr><w:pStyle w:val="FooterText"/></w:pPr>' +
    runs.join('') +
    '</w:p></w:ftr>'
  )
}

/**
 * 构建页眉（仅在 `header.text` 非空时生成该部件）。
 * @param {{ text: string }} ctx 页眉配置。
 * @returns {string} header1.xml 全文。
 */
function buildHeaderXml(ctx) {
  return (
    XML_DECL +
    `<w:hdr xmlns:w="${NS_W}" xmlns:r="${NS_R}">` +
    '<w:p><w:pPr><w:pStyle w:val="HeaderText"/></w:pPr>' +
    `<w:r><w:t xml:space="preserve">${xmlEscape(ctx.text)}</w:t></w:r>` +
    '</w:p></w:hdr>'
  )
}

/* ==================================================================== *
 * 5. numbering.xml —— 无序 / 有序列表（有序列表逐段重启编号）
 * ==================================================================== */

/**
 * 创建编号管理器：按需分配 `w:numId`，有序列表每次重新从 1 开始。
 * @returns {{
 *   get used(): boolean,
 *   bullet(): number,
 *   ordered(): number,
 *   xml(): string,
 * }} 编号管理器。
 */
function createNumbering() {
  let used = false
  let nextNumId = 2 // 1 固定留给项目符号
  /** @type {number[]} */
  const orderedIds = []

  /** 生成 9 级项目符号定义（bullet abstractNum 0）。 */
  const bulletLevels = () => {
    const marks = ['•', '○', '▪']
    let out = ''
    for (let lvl = 0; lvl < 9; lvl += 1) {
      const mark = marks[lvl % marks.length]
      out +=
        `<w:lvl w:ilvl="${lvl}"><w:start w:val="1"/><w:numFmt w:val="bullet"/>` +
        `<w:lvlText w:val="${mark}"/><w:lvlJc w:val="left"/>` +
        `<w:pPr><w:ind w:left="${420 * (lvl + 1)}" w:hanging="420"/></w:pPr>` +
        '<w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr></w:lvl>'
    }
    return out
  }

  /** 生成 9 级十进制编号定义（ordered abstractNum 1）。 */
  const orderedLevels = () => {
    let out = ''
    for (let lvl = 0; lvl < 9; lvl += 1) {
      const text = lvl === 0 ? '%1.' : lvl === 1 ? '%1.%2.' : `%${lvl + 1})`
      out +=
        `<w:lvl w:ilvl="${lvl}"><w:start w:val="1"/><w:numFmt w:val="decimal"/>` +
        `<w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/>` +
        `<w:pPr><w:ind w:left="${420 * (lvl + 1)}" w:hanging="420"/></w:pPr>` +
        '<w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:hint="default"/></w:rPr></w:lvl>'
    }
    return out
  }

  return {
    get used() {
      return used
    },
    /** 项目符号列表使用的 numId（全文档共用）。 */
    bullet() {
      used = true
      return 1
    },
    /** 分配一个新的有序列表 numId，使其从 1 重新开始。 */
    ordered() {
      used = true
      const id = nextNumId
      nextNumId += 1
      orderedIds.push(id)
      return id
    },
    /** 序列化为 numbering.xml。 */
    xml() {
      const nums = [
        '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>',
      ]
      for (const id of orderedIds) {
        const overrides = [0, 1, 2]
          .map(
            (lvl) =>
              `<w:lvlOverride w:ilvl="${lvl}"><w:startOverride w:val="1"/></w:lvlOverride>`,
          )
          .join('')
        nums.push(
          `<w:num w:numId="${id}"><w:abstractNumId w:val="1"/>${overrides}</w:num>`,
        )
      }
      return (
        XML_DECL +
        `<w:numbering xmlns:w="${NS_W}">` +
        '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>' +
        bulletLevels() +
        '</w:abstractNum>' +
        '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>' +
        orderedLevels() +
        '</w:abstractNum>' +
        nums.join('') +
        '</w:numbering>'
      )
    },
  }
}

/* ==================================================================== *
 * 6. 包级部件：[Content_Types].xml 与关系（.rels）
 * ==================================================================== */

/**
 * 构建 `[Content_Types].xml`。
 * @param {{ hasHeader: boolean, hasNumbering: boolean }} flags 可选部件开关。
 * @returns {string} Content Types 全文。
 */
function buildContentTypesXml(flags) {
  const overrides = [
    ['/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
    ['/word/styles.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml'],
    ['/word/settings.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml'],
    ['/word/footer1.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml'],
  ]
  if (flags.hasHeader) {
    overrides.push([
      '/word/header1.xml',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml',
    ])
  }
  if (flags.hasNumbering) {
    overrides.push([
      '/word/numbering.xml',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml',
    ])
  }
  return (
    XML_DECL +
    `<Types xmlns="${NS_CT}">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    overrides
      .map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`)
      .join('') +
    '</Types>'
  )
}

/**
 * 构建包根关系 `_rels/.rels`。
 * @returns {string} 关系文件全文。
 */
function buildRootRelsXml() {
  return (
    XML_DECL +
    `<Relationships xmlns="${NS_PKG_REL}">` +
    `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="word/document.xml"/>` +
    '</Relationships>'
  )
}

/**
 * 构建 `word/_rels/document.xml.rels`。
 * @param {{ styles: string, settings: string, footer: string, header: string|null, numbering: string|null }} rels 关系 id 映射。
 * @returns {string} 关系文件全文。
 */
function buildDocumentRelsXml(rels) {
  /** @type {Array<[string, string, string]>} */
  const items = [
    [rels.styles, `${NS_REL}/styles`, 'styles.xml'],
    [rels.settings, `${NS_REL}/settings`, 'settings.xml'],
    [rels.footer, `${NS_REL}/footer`, 'footer1.xml'],
  ]
  if (rels.header) items.push([rels.header, `${NS_REL}/header`, 'header1.xml'])
  if (rels.numbering) items.push([rels.numbering, `${NS_REL}/numbering`, 'numbering.xml'])
  return (
    XML_DECL +
    `<Relationships xmlns="${NS_PKG_REL}">` +
    items
      .map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`)
      .join('') +
    '</Relationships>'
  )
}

/* ==================================================================== *
 * 7. Markdown 解析（契约允许的子集）
 * ==================================================================== */

/**
 * @typedef {{ kind: 'text', text: string, bold: boolean, italic: boolean, code: boolean }} InlineRun
 * @typedef {(
 *   { type: 'heading', level: number, text: string } |
 *   { type: 'paragraph', text: string } |
 *   { type: 'list', ordered: boolean, items: Array<{ text: string, level: number, ordered: boolean }> } |
 *   { type: 'quote', text: string } |
 *   { type: 'code', text: string, lang: string } |
 *   { type: 'table', header: string[], align: Array<'left'|'center'|'right'>, rows: string[][] } |
 *   { type: 'hr' } |
 *   { type: 'figure', id: string }
 * )} MdBlock
 */

/** 行内转义占位符（处理 `\*` 等）。 */
const INLINE_ESCAPE = /\\([\\`*_{}[\]()#+\-.!|>~])/g

/** 行内语法的单遍扫描正则（顺序敏感：先代码，再三星，再双星/双下划线，最后单星/单下划线）。 */
const INLINE_TOKEN =
  /(`[^`\n]*`)|(\*\*\*[^*\n]+\*\*\*)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(\[[^\]\n]*\]\([^)\n]*\))/g

/**
 * 把一段 Markdown 行内文本拆成带样式的 run 列表。
 * 支持的语法：`**粗体**`、`*斜体*`、`` `代码` ``、`[文字](链接)`（只保留文字）。
 * @param {string} text 行内文本。
 * @returns {InlineRun[]} run 列表（至少一项）。
 */
function parseInline(text) {
  const src = toStr(text)
  /** @type {string[]} */
  const stash = []
  const protectedText = src.replace(INLINE_ESCAPE, (_m, ch) => {
    stash.push(ch)
    return `\uE000${stash.length - 1}\uE001`
  })

  /** @type {InlineRun[]} */
  const runs = []
  const pushPlain = (value) => {
    if (value) runs.push({ kind: 'text', text: value, bold: false, italic: false, code: false })
  }

  let cursor = 0
  INLINE_TOKEN.lastIndex = 0
  let match
  while ((match = INLINE_TOKEN.exec(protectedText)) !== null) {
    if (match.index > cursor) pushPlain(protectedText.slice(cursor, match.index))
    const token = match[0]
    let inner = token
    let bold = false
    let italic = false
    let code = false
    if (match[1]) {
      code = true
      inner = token.slice(1, -1)
    } else if (match[2]) {
      bold = true
      italic = true
      inner = token.slice(3, -3)
    } else if (match[3]) {
      bold = true
      inner = token.slice(2, -2)
    } else if (match[4]) {
      bold = true
      inner = token.slice(2, -2)
    } else if (match[5]) {
      italic = true
      inner = token.slice(1, -1)
    } else if (match[6]) {
      italic = true
      inner = token.slice(1, -1)
    } else if (match[7]) {
      const close = token.indexOf('](')
      inner = token.slice(1, close)
    }
    if (code) {
      runs.push({ kind: 'text', text: inner, bold: false, italic: false, code: true })
    } else {
      runs.push({ kind: 'text', text: inner, bold, italic, code: false })
    }
    cursor = match.index + token.length
  }
  if (cursor < protectedText.length) pushPlain(protectedText.slice(cursor))

  if (runs.length === 0) {
    runs.push({ kind: 'text', text: '', bold: false, italic: false, code: false })
  }
  // 还原转义字符
  for (const run of runs) {
    if (run.text.indexOf('\uE000') === -1) continue
    run.text = run.text.replace(/\uE000(\d+)\uE001/g, (_m, idx) => stash[Number(idx)] ?? '')
  }
  return runs
}

/**
 * 把一个 run 渲染成 `<w:r>`。
 * @param {InlineRun} run run。
 * @param {{
 *   bold?: boolean,
 *   italic?: boolean,
 *   color?: string|null,
 *   szHalfPoints?: number|null,
 *   styleId?: string|null,
 *   fontsXml?: string|null,
 * }} [opts] 额外样式。
 * @returns {string} run XML。
 */
function renderRunXml(run, opts = {}) {
  let text = run.text
  if (!text) return ''
  const rPr = []
  if (run.code) rPr.push('<w:rStyle w:val="CodeChar"/>')
  else if (opts.styleId) rPr.push(`<w:rStyle w:val="${opts.styleId}"/>`)
  if (opts.fontsXml) rPr.push(opts.fontsXml)
  const bold = (run.bold || opts.bold === true) && !run.code
  const italic = (run.italic || opts.italic === true) && !run.code
  if (bold) rPr.push('<w:b/>')
  if (italic) rPr.push('<w:i/>')
  if (opts.color) rPr.push(`<w:color w:val="${xmlAttr(opts.color)}"/>`)
  if (opts.szHalfPoints) {
    rPr.push(
      `<w:sz w:val="${opts.szHalfPoints}"/><w:szCs w:val="${opts.szHalfPoints}"/>`,
    )
  }
  const rPrXml = rPr.length > 0 ? `<w:rPr>${rPr.join('')}</w:rPr>` : ''
  return `<w:r>${rPrXml}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`
}

/**
 * 渲染行内文本（含软换行 `\n` → `<w:br/>`）。
 * @param {string} text 原始行内文本。
 * @param {object} [opts] 传给 {@link renderRunXml} 的额外样式。
 * @returns {string} 若干 run 的 XML。
 */
function renderInlineXml(text, opts = {}) {
  const pieces = toStr(text).split('\n')
  const out = []
  pieces.forEach((piece, index) => {
    if (index > 0) out.push('<w:r><w:br/></w:r>')
    for (const run of parseInline(piece)) out.push(renderRunXml(run, opts))
  })
  return out.join('')
}

/** 判断一行是否为表格分隔行（`| --- | :---: |`）。 */
function isTableDelimiter(line) {
  if (!line.includes('|') || !line.includes('-')) return false
  return /^[\s|:-]+$/.test(line) && /-{1,}/.test(line)
}

/**
 * 拆分管道表格的一行；支持 `\|` 转义。
 * @param {string} line 行文本。
 * @returns {string[]} 单元格文本。
 */
function splitTableRow(line) {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  /** @type {string[]} */
  const cells = []
  let cur = ''
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|'
      i += 1
      continue
    }
    if (ch === '|') {
      cells.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  cells.push(cur.trim())
  return cells
}

/** 解析表格分隔行的对齐方式。 */
function parseAlignments(delimiter) {
  return splitTableRow(delimiter).map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    return 'left'
  })
}

/**
 * 把图 token `[[figure:<id>]]` 从段落文本中切出来。
 * @param {string} text 段落文本。
 * @returns {Array<{ kind: 'text', value: string } | { kind: 'figure', id: string }>} 片段。
 */
function splitFigureTokens(text) {
  /** @type {Array<{ kind: 'text', value: string } | { kind: 'figure', id: string }>} */
  const parts = []
  const re = /\[\[figure:([^\]\s]+)\]\]/g
  let cursor = 0
  let match
  while ((match = re.exec(text)) !== null) {
    if (match.index > cursor) {
      parts.push({ kind: 'text', value: text.slice(cursor, match.index) })
    }
    parts.push({ kind: 'figure', id: match[1].trim() })
    cursor = match.index + match[0].length
  }
  if (cursor < text.length) parts.push({ kind: 'text', value: text.slice(cursor) })
  return parts
}

/** 判断一行是否开启一个新块（用于段落收敛）。 */
function startsNewBlock(line) {
  if (!line.trim()) return true
  if (/^\s{0,3}#{1,6}\s+/.test(line)) return true
  if (/^\s*(```|~~~)/.test(line)) return true
  if (/^\s*>/.test(line)) return true
  if (/^\s*([-*+]|\d{1,9}[.)])\s+/.test(line)) return true
  if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return true
  if (/^\s*\[\[figure:[^\]\s]+\]\]\s*$/.test(line)) return true
  if (line.includes('|') && /^\s*\|/.test(line)) return true
  return false
}

/**
 * 解析 Markdown 子集为块列表。
 * @param {unknown} markdown Markdown 源文本。
 * @param {(message: string) => void} warn 警告收集器。
 * @returns {MdBlock[]} 块列表。
 */
function parseMarkdown(markdown, warn) {
  const source = cleanBlockText(markdown, 400000)
  /** @type {MdBlock[]} */
  const blocks = []
  if (!source) return blocks
  const lines = source.split('\n')
  let i = 0
  let warnedLevel = false

  while (i < lines.length) {
    const rawLine = lines[i]
    const line = rawLine.replace(/\t/g, '    ')
    if (!line.trim()) {
      i += 1
      continue
    }

    // ---- 围栏代码块 ------------------------------------------------
    const fence = /^\s{0,3}(```|~~~)\s*([\w#+.-]*)\s*$/.exec(line)
    if (fence) {
      const marker = fence[1]
      const lang = fence[2] || ''
      const body = []
      i += 1
      while (i < lines.length && !new RegExp(`^\\s{0,3}${marker}\\s*$`).test(lines[i])) {
        body.push(lines[i])
        i += 1
      }
      if (i < lines.length) i += 1 // 跳过结束围栏
      else warn('代码块缺少结束围栏，已按文件末尾结束')
      blocks.push({ type: 'code', text: body.join('\n'), lang })
      continue
    }

    // ---- ATX 标题 --------------------------------------------------
    const headingMatch = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (headingMatch) {
      let level = Math.min(6, headingMatch[1].length)
      if (level > 4) {
        if (!warnedLevel) {
          warn(`Markdown 标题层级 #${headingMatch[1].length} 超出 Word 样式的 1..4 级，已统一降到 4 级`)
          warnedLevel = true
        }
        level = 4
      }
      blocks.push({ type: 'heading', level, text: headingMatch[2].trim() })
      i += 1
      continue
    }

    // ---- 独立成行的图 token ----------------------------------------
    const loneFigure = /^\s*\[\[figure:([^\]\s]+)\]\]\s*$/.exec(line)
    if (loneFigure) {
      blocks.push({ type: 'figure', id: loneFigure[1].trim() })
      i += 1
      continue
    }

    // ---- 水平分隔线 ------------------------------------------------
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: 'hr' })
      i += 1
      continue
    }

    // ---- 管道表格 --------------------------------------------------
    if (line.includes('|') && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
      const header = splitTableRow(line)
      const align = parseAlignments(lines[i + 1])
      if (align.length !== header.length) {
        warn('表格分隔行的列数与表头不一致，已按表头列数对齐')
      }
      i += 2
      /** @type {string[][]} */
      const rows = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const cells = splitTableRow(lines[i])
        rows.push(cells)
        i += 1
      }
      const normalizedAlign = header.map((_cell, index) => align[index] || 'left')
      blocks.push({ type: 'table', header, align: normalizedAlign, rows })
      continue
    }

    // ---- 引用块 ----------------------------------------------------
    if (/^\s*>/.test(line)) {
      const quoteLines = []
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''))
        i += 1
      }
      blocks.push({ type: 'quote', text: joinSoftLines(quoteLines) })
      continue
    }

    // ---- 列表 ------------------------------------------------------
    const listItem = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line)
    if (listItem) {
      const ordered = /\d/.test(listItem[2])
      /** @type {Array<{ text: string, level: number, ordered: boolean }>} */
      const items = []
      while (i < lines.length) {
        const match = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(lines[i])
        if (!match) break
        const indent = match[1].length
        const level = Math.min(MAX_LIST_LEVEL, Math.floor(indent / 2))
        items.push({ text: match[3].trim(), level, ordered: /\d/.test(match[2]) })
        i += 1
        // 列表项内的续行（悬挂文本）并入上一项
        while (i < lines.length && lines[i].trim() && !startsNewBlock(lines[i])) {
          items[items.length - 1].text += ` ${lines[i].trim()}`
          i += 1
        }
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }

    // ---- 普通段落 --------------------------------------------------
    const paragraphLines = [line]
    i += 1
    while (i < lines.length && lines[i].trim() && !startsNewBlock(lines[i])) {
      paragraphLines.push(lines[i])
      i += 1
    }
    blocks.push({ type: 'paragraph', text: joinSoftLines(paragraphLines) })
  }

  return blocks
}

/* ==================================================================== *
 * 8. 块级渲染
 * ==================================================================== */

/** `w:jc` 取值映射。 */
const ALIGN_MAP = Object.freeze({ left: 'left', center: 'center', right: 'right' })

/**
 * 渲染标题段落（同时写 `w:outlineLvl`，保证 TOC 域能收集到条目）。
 * @param {number} level 1..4。
 * @param {string} text 标题文本。
 * @returns {string} 段落 XML。
 */
function renderHeadingXml(level, text) {
  const safeLevel = clampInt(level, 1, 4, 1)
  return (
    '<w:p><w:pPr>' +
    `<w:pStyle w:val="Heading${safeLevel}"/>` +
    `<w:outlineLvl w:val="${safeLevel - 1}"/>` +
    '</w:pPr>' +
    renderInlineXml(text) +
    '</w:p>'
  )
}

/**
 * 渲染正文段落。
 * @param {string} text 段落文本。
 * @returns {string} 段落 XML。
 */
function renderParagraphXml(text) {
  return `<w:p><w:pPr><w:pStyle w:val="BodyText"/></w:pPr>${renderInlineXml(text)}</w:p>`
}

/**
 * 渲染有序 / 无序列表。
 * @param {Extract<MdBlock, { type: 'list' }>} block 列表块。
 * @param {{ numbering: ReturnType<typeof createNumbering> }} ctx 渲染上下文。
 * @returns {string} 若干段落 XML。
 */
function renderListXml(block, ctx) {
  const numId = block.ordered ? ctx.numbering.ordered() : ctx.numbering.bullet()
  const out = []
  for (const item of block.items) {
    const level = clampInt(item.level, 0, MAX_LIST_LEVEL, 0)
    out.push(
      '<w:p><w:pPr>' +
        '<w:pStyle w:val="ListParagraph"/>' +
        `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>` +
        '</w:pPr>' +
        renderInlineXml(item.text) +
        '</w:p>',
    )
  }
  return out.join('')
}

/**
 * 渲染管道表格：真实 `w:tbl` + 表头底纹 + 外/内边框 + 固定列宽。
 * @param {Extract<MdBlock, { type: 'table' }>} block 表格块。
 * @param {{ contentWidth: number, warn: (m: string) => void }} ctx 渲染上下文。
 * @param {{ widthRatios?: number[] }} [options] 可选列宽比例（用于“项目基本信息”表）。
 * @returns {string} 表格 XML（末尾补一个空段落，避免表格贴住后文）。
 */
function renderTableXml(block, ctx, options = {}) {
  const rawColumnCount = Math.max(
    block.header.length,
    ...block.rows.map((row) => row.length),
    1,
  )
  let columnCount = rawColumnCount
  if (columnCount > MAX_TABLE_COLUMNS) {
    ctx.warn(`表格列数 ${rawColumnCount} 超过 ${MAX_TABLE_COLUMNS} 列，已截断`)
    columnCount = MAX_TABLE_COLUMNS
  }

  const totalWidth = Math.max(1200, ctx.contentWidth)
  const widths = []
  const ratios =
    Array.isArray(options.widthRatios) && options.widthRatios.length === columnCount
      ? options.widthRatios.map((r) => (typeof r === 'number' && r > 0 ? r : 1))
      : null
  if (ratios) {
    const sum = ratios.reduce((a, b) => a + b, 0) || columnCount
    let used = 0
    for (let c = 0; c < columnCount; c += 1) {
      const width = Math.max(500, Math.floor((totalWidth * ratios[c]) / sum))
      widths.push(width)
      used += width
    }
    widths[columnCount - 1] = Math.max(500, widths[columnCount - 1] + (totalWidth - used))
  } else {
    const base = Math.floor(totalWidth / columnCount)
    for (let c = 0; c < columnCount; c += 1) {
      widths.push(c === columnCount - 1 ? totalWidth - base * (columnCount - 1) : base)
    }
  }

  const normalize = (cells) => {
    const out = []
    for (let c = 0; c < columnCount; c += 1) out.push(cells[c] === undefined ? '' : cells[c])
    return out
  }

  const cellXml = (text, index, isHeader) => {
    const align = ALIGN_MAP[block.align[index]] || 'left'
    const style = isHeader ? 'TableHeaderText' : 'TableParagraph'
    return (
      '<w:tc><w:tcPr>' +
      `<w:tcW w:w="${widths[index]}" w:type="dxa"/>` +
      (isHeader
        ? `<w:shd w:val="clear" w:color="auto" w:fill="${TABLE_HEADER_FILL}"/>`
        : '') +
      '<w:vAlign w:val="center"/>' +
      '</w:tcPr>' +
      `<w:p><w:pPr><w:pStyle w:val="${style}"/><w:jc w:val="${align}"/></w:pPr>` +
      renderInlineXml(text) +
      '</w:p></w:tc>'
    )
  }

  const rowsXml = []
  rowsXml.push(
    '<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="454" w:hRule="atLeast"/><w:tblHeader/></w:trPr>' +
      normalize(block.header)
        .map((cell, index) => cellXml(cell, index, true))
        .join('') +
      '</w:tr>',
  )
  block.rows.forEach((row) => {
    rowsXml.push(
      '<w:tr><w:trPr><w:cantSplit/></w:trPr>' +
        normalize(row)
          .map((cell, index) => cellXml(cell, index, false))
          .join('') +
        '</w:tr>',
    )
  })

  const grid = widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')
  return (
    '<w:tbl><w:tblPr>' +
    `<w:tblW w:w="${totalWidth}" w:type="dxa"/><w:jc w:val="center"/>` +
    '<w:tblBorders>' +
    `<w:top w:val="single" w:sz="8" w:space="0" w:color="${TABLE_BORDER_COLOR}"/>` +
    `<w:left w:val="single" w:sz="8" w:space="0" w:color="${TABLE_BORDER_COLOR}"/>` +
    `<w:bottom w:val="single" w:sz="8" w:space="0" w:color="${TABLE_BORDER_COLOR}"/>` +
    `<w:right w:val="single" w:sz="8" w:space="0" w:color="${TABLE_BORDER_COLOR}"/>` +
    `<w:insideH w:val="single" w:sz="4" w:space="0" w:color="${TABLE_BORDER_COLOR}"/>` +
    `<w:insideV w:val="single" w:sz="4" w:space="0" w:color="${TABLE_BORDER_COLOR}"/>` +
    '</w:tblBorders>' +
    '<w:tblLayout w:type="fixed"/>' +
    '<w:tblCellMar>' +
    '<w:top w:w="28" w:type="dxa"/><w:left w:w="85" w:type="dxa"/>' +
    '<w:bottom w:w="28" w:type="dxa"/><w:right w:w="85" w:type="dxa"/>' +
    '</w:tblCellMar>' +
    '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" ' +
    'w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>' +
    '</w:tblPr>' +
    `<w:tblGrid>${grid}</w:tblGrid>` +
    rowsXml.join('') +
    '</w:tbl><w:p><w:pPr><w:pStyle w:val="TableGap"/></w:pPr></w:p>'
  )
}

/**
 * 渲染围栏代码块：单段多行，行间用 `<w:br/>`，保留空白。
 * @param {Extract<MdBlock, { type: 'code' }>} block 代码块。
 * @returns {string} 段落 XML。
 */
function renderCodeBlockXml(block) {
  const lines = toStr(block.text).split('\n')
  const content = lines
    .map((line) => `<w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r>`)
    .join('<w:r><w:br/></w:r>')
  return (
    '<w:p><w:pPr><w:pStyle w:val="CodeBlock"/></w:pPr>' +
    (content || '<w:r><w:t xml:space="preserve"></w:t></w:r>') +
    '</w:p>'
  )
}

/**
 * 渲染引用块。
 * @param {Extract<MdBlock, { type: 'quote' }>} block 引用块。
 * @returns {string} 段落 XML。
 */
function renderQuoteXml(block) {
  return `<w:p><w:pPr><w:pStyle w:val="Quote"/></w:pPr>${renderInlineXml(block.text)}</w:p>`
}

/**
 * 渲染水平分隔线（段落下边框）。
 * @returns {string} 段落 XML。
 */
function renderHorizontalRuleXml() {
  return '<w:p><w:pPr><w:pStyle w:val="HorizontalRule"/></w:pPr></w:p>'
}

/**
 * 渲染一个 Markdown 块列表；段落中的 `[[figure:<id>]]` 会在此展开为原生图。
 * @param {MdBlock[]} blocks 块列表。
 * @param {object} ctx 渲染上下文（含 figure 解析器）。
 * @returns {string} 段落/表格 XML。
 */
function renderBlocksXml(blocks, ctx) {
  const out = []
  for (const block of blocks) {
    switch (block.type) {
      case 'heading':
        out.push(renderHeadingXml(block.level, block.text))
        break
      case 'paragraph': {
        const parts = splitFigureTokens(block.text)
        for (const part of parts) {
          if (part.kind === 'text') {
            const text = part.value.trim()
            if (text) out.push(renderParagraphXml(text))
          } else {
            out.push(ctx.renderFigure(part.id))
          }
        }
        break
      }
      case 'list':
        out.push(renderListXml(block, ctx))
        break
      case 'table':
        out.push(renderTableXml(block, ctx))
        break
      case 'quote':
        out.push(renderQuoteXml(block))
        break
      case 'code':
        out.push(renderCodeBlockXml(block))
        break
      case 'hr':
        out.push(renderHorizontalRuleXml())
        break
      case 'figure':
        out.push(ctx.renderFigure(block.id))
        break
      default:
        break
    }
  }
  // 图 token 只在段落中展开；出现在标题/列表/表格/代码块里会残留成字面量，明确告警。
  for (const block of blocks) {
    if (block.type === 'heading' || block.type === 'code') continue
    const raw =
      block.type === 'list'
        ? block.items.map((item) => item.text).join('\n')
        : block.type === 'table'
          ? [block.header.join('|'), ...block.rows.map((row) => row.join('|'))].join('\n')
          : block.type === 'quote'
            ? block.text
            : ''
    if (raw.includes('[[figure:')) {
      ctx.warn(
        `图 token [[figure:<id>]] 只能独立成段或位于普通段落中；该处（${block.type}）已按纯文本输出`,
      )
      break
    }
  }
  return out.join('')
}

/* ==================================================================== *
 * 9. 图：SVG → VML 原生绘图（文字保持为文字）
 * ==================================================================== *
 *
 * 合同要求图必须是“原生 Word 绘图”，中文标签用系统字体渲染、不做位图化。
 * 这里把 Host 生成的 SVG（rect / line / circle / ellipse / path / polyline /
 * text，含 translate/scale/matrix/rotate 变换）映射成 VML：
 *
 *   w:pict > v:group > v:rect / v:line / v:oval + v:textbox
 *                                              + w:txbxContent > w:p > w:r
 *
 * 文字落在 `w:txbxContent` 里，所以 Word 用的是 `w:rFonts/@w:eastAsia` 指定的
 * 中文字体，可以正常编辑、缩放、打印。
 */

/** 常见 CSS 颜色名 → 十六进制。 */
const NAMED_COLORS = Object.freeze({
  white: 'FFFFFF',
  black: '000000',
  gray: '808080',
  grey: '808080',
  silver: 'C0C0C0',
  red: 'FF0000',
  green: '008000',
  blue: '0000FF',
  navy: '000080',
  teal: '008080',
  orange: 'FFA500',
  yellow: 'FFFF00',
  purple: '800080',
  lightgray: 'D3D3D3',
  lightgrey: 'D3D3D3',
})

/** SVG 中不参与渲染（仅定义）的元素。 */
const SVG_SKIP_TAGS = new Set([
  'defs',
  'symbol',
  'clippath',
  'mask',
  'marker',
  'pattern',
  'lineargradient',
  'radialgradient',
  'style',
  'title',
  'desc',
  'metadata',
  'filter',
  'script',
])

/**
 * 解析 XML/SVG 实体。
 * @param {string} text 含实体的文本。
 * @returns {string} 解码后的文本。
 */
function decodeEntities(text) {
  return toStr(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      const isHex = entity[1] === 'x' || entity[1] === 'X'
      const code = Number.parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
      try {
        return String.fromCodePoint(code)
      } catch {
        return ''
      }
    }
    switch (entity) {
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
      case 'nbsp':
        return ' '
      default:
        return ''
    }
  })
}

/**
 * 解析标签属性串为普通对象（属性名小写）。
 * @param {string} attrText 形如 ` a="1" b='2'` 的文本。
 * @returns {Record<string, string>} 属性表。
 */
function parseAttributes(attrText) {
  /** @type {Record<string, string>} */
  const attrs = {}
  const re = /([\w:.@-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let match
  while ((match = re.exec(attrText)) !== null) {
    const name = match[1].toLowerCase()
    attrs[name] = decodeEntities(match[2] !== undefined ? match[2] : match[3] || '')
  }
  return attrs
}

/**
 * 解析 `style="fill:#fff;stroke-width:2"` 为属性表。
 * @param {string|undefined} style style 属性。
 * @returns {Record<string, string>} 属性表。
 */
function parseStyleDecl(style) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const decl of toStr(style).split(';')) {
    const index = decl.indexOf(':')
    if (index <= 0) continue
    out[decl.slice(0, index).trim().toLowerCase()] = decl.slice(index + 1).trim()
  }
  return out
}

/**
 * 归一化颜色为 `RRGGBB`；`none` / `transparent` 返回 null。
 * @param {string|undefined} raw 原始颜色。
 * @returns {string|null} 十六进制颜色或 null。
 */
function parseColor(raw) {
  const value = toStr(raw).trim().toLowerCase()
  if (!value || value === 'none' || value === 'transparent') return null
  if (/^#[0-9a-f]{3}$/.test(value)) {
    return value
      .slice(1)
      .split('')
      .map((ch) => ch + ch)
      .join('')
      .toUpperCase()
  }
  if (/^#[0-9a-f]{6}$/.test(value)) return value.slice(1).toUpperCase()
  if (/^#[0-9a-f]{8}$/.test(value)) return value.slice(1, 7).toUpperCase()
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(value)
  if (rgb) {
    const channel = (n) => Math.max(0, Math.min(255, Math.round(Number(n))))
    return [rgb[1], rgb[2], rgb[3]]
      .map((n) => channel(n).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  }
  if (value.startsWith('url(')) return null
  const named = NAMED_COLORS[value]
  if (named) return named
  return null
}

/**
 * 解析 SVG 长度（`12`、`12px`、`12pt`、`1.5em`）。
 * @param {string|undefined} raw 原始值。
 * @param {number} fallback 回退值。
 * @returns {number}
 */
function parseLength(raw, fallback = 0) {
  const match = /-?\d*\.?\d+(?:e[-+]?\d+)?/i.exec(toStr(raw))
  if (!match) return fallback
  const value = Number(match[0])
  return Number.isFinite(value) ? value : fallback
}

/** 单位矩阵。 */
const IDENTITY_MATRIX = Object.freeze({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 })

/**
 * 矩阵相乘：先应用 inner，再应用 outer。
 * @param {{a:number,b:number,c:number,d:number,e:number,f:number}} outer 外层。
 * @param {{a:number,b:number,c:number,d:number,e:number,f:number}} inner 内层。
 * @returns {{a:number,b:number,c:number,d:number,e:number,f:number}} 合成矩阵。
 */
function multiplyMatrix(outer, inner) {
  return {
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    e: outer.a * inner.e + outer.c * inner.f + outer.e,
    f: outer.b * inner.e + outer.d * inner.f + outer.f,
  }
}

/**
 * 解析 SVG `transform` 属性。
 * @param {string|undefined} raw transform 文本。
 * @returns {{a:number,b:number,c:number,d:number,e:number,f:number}} 矩阵。
 */
function parseTransform(raw) {
  let matrix = { ...IDENTITY_MATRIX }
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g
  let match
  while ((match = re.exec(toStr(raw))) !== null) {
    const kind = match[1].toLowerCase()
    const args = match[2]
      .split(/[\s,]+/)
      .map((n) => Number(n))
      .filter((n) => Number.isFinite(n))
    if (kind === 'matrix' && args.length >= 6) {
      matrix = multiplyMatrix(matrix, {
        a: args[0],
        b: args[1],
        c: args[2],
        d: args[3],
        e: args[4],
        f: args[5],
      })
    } else if (kind === 'translate' && args.length >= 1) {
      matrix = multiplyMatrix(matrix, {
        ...IDENTITY_MATRIX,
        e: args[0],
        f: args.length > 1 ? args[1] : 0,
      })
    } else if (kind === 'scale' && args.length >= 1) {
      const sx = args[0]
      const sy = args.length > 1 ? args[1] : sx
      matrix = multiplyMatrix(matrix, { ...IDENTITY_MATRIX, a: sx, d: sy })
    } else if (kind === 'rotate' && args.length >= 1) {
      const rad = (args[0] * Math.PI) / 180
      const cos = Math.cos(rad)
      const sin = Math.sin(rad)
      const rotateMatrix = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 }
      if (args.length >= 3) {
        matrix = multiplyMatrix(matrix, {
          ...IDENTITY_MATRIX,
          e: args[1],
          f: args[2],
        })
        matrix = multiplyMatrix(matrix, rotateMatrix)
        matrix = multiplyMatrix(matrix, {
          ...IDENTITY_MATRIX,
          e: -args[1],
          f: -args[2],
        })
      } else {
        matrix = multiplyMatrix(matrix, rotateMatrix)
      }
    }
  }
  return matrix
}

/**
 * 用矩阵变换一个点。
 * @param {{a:number,b:number,c:number,d:number,e:number,f:number}} matrix 矩阵。
 * @param {number} x x 坐标。
 * @param {number} y y 坐标。
 * @returns {{x: number, y: number}} 变换后的点。
 */
function applyMatrix(matrix, x, y) {
  return { x: matrix.a * x + matrix.c * y + matrix.e, y: matrix.b * x + matrix.d * y + matrix.f }
}

/**
 * 解析 path 的 `d` 属性为折线段（曲线采样）。
 * @param {string} d path 数据。
 * @returns {{ points: Array<{x:number,y:number}>, closed: boolean }[]} 子路径列表。
 */
function parsePathData(d) {
  const tokens = toStr(d).match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []
  /** @type {{ points: Array<{x:number,y:number}>, closed: boolean }[]} */
  const subPaths = []
  let current = { x: 0, y: 0 }
  let start = { x: 0, y: 0 }
  let previousControl = null
  let index = 0
  let command = ''
  /** @type {{ points: Array<{x:number,y:number}>, closed: boolean }|null} */
  let active = null

  const ensureActive = () => {
    if (!active) {
      active = { points: [current], closed: false }
      subPaths.push(active)
    }
    return active
  }
  const readNumber = () => {
    const value = Number(tokens[index])
    index += 1
    return Number.isFinite(value) ? value : 0
  }
  const sampleCubic = (p0, p1, p2, p3, steps = 10) => {
    for (let s = 1; s <= steps; s += 1) {
      const t = s / steps
      const mt = 1 - t
      const x =
        mt * mt * mt * p0.x + 3 * mt * mt * t * p1.x + 3 * mt * t * t * p2.x + t * t * t * p3.x
      const y =
        mt * mt * mt * p0.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p3.y
      ensureActive().points.push({ x, y })
    }
  }
  const sampleQuadratic = (p0, p1, p2, steps = 8) => {
    for (let s = 1; s <= steps; s += 1) {
      const t = s / steps
      const mt = 1 - t
      const x = mt * mt * p0.x + 2 * mt * t * p1.x + t * t * p2.x
      const y = mt * mt * p0.y + 2 * mt * t * p1.y + t * t * p2.y
      ensureActive().points.push({ x, y })
    }
  }

  while (index < tokens.length) {
    if (/^[a-z]$/i.test(tokens[index])) {
      command = tokens[index]
      index += 1
    } else if (!command) {
      index += 1
      continue
    }
    const relative = command === command.toLowerCase()
    const base = relative ? current : { x: 0, y: 0 }
    switch (command.toUpperCase()) {
      case 'M': {
        const x = readNumber() + base.x
        const y = readNumber() + base.y
        current = { x, y }
        start = { x, y }
        active = { points: [{ x, y }], closed: false }
        subPaths.push(active)
        command = relative ? 'l' : 'L'
        break
      }
      case 'L': {
        current = { x: readNumber() + base.x, y: readNumber() + base.y }
        ensureActive().points.push(current)
        previousControl = null
        break
      }
      case 'H': {
        current = { x: readNumber() + base.x, y: current.y }
        ensureActive().points.push(current)
        previousControl = null
        break
      }
      case 'V': {
        current = { x: current.x, y: readNumber() + base.y }
        ensureActive().points.push(current)
        previousControl = null
        break
      }
      case 'C': {
        const p1 = { x: readNumber() + base.x, y: readNumber() + base.y }
        const p2 = { x: readNumber() + base.x, y: readNumber() + base.y }
        const p3 = { x: readNumber() + base.x, y: readNumber() + base.y }
        sampleCubic(current, p1, p2, p3)
        previousControl = p2
        current = p3
        break
      }
      case 'S': {
        const p1 = previousControl
          ? { x: current.x * 2 - previousControl.x, y: current.y * 2 - previousControl.y }
          : current
        const p2 = { x: readNumber() + base.x, y: readNumber() + base.y }
        const p3 = { x: readNumber() + base.x, y: readNumber() + base.y }
        sampleCubic(current, p1, p2, p3)
        previousControl = p2
        current = p3
        break
      }
      case 'Q': {
        const p1 = { x: readNumber() + base.x, y: readNumber() + base.y }
        const p2 = { x: readNumber() + base.x, y: readNumber() + base.y }
        sampleQuadratic(current, p1, p2)
        previousControl = p1
        current = p2
        break
      }
      case 'T': {
        const p1 = previousControl
          ? { x: current.x * 2 - previousControl.x, y: current.y * 2 - previousControl.y }
          : current
        const p2 = { x: readNumber() + base.x, y: readNumber() + base.y }
        sampleQuadratic(current, p1, p2)
        previousControl = p1
        current = p2
        break
      }
      case 'A': {
        // 圆弧：VML 需要换算为 arc/curve，这里退化为直线段（已在 warnings 中说明）。
        const rx = readNumber()
        const ry = readNumber()
        readNumber() // x-axis-rotation
        readNumber() // large-arc-flag
        readNumber() // sweep-flag
        const end = { x: readNumber() + base.x, y: readNumber() + base.y }
        if (rx === 0 || ry === 0) {
          current = end
          ensureActive().points.push(end)
        } else {
          ensureActive().points.push(end)
          current = end
        }
        previousControl = null
        break
      }
      case 'Z': {
        current = start
        if (active) {
          active.closed = true
          active.points.push({ x: start.x, y: start.y })
        }
        previousControl = null
        break
      }
      default:
        index += 1
        break
    }
  }
  return subPaths.filter((sub) => sub.points.length >= 2)
}

/**
 * 从 SVG 源中提取可渲染的图元（文本单独收集）。
 * @param {unknown} svgSource SVG 源文本。
 * @param {(message: string) => void} warn 警告收集器。
 * @param {string} label 图标识（用于警告文案）。
 * @returns {{
 *   viewBox: { x: number, y: number, w: number, h: number },
 *   shapes: Array<Record<string, any>>,
 *   texts: Array<Record<string, any>>,
 *   unsupported: string[],
 * }} 解析结果。
 */
function parseSvg(svgSource, warn, label) {
  const src = toStr(svgSource)
  const unsupported = new Set()
  const shapes = []
  const texts = []

  const svgTagMatch = /<svg\b([^>]*)>/i.exec(src)
  const svgAttrs = svgTagMatch ? parseAttributes(svgTagMatch[1]) : {}

  let viewBox = { x: 0, y: 0, w: 800, h: 600 }
  let hasExplicitBox = false
  if (svgAttrs.viewbox) {
    const nums = svgAttrs.viewbox.split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n))
    if (nums.length === 4 && nums[2] > 0 && nums[3] > 0) {
      viewBox = { x: nums[0], y: nums[1], w: nums[2], h: nums[3] }
      hasExplicitBox = true
    }
  }
  if (!hasExplicitBox) {
    const width = parseLength(svgAttrs.width, 0)
    const height = parseLength(svgAttrs.height, 0)
    if (width > 0 && height > 0) {
      viewBox = { x: 0, y: 0, w: width, h: height }
      hasExplicitBox = true
    }
  }
  if (!hasExplicitBox) {
    warn(`图「${label}」缺少 viewBox/宽高，已按 800×600 估算版面`)
  }

  const baseMatrix = { ...IDENTITY_MATRIX, e: -viewBox.x, f: -viewBox.y }
  const matrixStack = [baseMatrix]
  let skipDepth = 0
  const tagRe = /<(\/?)([a-zA-Z][\w:.-]*)([^>]*?)(\/?)>/g
  let match

  while ((match = tagRe.exec(src)) !== null) {
    const closing = match[1] === '/'
    const name = match[2].toLowerCase()
    const selfClosing = match[4] === '/'
    const attrText = match[3] || ''
    const matrix = matrixStack[matrixStack.length - 1]

    if (!closing && (name === 'g' || name === 'svg')) {
      const attrs = parseAttributes(attrText)
      matrixStack.push(attrs.transform ? multiplyMatrix(matrix, parseTransform(attrs.transform)) : matrix)
      continue
    }
    if (closing && (name === 'g' || name === 'svg')) {
      if (matrixStack.length > 1) matrixStack.pop()
      continue
    }
    if (SVG_SKIP_TAGS.has(name)) {
      if (!closing && !selfClosing) skipDepth += 1
      else if (closing) skipDepth = Math.max(0, skipDepth - 1)
      continue
    }
    if (skipDepth > 0) continue

    if (!closing && name === 'text') {
      const attrs = parseAttributes(attrText)
      const closeIndex = src.indexOf('</text>', tagRe.lastIndex)
      const innerHtml = closeIndex === -1 ? '' : src.slice(tagRe.lastIndex, closeIndex)
      if (closeIndex !== -1) tagRe.lastIndex = closeIndex + '</text>'.length
      const style = parseStyleDecl(attrs.style)
      const pick = (key) => style[key] ?? attrs[key]
      const fontSize = parseLength(pick('font-size'), 0)
      const anchor = toStr(pick('text-anchor') || 'start').toLowerCase()
      const weight = toStr(pick('font-weight') || '').toLowerCase()
      const family = toStr(pick('font-family') || '').replace(/["']/g, '').trim()
      const fill = parseColor(pick('fill') || '') || '404040'

      // tspan 若带独立坐标，则按多行处理；否则合并为一行。
      const tspanRe = /<tspan\b([^>]*)>([\s\S]*?)<\/tspan>/gi
      const tspans = []
      let tspanMatch
      while ((tspanMatch = tspanRe.exec(innerHtml)) !== null) {
        tspans.push({ attrs: parseAttributes(tspanMatch[1]), text: tspanMatch[2] })
      }
      const plainText = decodeEntities(innerHtml.replace(/<[^>]*>/g, ''))
      const spawnText = (x, y, text, size, extraAttrs) => {
        const clean = cleanText(text, 400)
        if (!clean) return
        const point = applyMatrix(matrix, x, y)
        texts.push({
          x: point.x,
          y: point.y,
          text: clean,
          fontSize: size > 0 ? size : 12,
          anchor,
          bold: /bold|^[6-9]00$/.test(weight),
          fontFamily: family,
          fill,
          ...extraAttrs,
        })
      }

      if (tspans.length > 0 && tspans.some((t) => t.attrs.x !== undefined || t.attrs.y !== undefined)) {
        for (const tspan of tspans) {
          const text = decodeEntities(tspan.text.replace(/<[^>]*>/g, ''))
          const tAttrs = { ...attrs, ...tspan.attrs }
          const tStyle = parseStyleDecl(tspan.attrs.style)
          spawnText(
            parseLength(tAttrs.x, parseLength(attrs.x, 0)),
            parseLength(tAttrs.y, parseLength(attrs.y, 0)),
            text,
            parseLength(tStyle['font-size'] || tAttrs['font-size'], fontSize),
            {},
          )
        }
      } else {
        spawnText(
          parseLength(attrs.x, 0),
          parseLength(attrs.y, 0),
          plainText,
          fontSize,
          {},
        )
      }
      continue
    }

    if (closing) continue

    const attrs = parseAttributes(attrText)
    const style = parseStyleDecl(attrs.style)
    const pick = (key) => style[key] ?? attrs[key]
    const stroke = parseColor(pick('stroke') || '')
    const fill = parseColor(pick('fill') || '')
    const strokeWidth = parseLength(pick('stroke-width'), 1)
    const dash = toStr(pick('stroke-dasharray') || '')
    const transform = attrs.transform ? multiplyMatrix(matrix, parseTransform(attrs.transform)) : matrix

    if (name === 'rect') {
      const x = parseLength(attrs.x, 0)
      const y = parseLength(attrs.y, 0)
      const w = parseLength(attrs.width, 0)
      const h = parseLength(attrs.height, 0)
      if (w <= 0 || h <= 0) continue
      const corners = [
        applyMatrix(transform, x, y),
        applyMatrix(transform, x + w, y + h),
      ]
      const rx = parseLength(attrs.rx ?? attrs.ry, 0)
      shapes.push({
        kind: 'rect',
        x: Math.min(corners[0].x, corners[1].x),
        y: Math.min(corners[0].y, corners[1].y),
        w: Math.abs(corners[1].x - corners[0].x),
        h: Math.abs(corners[1].y - corners[0].y),
        radius: Math.max(0, rx * Math.abs(transform.a || 1)),
        fill,
        stroke,
        strokeWidth,
        dashed: dash !== '' && dash !== 'none',
      })
    } else if (name === 'circle' || name === 'ellipse') {
      const cx = parseLength(attrs.cx, 0)
      const cy = parseLength(attrs.cy, 0)
      const rx = name === 'circle' ? parseLength(attrs.r, 0) : parseLength(attrs.rx, 0)
      const ry = name === 'circle' ? parseLength(attrs.r, 0) : parseLength(attrs.ry, 0)
      if (rx <= 0 || ry <= 0) continue
      const center = applyMatrix(transform, cx, cy)
      const scaleX = Math.hypot(transform.a, transform.b) || 1
      const scaleY = Math.hypot(transform.c, transform.d) || 1
      shapes.push({
        kind: 'oval',
        x: center.x - rx * scaleX,
        y: center.y - ry * scaleY,
        w: rx * 2 * scaleX,
        h: ry * 2 * scaleY,
        fill,
        stroke,
        strokeWidth,
        dashed: dash !== '' && dash !== 'none',
      })
    } else if (name === 'line') {
      const p1 = applyMatrix(transform, parseLength(attrs.x1, 0), parseLength(attrs.y1, 0))
      const p2 = applyMatrix(transform, parseLength(attrs.x2, 0), parseLength(attrs.y2, 0))
      shapes.push({
        kind: 'line',
        x1: p1.x,
        y1: p1.y,
        x2: p2.x,
        y2: p2.y,
        fill: null,
        stroke: stroke || '595959',
        strokeWidth,
        dashed: dash !== '' && dash !== 'none',
        arrowEnd: toStr(attrs['marker-end'] || '').toLowerCase() !== '',
      })
    } else if (name === 'polyline' || name === 'polygon') {
      const nums = toStr(attrs.points)
        .split(/[\s,]+/)
        .map(Number)
        .filter((n) => Number.isFinite(n))
      const points = []
      for (let p = 0; p + 1 < nums.length; p += 2) {
        points.push(applyMatrix(transform, nums[p], nums[p + 1]))
      }
      if (points.length < 2) continue
      shapes.push({
        kind: 'polyline',
        points,
        closed: name === 'polygon',
        fill,
        stroke,
        strokeWidth,
        dashed: dash !== '' && dash !== 'none',
        arrowEnd: toStr(attrs['marker-end'] || '').toLowerCase() !== '',
      })
      if (fill) unsupported.add('polygon-fill')
    } else if (name === 'path') {
      const subPaths = parsePathData(attrs.d || '')
      if (subPaths.length === 0) continue
      for (const sub of subPaths) {
        const points = sub.points.map((point) => applyMatrix(transform, point.x, point.y))
        const box = points.reduce(
          (acc, point) => ({
            minX: Math.min(acc.minX, point.x),
            minY: Math.min(acc.minY, point.y),
            maxX: Math.max(acc.maxX, point.x),
            maxY: Math.max(acc.maxY, point.y),
          }),
          { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
        )
        const isAxisAlignedRect =
          points.length >= 5 &&
          Math.abs(box.maxX - box.minX) > 0.5 &&
          Math.abs(box.maxY - box.minY) > 0.5 &&
          points.every(
            (point) =>
              Math.abs(point.x - box.minX) < 0.5 ||
              Math.abs(point.x - box.maxX) < 0.5 ||
              Math.abs(point.y - box.minY) < 0.5 ||
              Math.abs(point.y - box.maxY) < 0.5,
          )
        if (isAxisAlignedRect && fill) {
          shapes.push({
            kind: 'rect',
            x: box.minX,
            y: box.minY,
            w: box.maxX - box.minX,
            h: box.maxY - box.minY,
            radius: 0,
            fill,
            stroke,
            strokeWidth,
            dashed: dash !== '' && dash !== 'none',
          })
        } else {
          shapes.push({
            kind: 'polyline',
            points,
            closed: sub.closed,
            fill: null,
            stroke,
            strokeWidth,
            dashed: dash !== '' && dash !== 'none',
            arrowEnd: toStr(attrs['marker-end'] || '').toLowerCase() !== '',
          })
          if (fill) unsupported.add('path-fill')
          if (/\bA\b|\ba\b/.test(toStr(attrs.d))) unsupported.add('arc')
        }
      }
    } else if (name === 'image' || name === 'use' || name === 'foreignobject') {
      unsupported.add(name)
    }
  }

  return {
    viewBox,
    shapes,
    texts,
    unsupported: Array.from(unsupported),
  }
}

/**
 * 估算一行文字的显示宽度（以字号为单位），用于给 VML 文本框定位。
 * @param {string} text 文字。
 * @param {number} fontSize 字号（用户单位）。
 * @returns {number} 宽度（用户单位）。
 */
function estimateTextWidth(text, fontSize) {
  let units = 0
  for (const ch of text) {
    if (/[\u2E80-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/.test(ch)) units += 1
    else if (/\s/.test(ch)) units += 0.35
    else if (/[A-Z0-9@%#&]/.test(ch)) units += 0.62
    else units += 0.55
  }
  return Math.max(fontSize * 0.9, units * fontSize)
}

/** 把数字格式化为紧凑字符串。 */
function fmt(value) {
  if (!Number.isFinite(value)) return '0'
  const rounded = Math.round(value * 100) / 100
  return String(rounded)
}

/**
 * 把已解析的 SVG 图形装配成 VML 组。
 *
 * @param {{
 *   viewBox: { x: number, y: number, w: number, h: number },
 *   shapes: Array<Record<string, any>>,
 *   texts: Array<Record<string, any>>,
 *   unsupported: string[],
 * }} parsed 解析结果。
 * @param {{
 *   widthPt: number,
 *   heightPt: number,
 *   headingFont: string,
 *   latinFont: string,
 *   bodyFont: string,
 *   idBase: number,
 * }} layout 版面参数。
 * @returns {string} `v:group` 内部 XML（不含 w:pict）。
 */
function buildVmlGroupContent(parsed, layout) {
  const { viewBox } = parsed
  const { widthPt, heightPt } = layout
  const coordLimit = 21600
  const maxSide = Math.max(viewBox.w, viewBox.h, 1)
  const k = Math.max(0.0001, coordLimit / maxSide)
  const coordW = Math.max(1, Math.round(viewBox.w * k))
  const coordH = Math.max(1, Math.round(viewBox.h * k))
  const scalePt = widthPt / Math.max(viewBox.w, 1)
  const X = (x) => Math.round((x - viewBox.x) * k)
  const Y = (y) => Math.round((y - viewBox.y) * k)
  const S = (len) => Math.max(0, Math.round(len * k))
  const strokePt = (sw) => {
    const value = Math.max(0.25, Math.min(4, (Number(sw) || 1) * scalePt))
    return `${fmt(Math.round(value * 100) / 100)}pt`
  }
  const colorAttr = (hex) => (hex ? `#${hex}` : null)

  let shapeId = layout.idBase
  const nextId = () => {
    shapeId += 1
    return `_x0000_s${shapeId}`
  }

  /** @type {string[]} */
  const pieces = []

  for (const shape of parsed.shapes) {
    if (shape.kind === 'rect') {
      const dashAttr = shape.dashed ? ' dashstyle="dash"' : ''
      const fillAttrs = shape.fill
        ? ` fillcolor="${colorAttr(shape.fill)}" filled="t"`
        : ' filled="f"'
      const strokeAttrs = shape.stroke
        ? ` strokecolor="${colorAttr(shape.stroke)}" strokeweight="${strokePt(shape.strokeWidth)}"`
        : ' stroked="f"'
      const style =
        `position:absolute;left:${X(shape.x)};top:${Y(shape.y)};` +
        `width:${S(shape.w)};height:${S(shape.h)}`
      // 统一使用 v:rect：Word 与 Apple 的 Word 转换器（macOS QuickLook）都能正确定位。
      // SVG 的圆角半径仍以 arcsize 保留（Word 支持圆角矩形，不认该属性的转换器只画
      // 方角，但位置永远正确）；v:roundrect 在 Apple 转换器里会被画到 left+宽度/2，
      // 视觉验收会表现为“图错位”，因此不再使用。
      const arcAttr =
        shape.radius > 0
          ? ` arcsize="${fmt(
              Math.max(2, Math.min(50, (shape.radius / Math.max(shape.w, shape.h, 1)) * 100)),
            )}%"`
          : ''
      pieces.push(
        `<v:rect id="${nextId()}" style="${style}"${arcAttr}${fillAttrs}${strokeAttrs}>` +
          `<v:stroke${dashAttr}/>` +
          '</v:rect>',
      )
    } else if (shape.kind === 'oval') {
      const fillAttrs = shape.fill
        ? ` fillcolor="${colorAttr(shape.fill)}" filled="t"`
        : ' filled="f"'
      const strokeAttrs = shape.stroke
        ? ` strokecolor="${colorAttr(shape.stroke)}" strokeweight="${strokePt(shape.strokeWidth)}"`
        : ' stroked="f"'
      pieces.push(
        `<v:oval id="${nextId()}" style="position:absolute;left:${X(shape.x)};top:${Y(shape.y)};` +
          `width:${S(shape.w)};height:${S(shape.h)}"${fillAttrs}${strokeAttrs}>` +
          `<v:stroke${shape.dashed ? ' dashstyle="dash"' : ''}/>` +
          '</v:oval>',
      )
    } else if (shape.kind === 'line') {
      pieces.push(
        `<v:line id="${nextId()}" from="${X(shape.x1)},${Y(shape.y1)}" ` +
          `to="${X(shape.x2)},${Y(shape.y2)}" style="position:absolute" ` +
          `strokecolor="${colorAttr(shape.stroke || '595959')}" ` +
          `strokeweight="${strokePt(shape.strokeWidth)}">` +
          `<v:stroke${shape.dashed ? ' dashstyle="dash"' : ''}` +
          `${shape.arrowEnd ? ' endarrow="block" endarrowwidth="medium"' : ''}/>` +
          '</v:line>',
      )
    } else if (shape.kind === 'polyline') {
      const points = shape.points
      for (let p = 0; p + 1 < points.length; p += 1) {
        const from = points[p]
        const to = points[p + 1]
        if (Math.hypot(to.x - from.x, to.y - from.y) < 0.2) continue
        const isLast = p + 2 >= points.length
        pieces.push(
          `<v:line id="${nextId()}" from="${X(from.x)},${Y(from.y)}" ` +
            `to="${X(to.x)},${Y(to.y)}" style="position:absolute" ` +
            `strokecolor="${colorAttr(shape.stroke || '595959')}" ` +
            `strokeweight="${strokePt(shape.strokeWidth)}">` +
            `<v:stroke${shape.dashed ? ' dashstyle="dash"' : ''}` +
            `${shape.arrowEnd && isLast ? ' endarrow="block" endarrowwidth="medium"' : ''}/>` +
            '</v:line>',
        )
      }
    }
  }

  const labelStyles = (text) => {
    const fontPt = Math.max(4.5, Math.min(18, (Number(text.fontSize) || 12) * scalePt))
    const halfPt = Math.max(9, Math.min(36, Math.round(fontPt * 2)))
    const eastAsia = layout.headingFont
    const latin = layout.latinFont
    const rFonts =
      `<w:rFonts w:ascii="${xmlAttr(latin)}" w:hAnsi="${xmlAttr(latin)}" ` +
      `w:eastAsia="${xmlAttr(eastAsia)}" w:cs="${xmlAttr(latin)}"/>`
    return { halfPt, rFonts }
  }

  for (const text of parsed.texts) {
    const { halfPt, rFonts } = labelStyles(text)
    const fontSize = Math.max(6, Math.min(20, (Number(text.fontSize) || 12)))
    const boxWidth = estimateTextWidth(text.text, fontSize) * 1.12 + fontSize * 0.4
    const boxHeight = fontSize * 1.45
    const anchor = toStr(text.anchor).toLowerCase()
    let left = text.x - boxWidth / 2
    if (anchor === 'start') left = text.x - fontSize * 0.1
    else if (anchor === 'end') left = text.x - boxWidth + fontSize * 0.1
    const top = text.y - fontSize * 0.98
    const jc = anchor === 'start' ? 'left' : anchor === 'end' ? 'right' : 'center'
    const boldXml = text.bold ? '<w:b/>' : ''
    pieces.push(
      `<v:rect id="${nextId()}" style="position:absolute;left:${X(left)};top:${Y(top)};` +
        `width:${S(boxWidth)};height:${S(boxHeight)};v-text-anchor:middle" filled="f" stroked="f">` +
        '<v:textbox inset="0,0,0,0">' +
        '<w:txbxContent>' +
        '<w:p><w:pPr><w:pStyle w:val="FigureLabel"/>' +
        '<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>' +
        `<w:jc w:val="${jc}"/></w:pPr>` +
        '<w:r><w:rPr>' +
        rFonts +
        boldXml +
        `<w:color w:val="${text.fill || '404040'}"/>` +
        `<w:sz w:val="${halfPt}"/><w:szCs w:val="${halfPt}"/>` +
        '</w:rPr>' +
        `<w:t xml:space="preserve">${xmlEscape(text.text)}</w:t>` +
        '</w:r></w:p>' +
        '</w:txbxContent></v:textbox></v:rect>',
    )
  }

  return {
    coordW,
    coordH,
    content: pieces.join(''),
  }
}

/**
 * 渲染一张图：`w:pict` + `v:group`（含中文文本框），并附中文图题。
 *
 * @param {object} ctx 文档渲染上下文。
 * @param {{ id: string, title: string, svg: string, sectionTitle?: string }} figure 图数据。
 * @returns {string} 段落 XML（图 + 图题）。
 */
function renderFigureXml(ctx, figure) {
  const id = cleanToken(figure.id, 80) || 'figure'
  const title = cleanText(figure.title, 200)
  const parsed = parseSvg(figure.svg, ctx.warn, title || id)

  // 版面：占满正文宽度，过高时等比压缩，避免图把页面撑爆。
  const maxWidthPt = Math.min(ctx.figureMaxWidthPt, ctx.contentWidth / 20)
  const maxHeightPt = 560
  const aspect = parsed.viewBox.h / Math.max(parsed.viewBox.w, 1)
  let widthPt = Math.max(120, maxWidthPt)
  let heightPt = widthPt * aspect
  if (heightPt > maxHeightPt) {
    heightPt = maxHeightPt
    widthPt = heightPt / Math.max(aspect, 0.0001)
  }
  widthPt = Math.max(80, widthPt)
  heightPt = Math.max(40, heightPt)

  const hasContent = parsed.shapes.length > 0 || parsed.texts.length > 0
  /** @type {string[]} */
  const warnings = []
  if (parsed.unsupported.length > 0) {
    const explain = {
      'path-fill': '路径填充',
      'polygon-fill': '多边形填充',
      arc: '圆弧路径（已退化为直线）',
      image: '<image> 位图',
      use: '<use> 引用',
      foreignobject: '<foreignObject>',
    }
    const labels = parsed.unsupported.map((kind) => explain[kind] || kind)
    warnings.push(`图「${title || id}」含不支持的 SVG 元素：${labels.join('、')}（已降级为描边/直线）`)
  }

  let groupContent
  let groupW = widthPt
  let groupH = heightPt
  let coordW = Math.max(1, Math.round(21600 * (parsed.viewBox.w / Math.max(parsed.viewBox.w, parsed.viewBox.h, 1))))
  let coordH = Math.max(1, Math.round(21600 * (parsed.viewBox.h / Math.max(parsed.viewBox.w, parsed.viewBox.h, 1))))
  let captionSuffix = ''
  if (hasContent) {
    const built = buildVmlGroupContent(parsed, {
      widthPt,
      heightPt,
      headingFont: ctx.fonts.heading,
      latinFont: ctx.fonts.latin,
      idBase: 1024 + ctx.figureSerial * 128,
    })
    groupContent = built.content
    coordW = built.coordW
    coordH = built.coordH
  } else {
    // 兜底：SVG 无法解析时，用“标题框”保证版面不塌陷，并说明原因。
    const fallbackFontPt = Math.max(9, Math.min(14, widthPt / 40))
    const halfPt = Math.round(fallbackFontPt * 2)
    groupW = Math.min(widthPt, 360)
    groupH = 72
    coordW = 3600
    coordH = 720
    groupContent =
      '<v:rect id="_x0000_s2001" style="position:absolute;left:0;top:0;width:3600;height:720" ' +
      'arcsize="8%" fillcolor="#F2F5FB" strokecolor="#8EA9DB" strokeweight="1pt">' +
      '<v:textbox inset="6pt,6pt,6pt,6pt" style="v-text-anchor:middle">' +
      '<w:txbxContent><w:p><w:pPr><w:pStyle w:val="FigureLabel"/><w:jc w:val="center"/></w:pPr>' +
      `<w:r><w:rPr><w:rFonts w:ascii="${xmlAttr(ctx.fonts.latin)}" w:hAnsi="${xmlAttr(ctx.fonts.latin)}" ` +
      `w:eastAsia="${xmlAttr(ctx.fonts.heading)}"/><w:sz w:val="${halfPt}"/><w:szCs w:val="${halfPt}"/>` +
      `<w:t xml:space="preserve">${xmlEscape(title || '示意图')}</w:t></w:r></w:p>` +
      '</w:txbxContent></v:textbox></v:rect>'
    warnings.push(
      `图「${title || id}」的 SVG 没有可识别的图形元素，已回退为标题占位框`,
    )
    captionSuffix = '（占位）'
  }

  for (const message of warnings) ctx.warn(message)

  ctx.figureSerial += 1
  const figureIndex = ctx.figureSerial

  const groupOpen =
    `<v:group id="_x0000_s${1000 + figureIndex}" ` +
    `style="width:${fmt(groupW)}pt;height:${fmt(groupH)}pt" ` +
    `coordsize="${coordW},${coordH}" coordorigin="0,0">`

  const picture =
    '<w:p><w:pPr><w:pStyle w:val="FigureParagraph"/></w:pPr>' +
    '<w:r><w:pict>' +
    groupOpen +
    groupContent +
    '</v:group>' +
    '</w:pict></w:r></w:p>'

  const captionText = title ? `图 ${ctx.figureNumber}　${title}${captionSuffix}` : ''
  if (captionText) {
    ctx.figureNumber += 1
    return (
      picture +
      '<w:p><w:pPr><w:pStyle w:val="Caption"/></w:pPr>' +
      `<w:r><w:t xml:space="preserve">${xmlEscape(captionText)}</w:t></w:r></w:p>`
    )
  }
  return picture
}

/* ==================================================================== *
 * 10. 模型归一化（缺字段不抛错，只产生 warnings）
 * ==================================================================== */

const MAX_SECTIONS = 2000
const MAX_MARKDOWN_CHARS = 400000
const MAX_SVG_CHARS = 2000000

/**
 * 判断是否为普通对象。
 * @param {unknown} value 任意值。
 * @returns {boolean}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 清洗字体名（去掉会破坏 XML 属性或样式表的字符）。
 * @param {unknown} value 原始值。
 * @param {string} fallback 回退字体。
 * @returns {string}
 */
function cleanFontName(value, fallback) {
  const name = cleanText(value, 60).replace(/["'<>&\\]/g, '').trim()
  return name || fallback
}

/**
 * 格式化为中文日期（如 `2026年10月29日`）。
 * @param {Date} date 日期。
 * @returns {string}
 */
function formatChineseDate(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date()
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

/**
 * 归一化并钳制整个导出模型。
 * @param {unknown} model 原始模型。
 * @param {(message: string) => void} warn 警告收集器。
 * @returns {{
 *   meta: object, page: object, fonts: object, cover: object,
 *   header: object, footer: object, toc: object,
 *   facts: Array<{ key: string, value: string }>,
 *   sections: Array<{ id: string, title: string, level: number, markdown: string,
 *                     figures: Array<{ id: string, title: string, svg: string, sectionTitle: string }> }>,
 *   contentWidth: number,
 * }} 归一化结果。
 */
function normalizeModel(model, warn) {
  const raw = isPlainObject(model) ? model : {}
  if (model != null && !isPlainObject(model)) {
    warn('model 不是对象，已按空文档处理')
  }

  // ---- meta ---------------------------------------------------------
  const rawMeta = isPlainObject(raw.meta) ? raw.meta : {}
  if (raw.meta != null && !isPlainObject(raw.meta)) warn('meta 字段类型非法，已忽略')
  const meta = {
    title: cleanText(rawMeta.title, 200),
    subtitle: cleanText(rawMeta.subtitle, 200),
    tenderNo: cleanText(rawMeta.tenderNo, 120),
    bidder: cleanText(rawMeta.bidder, 200),
    date: cleanText(rawMeta.date, 60),
  }

  // ---- page ---------------------------------------------------------
  const rawPage = isPlainObject(raw.page) ? raw.page : {}
  const rawMargins = isPlainObject(rawPage.margins) ? rawPage.margins : {}
  const page = {
    widthTwips: clampInt(rawPage.widthTwips, 6000, 30000, DEFAULT_PAGE.widthTwips),
    heightTwips: clampInt(rawPage.heightTwips, 6000, 40000, DEFAULT_PAGE.heightTwips),
    marginTop: clampInt(rawMargins.top, 0, 4320, DEFAULT_PAGE.marginTop),
    marginBottom: clampInt(rawMargins.bottom, 0, 4320, DEFAULT_PAGE.marginBottom),
    marginLeft: clampInt(rawMargins.left, 0, 4320, DEFAULT_PAGE.marginLeft),
    marginRight: clampInt(rawMargins.right, 0, 4320, DEFAULT_PAGE.marginRight),
  }
  if (rawPage.widthTwips != null && page.widthTwips !== Number(rawPage.widthTwips)) {
    warn(`页面宽度 ${toStr(rawPage.widthTwips)} twips 超出允许范围，已钳制为 ${page.widthTwips}`)
  }
  if (rawPage.heightTwips != null && page.heightTwips !== Number(rawPage.heightTwips)) {
    warn(`页面高度 ${toStr(rawPage.heightTwips)} twips 超出允许范围，已钳制为 ${page.heightTwips}`)
  }

  // 正文宽度下限 3000 twips（约 5.3cm），否则表格与图无法排版。
  const minContentWidth = 3000
  let contentWidth = page.widthTwips - page.marginLeft - page.marginRight
  if (contentWidth < minContentWidth) {
    warn('页边距过大导致正文宽度不足，已自动收窄左右边距以保证可排版')
    const available = Math.max(0, page.widthTwips - minContentWidth)
    page.marginLeft = Math.floor(available / 2)
    page.marginRight = page.widthTwips - minContentWidth - page.marginLeft
    contentWidth = minContentWidth
  }

  // ---- fonts --------------------------------------------------------
  const rawFonts = isPlainObject(raw.fonts) ? raw.fonts : {}
  const bodySizeRaw = Number(rawFonts.bodySizePt)
  // 中文字号常见 10.5pt（五号），因此按 0.5pt 取整而不是取整到 1pt。
  const bodySizePt = Number.isFinite(bodySizeRaw)
    ? Math.min(24, Math.max(6, Math.round(bodySizeRaw * 2) / 2))
    : DEFAULT_FONTS.bodySizePt
  const fonts = {
    body: cleanFontName(rawFonts.body, DEFAULT_FONTS.body),
    heading: cleanFontName(rawFonts.heading, DEFAULT_FONTS.heading),
    latin: cleanFontName(rawFonts.latin, DEFAULT_FONTS.latin),
    bodySizePt,
  }
  if (
    rawFonts.bodySizePt != null &&
    Number.isFinite(bodySizeRaw) &&
    bodySizeRaw !== bodySizePt
  ) {
    warn(`正文字号 ${toStr(rawFonts.bodySizePt)}pt 超出 6–24pt，已钳制为 ${bodySizePt}pt`)
  }

  // ---- cover --------------------------------------------------------
  const rawCover = isPlainObject(raw.cover) ? raw.cover : {}
  const cover = {
    enabled: toBool(rawCover.enabled, true),
    projectName: cleanText(rawCover.projectName ?? meta.title, 300),
    bidder: cleanText(rawCover.bidder ?? meta.bidder, 200),
    date: cleanText(rawCover.date ?? meta.date, 60),
    tenderNo: cleanText(rawCover.tenderNo ?? meta.tenderNo, 120),
  }

  // ---- header / footer ----------------------------------------------
  const rawHeader = isPlainObject(raw.header) ? raw.header : {}
  const rawFooter = isPlainObject(raw.footer) ? raw.footer : {}
  const header = { text: cleanText(rawHeader.text, 200) }
  const footer = {
    pageNumber: toBool(rawFooter.pageNumber, true),
    text: cleanText(rawFooter.text, 200),
  }

  // ---- toc ----------------------------------------------------------
  const rawToc = isPlainObject(raw.toc) ? raw.toc : {}
  const toc = {
    enabled: toBool(rawToc.enabled, true),
    maxLevel: clampInt(rawToc.maxLevel, 1, 4, 3),
  }
  if (rawToc.maxLevel != null && toc.maxLevel !== Number(rawToc.maxLevel)) {
    warn(`目录层级 ${toStr(rawToc.maxLevel)} 超出 1–4，已钳制为 ${toc.maxLevel}`)
  }

  // ---- facts --------------------------------------------------------
  /** @type {Array<{ key: string, value: string }>} */
  const facts = []
  if (Array.isArray(raw.facts)) {
    for (const item of raw.facts) {
      if (!isPlainObject(item)) {
        warn('facts 中存在非对象条目，已忽略')
        continue
      }
      const key = cleanText(item.key, 120)
      const value = cleanText(item.value, 4000)
      if (key || value) facts.push({ key, value })
    }
    if (facts.length > 200) {
      warn('facts 条目超过 200 条，仅保留前 200 条')
      facts.length = 200
    }
  } else if (raw.facts != null) {
    warn('facts 不是数组，已忽略')
  }

  // ---- sections -----------------------------------------------------
  /** @type {Array<{ id: string, title: string, level: number, markdown: string, figures: Array<{ id: string, title: string, svg: string, sectionTitle: string }> }>} */
  const sections = []
  if (Array.isArray(raw.sections)) {
    if (raw.sections.length > MAX_SECTIONS) {
      warn(`章节数 ${raw.sections.length} 超过上限 ${MAX_SECTIONS}，超出部分已丢弃`)
    }
    raw.sections.slice(0, MAX_SECTIONS).forEach((item, index) => {
      if (!isPlainObject(item)) {
        warn(`第 ${index + 1} 个章节不是对象，已跳过`)
        return
      }
      const title = cleanText(item.title, 300)
      const rawLevel = Number(item.level)
      const level = clampInt(rawLevel, 1, 4, 1)
      if (Number.isFinite(rawLevel) && rawLevel !== level) {
        warn(`章节「${title || index + 1}」的层级 ${toStr(item.level)} 超出 1–4，已钳制为 ${level}`)
      }
      let markdown = ''
      if (typeof item.markdown === 'string') markdown = item.markdown.slice(0, MAX_MARKDOWN_CHARS)
      else if (item.markdown != null) warn(`章节「${title || index + 1}」的 markdown 不是字符串，已忽略`)

      /** @type {Array<{ id: string, title: string, svg: string, sectionTitle: string }>} */
      const figures = []
      if (Array.isArray(item.figures)) {
        for (const figure of item.figures) {
          if (!isPlainObject(figure)) {
            warn(`章节「${title || index + 1}」中存在非对象图定义，已忽略`)
            continue
          }
          const id = cleanToken(figure.id, 80)
          if (!id) {
            warn(`章节「${title || index + 1}」中有图缺少 id，已忽略`)
            continue
          }
          let svg = ''
          if (typeof figure.svg === 'string') svg = figure.svg.slice(0, MAX_SVG_CHARS)
          else if (figure.svg != null) warn(`图「${figure.title || id}」的 svg 不是字符串，已忽略`)
          figures.push({
            id,
            title: cleanText(figure.title, 200),
            svg,
            sectionTitle: title,
          })
        }
      } else if (item.figures != null) {
        warn(`章节「${title || index + 1}」的 figures 不是数组，已忽略`)
      }

      sections.push({
        id: cleanToken(item.id, 80) || `s${index + 1}`,
        title,
        level,
        markdown,
        figures,
      })
    })
  } else {
    warn('缺少 sections 数组，将生成仅含封面/目录的空文档')
  }

  return { meta, page, fonts, cover, header, footer, toc, facts, sections, contentWidth }
}

/* ==================================================================== *
 * 11. 文档装配：封面 / 目录 / 基础信息 / 章节 / 节属性
 * ==================================================================== */

/** 分页符段落。 */
function pageBreakXml() {
  return '<w:p><w:pPr><w:pStyle w:val="PageBreak"/></w:pPr><w:r><w:br w:type="page"/></w:r></w:p>'
}

/**
 * 渲染封面（居中标题 + 招标编号 / 投标人 / 日期）。
 * @param {object} ctx 文档上下文。
 * @returns {string} 封面段落 XML。
 */
function renderCoverXml(ctx) {
  const out = []
  const blank = () => '<w:p><w:pPr><w:pStyle w:val="CoverBlank"/></w:pPr></w:p>'
  const title = ctx.cover.projectName || ctx.meta.title || '投标文件'

  out.push(blank(), blank(), blank())
  out.push(
    '<w:p><w:pPr><w:pStyle w:val="CoverTitle"/></w:pPr>' +
      renderInlineXml(title) +
      '</w:p>',
  )
  if (ctx.meta.subtitle) {
    out.push(
      '<w:p><w:pPr><w:pStyle w:val="CoverSubtitle"/></w:pPr>' +
        renderInlineXml(ctx.meta.subtitle) +
        '</w:p>',
    )
  }
  out.push(blank(), blank())

  const infoLines = []
  if (ctx.cover.tenderNo) infoLines.push(`招标编号：${ctx.cover.tenderNo}`)
  if (ctx.cover.bidder) infoLines.push(`投　标　人：${ctx.cover.bidder}`)
  if (ctx.cover.date) infoLines.push(`日　　　期：${ctx.cover.date}`)
  for (const line of infoLines) {
    out.push(
      '<w:p><w:pPr><w:pStyle w:val="CoverInfo"/></w:pPr>' +
        `<w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`,
    )
  }
  return out.join('')
}

/**
 * 渲染目录页：标题 + 自动目录域（`TOC \o "1-N" \h \z \u`）。
 * @param {object} ctx 文档上下文。
 * @returns {string} 目录段落 XML。
 */
function renderTocXml(ctx) {
  const instr = ` TOC \\o "1-${ctx.toc.maxLevel}" \\h \\z \\u `
  return (
    '<w:p><w:pPr><w:pStyle w:val="TOCTitle"/></w:pPr>' +
    '<w:r><w:t xml:space="preserve">目　　录</w:t></w:r></w:p>' +
    '<w:p><w:pPr><w:pStyle w:val="TOC1"/></w:pPr>' +
    `<w:fldSimple w:instr="${xmlAttr(instr)}">` +
    '<w:r><w:rPr><w:color w:val="808080"/></w:rPr>' +
    '<w:t xml:space="preserve">（目录域：在 Word 中按 F9 或“更新域”即可生成；w:updateFields 已置为 true）</w:t>' +
    '</w:r></w:fldSimple></w:p>'
  )
}

/**
 * 渲染“项目基本信息”表（来自 model.facts）。
 * @param {object} ctx 文档上下文。
 * @returns {string} 标题 + 表格 XML。
 */
function renderFactsXml(ctx) {
  if (ctx.facts.length === 0) return ''
  const block = {
    type: 'table',
    header: ['项目', '内容'],
    align: ['left', 'left'],
    rows: ctx.facts.map((fact) => [fact.key, fact.value]),
  }
  return (
    renderHeadingXml(1, '项目基本信息') +
    renderTableXml(block, ctx, { widthRatios: [0.28, 0.72] })
  )
}

/**
 * 渲染所有章节（1 级章节自动另起一页）。
 * @param {object} ctx 文档上下文。
 * @returns {{ xml: string, hasContent: boolean }} 章节 XML。
 */
function renderSectionsXml(ctx) {
  const out = []
  let hasContent = false

  ctx.sections.forEach((section, index) => {
    const hasMarkdown = section.markdown.trim().length > 0
    const hasFigures = section.figures.length > 0
    if (!section.title && !hasMarkdown && !hasFigures) {
      ctx.warn(`第 ${index + 1} 个章节既无标题也无内容，已跳过`)
      return
    }
    if (section.level === 1 && hasContent) out.push(pageBreakXml())
    if (section.title) out.push(renderHeadingXml(section.level, section.title))
    else ctx.warn(`第 ${index + 1} 个章节缺少标题，已直接输出正文`)

    if (hasMarkdown) {
      const blocks = parseMarkdown(section.markdown, ctx.warn)
      out.push(renderBlocksXml(blocks, ctx))
    }

    for (const figure of section.figures) {
      if (ctx.usedFigures.has(figure.id)) continue
      ctx.warn(
        `图「${figure.title || figure.id}」没有被 [[figure:${figure.id}]] 引用，已追加到章节末尾`,
      )
      out.push(renderFigureXml(ctx, figure))
      ctx.usedFigures.add(figure.id)
    }

    hasContent = true
  })

  return { xml: out.join(''), hasContent }
}

/**
 * 生成节属性（`w:sectPr`）：页面尺寸、页边距、页眉页脚引用、页码起始值。
 * @param {object} ctx 文档上下文。
 * @param {{ variant: 'front'|'body', footerRelId?: string|null, headerRelId?: string|null }} options 变体与关系 id。
 * @returns {string} sectPr XML。
 */
function sectPrXml(ctx, options) {
  const { page } = ctx
  const pageSize = `<w:pgSz w:w="${page.widthTwips}" w:h="${page.heightTwips}"/>`
  const pageMargin =
    `<w:pgMar w:top="${page.marginTop}" w:right="${page.marginRight}" ` +
    `w:bottom="${page.marginBottom}" w:left="${page.marginLeft}" ` +
    `w:header="${DEFAULT_PAGE.headerTwips}" w:footer="${DEFAULT_PAGE.footerTwips}" w:gutter="0"/>`
  const cols = '<w:cols w:space="425"/>'
  const docGrid = '<w:docGrid w:type="lines" w:linePitch="312"/>'

  if (options.variant === 'front') {
    return (
      '<w:sectPr><w:type w:val="nextPage"/>' +
      pageSize +
      pageMargin +
      cols +
      docGrid +
      '</w:sectPr>'
    )
  }
  const headerRef = options.headerRelId
    ? `<w:headerReference w:type="default" r:id="${options.headerRelId}"/>`
    : ''
  const footerRef = options.footerRelId
    ? `<w:footerReference w:type="default" r:id="${options.footerRelId}"/>`
    : ''
  return (
    '<w:sectPr>' +
    headerRef +
    footerRef +
    pageSize +
    pageMargin +
    '<w:pgNumType w:start="1"/>' +
    cols +
    docGrid +
    '</w:sectPr>'
  )
}

/**
 * 生成 document.xml 的根元素命名空间声明。
 *
 * v / o / w10 是 VML 图元需要的命名空间；wp / a / pic / mc 一并声明，
 * 以便 Word 打开、转换并与后续可能的 DrawingML 内容兼容。
 * @returns {string} 根元素属性串。
 */
function documentRootAttributes() {
  return [
    `xmlns:w="${NS_W}"`,
    `xmlns:r="${NS_R}"`,
    `xmlns:w10="${NS_W10}"`,
    `xmlns:wp="${NS_WP}"`,
    `xmlns:a="${NS_A}"`,
    `xmlns:pic="${NS_PIC}"`,
    `xmlns:v="${NS_V}"`,
    `xmlns:o="${NS_O}"`,
    `xmlns:mc="${NS_MC}"`,
  ].join(' ')
}

/* ==================================================================== *
 * 12. 对外入口
 * ==================================================================== */

/**
 * 把 BidKit 的导出模型编译为一个合法的 `.docx` 字节流。
 *
 * 这是本模块唯一的公开导出（见 docs/CONTRACT.md §3）。
 *
 * @param {object} [model] 导出模型，字段全部可缺省（`sections` 也可缺省）。
 * @param {object} [options] 导出选项。
 * @param {Date|string|number} [options.modifiedAt] 固定 ZIP 时间戳（便于测试复现）。
 * @returns {Promise<{ buffer: Uint8Array, warnings: string[], bytes: number }>} 文档字节与警告。
 *
 * @example
 * const { buffer, bytes, warnings } = await buildDocx({ sections: [...] })
 * await writeFile('bid.docx', buffer)
 */
export async function buildDocx(model = {}, options = {}) {
  /** @type {string[]} */
  const warnings = []
  const seenWarnings = new Set()
  /**
   * 收集警告（去重、限量，绝不抛出）。
   * @param {string} message 警告文本。
   */
  const warn = (message) => {
    const text = cleanText(message, 500)
    if (!text || seenWarnings.has(text)) return
    if (warnings.length >= 200) return
    seenWarnings.add(text)
    warnings.push(text)
  }

  const opts = isPlainObject(options) ? options : {}
  const normalized = normalizeModel(model, warn)
  const { meta, page, fonts, cover, header, footer, toc, facts, sections, contentWidth } =
    normalized

  // 封面缺日期时用当天日期补全（真实标书必须落款，且明确告知用户）。
  if (cover.enabled && !cover.date) {
    cover.date = formatChineseDate(new Date())
    warn(`封面未提供日期，已按当天日期填写「${cover.date}」`)
  }
  if (cover.enabled && !cover.projectName && !meta.title) {
    warn('封面未提供项目名称，已使用默认标题「投标文件」')
  }

  // ---- 图索引：id → 图（全局唯一，重复 id 只保留第一个） -------------
  /** @type {Map<string, { id: string, title: string, svg: string, sectionTitle: string }>} */
  const figureIndex = new Map()
  for (const section of sections) {
    for (const figure of section.figures) {
      if (figureIndex.has(figure.id)) {
        warn(`图 id「${figure.id}」重复出现，仅使用第一个定义`)
        continue
      }
      figureIndex.set(figure.id, figure)
    }
  }

  const numbering = createNumbering()
  /** @type {Set<string>} */
  const usedFigures = new Set()

  /** 文档渲染上下文。 */
  const ctx = {
    meta,
    page,
    fonts,
    cover,
    header,
    footer,
    toc,
    facts,
    sections,
    contentWidth,
    figureMaxWidthPt: Math.min(contentWidth / 20, 440),
    figureSerial: 0,
    figureNumber: 1,
    numbering,
    usedFigures,
    warn,
    /**
     * 按 id 插入图；找不到时插入醒目的占位段落而不是抛错。
     * @param {string} rawId 图 id。
     * @returns {string} 图 XML。
     */
    renderFigure: (rawId) => {
      const id = cleanToken(rawId, 80)
      const entry = figureIndex.get(id)
      if (!entry) {
        warn(`正文引用了不存在的图 id「${id}」，已插入占位段落`)
        return (
          '<w:p><w:pPr><w:pStyle w:val="Caption"/><w:jc w:val="center"/></w:pPr>' +
          '<w:r><w:rPr><w:color w:val="C00000"/><w:b/></w:rPr>' +
          `<w:t xml:space="preserve">［缺少图：${xmlEscape(id || '未命名')}］</w:t></w:r></w:p>`
        )
      }
      if (usedFigures.has(id)) {
        warn(`图「${entry.title || id}」被重复引用，已按引用次数重复嵌入`)
      }
      usedFigures.add(id)
      return renderFigureXml(ctx, entry)
    },
  }

  // ---- 正文装配 -------------------------------------------------------
  const bodyParts = []
  const hasFrontMatter = cover.enabled || toc.enabled

  if (cover.enabled) bodyParts.push(renderCoverXml(ctx))
  if (toc.enabled) {
    if (cover.enabled) bodyParts.push(pageBreakXml())
    bodyParts.push(renderTocXml(ctx))
  }

  const bodyXmlParts = []
  if (facts.length > 0) bodyXmlParts.push(renderFactsXml(ctx))
  const sectionsResult = renderSectionsXml(ctx)
  if (sectionsResult.xml) bodyXmlParts.push(sectionsResult.xml)

  if (bodyXmlParts.length === 0) {
    bodyXmlParts.push(
      '<w:p><w:pPr><w:pStyle w:val="BodyText"/></w:pPr>' +
        '<w:r><w:t xml:space="preserve">（文档暂无正文内容）</w:t></w:r></w:p>',
    )
  }
  if (sections.length === 0) warn('未提供任何章节，已生成仅含封面/目录的文档')

  // 前置部分（封面 + 目录）单独成节，正文页码从 1 开始。
  const frontSectParagraph = hasFrontMatter
    ? '<w:p><w:pPr>' + sectPrXml(ctx, { variant: 'front' }) + '</w:pPr></w:p>'
    : ''

  const bodyWithoutFinalSect = bodyParts.join('') + frontSectParagraph + bodyXmlParts.join('')

  // ---- 关系 id 分配（footer 恒存在；header/numbering 按需） -----------
  const footerRelId = 'rId3'
  let nextRelId = 4
  let headerRelId = null
  if (header.text) {
    headerRelId = `rId${nextRelId}`
    nextRelId += 1
  }
  let numberingRelId = null
  if (numbering.used) {
    numberingRelId = `rId${nextRelId}`
    nextRelId += 1
  }

  const finalSect = sectPrXml(ctx, {
    variant: 'body',
    footerRelId,
    headerRelId,
  })

  const documentXml =
    XML_DECL +
    `<w:document ${documentRootAttributes()}>` +
    '<w:body>' +
    bodyWithoutFinalSect +
    finalSect +
    '</w:body></w:document>'

  // ---- 其余部件 -------------------------------------------------------
  const stylesXml = buildStylesXml({
    fonts,
    contentWidth,
    headingSpec: HEADING_SPEC,
  })
  const settingsXml = buildSettingsXml({ tocEnabled: toc.enabled })
  const footerXml = buildFooterXml({
    text: footer.text,
    pageNumber: footer.pageNumber,
    fonts,
  })
  const headerXml = header.text ? buildHeaderXml({ text: header.text }) : null
  const numberingXml = numbering.used ? numbering.xml() : null

  const relsXml = buildDocumentRelsXml({
    styles: 'rId1',
    settings: 'rId2',
    footer: footerRelId,
    header: headerRelId,
    numbering: numberingRelId,
  })
  const contentTypesXml = buildContentTypesXml({
    hasHeader: Boolean(headerXml),
    hasNumbering: Boolean(numberingXml),
  })

  /** @type {Array<[string, string]>} */
  const parts = [
    ['[Content_Types].xml', contentTypesXml],
    ['_rels/.rels', buildRootRelsXml()],
    ['word/document.xml', documentXml],
    ['word/styles.xml', stylesXml],
    ['word/settings.xml', settingsXml],
    ['word/footer1.xml', footerXml],
    ['word/_rels/document.xml.rels', relsXml],
  ]
  if (headerXml) parts.push(['word/header1.xml', headerXml])
  if (numberingXml) parts.push(['word/numbering.xml', numberingXml])

  // ---- 打包 -----------------------------------------------------------
  const when = opts.modifiedAt ? new Date(opts.modifiedAt) : new Date()
  const zip = buildZip(
    parts.map(([name, content]) => ({
      name,
      data: Buffer.from(content, 'utf8'),
    })),
    Number.isNaN(when.getTime()) ? new Date() : when,
  )
  const buffer = new Uint8Array(zip.length)
  buffer.set(zip)

  return { buffer, warnings, bytes: buffer.length }
}




