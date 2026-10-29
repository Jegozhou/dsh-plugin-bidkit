# BidKit 实机验收证据

本文件记录 `dsh-plugin-bidkit` 在**当前 DSH 桌面实例**（profile `desktop`，插件行 `include:dsh-plugin-bidkit`）上的真实运行证据。所有命令输出均为实跑结果，不是设计意图。

日期：2026-10-29 · 宿主：DeepSeek Harness Desktop，Web `http://127.0.0.1:64877`

## 1. 安装与注册

| 项目 | 证据 |
| --- | --- |
| 安装 | `plugin_manager install_bundle(target=/Volumes/ZHITAI/标书/dsh-plugin-bidkit)` → `"application":"applied", "enabled":true, "warnings":[]` |
| 插件行 | `list_plugins` → `include:dsh-plugin-bidkit`，`moduleName: dsh-plugin-bidkit`，`fiberPhase: active` |
| Host 工具 | `cordis_inspect_query(host, Tool, listTools)` 中出现 17 个 `bid_*` 工具（见 §2） |
| Host 服务 | `provider: bidkit`（`BidRuntime`）注册为 Cordis 服务，供其他 Host 插件读取 |
| 工作台路由 | `/dsh-plugin-bidkit/api/*` 由 `ctx.inject(['webServer'])` 注册；未携带宿主会话凭据的请求被 `connection` 服务拒绝（`{"error":{"code":"rejected"}}`），证明路由受宿主统一鉴权保护而非自带鉴权 |
| 数据根 | `~/.dsh/bidkit/projects/` 由插件激活时创建 |

17 个工具：

```
bid_project_create  bid_project_list    bid_project_status  bid_import_tender
bid_parse_tender    bid_commit_parse    bid_facts_lock      bid_outline_plan
bid_outline_set     bid_section_write   bid_section_read   bid_figure_add
bid_kb_index        bid_kb_search       bid_review         bid_export_docx
bid_handoff_plan
```

## 2. 实机闭环（同一项目、真实工具调用）

项目：`p-092ade4b-fawc`「云枢市智慧政务云平台（二期）建设项目」
输入：`fixtures/mock-tender.md`（含 19 条 ★ 废标项、技术/商务/价格评分表、采购清单、两标段、两阶段评审的模拟招标文件）

| 步骤 | 工具 | 实测结果 |
| --- | --- | --- |
| 建项并导入招标文件 | `bid_project_create` | `chars:5497, sections:54, coverage 15/18, starClauses:19, scoring {t:6,c:4,p:1}` |
| 企业知识库 | `bid_kb_index` | 索引 `/Volumes/ZHITAI/标书/企业素材` → `files:1, chunks:12` |
| 素材检索 | `bid_kb_search("CS 四级 资质证书编号 政务云 业绩 合同金额")` | 命中 `CS4-2024-0088`、一期合同 1680 万元、运维合同 1260 万元、项目经理证书编号 |
| 全局事实锁定 | `bid_facts_lock` | 6 条：投标人名称/统一社会信用代码/CS 编号/承诺工期 90 个日历日/质保期 3 年/投标报价 25,860,000.00 元 |
| 评分对齐目录 | `bid_outline_plan(total_words=120000)` | 12 章 / 49 个叶子节 / 目标 90,000 字；★条款逐条生成「★响应」小节；评分项只挂到唯一消费它的章节（技术 6 项→技术方案，商务 4 项→商务响应，价格 1 项→报价文件） |
| 正文撰写 | `bid_section_write` × 50 | 50 节 / 12,971 字；每次返回 `anchoring.used/missing`（事实锚定）；`mode=append` 也验证过 |
| 配图 | `bid_figure_add` × 3 | 图 6-1 总体架构（architecture，736×344）、图 6-3 数据流转（mermaid，1084×768）、图 7-1 实施流程（flow，344×524）；返回 `[[figure:...]]` token 并写入 SVG 资产 |
| 合规体检 | `bid_review` | **blocker 0 / major 51 / minor 0**；major 全部是「篇幅不足目标 60%」与「全文不足 50%」（演示稿有意写短），无废标项、无占位符、无事实冲突、无否定承诺、无自重复 |
| 导出 Word | `bid_export_docx` | `34090 bytes, sections:61, words:12971, warnings:[]`；同时落盘到工作区 `云枢市智慧政务云平台（二期）投标文件.docx` |

