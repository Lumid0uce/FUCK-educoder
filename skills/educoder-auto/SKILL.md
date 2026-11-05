# 自动解题 / 自动写作（头歌 + iWrite）

两个平台，六条工具：

- **头歌（Educoder）**：给题目网址 → 抓题干 → AI 出答案 → 写回 → 提交评测 → 不过就看着报错重写。
  支持三类题：**编程题**、**选择题**、**填空题**。
- **iWrite（外研社英语写作 iwrite.unipus.cn）**：给写作页网址（或直接不给）→ 拉任务要求 → AI 写作文 → 逐条自检 → 保存 → 提交。

## 什么时候用

**头歌**：用户说「帮我做这道头歌题」「这个 educoder 链接能不能自动做掉」「头歌作业自动写」，且给了 `educoder.net` 网址。

**iWrite**：用户说「帮我写这个 iwrite」「英语作文自动写」「外研社写作平台」「按它要求写一篇」，且给了 `iwrite.unipus.cn` 网址。
用户只说「写作作业」但没说平台时，先看网址；没给网址就问一句平台，别瞎猜。

## 头歌：三步走

1. **`educoder_status`** —— 先看登录态和 AI 路由通不通。
   没登录就去第 2 步；AI 路由为空说明 DSH 没配模型，需要用户先配。
2. **`educoder_login`** —— 打开 Edge，让用户在窗口里输账号密码登录一次。
   cookie 会自动存到 `~/.dsh/educoder-auto/session.json`，之后不用再登。
   头歌登录页没有扫码入口，只有账号密码 + 微信/钉钉，必须让用户自己输。
3. **`educoder_solve`** —— 传 `url`，默认会真的保存并提交评测。
   - 想先看代码不提交：`submit: false`
   - API 拿不到结构：`mode: "browser"`
   - 上次评测报错了：把报错原文放进 `extra`，模型会带着错因重写

## iWrite：三步走

1. **`iwrite_status`** —— 看登录态、待写作业列表、AI 路由。
2. **`iwrite_login`** —— 默认**自动登录**：用保存的账号密码（`~/.dsh/educoder-auto/iwrite-credentials.json`）
   无头填 SSO 表单并提交，不弹窗。没保存过账号密码、或平台触发极验风控时才回落到弹窗手动登。
   第一次调用时把账号密码传进来即可：`iwrite_login(username="手机号", password="密码")`。
   cookie 存到 `~/.dsh/educoder-auto/iwrite-session.json`（和头歌完全独立）。
3. **`iwrite_solve`** —— 传 `url`；不传就自动挑一份没提交的。
   - 想先看稿不提交：`submit: false`（只存草稿）
   - 有额外写作要求：`extra: "多用简单句，别用生僻词"`
   - 快速验证：`speed: 0.02`（快进 50 倍）

## 参数速查

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `educoder_solve` | `url` | 必填，题目网址 |
| | `mode` | `auto`（默认）/ `api` / `browser` |
| | `submit` | 是否真提交，默认跟随插件配置（`autoSubmit: true`） |
| | `extra` | 额外提示，例如上次的编译错误 |
| | `keepOpen` | 跑完是否留着浏览器窗口，默认 `false` |
| | `showBrowser` | 本次用有头浏览器（默认无头后台跑） |
| | `humanize` | 是否用拟人节奏，默认 `true`。想立刻拿到结果就设 `false` |
| | `speed` | 节奏倍率，`1` 真人速度 / `0.05` 快进 20 倍 / `0` 不等待 |
| `educoder_login` | `timeoutSec` | 等登录的秒数，默认 300 |
| `educoder_status` | 无 | 体检 |
| `iwrite_solve` | `url` | 写作页网址，可不传（自动挑一份未提交的） |
| | `taskId` / `classId` | url 里没带时手动给 |
| | `submit` | 是否真提交，默认跟随配置；`false` = 只存草稿 |
| | `extra` | 额外写作要求，会当硬约束拼进题干 |
| | `maxAttempts` | 不合格时最多重写几轮，默认 3 |
| | `reuseDraft` | 已有草稿合格就沿用，默认 `true` |
| | `level` | 写作水平：`highschool`（默认，高三生 + 四级词汇）/ `cet4` / `cet6` |
| | `polish` | 定稿前润色一遍（只改措辞，默认 `true`） |
| | `humanize` / `speed` | 拟人节奏，同上 |
| `iwrite_login` | `username` / `password` | 给了就保存到本地，下次自动登录直接用 |
| `iwrite_login` | `manual` | `true` = 跳过自动登录直接弹窗 |
| `iwrite_login` | `timeoutSec` | 手动登录时等多久，默认 300 |
| `iwrite_status` | 无 | 体检 + 待写作业列表 |

