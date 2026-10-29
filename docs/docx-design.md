# BidKit Word 导出器设计说明（`lib/docx.js`）

本文记录 `lib/docx.js` 的实现决策、对 `docs/CONTRACT.md` §3 的落实方式，以及
验证到什么程度、还有哪些已知限制。文中命令都可直接复现。

## 1. 职责边界

```js
export async function buildDocx(model, options = {})
  // → Promise<{ buffer: Uint8Array, warnings: string[], bytes: number }>
```

- 纯 ESM，**零运行时依赖**：只用 `node:zlib`（`deflateRawSync`）与 `node:buffer`。
- 只做“模型 → `.docx` 字节”，不读文件、不写文件、不联网；图以 `{ id, title, svg }`
  随模型传入（Host 从 `<dataDir>/<project>/figures/*.svg` 读出后注入）。
- 所有字段可缺省，缺省/类型错误/超范围一律**降级 + 记 warning**，不抛异常；
  `warnings` 去重、限 200 条、单条 ≤500 字符。
- `options.modifiedAt` 可固定 ZIP 时间戳，便于测试逐字节复现。

## 2. ZIP 容器（自己写，不用第三方库）

`buildZip()` 依次写：本地文件头（`0x04034b50`）→ 压缩数据 → 中央目录
（`0x02014b50`）→ EOCD（`0x06054b50`）。

- CRC32 用预计算的 256 项查找表（多项式 `0xEDB88320`）。
- 每个条目先 `deflateRawSync(level: 9)`；若压缩后不比原文小（小 XML 常见），
  自动回落为 store（method 0），避免“负压缩”的怪异字节。
- 文件名 UTF-8 标志位（bit 11）置位；本地头与中央目录的 CRC/长度/时间完全一致。
- DOS 日期夹在 1980–2107，避免非法时间戳让 Word 报“文件已损坏”。

## 3. 包结构

| 部件 | 内容类型 | 说明 |
| --- | --- | --- |
| `[Content_Types].xml` | `application/xml`（默认）+ 逐部件 Override | `rels`/`xml` 两个 Default |
| `_rels/.rels` | `…package.relationships+xml` | 指向 `word/document.xml` |
| `word/document.xml` | `…wordprocessingml.document.main+xml` | 正文 + 最后 sectPr |
| `word/styles.xml` | `…wordprocessingml.styles+xml` | docDefaults + 全部样式 |
| `word/settings.xml` | `…wordprocessingml.settings+xml` | `w:updateFields` |
| `word/footer1.xml` | `…wordprocessingml.footer+xml` | `PAGE` / `NUMPAGES` 域 |
| `word/_rels/document.xml.rels` | `…relationships+xml` | styles / settings / footer /（header）/（numbering） |
| `word/header1.xml` | `…wordprocessingml.header+xml` | 仅当 `header.text` 非空 |
| `word/numbering.xml` | `…wordprocessingml.numbering+xml` | 仅当出现列表 |

`word/media/*` 不会出现——图不是位图，而是 VML 矢量对象（见 §6）。

## 4. 中文标书版式

`docDefaults` + `Normal` 定义全局基线：`w:rFonts` 同时写
`ascii`/`hAnsi`/`eastAsia`/`cs`（默认宋体 + Times New Roman），`w:sz=21`（五号
10.5pt），`w:spacing w:line="360" w:lineRule="auto"`（1.5 倍行距），
`w:ind w:firstLineChars="200"` 并附 `w:firstLine="420"` 兜底（不认 chars 单位的
老版本 Word 也能缩进 2 字符）。

- 标题 1–4：黑体、22/16/14/12pt，`w:keepNext`，字号递减，段前段后成比例，
  并且样式与段落上都写 `w:outlineLvl`（0..3）——这是自动目录能收集条目、
  导航窗格能显示层级的根本。
- 正文样式 `BodyText` 两端对齐；封面/图题/表格/列表等样式都显式把
  `firstLineChars` 归零，避免继承正文缩进。
