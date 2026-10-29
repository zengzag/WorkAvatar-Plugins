# 参考实现

本文件是可选的工程实现，不是美学规则。美学标准以 [`aesthetic-system.md`](aesthetic-system.md) 与 [`composition-grammar.md`](composition-grammar.md) 为准；实现可以替换，约束不可放宽。阶段顺序与放行条件见 [`pipeline.md`](pipeline.md)，本文件只描述 `deck.json` 与命令。

`deck.json` 只是把“构图选择 + 文本/图像槽位”序列化，便于把同一份内容渲染为可编辑 PPTX。字段描述的是视觉槽位，不规定该写什么内容。

## 快速开始

```bash
python scripts/render_deck.py deck.json -o out
python scripts/render_deck.py deck.json -o out --audit
```

依赖：Python 3.9+、`python-pptx`、`Pillow`。

输出：

- `out/<outputName>.pptx`：文字、表格、图片、色块均为原生可编辑对象；
- `--audit`：在渲染后输出每页的模块数、强调数、图片数与阈值检查。

`--strict` 与 `--audit` 同用时，审计不通过返回非零退出码。

## 最小结构

```json
{
  "meta": {
    "titleLines": ["示例主标题", "示例副标题"],
    "reporter": "示例：汇报人",
    "fontProfile": "office"
  },
  "slides": [
    {"type": "cover"},
    {"type": "content", "layout": "table", "no": "1.1", "title": "示例标题",
     "table": {"cols": [{"label": "A", "w": 1}, {"label": "B", "w": 1}], "rows": [["示例", "示例"]]},
     "conclusion": "示例结论"},
    {"type": "ending"}
  ]
}
```

完整可运行样例见 [`../examples/sample-deck.json`](../examples/sample-deck.json)。样例中的姓名、单位、指标均为虚构占位，只用于演示版式，不是内容模板。

## meta

| 字段 | 说明 |
|---|---|
| `kicker` | 陈述页顶部微型标签，可空 |
| `titleLines` | 陈述页主标题，1–2 行 |
| `titleAccent` | 主标题下的强调行，可空 |
| `subtitle` | 浅色陈述页副标题 |
| `reporter` | 陈述页元信息胶囊文字 |
| `unitLines` / `units` | 深色/浅色陈述页底部元信息 |
| `coverStyle` | `dark` 或 `light` |
| `fontProfile` | `office`（宋体/微软雅黑，默认）或 `noto`（思源系） |
| `outputName` | 输出文件名 |

## 页面类型与构图映射

| `type` / `layout` | 构图语法 | 说明 |
|---|---|---|
| `cover` | 陈述场 | 深色或浅色全幅陈述 |
| `agenda` | 索引轨 | 4–6 个等高端点，当前项高亮 |
| `divider` | 陈述场 / 索引轨 | `variant` 控制深色或索引形态 |
| `ending` | 陈述场 | 与封面同族 |
| `content` + `table` | 证据场 | 表格为主证据，可带 `bottomCards` 判断卡 |
| `content` + `split` | 双场 | 左右两组对照 |
| `content` + `flow` | 序列轨 | 3–5 步 + 说明卡 |
| `content` + `roadmap` | 证据场 + 序列轨 | 目标表 + 三阶段 |
| `content` + `intro-cards` | 星座场 | 2–3 个并列模块 |
| `content` + `metrics` | 星座场 | 指标块 + 2 个模块 |
| `content` + `profile` | 焦点场 | 单一主体 + 证据表 |
| `content` + `team` | 星座场 | 3–4 个并列主体 |
| `content` + `awards` | 证据场 + 目录场 | 双栏证据 + 证书目录 |
| `content` + `results` | 星座场 | 3 个并列成果模块 |
| `content` + `images` | 目录场 | 2–4 张证据图 |
| `content` + `custom` | 任意 | `rows` + `cols` + `blocks` 自由拼装 |

布局名称只是实现便利，不是内容规定。内容形态不匹配时用 `custom`，仍须满足美学约束。

## content 公共字段

| 字段 | 说明 |
|---|---|
| `no` / `title` | 标题编号块文字（如 `1.1`）与标题（≤20 汉字） |
| `banner` | 页首结论句：通栏主蓝带，一句话判断/问题，≤55 字 |
| `intro` | 导语，1–2 条 |
| `conclusion` | 底部结论带，一句话 ≤45 字；不需要则省略 |
| `notes` | 页脚来源/备注，≤2 条（页脚同时自动生成页码） |
| `bottomCards` | 表格页下方 2–3 张判断卡 |
| `points` | 无 `bottomCards` 时的整幅说明面板 |

文本强调标记：`**红**`（目标/差距/风险/关键数字）、`!!红下划线!!`（必须记住的指标）、`[[蓝]]`（技术名/结构）、`{{金}}`（仅深色页）。语义色预算见美学系统第 2 节。