## 两条通道怎么选

- **API 路**（首选）：走 `data.educoder.net/api`，拿结构化 JSON（题干、文件清单、当前代码、小题选项）。
  快、准、不依赖页面渲染。需要登录态。
- **浏览器路**（兜底）：API 报错 / 题型特殊 / 页面纯前端渲染时自动降级。
  开 Edge → 截图 → 抓 Monaco/CodeMirror/textarea 内容 → AI 出码 → 写回 → 点评测 → 用 `game_status` 接口读结论。
- **截图识题**（题干兜底）：题干少于 40 字、或页面正文少于 200 字时，把截图作为图像输入交给模型读题。
  宿主模型不支持图片时会自动跳过。`educoder_status` 里会显示截图识题是否可用。

`auto` 模式就是「先 API，挂了自动换浏览器」，一般不用手动指定。

> **浏览器默认无头**（`browser.headless: true`）：不弹窗、不抢焦点，你照常用电脑。
> 唯一例外是 `educoder_login`，它强制有头——不然你看不见窗口没法输密码。
> 想盯着看就传 `keepOpen: true` 或把配置改成 `headless: false`。

## 三类题怎么走

| 题型 | 识别 | 怎么做 |
| --- | --- | --- |
| 编程题 | 有 `challenge.path` / 文件清单 | 读文件 → AI 写完整代码 → `update_file` 保存 → `game_build` 评测 → 轮询 `game_status` |
| 选择题 | `chooses[]` 且 `question_type=0` | AI 出选项字母 → `choose_build` 交卷 |
| 填空题 | `chooses[]` 且 `question_type=3` | AI 出每个空的答案 → `choose_build` 交卷（答案是二维数组） |

选择题和填空题共用同一个提交接口 `POST /tasks/<id>/choose_build.json`，区别只在 `answer` 形状：
`["A","C",...]` vs `[["\n","\""],["5"],...]`。

## 客观题的判分（重要）

平台**不回逐题对错**：`choose_build` 响应里 `test_sets[].result` 和 `choose_correct_num` 恒为 `null`，
页面「测试结果」面板也只显示「已提交」。所以判分只能看：

- `game.status === 2` → 通过
- 否则看 `game.final_score / challenge.score`（得分率）：`>= 1` 通过，`< 1` 没通过
  - 实测：选择题满分 150、答对 4/11 → `final_score=120`（80%）、`status=0` → 判 fail，正确
  - 实测：编程题满分 100、全对 → `final_score=100`（100%）、`status=2` → 判 pass，正确

所以客观题结果里 `passed` 是 `true` / `false` / `undefined`（真的没信息时），
`verdict.finalScore` / `verdict.maxScore` / `verdict.radio` 会一并返回，用户可以自己核对。
**答错一部分也是 fail** —— 头歌客观题要求全对才给满分。

## 结果怎么看

- `passed`：`true` 通过 / `false` 没通过 / `undefined` 没拿到结论（比如 dry-run 或真的没信息）
- `kind`：`code` / `choice` / `fill` / `unknown`
- `answers`：客观题的作答内容（选择题是字母数组，填空题是二维数组）
- `chooses`：客观题的题干与选项（便于人工核对）
- `verdict.cases`：逐个测试用例的通过情况与报错
- `verdict.finalScore` / `verdict.maxScore` / `verdict.radio`：客观题得分与得分率
- `attempts`：每轮试了什么、结果如何（编程题默认最多重写 3 轮）
- `channel`：`api` 还是 `browser`
- `code`：最终提交的代码（编程题）
- `trace`：每一步干了什么（排查问题就看它）
- `screenshots`：浏览器路的截图（会作为图像进上下文，可以直接"看"）

