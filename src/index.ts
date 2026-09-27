/**
 * @openlearn/plugin-exam-bank — 题库·问卷·随堂测验（full-stack）
 *
 * 架构对齐：
 * - 命令经 commandBus.registerHandler 注册（内核 wrapCommandBus 自动加 manifest.id 前缀）
 * - REST 经 ctx.http 注册（manifest.api.routes 声明 → 宿主网关 RBAC 前置），与命令
 *   共用 src/core.ts 的同一组业务函数，保证两条通道行为一致
 * - 状态变更 publish EventBus 事件（实时投递交给宿主 server/event-routing.ts）
 */
import type { PluginContext, PluginApiResponse } from '@openlearn/plugin-sdk';
import { IDatabaseToken } from '@openlearn/plugin-sdk';
import { createCore, OpError, type Core, type DbHandle, type Tables } from './core.js';

let core: Core | null = null;

/** 业务异常 → HTTP 状态码（REST 通道） */
function toResponse(err: unknown): PluginApiResponse {
  if (err instanceof OpError) return { status: err.status, body: { success: false, error: err.message } };
  return { status: 500, body: { success: false, error: err instanceof Error ? err.message : String(err) } };
}

/** Command handler 包装：捕获业务异常 → { success: false, error }（invokeCommand 契约） */
function wrapHandler(fn: (payload: any) => Promise<any>): { execute(command: any): Promise<any> } {
  return {
    async execute(command: any) {
      try {
        return { success: true, ...(await fn(command.payload ?? {})) };
      } catch (err) {
        if (err instanceof OpError) return { success: false, error: err.message };
        throw err;
      }
    },
  };
}

// ── 激活入口 ─────────────────────────────────────────────────────────────

