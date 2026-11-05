# dsh-educoder-auto

给 DeepSeek Harness（DSH）用的自动解题插件，现在覆盖两个平台：

- **头歌（Educoder）**：丢一个题目网址给它，它自己抓题干、让 AI 写代码、写回平台、提交评测，评测不过还会看着报错重写。
- **iWrite（外研社英语写作 iwrite.unipus.cn）**：丢一个写作页网址（或者干脆不给，自动挑一份没写的），它按体裁 / 词数区间 / 题干要点 / 关键词写一篇、逐条自检、保存并提交。

```
你：帮我做这个 https://www.educoder.net/tasks/xxxxx?homework_common_id=123
它：→ 登录态检查 → 拉题目 → AI 出码 → 写回 → 评测 → （不过就重写）→ 报结果

你：帮我写这个 https://iwrite.unipus.cn/student/daily/write?taskId=...&uid=...&classId=...
它：→ 登录态检查 → 拉任务（体裁/词数/要点）→ AI 写稿 → 自检（词数/要点/中文）→ 保存 → 提交 → 回读
```

两个平台各用各的登录态、各用各的浏览器 profile，互不影响。

## 装

**从 GitHub 直接装（推荐）**：

```bash
dsh plugin --profile desktop add git+https://github.com/Lumidouces/dsh-educoder-auto.git
```

也可以钉版本：

```bash
dsh plugin --profile desktop add git+https://github.com/Lumidouces/dsh-educoder-auto.git#v0.3.0
```

**本地开发**（clone 后 link，改代码即时生效）：

```bash
git clone https://github.com/Lumidouces/dsh-educoder-auto.git
dsh plugin --profile desktop add link:/path/to/dsh-educoder-auto
```

装完**重启 DSH**（服务端插件不是热更新的）。

## 六条工具

| 工具 | 干什么 |
|---|---|
| `educoder_status` | 头歌体检：登录态、AI 路由、浏览器能不能用、拟人化开没开 |
| `educoder_login` | 开浏览器让你登录头歌一次，把 session cookie 存到本地 |
| `educoder_solve` | 给网址，解一道头歌的题 |
| `iwrite_status` | iWrite 体检：登录态、有几份待写作业、AI 路由 |
| `iwrite_login` | 登录 iWrite：默认用保存的账号密码自动登，失败才弹窗手动登 |
| `iwrite_solve` | 给网址（或不给），写一篇并提交 |

`educoder_solve` 的参数：

- `url`（必填）头歌题目网址
- `mode`：`auto`（默认，API 优先、失败降级浏览器）/ `api` / `browser`
- `submit`：是否真提交。`false` 是 dry-run，只生成代码不碰平台
- `extra`：额外提示，比如「上次报错是 NameError」
- `keepOpen`：跑完是否留着浏览器窗口。默认 `false`（关掉）。想盯着看过程就设 `true`
- `humanize`：是否用拟人节奏，默认 `true`。想立刻拿结果就设 `false`
- `speed`：节奏倍率。`1` = 真人速度（一道编程题 2~6 分钟），`0.05` = 快进 20 倍，`0` = 完全不等待

> 默认会自己关浏览器：一是别在桌面上留一堆 Edge，二是 `user-data-dir` 被占住时下次启动会直接报 `Target page, context or browser has been closed`。

## 浏览器在后台跑，不弹窗

默认 `browser.headless: true`：抓题、截图、点评测全在无头浏览器里跑，**不弹窗口、不抢焦点**，你可以正常用电脑。

- **登录是例外**：`educoder_login` 强制有头，否则你看不见窗口就没法输密码。
- 想看浏览器到底在干什么：配置里 `browser.headless: false`，或者解题时传 `keepOpen: true` 留着窗口。
- 无头下头歌的 Monaco 编辑器加载比有头慢 1~2 秒，插件会自动等（`pageSnapshot` 的 `editorTimeoutMs`），实测单题整体 7 秒左右，有头约 5 秒，差得不多。
- 代价：无头浏览器的 UA 里带 `HeadlessChrome` 字样（`navigator.webdriver` 已处理成 `false`）。如果介意这点，就设 `headless: false`。