生成文件路径：`~/.dsh/bidkit/projects/p-092ade4b-fawc/exports/云枢市智慧政务云平台（二期）建设项目-投标文件-20261029-1745.docx`，副本 `/Volumes/ZHITAI/标书/云枢市智慧政务云平台（二期）投标文件.docx`。

## 3. 导出物验证（独立工具，非本插件代码）

| 断言 | 工具 | 结果 |
| --- | --- | --- |
| ZIP 完整性（CRC） | `python3 zipfile.testzip()` | `None`（无坏块） |
| 部件清单 | `zipfile.namelist()` | 9 个：`[Content_Types].xml`、`_rels/.rels`、`word/document.xml`、`styles.xml`、`settings.xml`、`footer1.xml`、`_rels/document.xml.rels`、`header1.xml`、`numbering.xml` |
| XML 良构 | `xml.etree.ElementTree.fromstring` | document/styles/settings 全部解析通过 |
| 中文字体 | 结构断言 | `w:eastAsia` 存在，styles 内含「宋体」「黑体」 |
| 自动目录 | 结构断言 | `TOC \o "1-3" \h \z \u` 域存在，`w:updateFields` 为 true |
| 标题层级 | 计数 | `w:outlineLvl` × 234 |
| 表格 | 计数 | `<w:tbl>` × 36 |
| 图形 | 计数 | `<v:group>` × 3、`<v:rect>` × 60、`<v:roundrect>` **0**（规避 Apple 转换器偏移）；图内中文标签（总体技术架构/数据中台/统一身份认证/应用层/实施流程）均以 `w:t` 文字存在，未位图化（`a:blip` = 0） |
| 页码 | footer1.xml | `PAGE` 域存在，正文节 `w:pgNumType start=1` |
| 独立 Word 解析器 | macOS `textutil -convert txt` | 成功提取封面、目录、项目基本信息表、章节正文、公司名称、金额 25,860,000.00 |
| 视觉（封面） | macOS QuickLook | 封面、目录域、项目基本信息表、章节标题、页脚页码正常，见 [`docs/evidence/cover-quicklook.png`](evidence/cover-quicklook.png) |
| 视觉（图元） | macOS QuickLook | 三层架构图：层名在左侧留白槽内不被遮挡、框/箭头/中文标签对齐、图题不重复编号；流程图同页正常，见 [`docs/evidence/figure-page-quicklook.png`](evidence/figure-page-quicklook.png) |

## 4. 工作台（Client 半）

| 断言 | 证据 |
| --- | --- |
| 模块格式 | `node --check client.js` 通过；`window.__ModuleLoader__.load({id:'dsh-plugin-bidkit', factory})` |
| 插槽注册 | 冒烟测试 39/39：`main`（key `dsh-plugin-bidkit`）+ `sidebar.panellist`（id、order 26、label「标书工作台」、currentColor SVG 图标）；`ctx.slots.inject` 恰为 `main,sidebar.pannellist`；locale 与 `<style>` 两个 effect 可释放 |
| 四个视图 + 数据流 | jsdom + 真实 React 19 渲染测试 72/72：中文/英文、四个 Tab、证据展开、目录→章节请求、Markdown 子集、图 `<img>`、风险面板、`重新体检` POST、路由缺失/畸形载荷降级、错误边界（注入渲染异常后边界接管并可恢复） |
| 真实数据渲染 | 用**线上项目的真实 API 载荷**（由 `lib/api.js` 路由生成）驱动 `client.js`：16/16 通过 —— 渲染出真实项目名、18 项覆盖 15/18、★ 条款原文、锁定事实（CS4-2024-0088 等）、目录首章、章节正文「一云多芯」、审阅摘要，图 URL 指向 `/dsh-plugin-bidkit/api/projects/<id>/figures/<fid>.svg` |
| 主题与卸载 | 只用 `--dsw-alias-*` token；无 `document.body` 写操作；样式/监听器均在 effect 中并返回 disposer |

