# dsh-plugin-bidkit

[![tests](https://github.com/Jegozhou/dsh-plugin-bidkit/actions/workflows/test.yml/badge.svg)](https://github.com/Jegozhou/dsh-plugin-bidkit/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

面向招投标全流程的原生 DeepSeek Harness 插件（MIT）。它把"读招标文件 → 生成高分目录 → 写超长正文 → 合规体检 → 导出排版级 Word"做成一整条可在会话里恢复的流水线，并把这套流水线的状态实时呈现为 Harness 里的**标书工作台**。

> Clean-room 实现：不引入独立 Agent 运行时、不引入外部数据库或任务队列、不桥接外部进程。全部能力由 DSH 原生的 Cordis 服务体系承载：`ctx.tools` 注册工具、`ctx.effect` 管理生命周期、`ctx.inject(['webServer'])` 提供工作台只读/操作接口、`ctx.providers` 暴露可组合服务；打开/关闭插件即挂载/卸载全部注册，无残留。

## 能力

| 能力 | 实现 |
| --- | --- |
| 招标文件 18 项深度结构化解析 | `lib/parse.js`：编号/标题分节、★实质性条款识别与分类、评分表抽取（技术/商务/价格，价格公式缺表时按正文补齐）、标段与阶段、18 项逐项定位并给出原文证据与覆盖率 |
| 多标段 / 多阶段 | 解析结果保留 `lots[]` 与阶段判定；目录与评分按标段复用 |
| 企业知识库素材复用 | `lib/kb.js`：目录索引 → 分块 → 中文 bigram + BM25 检索，返回文件、标题与原文块，写章节前先查资料，杜绝编造资质与业绩 |
| 按评分标准生成高分目录 | `lib/outline.js`：每个评分细则映射为一个二级章节，★条款挂到必须响应它的章节，字数按分值权重分配，输出 rationale |
| 无字数上限正文 | `bid_section_write` 一节一文件、支持 `append` 续写；`bid_handoff_plan` 把未完成章节切成子智能体批次（PTC/subagent），每批带全局事实与写作策略 |
| 全局事实锁定 | `bid_facts_lock` 锁定企业名称/资质编号/业绩金额/工期/质保；每次写入回报 used/missing，体检规则检测与锁定值矛盾的表述 |
| 配图（Mermaid / 图元 / SVG） | `lib/figure.js`：Mermaid 子集与 flow/architecture 规格 → 图元模型 → SVG（工作台）与 Word 原生矢量形状（导出），中文标签始终是文字 |
| 全量合规审查 | `lib/review.js`：★条款未响应、必备项缺失、占位符、事实冲突、未写/过短章节、否定性承诺、错别字与标点、自重复、配图缺失、跨标书相似度（围标/串标风险） |
| 排版级 .docx | `lib/docx.js`：纯 JS OOXML + 自写 ZIP（`node:zlib`），封面、自动目录域、中文标题/正文字体（eastAsia）、页码域、表格样式、矢量图 |
| 标书工作台 UI | `client.js`：`main` 面板整页 + 侧边栏图标，四个视图（招标解析 / 目录编排 / 章节预览 / 风险审查），只读 Host API，主题 token 与宿主一致，卸载即移除 |

## 安装

仓库地址：<https://github.com/Jegozhou/dsh-plugin-bidkit>（MIT）

```bash
git clone https://github.com/Jegozhou/dsh-plugin-bidkit.git ~/dsh-plugin-bidkit
```

然后在 DSH 会话里把**克隆下来的目录**交给插件管理器（Desktop 的插件页或 `plugin_manager` 工具）：

```text
plugin_manager  install_bundle  target: ~/dsh-plugin-bidkit
```

安装后侧边栏出现「标书工作台」。工作台数据来自同源只读接口 `/dsh-plugin-bidkit/api/*`。
本包零运行时依赖，不需要 `npm install`；`test/` 只依赖 Node 内置 `node:test`。

配置（`cordis.patch.yml` 行，用户覆盖补丁层时需重述完整 config）：

```yaml
- id: dsh-plugin-bidkit
  name: 'dsh-plugin-bidkit'
  config:
    dataDir: ''            # 默认 <DSH_HOME>/bidkit/projects
    kbDir: ''              # 可选：默认企业素材目录
    allowWrite: true       # false 时所有写工具只读报错
    defaultTargetWords: 0  # 0 表示按评分权重推导全文目标
```

## 一次典型的闭环（工具名）

```
bid_project_create(name, tender_path)
  → bid_parse_tender / bid_commit_parse     # 18 项 + ★ + 评分
  → bid_kb_index / bid_kb_search            # 真实企业素材
  → bid_facts_lock                          # 全局事实锚定
  → bid_outline_plan                        # 评分对齐目录
  → bid_section_write × N（或 bid_handoff_plan + 子智能体）
  → bid_figure_add                          # 架构图/流程图
  → bid_review                              # 废标项/一致性/错别字/查重
  → bid_export_docx                         # 排版级 Word
```

## 状态与可恢复性

一个项目就是一个目录：`project.json`（索引：解析、目录、事实、体检、导出）、`sections/<id>.md`（正文，一节一文件）、`figures/*.svg`、`exports/*.docx`、`tender/source.md`。所有写操作为「临时文件 + rename」原子写；任何一步中断后，下一次 `bid_project_status` / `bid_section_read` 都能从磁盘继续。插件本身不持有跨会话内存状态。

## 测试

```bash
node --test test/runtime.test.js test/api.test.js test/docx.test.js
# 16/16：宿主侧闭环、工作台 HTTP 契约、OOXML 结构与 CRC
```

实机验收证据（安装与注册、17 个工具、真实 18 项解析、50 节正文与 3 张图的完整闭环、审查结果、
导出物结构断言、QuickLook 视觉截图、无残留卸载、跨标书查重）见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。

## License

MIT，见 [LICENSE](LICENSE)。