- 页眉页脚：`HeaderText` / `FooterText` 9pt，页脚下边距 992 twips。
- 两个 `w:sectPr`：前置节（封面+目录，`nextPage`，无页眉页脚引用）与正文节
  （页脚 + `w:pgNumType w:start="1"`），因此封面/目录不显示页码，正文从第 1 页
  开始计数。
- 文档默认 A4（11906×16838 twips）、上下 2.54cm、左右 3.17cm，全部可被
  `model.page` 覆盖并被钳制在合理区间。

## 5. 目录与字段

目录用简单域：

```xml
<w:fldSimple w:instr=" TOC \o &quot;1-3&quot; \h \z \u ">
  <w:r>…占位提示文字…</w:r>
</w:fldSimple>
```

`maxLevel` 默认 3（可 1–4，直接写进 `\o "1-N"`）。`settings.xml` 里写
`<w:updateFields w:val="true"/>`，Word 打开文档时会刷新 TOC/PAGE/NUMPAGES 域。
`TOC1..TOC4` 样式带“右对齐 + 点线前导符”的制表位（位置 = 正文宽度），
所以更新后的目录页码能对齐。

页脚是 `第 { PAGE } 页　共 { NUMPAGES } 页`，`footer.pageNumber === false` 时
只留 `footer.text`，仍会生成 `footer1.xml`（契约要求的固定部件）。

## 6. 图：SVG → VML 原生绘图（不位图化）

**为什么选 VML**：`w:pict` 是 WordprocessingML 的一部分，图元是编辑期对象；
文字放在 `v:textbox` → `w:txbxContent` → `w:p` → `w:r` 里，用的是
`w:rFonts/@w:eastAsia` 指定的中文字体，可缩放、可打印、可编辑，完全满足
“中文标签用系统字体、不做位图化”。

渲染结构：

```xml
<w:p><w:pPr><w:pStyle w:val="FigureParagraph"/></w:pPr><w:r><w:pict>
  <v:group style="width:…pt;height:…pt" coordsize="21600,9000" coordorigin="0,0">
    <v:rect style="position:absolute;left:…;top:…;width:…;height:…" arcsize="…%"
            fillcolor="#D9E2F3" strokecolor="#3B5A9A" strokeweight="1pt"><v:stroke/></v:rect>
    <v:line from="x1,y1" to="x2,y2" style="position:absolute"><v:stroke endarrow="block"/></v:line>
    <v:rect style="…;v-text-anchor:middle" filled="f" stroked="f">
      <v:textbox inset="0,0,0,0"><w:txbxContent><w:p>…<w:t>数据采集层</w:t>…</w:p></w:txbxContent></v:textbox>
    </v:rect>
  </v:group>
</w:pict></w:r></w:p>
```

几何换算：

1. 取 `viewBox`（没有就用 `width`/`height`，都没有按 800×600 并告警）。
2. 图宽 = `min(正文宽度, 440pt)`；按 viewBox 宽高比算高，高 > 560pt 时等比压缩。
3. 把设计坐标压到 21600 的整数坐标系（`coordsize`），`v:group` 的 `style` 用 pt
   给出物理尺寸——这正是 Word 自己输出组合图形的方式，缩放不影响清晰度。
4. 描边宽度按 `设计单位 × (图宽pt / viewBox宽)` 折算成 pt，并夹在 0.25–4pt。

支持的 SVG 子集（Host 生成图时应尽量落在这个子集里）：

| SVG | 映射 |
| --- | --- |
| `<rect>`（含 `rx/ry`） | `v:rect`（原 `rx/ry` 圆角折算成 `arcsize`；**不用 `v:roundrect`**，见 §8） |
| `<circle>` / `<ellipse>` | `v:oval` |
| `<line>` | `v:line`；`marker-end` → `endarrow="block"` |
| `<polyline>` / `<polygon>` | 逐段 `v:line` |
| `<path>`（`M L H V C Q S T Z`） | 曲线采样为折线逐段 `v:line`；轴对齐闭合矩形识别为 `v:rect`（保留填充） |
| `<text>` / `<tspan>` | `v:textbox` + `w:txbxContent`（真文字，可编辑） |
| `<g transform>`、元素 `transform` | translate / scale / rotate / matrix 合成矩阵后变换坐标 |
| `<defs>`、渐变、`<marker>`、`<clipPath>`、`<style>` | 跳过（不渲染定义） |