## 第一次用：先登录

```bash
educoder_login
```

会弹一个 Edge 窗口，在里面把账号密码输完。登录成功后 cookie 自动落到 `~/.dsh/educoder-auto/session.json`（权限 600），之后就不用再登了，直到它过期。

> 头歌登录页只有「账号密码」+ 微信/钉钉两个第三方入口，**没有扫码**。所以得手动输一次密码。

## 两条解题通道

插件自动识别三类题：**编程题**、**选择题**、**填空题**。前两类（客观题）不走浏览器，直接交答案。

### A. API 路（首选）

走平台前端自己在用的 `data.educoder.net/api`，签名算法是前端公开常量：

```
X-EDU-Signature = md5(base64("method=<M>&ak=<AK>&sk=<SK>&time=<ms>"))
```

这不是破解，是把浏览器里已经在跑的那套请求原样搬到 Node 里。好处是题干、文件清单、评测用例结果全是结构化 JSON，比截图 + 视觉模型可靠得多，也快。

流程：`/tasks/<id>.json` 拿题干和文件 → 缺内容就 `/rep_content.json` 单独读 → AI 出码 → `/myshixuns/<id>/update_file.json` 保存 → `/tasks/<id>/game_build.json` 触发评测 → 轮询 `test_sets[].result` 拿结果。

### B. 浏览器路（兜底）

API 拿不到结构时（题型特殊、页面纯前端渲染、或者你只是想看着它做），就用 playwright-core 驱动系统 Edge：打开页面 → 截图 + 抓 DOM 和编辑器内容 → 喂给 AI → 写回编辑器 → 点「评测」→ 用 `game_status` 接口读结论（读不到再退回页面文字）。

编辑器探测顺序：Monaco → CodeMirror 5 → CodeMirror 6 → textarea，支持 iframe。头歌是 React SPA，所以 `goto` 之后会等页面 settle，不然截图是白图。

两个必须知道的实现细节：

- 头歌的 Monaco 挂在 `window.Monaco`（**大写 M**），不是标准的 `window.monaco`。只认小写会退到 textarea 兜底，读到的是输入代理框残片。
- **不能用 Playwright 的 `fill()` 写 Monaco**：它逐字符 insertText，每个换行都触发一次 auto-indent，缩进会一路累积。走原生 value setter + 派发 `input`/`change`，写完回读比对（`filled.verified`）。

### C. 截图识题（题干缺失时才启用）

题干是准确文本，截图反而有 OCR 误差，所以截图是兜底不是主路。触发条件：

- API 返回的题干**少于 40 字**（这个题型/版本的题干不在接口里）
- 浏览器路页面正文**少于 200 字**（纯图、canvas、还没渲染完）

触发后把截图作为图像输入交给模型。宿主模型若声明只接受文本（`inputModalities` 不含 `image`），会自动跳过，不会白烧 token；`educoder_status` 会提前告诉你截图识题能不能用。

关掉它：配置里 `visionFallback: false`。

### D. 选择题 / 填空题

`detectKind()` 按 `chooses[].question_type` 分流：`0` 是选择，`3` 是填空。

流程：`chooses[]` 里已经带着题干、选项（选择题是 `challenge_question[].option_name`）、空数（`multi_count`）
→ 组 prompt 让模型只输出 `{"answers":[...]}` → 提交到 `POST /tasks/<id>/choose_build.json`。

两种题型的 `answer` 形状不同：

```jsonc
// 选择题：一题一个字母，多选拼起来
{"answer": ["A", "C", "D"], "challenge_id": 5549278, ...}

// 填空题：一题一个数组，一个空一个字符串
{"answer": [["\n", "\""], ["5"]], "challenge_id": 5549279, ...}
```