**一项无法在本会话完成的验证**：Lead 没有浏览器面板（`read_browser` 返回 "Only Bots on the team have a browser"），且 Web 入口要求桌面会话 cookie，`curl` 被宿主 `connection` 服务 401 拒绝。因此「工作台在真实页面中的像素级外观/暗色主题取值」只验证到 DOM 结构层（真实 React + jsdom + 真实载荷），未做真人截图。侧边栏图标与页面入口的注册关系已由插槽注册断言证明。

## 5. 自动化测试

```bash
node --test test/runtime.test.js test/api.test.js test/docx.test.js
# tests 16 / pass 16 / fail 0
#   runtime 6/6  解析→目录→写作→配图→审查→知识库→导出
#   api     2/2  工作台 HTTP 契约、拒绝策略
#   docx    8/8  ZIP/CRC/XML/TOC/表格/图/退化输入
```

另有两份仅在开发期使用的渲染校验脚本（未随包发布）：`/tmp/bidkit-smoke.cjs`（39/39）、`/tmp/bidkit-render.cjs`（72/72）、`/tmp/bidkit-live-render.cjs`（16/16）。

## 5.1 无残留卸载（实机）

插件行 `include:dsh-plugin-bidkit` 关闭后立即实测：

| 断言 | 结果 |
| --- | --- |
| 工具消失 | `Tool.listTools` 中 `bid_*` 数量 = **0** |
| 路由消失 | `GET /dsh-plugin-bidkit/api/health` → **404**（此前为 401 `rejected`，说明路由确实已卸载而非仅鉴权） |
| 数据保留 | 项目目录与文件不动（状态在磁盘，不在插件内存） |
| 重新启用 | `set_plugin enabled=true` → 工具与路由全部恢复，项目可继续 |

## 5.2 跨标书查重（围标/串标）实机

临时复制同一份内容为对照项目 `对比样例（查重演示）`，执行 `bid_review(project=主项目, compare_with=对照项目)`：

```
message: 与另一份标书「对比样例（查重演示）」相似度 100.0%，存在围标/串标雷同风险
evidence: 共享 3613 个文段指纹（8 字窗口），Jaccard=1.000
severity: blocker
```

对照项目随后已删除，主项目重跑无对比体检恢复 `blocker 0`。

## 6. 已知限制（诚实清单）

1. 未在真实 Microsoft Word 中打开：本机无 Word/LibreOffice。已用 OOXML 结构断言 + python-docx/zipfile + macOS QuickLook（Apple Word 转换器）替代；VML 图形在 Word 中的最终呈现未肉眼确认。
2. QuickLook 对 `v:group` 内 `v:roundrect` 存在偏移（Apple 转换器缺陷），已按此改为 `v:rect` 以兼容两条渲染路径。
3. TOC/页码是 Word 域，需在 Word 中「更新域」后显示实际目录条目（`w:updateFields` 已置 true，Word 打开时会提示更新）。
4. PDF 招标文件不内置解析（无 PDF 文本抽取运行时），需先转 `.docx/.md`；`.docx` 已支持（自写 ZIP + document.xml 文本抽取）。
5. 演示稿为压缩篇幅（12,971 字 / 目标 90,000 字），因此体检有 51 条 major「篇幅不足」；这不是缺陷，而是体检规则在本用例上的正确输出。
6. 百万字级并发写作走 `bid_handoff_plan` + Harness 子智能体；本次为保证可复现由主智能体串行写满 50 节，未在本轮触发子智能体批次。