颜色支持 `#rgb` / `#rrggbb` / `#rrggbbaa` / `rgb()` / 常见颜色名；`none` 视为无填充/无描边。
文字按 `font-size × 缩放` 折算 pt（夹 4.5–18pt），`w:sz` 写 half-points；
字号、粗体、颜色、`text-anchor`（start/middle/end）都会带进 `w:rPr`/`w:jc`；
文本框宽用“中文 1 em、西文约 0.55 em”的宽度估算，按锚点反推 left，垂直居中
靠 `v-text-anchor:middle`。

与 Host 的 `lib/figure.js` 联调：该模块 `renderSvg()` 只输出
`rect`（含 `rx`）、`text`、`path`（`M/L` 折线，`fill="none"` + `marker-end`）
以及 `defs/marker`，全部落在上面的子集内；端到端用
`createFigure({kind:'flow'|'architecture'})` 生成的 SVG 交给 `buildDocx()`
构建，`warnings` 为空，图元/连线/中文标签/箭头全部进入 VML。

降级策略（都会进 `warnings`，不会抛错）：

- token 指向不存在的图 id → 插入红色 `［缺少图：id］` 占位段落；
- 图有 `title` 但 SVG 解析不出任何图元 → 单个圆角“标题占位框”，图题后缀“（占位）”；
- SVG 含 `<image>`/`<use>`/`<foreignObject>`、路径填充、多边形填充、圆弧 →
  对应元素丢弃或描边化，并说明降级原因；
- 章节里定义了图但正文没有 `[[figure:]]` 引用 → 自动追加到该章节末尾并告警；
- 同 id 图重复定义 → 只用第一个；同一 id 被多次引用 → 重复嵌入并告警。

图题：`图 N　<标题>`，`Caption` 样式居中，编号按文档顺序自增。

## 7. Markdown 子集

行级：ATX 标题（`#`…`####`，>4 级降到 4 并告警）、段落、有序/无序列表
（缩进 2 空格一级，最多 3 级）、引用块、围栏代码块、管道表格（表头 + 分隔行
的对齐 `:---` / `:---:` / `---:`）、水平分隔线、独占一行或行内的
`[[figure:<id>]]`。

行内：`**粗体**`、`*斜体*`、`***粗斜体***`、`` `代码` ``、`[文字](链接)`
（只保留文字）。`\*` 等转义通过占位符还原。

列表写进 `word/numbering.xml`：两个 `abstractNum`（bullet / decimal，各 9 级），
**每个有序列表块单独分配一个 `numId` 并带 `startOverride=1`**，所以“中间隔一段
正文再开新列表”会从 1 重新编号，而不是接着上一组。

表格是真实 `w:tbl`：`tblGrid` 固定列宽（正文宽度均分，facts 表按 28/72 分）、
表头 `w:shd w:fill="D9E2F3"` + `tblHeader`（跨页重复表头）、`cantSplit`、
边框 `8EA9DB`、单元格 `vAlign=center`，对齐方式取自分隔行，中文正常换行。
表格后补一个 `TableGap` 空段落，避免表格贴住后文。

## 8. 已知限制

1. **VML 渲染的验证程度**：结构层面已用 `xmllint` 全部部件通过、用
   `python-docx` 成功打开（45 段落 / 2 表格 / 2 节 / A4 210×297mm），并用
   macOS QuickLook（Apple 自带的 Word 转换器）做了像素级核对：矩形、连线、
   箭头、中文标签、图题、封面、表格、页脚页码都正确显示。
   **但没有在 Microsoft Word 里实际打开过**（本机无 Word/LibreOffice）。
   这里有一个已实测并已规避的第三方转换器差异：Apple QuickLook 会把
   `v:group` 里的 `v:roundrect` 画在“left + 宽度/2”的位置（同一文件里的
   `v:rect`、`v:line`、文本框位置全部正确）。因此导出器**统一改用 `v:rect`**：
   原 SVG 的 `rx/ry` 仍折算成 `arcsize` 保留（Word 会按圆角矩形渲染；忽略该
   属性的转换器只画方角，位置永远正确）。改后实测 QuickLook 中三个框的横向
   边界为 172..341 / 412..581 / 651..821 px，与按 4.75 px/mm 换算出的期望值
   一致（偏差 ≤1px），连线、箭头、中文标签随框对齐。Word 对 `v:rect` 与
   `v:roundrect` 均原生支持，所以这是双向安全的最小改法。