**判分**：平台不回逐题对错（`test_sets[].result` 和 `choose_correct_num` 恒为 `null`，页面也只显示「已提交」）。
只能看 `game.status === 2`（通过）或 `game.final_score / challenge.score` 的得分率，`>= 1` 才算通过。
所以 `verdict` 里会带 `finalScore` / `maxScore` / `radio`，让用户自己核对。

> 填空题的答案对空白敏感——换行符本身就是答案。所以 `extractObjectiveAnswers` 对数组元素**刻意不 trim**。

## iWrite：英语写作（`iwrite_solve`）

平台 `iwrite.unipus.cn` 是外研社的英语写作教学与评阅系统，老师布置作文题，学生写完提交进批改流程。

### 登录（默认自动）

第一次把账号密码交给插件，之后就一直自动登：

```bash
educoder-auto iwrite-login 13628198902 你的密码     # 保存账号密码 + 立即自动登录
```

或者用工具：

```
iwrite_login(username="手机号", password="密码")     # 保存并自动登录
iwrite_login()                                      # 之后不带参数也能自动登录
```

自动登录走的是外研社 SSO 的普通表单（`input[name=username]` / `input[name=password]` + 那个无 name 的「我已阅读并同意」复选框）。**极验是按风险触发的**——同机同 profile、正常速度填表时实测不弹；万一弹了（`loginWithCredentials` 会返回 `needsManual: true` 并说明原因），插件自动回落到弹窗，让你手动拖一次滑块。

账号密码存在 `~/.dsh/educoder-auto/iwrite-credentials.json`（chmod 600，Windows 上等于没有），登录态存 `iwrite-session.json`。**这两个文件都是明文**，别把 `.dsh` 放网盘或共享目录。

> iWrite 的登录态和头歌完全独立：不同 profile 目录、不同 session 文件。过期了重新 `iwrite_login` 即可，不用再输账号密码。

### 怎么用

```
iwrite_solve(url="https://iwrite.unipus.cn/student/daily/write?taskId=123&uid=456&classId=789")
iwrite_solve()                                  # 不给 url：自动挑一份没提交的
iwrite_solve(url=..., submit=false)             # 只存草稿，先看写得好不好
iwrite_solve(url=..., extra="多用简单句，别用生僻词")
```

`iwrite_solve` 的参数：

- `url`：写作页网址。里面最好带 `taskId` / `uid` / `classId`；缺 `classId` 时插件会去作业列表里反查
- `taskId` / `classId`：url 没带时手动给
- `submit`：是否真提交。`false` = 只保存草稿（dry-run）
- `extra`：额外写作要求，会当成硬约束拼进题干
- `maxAttempts`：不合格时最多重写几轮，默认 3
- `reuseDraft`：已有草稿合格就沿用不重写，默认 `true`（省一次模型调用，也更像"自己改过"）
- `level`：写作水平档位，`highschool`（默认）/ `cet4` / `cet6`，见下节
- `polish`：定稿前再润色一遍（只改措辞，内容结构不动），默认 `true`
- `humanize` / `speed`：拟人节奏，见下

### 「严格按照其要求写作」是怎么保证的

平台给的任务信息里，真正构成硬约束的是这几项，插件全部显式塞进提示词，**并且拿到稿子后逐条复核**，不合格就打回重写（带着「哪里不合格」回喂）：

| 约束 | 来源字段 | 怎么校验 |
|---|---|---|
| 体裁 | `genre`（0 通用 / 1 应用文 / 2 议论文 / 3 说明文 / 4 记叙文 / 5 学术 / 6 雅思） | 写进提示词的 `GENRE_GUIDE`，要求文体、人称、时态、结构都对应 |
| 词数区间 | `words` / `words2` | 平台按**空白分词**计数，插件用同一口径（`countWords`），留 ±5% 余量 |
| 题干要点 | `stem` 原文 | 题干逐字进提示词，要求每条 bullet 都覆盖 |
| 关键词 | `keyWord` | 逐个检查是否出现在正文里，缺一个就报问题 |
| 标题 | `title` | 平台标题是独立字段。题干没给标题时让模型起一个（3~10 词 Title Case）；**正文里不许再写标题行** |
| 中文混入 | — | 平台会拦「识别到中文内容」，插件提前查 |
| 写作水平 | 本地档位 | 见下节「写作水平档位」 |

