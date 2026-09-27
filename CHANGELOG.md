# Changelog

本项目的所有重要变更都会记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-09-27

### Added

- **多题型题库**：单选 / 多选 / 判断 / 填空（文本规范化自动判分）/ 量表（1-5，问卷专用）/ 简答（开放题，教师批阅）六类题型；题干支持标签分类与分值设定；JSON 批量导入导出。
- **组卷与问卷设计**：`quiz`（随堂测验，实名作答）/ `survey`（问卷调查，匿名作答）两种形态，`identity_mode` 决定答卷归属与统计口径（匿名卷 `student_id` 存 `anon:<token>`，不入学生档案；匿名问卷不输出个人成绩明细）；草稿 → 发布 → 关闭生命周期，迟交与空卷发布拦截。
- **实时作答推送**：发布/关闭经内核事件总线 → `server/event-routing.ts` SOCKET_ROUTES 投递到班级房间（`exambank-survey-state`）；作答提交实时统计（`exambank-stats-update`，教师投屏面板增量刷新）。
- **学生答题界面**：注册平台 `student.classroom.overlay` 课中浮层槽位（学生上课被锁定在课节视图时的答题弹窗）；支持晚进/刷新恢复（`exambank.survey.active_for_lesson` 主动查询进行中的卷，脱敏不携带标准答案）；提交结果统一 `{ submit }` 契约。
- **统计聚合**：逐题作答人数/正确率/选项分布/量表均值/填空高频答案/开放题答案列表；实名测验附成绩明细（roster）；教师批量批阅开放题（`exambank.grade.batch`）自动回算总分。
- **REST 与 Command 双通道**：业务逻辑抽为 `src/core.ts` 共享层，`invokeCommand`（前端）与 `ctx.http` REST（宿主网关 RBAC 前置，manifest 声明 12 条路由）行为完全一致。

### 平台配套（宿主仓库 openlearn-next）

- `server/event-routing.ts` 新增三条内核事件 → Socket.IO 班级房间路由。
- `GET /api/plugins/:id(*)` 详情路由不再吞掉网关子路径（修复插件 REST GET 通道）。
- CSP `scriptSrc` 补 `blob:`（插件前端 Blob URL 加载通道）。
- `StudentInteractiveOverlay` 新增 `student.classroom.overlay` 课中插件浮层槽位。

### 验证

- 服务端集成测试 6/6（题库 CRUD / 问卷发布 / 匿名提交 / 重复提交拦截 / 自动判分 / 统计聚合）。
- 浏览器实测（Playwright 双角色）：学生登录 → 进课节（锁屏跟随）→ 教师发布 → socket 推送 → 答题模态自动弹出 → 提交判分 10/10 → 教师端实时统计。

### Notes

- 插件 id 使用 `@teacher/` 前缀——`@openlearn/*` 被平台视为系统插件保留命名空间（阻断 update 通道）。
- 数据表按安装时 DB UUID 前缀（`plugin_<uuid>_`），重装更换 UUID 属平台预期行为，题库数据不跨重装保留。
- 宿主 EsmLoader 对 data: URL 热重载无法解析裸导入（`@openlearn/plugin-sdk`），更新插件后需重启服务器加载新版本（更新失败自动回滚，数据无损）。