## 拟人化（默认开启，别关）

插件会刻意放慢节奏、对齐代码风格，让提交记录不像脚本刷的：

- **时间**：读题 10~40 秒 → 敲代码 1~4 分钟 → 自查 5~20 秒 → 点评测；改 bug 每轮再 1~4 分钟。
  一道普通编程题整体 2~6 分钟。档位 `humanizeProfile`：`brisk` / `normal` / `relaxed`。
- **风格**：从「本题模板骨架 + 同作业已通过关卡的历史提交」归纳缩进、`#include` 空格、花括号位置、
  关键字空格，先写进提示词，再对生成结果做一次纯空白改写（抹掉空白后必须完全相同，否则回退）。

所以 `educoder_solve` 一道题跑几分钟是**正常的**，别以为卡住了；看 `trace` 里「拟人节奏：…」就知道在等。
想快速验证：`humanizeSpeed: 0.05`（快进 20 倍）。

## iWrite：怎么保证「严格按照要求写作」

平台的任务对象里，真正构成硬约束的是这几项，全部显式进提示词，**并且拿到稿子后逐条复核**，不合格就打回重写：

| 约束 | 字段 | 校验方式 |
| --- | --- | --- |
| 体裁 | `genre`（0 通用 / 1 应用文 / 2 议论文 / 3 说明文 / 4 记叙文 / 5 学术 / 6 雅思） | `GENRE_GUIDE` 给出文体、人称、时态、结构要求 |
| 词数区间 | `words` / `words2` | 平台按**空白分词**，插件同口径，留 ±5% 余量 |
| 题干要点 | `stem` | 原文进提示词，要求每条 bullet 都覆盖 |
| 关键词 | `keyWord` | 逐个检查是否出现在正文，缺一个就报问题 |
| 标题 | `title` | 独立字段。题干没标题时让模型起一个（3~10 词 Title Case）；正文不许重复标题行 |
| 中文混入 | — | 平台会拦「识别到中文内容」，插件提前查 |
| 写作水平 | 本地档位 `level` | 默认 `highschool`：高考词汇 + 四级范围，超纲词和缩写会被拦；`cet4`/`cet6` 放宽 |

**默认档位是高三生水平**：词表要求「高中认识且在四级词表内」，内置 60 多个超纲/AI 味词黑名单（`delve`、`tapestry`、`multifaceted`、`ubiquitous`、`leverage`、`facilitate`、`holistic` 等），出现就打回；`don't`/`can't` 这类缩写在考试作文里也要写全称。定稿后还有一轮**润色**（`polish`），只改措辞不改内容，润色稿要重新过校验，过不了保留原稿。

系统提示词里写死的三条：正文不写标题、输出纯正文不带围栏、段落之间空一行（少于 2 段判不合格）。

链路：任务列表 / `loadTaskStudent` 取任务与草稿 → AI 写 → 校验（最多 3 轮）
→ `saveTask`（`source:0, savePattern:0`）→ `submitTask` → 回读确认。

> 优先走接口：一次 POST 写完，还能拿到结构化字段（体裁/词数/关键词/题干）。保存或提交报错时自动切浏览器路兜底（`lib/iwrite-browser.mjs`）：开写作页 → 必要时先过「写前构思」门 → 填标题正文 → 点保存 → 点提交。

## iWrite 结果怎么看

- `ok`：流程是否走完
- `submitted`：是否真的提交了（`false` = 只存了草稿）
- `title` / `body` / `words`：标题、正文、词数（按平台口径）
- `attempts`：写了几轮才过校验
- `problems`：最后一次没过的原因（词数不对、缺关键词、混了中文、只有一段…）
- `task`：体裁、词数区间、截止时间
- `verified`：回读结果（`words`、`articleMatches` 正文是否一致、`submitted` 平台是否标记提交）
- `trace`：每一步干了什么，含「拟人节奏：…」的等待说明

## iWrite 的拟人节奏