### 写作水平档位（`level`）

默认 `highschool`，也就是**高三生水平、词汇落在四级范围内**。三档：

| 档位 | 词汇边界 | 句子/结构 |
|---|---|---|
| `highschool`（默认） | 高考核心词 + 四级常见词，逐词要求「高中认识且在四级词表内」 | 12~20 词为主，连接词只用 first / also / however / in short 这类 |
| `cet4` | 四级词汇 | 15~25 词，标准学术连接词 |
| `cet6` | 六级词汇 | 句式可以更复杂 |

高三档还有两条硬检查：

1. **超纲词拦截**：内置一份「一眼像 AI / 明显超出四级」的词表（`delve`、`tapestry`、`multifaceted`、`ubiquitous`、`leverage`、`facilitate`、`paramount`、`holistic`、`intricate`、`notwithstanding` 等 60 多个），出现任何一个就报问题打回重写。
2. **缩写拦截**：`don't` / `can't` / `it's` 这类在考试作文里要写全称，出现就报问题。

定稿后还有一步**润色**（`polish: true`）：只改措辞、重复用词和句子衔接，不许加论点、不许改段落数、不许把词拔高。润色稿要重新过一遍同样的校验，过不了就保留原稿。

另外三条硬规则写死在系统提示词里：正文不写标题、输出纯正文不带 markdown 围栏、段落之间空一行（少于 2 段判不合格）。

### 提交链路

```
定位任务（URL 或作业列表）→ 用列表里的 task（字段最全）
  → loadTaskStudent 取已有草稿（有就接着改）
  → AI 写稿 → 校验（不合格重写，最多 3 轮）
  → saveTask（source:0, savePattern:0）
  → submitTask
  → 回读：loadTaskStudent 再看正文是否一致 + 列表里 submitted 是否变 true
```

保存 / 提交的 payload 形状是从写作页源码抠出来的：

```jsonc
{
  "taskStudentId": "12", "classId": "789", "taskId": "1001", "studentId": "456",
  "title": "My Campus Life",
  "article": "……正文……",
  "simpleArticle": "……正文压成单行的摘要……",
  "words": 178,
  "source": 0,        // 0 = 正式保存（自动存盘是 1）
  "savePattern": 0
}
```

> 为什么优先走接口：一次 POST 就写完了，还能拿到结构化字段（体裁、词数区间、关键词、题干原文）——这些正是「严格按照其要求写作」的依据。走页面要先过「写前构思」门、再往编辑区塞几百词，多几步能坏的地方。接口保存/提交报错时会自动切浏览器路兜底（`lib/iwrite-browser.mjs`）。

### 浏览器路兜底（`lib/iwrite-browser.mjs`）

接口保存或提交报错时自动切过去。**默认走整页的 `/student/toSubmitTask`**，不是抽屉那条 `daily/write`：

```
注入登录 cookie → 打开 /student/toSubmitTask?id=<taskId>&clsId=<classId>&addNew=1
  → 填标题（input.biaoti[placeholder="请输入作文标题"]）
  → 填正文（UEditor：iframe#ueditor_0 里的 body[contenteditable]）
  → 点 <a>保存</a> → 点 <a>提交</a> → layui 弹窗点「确认并提交」
  → 等跳 /student/showTask
```

为什么选这条：`daily/write` 在 `preWriteRequired=1` 的作业上会先被拦到 `/student/daily/prewrite`，要跟「写作构思智能体」聊一轮才解锁，慢且不可靠；`toSubmitTask` 没这道门，保存/提交按钮都带文字，好定位。