export default {
  manifest: {
    id: '@teacher/plugin-exam-bank',
    name: '题库与随堂测验',
    version: '0.1.0',
    main: 'index.js',
    description: '多题型题库、问卷/组卷设计、实时作答推送与统计图表',
    author: 'OpenLearn',
    engines: { openlearn: '>=0.3.16' },
    requires: [
      '@openlearn/core:ICommandBusService@^1.0.0',
      '@openlearn/core:IEventBusService@^1.0.0',
      '@openlearn/core:IStorageService@^1.0.0',
      '@openlearn/core:IDatabase@^1.0.0',
    ],
    capabilitiesProposed: ['lesson:read', 'user:read'],
  },

  async activate(ctx: PluginContext) {
    const eventBus = ctx.services.eventBus;

    const db = (await ctx.resolve(IDatabaseToken)) as DbHandle;
    const tables: Tables = {
      questions: ctx.db.table('questions'),
      surveys: ctx.db.table('surveys'),
      survey_questions: ctx.db.table('survey_questions'),
      submissions: ctx.db.table('submissions'),
      answers: ctx.db.table('answers'),
    };

    // ── 建表（schema 为插件自身常量，无外部输入拼接） ──
    await ctx.db.ensureTable('questions', `
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      stem TEXT NOT NULL,
      options TEXT,
      answer TEXT,
      answer_strict INTEGER NOT NULL DEFAULT 0,
      score REAL NOT NULL DEFAULT 1,
      tags TEXT,
      media_url TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    `);
    await ctx.db.ensureTable('surveys', `
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      mode TEXT NOT NULL,
      identity_mode TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      config TEXT,
      lesson_id TEXT,
      class_id TEXT,
      question_ids TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      published_at INTEGER,
      closed_at INTEGER
    `);
    await ctx.db.ensureTable('survey_questions', `
      survey_id TEXT NOT NULL,
      question_id TEXT NOT NULL,
      pos INTEGER NOT NULL,
      PRIMARY KEY (survey_id, question_id)
    `);
    await ctx.db.ensureTable('submissions', `
      id TEXT PRIMARY KEY,
      survey_id TEXT NOT NULL,
      student_id TEXT,
      submitted_at INTEGER NOT NULL,
      total_score REAL NOT NULL DEFAULT 0
    `);
    await ctx.db.ensureTable('answers', `
      id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL,
      question_id TEXT NOT NULL,
      answer TEXT NOT NULL,
      is_correct INTEGER,
      score REAL NOT NULL DEFAULT 0,
      graded_by TEXT,
      submitted_at INTEGER NOT NULL
    `);

    core = createCore(db, tables, async (type, payload, correlationId) => {
      await eventBus.publish({
        id: crypto.randomUUID(),
        type,
        source: `plugin.${ctx.manifest.id}`,
        payload,
        timestamp: Date.now(),
        correlationId,
      } as any);
    });

    // ── Command Handlers（前端 invokeCommand 通道）──

    const register = async (type: string, fn: (payload: any) => Promise<any>) => {
      await ctx.services.commandBus.registerHandler(type, wrapHandler(fn));
    };

    await register('exambank.question.save', (p: any) => core!.saveQuestion(p as Partial<import('./types.js').Question>));
    await register('exambank.question.delete', async (p) => {
      await core!.deleteQuestion(p.id);
      return {};
    });
    await register('exambank.question.list', (p: any) => Promise.resolve({ questions: core!.listQuestions(String(p?.search ?? '')) }));
    await register('exambank.question.import', (p) => core!.importQuestions(p?.questions));

    await register('exambank.survey.save', (p: any) => core!.saveSurvey(p as Partial<import('./types.js').Survey>));
    await register('exambank.survey.publish', async (p) => {
      await core!.publishSurvey(p.id);
      return {};
    });
    await register('exambank.survey.close', async (p) => {
      await core!.closeSurvey(p.id);
      return {};
    });
    await register('exambank.survey.list', () => Promise.resolve({ surveys: core!.listSurveys() }));

    // 学生侧：查询本课节进行中的卷（脱敏，无标准答案）—— 晚进/刷新的学生恢复答题界面
    await register('exambank.survey.active_for_lesson', async (p: any) => ({
      active: core!.getActiveSurveyForLesson(String(p?.lessonId ?? '')),
    }));

    // 提交结果统一以 { submit } 包裹（REST 与 Command 两条通道同形，前端读 r.submit）
    await register('exambank.answer.submit', async (p: any) => ({
      submit: await core!.submitAnswer({
        surveyId: p.surveyId,
        studentId: p.student_id ?? p.studentId,
        anonymousToken: p.anonymous_token,
        answers: p.answers,
      }),
    }));

    await register('exambank.stats.query', (p) => Promise.resolve({ stats: core!.queryStats(p?.surveyId) }));
    await register('exambank.grade.batch', (p) => core!.gradeBatch(p?.grades, p?.gradedBy));

    // ── REST Handlers（ctx.http 通道，宿主网关按 manifest.api.routes 前置 RBAC）──
    // 与命令共用 core —— 两条通道判分/落库/事件行为完全一致。

    ctx.http.get('/health', () => ({ status: 200, body: { ok: true, plugin: ctx.manifest.id, ts: Date.now() } }));

    ctx.http.get('/questions', (req) => {
      try {
        return { status: 200, body: { success: true, questions: core!.listQuestions((req.query as any)?.search) } };
      } catch (err) {
        return toResponse(err);
      }
    });
    ctx.http.post('/questions', async (req) => {
      try {
        return { status: 200, body: { success: true, ...(await core!.saveQuestion((req.body ?? {}) as any)) } };
      } catch (err) {
        return toResponse(err);
      }
    });
    ctx.http.delete('/questions/:id', async (req) => {
      try {
        await core!.deleteQuestion(req.params.id);
        return { status: 200, body: { success: true } };
      } catch (err) {
        return toResponse(err);
      }
    });
    ctx.http.post('/questions/import', async (req) => {
      try {
        return { status: 200, body: { success: true, ...(await core!.importQuestions((req.body as any)?.questions)) } };
      } catch (err) {
        return toResponse(err);
      }
    });

    ctx.http.get('/surveys', () => {
      try {
        return { status: 200, body: { success: true, surveys: core!.listSurveys() } };
      } catch (err) {
        return toResponse(err);
      }
    });
    ctx.http.post('/surveys', async (req) => {
      try {
        return { status: 200, body: { success: true, ...(await core!.saveSurvey((req.body ?? {}) as any)) } };
      } catch (err) {
        return toResponse(err);
      }
    });
    ctx.http.post('/surveys/:id/publish', async (req) => {
      try {
        await core!.publishSurvey(req.params.id);
        return { status: 200, body: { success: true } };
      } catch (err) {
        return toResponse(err);
      }
    });
    ctx.http.post('/surveys/:id/close', async (req) => {
      try {
        await core!.closeSurvey(req.params.id);
        return { status: 200, body: { success: true } };
      } catch (err) {
        return toResponse(err);
      }
    });
    ctx.http.get('/surveys/active', (req) => {
      try {
        const lessonId = String((req.query as any)?.lessonId ?? '');
        return { status: 200, body: { success: true, active: core!.getActiveSurveyForLesson(lessonId) } };
      } catch (err) {
        return toResponse(err);
      }
    });
    ctx.http.get('/surveys/:id/stats', (req) => {
      try {
        return { status: 200, body: { success: true, stats: core!.queryStats(req.params.id) } };
      } catch (err) {
        return toResponse(err);
      }
    });

    ctx.http.post('/surveys/:id/submit', async (req) => {
      try {
        const submit = await core!.submitAnswer({
          surveyId: req.params.id,
          studentId: req.actor?.userId ?? (req.body as any)?.student_id,
          anonymousToken: (req.body as any)?.anonymous_token,
          answers: (req.body as any)?.answers,
        });
        return { status: 200, body: { success: true, submit } };
      } catch (err) {
        return toResponse(err);
      }
    });

    ctx.log.info(`[${ctx.manifest.id}] activated (${ctx.manifest.version})`);
  },

  async deactivate() {
    core = null;
  },
};