读题约 25 秒 → 构思敲字按 8~14 词/分钟估（300 词约 25~40 分钟）→ 交卷前检查约 12 秒。
沿用已有草稿时不重复计构思时间。所以 `iwrite_solve` 跑半小时是**正常的**，看 `trace` 就知道在等。
快速验证用 `speed: 0.02`。

## 坑

- **登录态会过期**。API 报 `NEED_LOGIN` 就重新跑 `educoder_login`。
- **平台占位符是连续长破折号**（`————`，U+2014）。代码里留着它必然编译失败，AI 要把它替换掉。
- **评测是异步的，而且会先「拉容器」**。点评测后 `game_status.json` 有一段时间不返回 `test_sets`，只回 `running_code_message`（`"服务启动中..."` → `"服务启动完成"`）。这期间是 `pending`，不是失败。默认等 240 秒（`buildTimeoutMs`）。
- **别对同一题连点评测**。头歌有频率限制，连续提交可能被临时锁。
- **客观题的 `answer` 不能 trim**。填空题的答案可能就是换行符或空格本身，去掉空白等于答错。
  插件里 `extractObjectiveAnswers` 对数组元素刻意不 trim。
- **客观题平台不回对错**，只回总分。别指望从 `choose_build` 响应里读出「第 3 题错了」。
- **进程被 kill 后残留 Edge 会占住 profile**，下次报 `Target page, context or browser has been closed`。
  插件默认跑完会自己关浏览器，所以正常不会遇到；真遇到了清理一下：
  `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*educoder-auto*' } | Stop-Process -Force`
- **CLI 里没有宿主模型**。`bin/educoder-auto.mjs` 在终端跑时 `ctx.get('llm')` 不存在，必须配 `EDUC_AI_BASEURL` / `EDUC_AI_KEY`；在 DSH 里用工具调用则不用配。

iWrite 专属的坑：

- **登录默认自动、风控时手动**。外研社 SSO 的极验是按风险触发的：同机同 profile 正常填表不弹，弹了就说明被风控，插件会回落到手动并说明原因，不去破解滑块。
- **接口提交可能交上旧版本**。`saveTask` 每次都新建一个 `taskStudentId`，而 `submitTask` 认的是作业当前绑定的那一版，两者不一致时页面显示「已提交」但内容是上一次的草稿。插件现在会回读比对，不一致就自动改用浏览器路重交（页面提交实测可靠）。
- **写作页有两套实现**。`/student/toSubmitTask` 用 UEditor（正文在 `iframe#ueditor_0` 的 `body[contenteditable]` 里，按钮是 `<a>保存</a>`/`<a>提交</a>`，确认弹窗是 layui 的「确认并提交」）；`/student/daily/write` 用普通 textarea + `<button aria-label="提交">` + antd 弹窗。浏览器路默认走前者（没有「写前构思」那道门）。
- **登录态会过期**。API 报 `NEED_LOGIN`（`code` 100/400/401/2002，或 302 跳登录页）就重新跑 `iwrite_login`。
- **`classId` 不能少**。写作页 URL 里没有 `classId` 时插件会去作业列表反查；反查不到就报 `NO_CLASS_ID`，让用户给带 `classId=` 的 URL。
- **标题和正文是两个字段**。正文里再写一遍标题会被判重复，插件会自动删掉与标题重复的首行。
- **词数按空白分词**，不是按字符。`countWords` 和前端同一个口径。
- **不要提交中文**。平台会拦，插件提前查。
- **同一份作业重复提交**：平台是否允许取决于老师设置（`submitCount`）。插件不会拦，但会提示「之前已经提交过」。
- **`preWriteRequired: 1` 的作业多一道门**。会先落到 `/student/daily/prewrite`，必须往「写作构思智能体」的聊天框发一条消息，「我要写作」按钮才解锁。走接口时不受影响；走浏览器兜底时插件会自动过这道门。
- **浏览器兜底里，提交按钮没有文字**，只有 `aria-label="提交"` 和一张图片，点完还要点 antd confirm 的「确定」。
- **写作页正文不是 TinyMCE**，就是普通 `textarea[placeholder="请在此撰写你的作文..."]`（umi.js 里有 tinymce 依赖但线上没启用）。