**同一份作业，两个入口的编辑区实现完全不同**，两种都支持：

| 入口 | 正文编辑器 | 保存/提交 | 确认弹窗 |
|---|---|---|---|
| `/student/toSubmitTask` | UEditor（`iframe#ueditor_0` → `body[contenteditable]`） | `<a>保存</a>` / `<a>提交</a>` | layui，`a.layui-layer-btn0`「确认并提交」 |
| `/student/daily/write` | 普通 `textarea.editor___*` | `<button>保存</button>` / `<button aria-label="提交"><img></button>` | antd，`.ant-btn-primary`「确定」 |

实测踩到的坑，代码里都绕过了：

1. **`daily/write` 的正文不是 TinyMCE**。umi.js 里有 tinymce 依赖，但线上这版没启用：`window.tinymce` 不存在、没有 iframe、没有 contenteditable，正文就是普通 `textarea`。早先按 TinyMCE 写的逻辑全部失效。
2. **`toSubmitTask` 的正文在 UEditor 的 iframe 里**，主文档读不到，必须遍历 `page.frames()` 找 `body[contenteditable="true"]`。写的时候直接改 `innerHTML` 再派发 `input`——**不能用 Playwright 的 `fill()`/`type()`**，逐字符输入会触发编辑器的自动缩进和换行规则。
3. **提交按钮两种页面长得不一样**。`daily/write` 是 `<button aria-label="提交">` 里塞一张图（没有文字），按文字永远找不到；`toSubmitTask` 是带文字的 `<a>提交</a>`。两套选择器都得有。
4. **确认弹窗是两套 UI 库**。`daily/write` 用 antd（`.ant-modal-confirm` + `.ant-btn-primary`），`toSubmitTask` 用 layui（`a.layui-layer-btn0`，文案「确认并提交」，旁边还有个「返回修改」别点错）。
5. **`preWriteRequired: 1` 的作业多一道门**。`daily/write` 上「我要写作」按钮在没聊过天时带 `writeBtnLocked` 类且禁用，必须往聊天框发一条消息才解锁。
6. **提交成功后跳的页不一样**。`daily/write` 跳 `/report`，`toSubmitTask` 跳 `/student/showTask`。两个都算成功，回读正文时都要跳过（跳走了就读不到编辑区）。

### iWrite 的拟人节奏

写作的时间开销比做题大得多，单独一套：

| 阶段 | 时长 |
|---|---|
| 读题 | 25 秒左右（±） |
| 构思 + 敲字 | 按 8~14 词/分钟估，300 词约 25~40 分钟 |
| 交卷前检查 | 12 秒左右 |

档位同上（`brisk` ×0.6 / `normal` / `relaxed` ×1.5）。沿用已有草稿时**不重复计构思时间**（本来就没重写）。

调试时用 `speed: 0.02` 快进 50 倍，`speed: 0` 完全不等待。

## 拟人化（时间节奏 + 代码风格）

默认开启。目的只有一个：让提交记录别一眼就看出是脚本刷的。

### 时间节奏

每个阶段插入随机停顿，区间按"普通学生做一道 C 语言课后题"估：

| 阶段 | 编程题 | 选择题/填空题 |
|---|---|---|
| 读题 | 10~40 秒 | 8~25 秒 |
| 敲代码 / 想答案 | 1~4 分钟（代码越长越久） | 20~90 秒 |
| 自查后点评测 | 5~20 秒 | 5~15 秒 |
| 评测失败改 bug | 1~4 分钟，第 2 轮起再乘轮次 | — |

三档：`humanizeProfile: brisk`（熟练工，×0.55）、`normal`（默认）、`relaxed`（边玩边写，×1.6）。

一道普通编程题整体耗时落在 **2~6 分钟**，和你自己敲一遍差不多。

### 代码风格

三步：

