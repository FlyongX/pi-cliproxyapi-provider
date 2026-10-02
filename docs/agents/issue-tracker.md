# Issue tracker: GitHub

工作项和规格存放在：
https://github.com/FlyongX/pi-cliproxyapi-provider/issues

使用 `gh` CLI。所有 issue 操作显式指定
`--repo FlyongX/pi-cliproxyapi-provider`，避免误操作上游仓库。

上游 `router-for-me/pi-cliproxyapi-provider` 仅用于同步代码；
本项目工作默认记录在 fork 中。

## 常用操作

以下命令均须添加上述 `--repo` 参数：

- 创建：`gh issue create --title "..." --body-file -`
  （多行正文通过 heredoc 传入标准输入）。
- 阅读：`gh issue view <number> --comments`。
- 结构化读取：`gh issue view <number> --json number,title,body,labels,comments,state`。
- 列表：`gh issue list --state open --json number,title,body,labels,comments`；
  按需指定 `--label`、`--state`、`--limit`。
- 评论：`gh issue comment <number> --body "..."`。
- 标签：`gh issue edit <number> --add-label "..." --remove-label "..."`。
- 关闭：`gh issue close <number> --comment "..."`。

标签名称和用途以 `docs/agents/triage-labels.md` 为准。

## Pull requests as a triage surface

**PRs as a request surface: no.**

PR 用于代码审查，不作为需求分诊入口。
GitHub Issues 与 PR 共用编号；无法确定编号类型时，
查询 `gh api repos/FlyongX/pi-cliproxyapi-provider/issues/<number>`：
存在 `pull_request` 字段表示 PR。

## 技能约定

- “publish to the issue tracker”：创建 GitHub issue。
- “fetch the relevant ticket”：读取 issue 正文、标签及评论。

## Wayfinding operations

供 `/wayfinder` 使用：

- Map：一个带 `wayfinder:map` 标签的 issue，
  正文保存 Notes、Decisions-so-far 和 Fog。
- Child ticket：使用 GitHub sub-issue 关联到 Map；
  不可用时，在 Map 的任务列表中链接，并在子 issue 顶部写
  `Part of #<map>`。
- 子任务标签：`wayfinder:research`、`wayfinder:prototype`、
  `wayfinder:grilling`、`wayfinder:task`。
- 阻塞关系优先使用 GitHub 原生 issue dependencies。
  添加关系：
  `gh api --method POST repos/FlyongX/pi-cliproxyapi-provider/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`。
  数据库 ID 用
  `gh api repos/FlyongX/pi-cliproxyapi-provider/issues/<blocker> --jq .id`
  获取，不使用 issue 编号或 node_id。
- 原生依赖不可用时，在子 issue 顶部记录
  `Blocked by: #<number>`；所有阻塞项关闭后才可执行。
- Frontier：按 Map 顺序选择未关闭、无人认领、无未关闭阻塞项的子任务。
- Claim：`gh issue edit <number> --add-assignee @me`，作为会话首次写操作。
- Resolve：评论结论、关闭子任务，再将摘要和链接补充到 Map 的
  Decisions-so-far。