## 主要布局字段

- `table`：`cols[{label,w}]`、`rows`、`rowH`、`align`、`firstColBold`。
- `split`：`left`/`right`，各含 `title`、`bullets`、`image`，`imagePosition` 为 `top|bottom`。
- `flow`：`steps[{title,desc}]`、`cards[{title,bullets,image}]`。
- `intro-cards`：`cards[{title,bullets,image}]`。
- `roadmap`：`table`、`stages[{period,title,desc}]`。
- `metrics`：`metrics[{value,label,note,tone}]`、`cards`。
- `profile`：`profile{photo,name,title,direction,education,achievements}`。
- `team`：`members[{photo,name,role,bullets}]`、`platform`。
- `awards`：`panels[{title,bullets}]`、`certificates[{src,caption}]`。
- `results`：`columns[{title,bullets,image}]`。
- `images`：`images[{src,caption,note}]`。
- `custom`：`rows[{h|fr,gap,cols[{w,blocks}]}]`。

### custom blocks

`text`、`bullets`、`card`、`table`、`flow`、`note`、`image`、`images`、`metrics`、`tags`、`vlabel`、`bars`、`zone`、`spacer`。

- `h` 为精确高度；`fr` 为剩余空间权重。
- `card`、`vlabel`、`zone`、`image`、`images` 未写 `h`/`fr` 时默认填满单元格。
- `text`、`bullets`、`table`、`flow`、`metrics` 默认按内容高度排布。

### 区域底色 `zone`

`zone` 用一个淡色虚线容器表达逻辑分组（阶段、环境、候选范围），内部照常放 `flow`、`card`、`table` 等块：

```json
{"kind": "zone", "tone": "ice", "label": "研究阶段",
 "body": [{"kind": "flow", "h": 122, "steps": [{"title": "步骤", "desc": "说明"}]}]}
```

| 字段 | 说明 |
|---|---|
| `tone` | `ice` / `mist` / `cream` / `lavender`，默认 `ice`；色值与语义见美学系统第 2 节 |
| `label` | 可空；≤8 字，放在容器左上，不写句子 |
| `body` | 容器内块列表；内边距 12 px，标题占 20 px |

约束：同页 ≤3 区，全 deck 区域色调 ≤2 种；`zone` 只表达分组，不叠加第二层底色，不做装饰轮换。

## 图像

- `src` 支持本地路径与 http(s)；相对路径相对于 `deck.json`。
- 照片用 `cover`；截图、图表、示意图用 `contain`。
- PPTX 不支持 SVG，遇到会跳过并警告；请先转 PNG。
- 缺失图片画浅蓝占位框并给出 `[warn]`；可选人物照片缺失只画占位，不告警。

## 固定元素与版面

渲染器按美学系统第 1、4 节的坐标自动生成固定元素，JSON 不逐页控制：

- 标题编号块 60×43 px（0.62×0.45 in），主蓝圆角，白字编号；标题 32 px 深蓝加粗。
- 标题分隔线 y=96 px（1.0 in），通栏主蓝 1 px，左端深蓝短线。
- 页首结论句 y=108–146 px；内容区 y=154–612 px（有结论句）/ 110–662 px（无）。
- 底部结论带 y=624–662 px（6.5–6.9 in），通栏主蓝。
- 页脚 y=666 px：左侧 `notes`，右侧"页码 / 总页数"，灰色 10.5 px。
- 封面、目录、章节、结束页为深色陈述页，不出现编号块与页脚。

## 字号两档

参考实现默认为**高密度审阅档**（正文 12–15 px，表格 11–12 px），忠实于评审参考图的密度，适合屏幕送审。用于**现场投影**时按美学系统第 3 节执行投影档：正文 ≥14 pt（≈19 px）、表格 ≥10 pt（≈13 px）——在 deck.json 中上调字号并相应删减内容，两档不得混用。

## 美学审计

审计阈值来自 [`../assets/aesthetic-tokens.json`](../assets/aesthetic-tokens.json)，当前检查：

- 每页主模块数 ≤4；
- 红色文字 span ≤3；
- 每模块要点 ≤6；
- 内容页图片 ≤4（目录页 ≤6）；
- 区域底色 ≤3 区/页，全 deck 色调 ≤2 种，色调名合法；单区 >25% 页面面积时输出 `[warn]`；
- 深色陈述页占比 15–25%。

字号、颜色、边距、栅格等已在渲染器中固定，不在 JSON 中逐页开放；审计只覆盖结构层可计算项，像素级覆盖率仍需按美学系统的测量公式人工抽查。

```bash
python scripts/render_deck.py deck.json -o out --audit --strict
```

审计通过只说明“没有越过量化底线”，不替代视觉判断；最终仍需导出 PNG 逐页检查构图、留白与焦点。