1. **归纳**——从「本题模板骨架（Begin/End 之外的部分）」+「同一作业里已通过关卡的历史提交」里数出：
   缩进是 tab 还是空格、几个空格、`#include <x>` 还是 `#include<x>`、`{` 同行还是换行、`if (x)` 还是 `if(x)`。
2. **写进提示词**——让模型照着这个风格写（比事后改更自然）。
3. **事后套用**——把缩进宽度、include 空格、花括号位置、关键字空格按画像改一遍。

安全阀（重要）：改完会把所有空白抹掉，必须和原文**完全相同**，否则整体回退。跨行字符串、注释行、宏定义里的 `{` 都不动。

### 相关配置

```yaml
humanize: true           # 总开关
humanizeSpeed: 1         # 倍率，1 = 拟人；0.2 = 快进 5 倍调试；0 = 不等待
humanizeProfile: normal  # brisk / normal / relaxed
maxWaitMs: 600000        # 单次停顿上限
styleMatch: true         # 代码风格对齐总开关
styleSampleTasks: 4      # 归纳风格时最多翻几道历史关卡
```

调试点快：`humanizeSpeed: 0.05`（快进 20 倍，一道题十几秒跑完，日志里仍会打印每段本来要等多久）。

## 评测不过会自动重写

最多 3 轮（`maxAttempts`）。每轮把失败用例的报错回喂给模型：

```
上一轮提交的代码：...
评测没有通过，报错如下：
用例 2 用例2：AssertionError: expected [3,2,1], got None
请针对报错修正，重新给出完整代码。
```

## 配置

写在 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 里那一行：

```yaml
- id: educoder-auto
  name: dsh-educoder-auto
  config:
    ai:
      provider: ''          # 留空 = 自动挑宿主第一个可用路由
      model: ''
      baseURL: ''           # 没有宿主 llm 时走这个 OpenAI 兼容接口
      apiKey: ''
      maxTokens: 8192
      temperature: 0.2
    browser:
      headless: true        # 默认无头，后台跑不弹窗；登录不受影响（登录强制有头）
      executablePath: ''    # 留空 = 自动找 Edge
      profileDir: ''        # 留空 = ~/.dsh/educoder-auto/browser-profile
      viewportWidth: 1440
      viewportHeight: 900
    autoSubmit: true        # 默认真提交
    maxAttempts: 3
    buildTimeoutMs: 240000  # 头歌评测要拉容器，实测 5~10 秒，慢的时候 3 分钟
    taskTimeoutMs: 1800000  # 拟人节奏下单题可能跑 2~6 分钟，给 30 分钟
    visionFallback: true    # 题干缺失时用截图识题兜底
    humanize: true          # 拟人化（节奏 + 风格）
    humanizeSpeed: 1
    humanizeProfile: normal
    maxWaitMs: 600000
    styleMatch: true
    styleSampleTasks: 4
    iwrite:                 # iWrite 写作部分，和头歌完全独立
      autoSubmit: true      # false = 只存草稿不提交
      maxAttempts: 3        # 作文不合格最多重写几轮
      reuseDraft: true      # 已有草稿合格就沿用
      level: highschool     # 写作水平：highschool / cet4 / cet6
      polish: true          # 定稿前润色一遍
      humanize: true
      humanizeSpeed: 1      # 300 词作文约 30~60 分钟；0.02 = 快进 50 倍
      humanizeProfile: normal
      taskTimeoutMs: 7200000  # 单篇最多 2 小时（拟人节奏下确实要这么久）
```

AI 通道默认用 DSH 自己的模型（不用额外配 key）。只有宿主 `llm` 服务不可用时才会走 HTTP 兜底。

## CLI（不想开 GUI 时）

```bash
# 头歌
node bin/educoder-auto.mjs status
node bin/educoder-auto.mjs login
node bin/educoder-auto.mjs solve <url> --submit --mode api
node bin/educoder-auto.mjs courses
node bin/educoder-auto.mjs homework <courseId>

# iWrite
node bin/educoder-auto.mjs iwrite-status
node bin/educoder-auto.mjs iwrite-login
node bin/educoder-auto.mjs iwrite-tasks
node bin/educoder-auto.mjs iwrite-solve [url] --submit --speed 0.02 --extra "多用简单句"
```

