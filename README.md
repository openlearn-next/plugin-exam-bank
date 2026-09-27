# 题库与随堂测验插件（@teacher/plugin-exam-bank）

OpenLearn Next 教学平台插件：多题型题库、问卷/组卷设计、实时作答推送与统计图表。

## 功能

| 模块 | 说明 |
|---|---|
| 题库管理 | 单选 / 多选 / 判断 / 填空 / 量表 / 简答六类题型；标签分类；JSON 批量导入 |
| 组卷 · 问卷 | 随堂测验（实名）/ 问卷调查（匿名）双形态；草稿 → 发布 → 关闭生命周期 |
| 实时作答 | 发布即推送到学生端（socket 班级房间），自动弹出答题界面；晚进/刷新可恢复 |
| 统计图表 | 正确率、选项分布、量表均值、填空高频答案、开放题批阅、班级成绩明细 |

## 前端扩展点

- `teacher.tab` —「题库与测验」管理页（题库 / 组卷与问卷 / 统计报告三面板）
- `classroom.tool` — 白板工具架快速发布按钮（面板 portal 到 body）
- `student.classroom.overlay` — 学生课中答题模态（实时推送触发）

## 开发

```bash
npm install            # 或 pnpm install
npx @openlearn/plugin-sdk build   # 产出 dist/ 与 <name>.zip
npx vitest run         # 服务端集成测试
```

上传 `dist/*.zip` 到平台「插件中心」安装；宿主版本要求 `>=0.3.16`。

## 数据表

`questions` / `surveys` / `survey_questions` / `submissions` / `answers`
（自动加 `plugin_<uuid>_` 前缀，随安装实例隔离）。

## 命令与事件

| 类型 | 名称 |
|---|---|
| Commands | `exambank.question.save/.delete/.list/.import`、`exambank.survey.save/.publish/.close/.list`、`exambank.answer.submit`、`exambank.stats.query`、`exambank.grade.batch` |
| Events | `exambank.question.saved/.deleted/.imported`、`exambank.survey.saved/.published/.closed/.graded`、`exambank.answer.submitted` |
| Socket | `exambank-survey-state`（发布/关闭）、`exambank-stats-update`（作答统计） |