2. SVG 的渐变、图案、滤镜、遮罩、裁剪、位图、`<use>`、圆弧路径不做保真渲染，
   会降级并给出 warning；生成图时建议只用矩形/圆角矩形/直线/箭头/文字。
3. 表格不支持合并单元格（colspan/rowspan）与自动列宽；列宽按正文宽度均分。
4. 不做自动多级编号（“1.1”“1.2.3”这类章节号需要写在标题文字里），因为
   中文标书的编号体系经常与标题层级不一致，交给模型显式书写更可控。
5. TOC 与页码是域，需要 Word 打开时更新（`w:updateFields` 已置 true，
   Word 会提示或自动刷新）；不更新时目录位置显示占位提示。
6. 代码块是单段落 + `<w:br/>` 换行，超长代码整块下移，不会在块内分页。
7. 图题编号是全文顺序、不按章编号；“图 1-2”式编号需要模型在 `figure.title`
   里自带章号（当前实现会再加一层全局序号）。

## 9. 测试与验证

`test/docx.test.js` 自己实现了最小 ZIP 读取器（EOCD → 中央目录 → 本地头）、
独立 CRC32、极简 XML 良构性检查（去命名空间前缀后配平标签、检查裸 `&`、
属性引号、单一根元素），并对 `[Content_Types].xml`、`.rels` 目标、`r:id` 引用
做交叉校验。`test/out/` 会生成 `minimal.docx` 与 `full.docx` 两个样本。

```bash
node --check lib/docx.js
node --test test/docx.test.js
python3 -c "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(z.testzip()); print(len(z.namelist()))" test/out/full.docx
xmllint --noout <解压后的每个 xml/rels>
python3 -c "from docx import Document; d=Document('test/out/full.docx'); print(len(d.paragraphs), len(d.tables), len(d.sections))"

# 独立解析证据：段落/表格/节/页面尺寸 + 原生绘图断言
python3 - <<'PY'
import zipfile
from docx import Document
d = Document('test/out/full.docx')
xml = zipfile.ZipFile('test/out/full.docx').read('word/document.xml').decode('utf-8')
print('paragraphs:', len(d.paragraphs), 'tables:', len(d.tables), 'sections:', len(d.sections))
print('page (mm):', round(d.sections[-1].page_width.mm, 1), 'x', round(d.sections[-1].page_height.mm, 1))
print('v:group:', xml.count('<v:group '), 'v:rect:', xml.count('<v:rect '),
      'v:roundrect:', xml.count('<v:roundrect'))
assert xml.count('<v:group ') >= 1
assert xml.count('<v:roundrect') == 0
assert 'a:blip' not in xml          # 图不是位图
assert '数据采集层' in xml          # 图内中文标签是真文字
PY

# macOS QuickLook 视觉核对（渲染第 1 页缩略图）
qlmanage -t -s 1400 -o /tmp/ql test/out/full.docx
```

当前实测结果（2026-10-29，A4 / 宋体 10.5pt / `modifiedAt` 固定）：

| 检查 | 结果 |
| --- | --- |
| `node --test test/docx.test.js` | 8 pass / 0 fail |
| `zipfile.testzip()` | `None`（无坏 CRC），`full.docx` 9 个部件 |
| `xmllint --noout` 全部 xml/rels | 9/9 通过 |
| `python-docx` | 45 段落 / 2 表格 / 2 节 / 210.0×297.0mm，Heading 1–4 齐全 |
| `document.xml` 原生绘图 | `v:group`=1、`v:rect`=7、`v:roundrect`=0、`a:blip`=false |
| QuickLook 几何 | 图框横向 172..341 / 412..581 / 651..821 px，与期望值一致（≤1px） |
| 样本体积 | `minimal.docx` 4762 B / `full.docx` 7968 B |