环境变量：`EDUC_AI_BASEURL` / `EDUC_AI_KEY` / `EDUC_AI_MODEL`。

## 踩过的坑

- **占位符**：平台初始代码里塞的是连续 U+2014（`————`），不替换掉必然编译失败。`PLACEHOLDER_RE` 专门盯它。
- **`challenge.task_pass` 是题干不是状态**，字段名容易误解。
- **`challenge.path` 多文件用全角「；」分隔**，用半角分会拆错。
- **评测是异步的，而且会先「拉容器」**：点评测后 `game_status.json` 有一段时间**不返回 `test_sets`**，只返回 `{running_code_status, running_code_message}`（`"服务启动中..."` → `"服务启动完成"`）。这期间必须判 `pending`，判成 `unknown` 就会一直空转到超时。等 `test_sets` 出现，`test_sets[].result` 是**布尔值**（不是对象），另有 `compile_success`（0 = 编译失败）。
- **保存接口的参数少一个就静默不写盘**：URL 里要 `myshixun.identifier`（字符串如 `ajlk5ovpzr`，不是数字 id），query 要 `zzud=<user.login>`，body 要 `evaluate:1`（数字）、`tab_type:1`、代码在 `content`、`game_id` 取 `game.id`（`challenge.game_id` 不存在）、`extras.challenge_id` / `extras.currentUserId`。返回的 `content_modified: 0` **不可信**，内容其实写进去了。
- **`next_game` 在上一关没通过时是 null**，想枚举全部关卡只能靠 prev/next 走链。
- **客观题平台不回逐题对错**：`choose_build` 的 `test_sets[].result` 和 `choose_correct_num` 恒为 `null`，页面「测试结果」也只写「已提交」。只能靠 `game.status === 2` 或 `final_score / challenge.score >= 1` 判通过。答对一部分也是 fail（满分制）。
- **填空题答案不能 trim**：答案可能就是换行符本身，去掉空白就答错了。
- **进程被 kill 后残留 Edge 会占住 profile**，下次启动报 `Target page, context or browser has been closed`。清理：

  ```powershell
  Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
    Where-Object { $_.CommandLine -like '*educoder-auto*' } | Stop-Process -Force
  ```

- **iWrite 的接口路径不全是通的**：`/api/task/show/<id>/<class>` 和 `/api/studenttask/getStudentTaskList/...` 实测 404，任务详情和草稿都走 `POST /api/studenttask/loadTaskStudent`。
- **iWrite 的响应不都带信封**：`/api/student_task_index/loadByStudentId` 直接返回 `{totalPages, stid, totalElements}`，没有 `{code,msg,data}`。
- **iWrite 的题干是转义过的 HTML**（`&lt;p&gt;`），要先 `htmlToText` 再喂模型，否则模型看到一堆实体符号。
- **iWrite 写作页的提交按钮没有文字**，只有 `aria-label="提交"` 和一张图片，按文字点不到。

## 文件结构

```
educoder-auto/
├── index.js                    插件入口：注册 6 个工具 + 1 个 skill
├── cordis.patch.yml            bundle patch
├── lib/
│   ├── browser.mjs             浏览器层（playwright-core + 系统 Edge）
│   ├── educoder-api.mjs        头歌平台 API + 签名 + 评测结果解析
│   ├── session.mjs             头歌登录态存取
│   ├── ai.mjs                  解题 prompt / 双通道调用 / 代码提取 / 视觉识题
│   ├── images.mjs              截图 → 图像输入（宿主 attachment + HTTP base64 双形态）
│   ├── humanize.mjs            拟人化：节奏规划 + 代码风格归纳/套用
│   ├── solver.mjs              头歌编排层：URL → 答案 → 提交 → 重试
│   ├── iwrite-api.mjs          iWrite 接口层（Umi 前端逆向出来的）
│   ├── iwrite-session.mjs      iWrite 登录态（独立 profile、自动登录 + 手动兜底）
│   ├── iwrite-ai.mjs           作文 prompt / 抽取 / 逐条校验 / 重写
│   ├── iwrite-solver.mjs       写作编排层：任务 → 写稿 → 校验 → 保存 → 提交 → 回读
│   └── iwrite-browser.mjs      写作页兜底路（过写前构思门 + 填 textarea/TinyMCE + 点提交）
├── bin/educoder-auto.mjs       CLI
├── tests/                      测试（见下）
└── skills/educoder-auto/SKILL.md
```

## 测试

```bash
node tests/run.mjs        # 快测：纯函数 + 插件装配，约 5s，不起浏览器
node tests/run.mjs --all  # 全测：再加浏览器 e2e，会真开一个 Edge 窗口，约 25s
```

| 用例 | 覆盖 |
|---|---|
| `api.test.mjs` | 签名算法、URL 解析（含三段式 `/tasks/<课>/<hw>/<task>`）、字段归一、占位符识别、题型判定 |
| `ai-code.test.mjs` | 代码块提取（单/多文件）、裸代码 vs 人话、prompt 截断 |
| `verdict.test.mjs` | 页面文字判定、`game_status` 解析（含「拉容器」阶段必须算 pending） |
| `load.test.mjs` | 用假 ctx 跑 `apply()`，校验 6 个工具 / skill 形状能过宿主校验（含无损 JSON） |
| `api-e2e.test.mjs` | fetch 打桩跑完整 API 编排，验证 fail → 回喂报错 → pass |
| `browser-e2e.test.mjs` | 真开 Edge 跑本地 fixture，正例过、反例挂 |
| `vision.test.mjs` | 截图兜底：文本模型下正确跳过，不多烧模型调用 |
| `objective.test.mjs` | 客观题：选项解析、答案 JSON 抽取（含脏回复）、判分、dry-run 不提交 |
| `credentials.test.mjs` | iWrite 账号密码存取：落盘路径、回读、清空、脏文件兜底（用临时 DSH_HOME，不碰真实凭据） |
| `humanize.test.mjs` | 拟人化：节奏抖动区间、sleep 可中断、风格归纳、风格套用（含字符串/注释/宏不误改的不变式） |
| `iwrite.test.mjs` | iWrite：接口信封/登录失效识别、保存 payload 形状、作文抽取与逐条校验（词数/关键词/中文/单段）、拟人时长 |

## 边界

这是给**自己的账号**做作业/练习用的效率工具。它不会绕过平台的任何校验——代码还是走平台自己的编译器和测试用例，过了就是真过了；作文也是走平台自己的提交与批改流程。别拿去刷别人的号或者跑违规用途。

iWrite 的登录页在**触发风控时**才会出极验滑块，插件不会去破解滑块——遇到滑块就停下来让用户手动过，正常情况用保存的账号密码自动登录。

## 拟人化的边界（说实话）

它能让提交时间看起来像人做的，但有几件事它做不到，也别指望：

1. **答案全对反而可疑**。真人会错、会改、会有一次编译不过。如果你在意，可以手动留一两道自己做。
2. **风格只能对齐格式**（缩进、括号、include 空格），改不了「这人平时爱用 `for` 还是 `while`」「变量名是 `i/j/k` 还是 `idx`」这些习惯。这部分靠提示词让模型模仿，但没有保证。
3. **提交间隔**能拉开，但**一天内做完整个学期的作业**这种宏观模式，插件管不了。要分散到不同天。
4. **平台侧日志**（IP、UA、请求顺序、是否有 DOM 交互）插件改不了。API 路是纯 HTTP，和真人点按钮的痕迹本来就不一样。真要更隐蔽只能走浏览器路（`mode: "browser"`），代价是慢且脆。

这些是使用者的判断，不是技术能完全解决的事。
