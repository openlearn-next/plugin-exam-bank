/**
 * 题库与随堂测验 — 核心业务逻辑（前后端双通道共享层）
 *
 * Command handlers（前端 invokeCommand）与 REST handlers（ctx.http，
 * 经宿主网关 RBAC）共用同一组操作函数，保证两条通道行为一致。
 */
import { gradeAnswer, type AnswerInput, type Question, type Survey, type SurveyStats } from './types.js';

/** better-sqlite3 同步句柄的最小结构视图 */
export interface DbHandle {
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
}

export interface Tables {
  questions: string;
  surveys: string;
  survey_questions: string;
  submissions: string;
  answers: string;
}

export type PublishFn = (type: string, payload: Record<string, unknown>, correlationId?: string) => Promise<void>;

export class OpError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

const QUESTION_TYPES = ['single', 'multi', 'boolean', 'fill', 'scale', 'open'];

function safeJsonParse<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToQuestion(row: any): Question {
  return {
    id: row.id,
    type: row.type,
    stem: row.stem,
    options: safeJsonParse(row.options, undefined as any),
    answer: safeJsonParse(row.answer, undefined as any),
    answerStrict: row.answer_strict ? true : undefined,
    score: row.score,
    tags: safeJsonParse(row.tags, undefined as any),
    mediaUrl: row.media_url || undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToSurvey(row: any): Survey {
  return {
    id: row.id,
    title: row.title,
    description: row.description || undefined,
    mode: row.mode,
    identity_mode: row.identity_mode,
    status: row.status,
    config: safeJsonParse(row.config, undefined as any),
    lesson_id: row.lesson_id || undefined,
    class_id: row.class_id || undefined,
    question_ids: safeJsonParse<string[]>(row.question_ids, []),
    created_at: row.created_at,
    published_at: row.published_at || undefined,
    closed_at: row.closed_at || undefined,
  };
}

export function createCore(db: DbHandle, tables: Tables, publish: PublishFn) {
  const T = () => tables;

  function sqldb(): DbHandle {
    return db;
  }

  function listSurveyQuestions(surveyId: string): Question[] {
    const rows = db
      .prepare(
        `SELECT q.* FROM ${T().survey_questions} sq
         JOIN ${T().questions} q ON q.id = sq.question_id
         WHERE sq.survey_id = ? ORDER BY sq.pos`,
      )
      .all(surveyId) as any[];
    return rows.map(rowToQuestion);
  }

  async function publishSafe(type: string, payload: Record<string, unknown>, correlationId?: string): Promise<void> {
    try {
      await publish(type, payload, correlationId);
    } catch (err) {
      console.error(`[exam-bank] publish ${type} failed:`, err);
    }
  }

  return {
    // ── 题库 ──

    async saveQuestion(input: Partial<Question>): Promise<{ id: string }> {
      const q = input ?? {};
      if (!q.type || !q.stem) throw new OpError('missing type or stem', 400);
      if (!QUESTION_TYPES.includes(q.type)) throw new OpError(`unknown question type: ${q.type}`, 400);
      const now = Date.now();
      const id = q.id || crypto.randomUUID();
      let createdAt = now;
      if (q.id) {
        const existing = db.prepare(`SELECT created_at FROM ${T().questions} WHERE id = ?`).get(q.id) as any;
        if (!existing) throw new OpError('question not found', 404);
        createdAt = existing.created_at;
      }
      db.prepare(
        `INSERT INTO ${T().questions} (id, type, stem, options, answer, answer_strict, score, tags, media_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET type=excluded.type, stem=excluded.stem, options=excluded.options,
           answer=excluded.answer, answer_strict=excluded.answer_strict, score=excluded.score,
           tags=excluded.tags, media_url=excluded.media_url, updated_at=excluded.updated_at`,
      ).run(
        id,
        q.type,
        q.stem,
        JSON.stringify(q.options ?? null),
        JSON.stringify(q.answer ?? null),
        q.answerStrict ? 1 : 0,
        q.score ?? 1,
        JSON.stringify(q.tags ?? []),
        q.mediaUrl || null,
        createdAt,
        now,
      );
      await publishSafe('exambank.question.saved', { id });
      return { id };
    },

    async deleteQuestion(id: string): Promise<void> {
      if (!id) throw new OpError('missing id', 400);
      const used = db.prepare(`SELECT COUNT(*) AS n FROM ${T().survey_questions} WHERE question_id = ?`).get(id) as any;
      if (used.n > 0) throw new OpError('question is referenced by a survey', 409);
      db.prepare(`DELETE FROM ${T().questions} WHERE id = ?`).run(id);
      await publishSafe('exambank.question.deleted', { id });
    },

    listQuestions(search?: string): Question[] {
      const q = String(search ?? '').trim().toLowerCase();
      return (db.prepare(`SELECT * FROM ${T().questions} ORDER BY created_at DESC`).all() as any[])
        .map(rowToQuestion)
        .filter(
          (item) =>
            !q ||
            item.stem.toLowerCase().includes(q) ||
            (item.tags ?? []).some((t) => t.toLowerCase().includes(q)) ||
            item.type.includes(q),
        );
    },

    async importQuestions(list: Partial<Question>[]): Promise<{ imported: number }> {
      if (!Array.isArray(list) || list.length === 0) throw new OpError('no questions to import', 400);
      let imported = 0;
      const now = Date.now();
      const insert = db.prepare(
        `INSERT INTO ${T().questions} (id, type, stem, options, answer, answer_strict, score, tags, media_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const q of list) {
        if (!q.type || !q.stem) continue;
        if (!QUESTION_TYPES.includes(q.type)) continue;
        insert.run(
          crypto.randomUUID(),
          q.type,
          q.stem,
          JSON.stringify(q.options ?? null),
          JSON.stringify(q.answer ?? null),
          q.answerStrict ? 1 : 0,
          q.score ?? 1,
          JSON.stringify(q.tags ?? []),
          q.mediaUrl || null,
          now,
          now,
        );
        imported++;
      }
      await publishSafe('exambank.question.imported', { count: imported });
      return { imported };
    },

    // ── 问卷 / 组卷 ──

    async saveSurvey(input: Partial<Survey>): Promise<{ id: string }> {
      const s = input ?? {};
      if (!s.title || !s.mode) throw new OpError('missing title or mode', 400);
      const id = s.id || crypto.randomUUID();
      const identity = s.identity_mode || (s.mode === 'survey' ? 'anonymous' : 'realname');
      const qIds = (s.question_ids ?? []).filter(Boolean);
      db.prepare(
        `INSERT INTO ${T().surveys} (id, title, description, mode, identity_mode, status, config, lesson_id, class_id, question_ids, created_at)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, description=excluded.description, mode=excluded.mode,
           identity_mode=excluded.identity_mode, config=excluded.config, lesson_id=excluded.lesson_id,
           class_id=excluded.class_id, question_ids=excluded.question_ids`,
      ).run(
        id,
        s.title,
        s.description || null,
        s.mode,
        identity,
        JSON.stringify(s.config ?? {}),
        s.lesson_id || null,
        s.class_id || null,
        JSON.stringify(qIds),
        Date.now(),
      );
      db.prepare(`DELETE FROM ${T().survey_questions} WHERE survey_id = ?`).run(id);
      const ins = db.prepare(`INSERT INTO ${T().survey_questions} (survey_id, question_id, pos) VALUES (?, ?, ?)`);
      qIds.forEach((qid, i) => ins.run(id, qid, i));
      await publishSafe('exambank.survey.saved', { id });
      return { id };
    },

    async publishSurvey(id: string): Promise<void> {
      if (!id) throw new OpError('missing id', 400);
      const survey = db.prepare(`SELECT * FROM ${T().surveys} WHERE id = ?`).get(id) as any;
      if (!survey) throw new OpError('survey not found', 404);
      if (survey.status !== 'draft') throw new OpError(`survey is ${survey.status}`, 409);
      const hasAny = db.prepare(`SELECT COUNT(*) AS n FROM ${T().survey_questions} WHERE survey_id = ?`).get(id) as any;
      if (!hasAny.n) throw new OpError('survey has no questions', 409);
      db.prepare(`UPDATE ${T().surveys} SET status='published', published_at=? WHERE id=?`).run(Date.now(), id);
      const questions = listSurveyQuestions(id);
      // 公开投递内容：不携带标准答案
      const publishedQuestions = questions.map((q) => ({ ...q, answer: undefined, answerStrict: undefined }));
      await publishSafe('exambank.survey.published', {
        surveyId: id,
        title: survey.title,
        classId: survey.class_id,
        mode: survey.mode,
        identity_mode: survey.identity_mode,
        config: safeJsonParse(survey.config, {}),
        questions: publishedQuestions,
      });
    },

    async closeSurvey(id: string): Promise<void> {
      if (!id) throw new OpError('missing id', 400);
      db.prepare(`UPDATE ${T().surveys} SET status='closed', closed_at=? WHERE id=? AND status='published'`).run(
        Date.now(),
        id,
      );
      const survey = db.prepare(`SELECT * FROM ${T().surveys} WHERE id = ?`).get(id) as any;
      if (survey) {
        await publishSafe('exambank.survey.closed', { surveyId: id, classId: survey.class_id });
      }
    },

    /** 学生侧：按课节查当前进行中的卷（脱敏 —— 不携带标准答案）；无卷时仍返回 classId 供加入房间 */
    getActiveSurveyForLesson(
      lessonId: string,
    ): { survey: Survey | null; questions: Question[]; classId: string | null } {
      if (!lessonId) return { survey: null, questions: [], classId: null };
      const rows = db
        .prepare(`SELECT * FROM ${T().surveys} WHERE lesson_id = ? AND status = 'published' ORDER BY created_at DESC LIMIT 1`)
        .all(lessonId) as any[];
      const sessionRow = db
        .prepare('SELECT class_id FROM classroom_sessions WHERE lesson_id = ? AND stage != ? ORDER BY created_at DESC LIMIT 1')
        .get(lessonId, 'ARCHIVED_REPORT') as { class_id: string | null } | undefined;
      const classId = sessionRow?.class_id ?? null;
      if (!rows.length) return { survey: null, questions: [], classId };
      const survey = rowToSurvey(rows[0]);
      const questions = listSurveyQuestions(survey.id).map((q) => ({
        ...q,
        answer: undefined,
        answerStrict: undefined,
      }));
      return { survey, questions, classId: survey.class_id ?? classId };
    },

    listSurveys(): Survey[] {
      const rows = db.prepare(`SELECT * FROM ${T().surveys} ORDER BY created_at DESC`).all() as any[];
      return rows.map(rowToSurvey);
    },

    getSurvey(surveyId: string): Survey {
      const row = db.prepare(`SELECT * FROM ${T().surveys} WHERE id = ?`).get(surveyId) as any;
      if (!row) throw new OpError('survey not found', 404);
      return rowToSurvey(row);
    },

    // ── 作答提交 ──

    async submitAnswer(input: {
      surveyId: string;
      studentId?: string;
      anonymousToken?: string;
      answers: AnswerInput[];
    }): Promise<{ submissionId: string; totalScore: number; maxScore: number; items?: any[] }> {
      const surveyRow = db.prepare(`SELECT * FROM ${T().surveys} WHERE id = ?`).get(input.surveyId) as any;
      if (!surveyRow) throw new OpError('survey not found', 404);
      if (surveyRow.status !== 'published') throw new OpError('survey not accepting answers', 409);
      const inputs = input.answers ?? [];
      if (!Array.isArray(inputs) || inputs.length === 0) throw new OpError('no answers', 400);

      // 重复提交拦截：实名按 student_id；匿名按客户端生成的随机 token（不入学生档案）
      const identityKey =
        surveyRow.identity_mode === 'anonymous' ? String(input.anonymousToken ?? '') : String(input.studentId ?? '');
      if (!identityKey) throw new OpError('identity required', 400);
      const dup = db
        .prepare(`SELECT id FROM ${T().submissions} WHERE survey_id = ? AND student_id = ?`)
        .get(input.surveyId, surveyRow.identity_mode === 'anonymous' ? `anon:${identityKey}` : identityKey);
      if (dup) throw new OpError('duplicate submission', 409);

      const questions = listSurveyQuestions(input.surveyId);
      const map = new Map(questions.map((q) => [q.id, q]));
      const submissionId = crypto.randomUUID();
      const now = Date.now();
      let totalScore = 0;
      let maxScore = 0;
      const items: Array<{ question_id: string; is_correct: boolean | null; score: number }> = [];
      const insertAnswer = db.prepare(
        `INSERT INTO ${T().answers} (id, submission_id, question_id, answer, is_correct, score, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const q of questions) maxScore += q.score || 0;

      for (const inputItem of inputs) {
        const q = map.get(inputItem.question_id);
        if (!q) continue;
        const { is_correct, normalized } = gradeAnswer(q, inputItem.answer);
        const awarded =
          is_correct === null ? (q.type === 'open' ? 0 : q.score || 0) : is_correct ? q.score || 0 : 0;
        insertAnswer.run(
          crypto.randomUUID(),
          submissionId,
          q.id,
          JSON.stringify(normalized),
          is_correct === null ? null : is_correct ? 1 : 0,
          awarded,
          now,
        );
        items.push({ question_id: q.id, is_correct, score: awarded });
        totalScore += awarded;
      }
      const storeStudent = surveyRow.identity_mode === 'anonymous' ? `anon:${identityKey}` : identityKey;
      db.prepare(
        `INSERT INTO ${T().submissions} (id, survey_id, student_id, submitted_at, total_score) VALUES (?, ?, ?, ?, ?)`,
      ).run(submissionId, input.surveyId, storeStudent, now, totalScore);

      const subCount = (
        db.prepare(`SELECT COUNT(*) AS n FROM ${T().submissions} WHERE survey_id = ?`).get(input.surveyId) as any
      ).n;
      await publishSafe('exambank.answer.submitted', {
        surveyId: input.surveyId,
        surveyTitle: surveyRow.title,
        classId: surveyRow.class_id,
        submissionCount: subCount,
      });

      return {
        submissionId,
        totalScore,
        maxScore,
        items: surveyRow.mode === 'quiz' ? items : undefined,
      };
    },

    // ── 统计与批阅 ──

    queryStats(surveyId: string): SurveyStats {
      const surveyRow = db.prepare(`SELECT * FROM ${T().surveys} WHERE id = ?`).get(surveyId) as any;
      if (!surveyRow) throw new OpError('survey not found', 404);
      return computeStats(rowToSurvey(surveyRow));
    },

    async gradeBatch(
      grades: Array<{ answer_id: string; score: number }>,
      gradedBy?: string,
    ): Promise<{ updated: number }> {
      let updated = 0;
      for (const g of grades ?? []) {
        const a = db.prepare(`SELECT id, submission_id FROM ${T().answers} WHERE id = ?`).get(g.answer_id) as any;
        if (!a) continue;
        db.prepare(`UPDATE ${T().answers} SET score = ?, is_correct = ?, graded_by = ? WHERE id = ?`).run(
          g.score,
          g.score > 0 ? 1 : 0,
          gradedBy || null,
          g.answer_id,
        );
        updated++;
        const total = (
          db.prepare(`SELECT COALESCE(SUM(score),0) AS s FROM ${T().answers} WHERE submission_id = ?`).get(
            a.submission_id,
          ) as any
        ).s;
        db.prepare(`UPDATE ${T().submissions} SET total_score = ? WHERE id = ?`).run(total, a.submission_id);
      }
      await publishSafe('exambank.survey.graded', { count: updated });
      return { updated };
    },
  };

  // ── 统计聚合（私有） ──

  function computeStats(survey: Survey): SurveyStats {
    const submissions = db.prepare(`SELECT * FROM ${T().submissions} WHERE survey_id = ?`).all(survey.id) as any[];
    const isQuiz = survey.mode === 'quiz';
    const stats: SurveyStats = {
      survey_id: survey.id,
      title: survey.title,
      mode: survey.mode,
      identity_mode: survey.identity_mode,
      status: survey.status,
      submission_count: submissions.length,
      max_score: 0,
      avg_score:
        isQuiz && submissions.length
          ? Math.round((submissions.reduce((a, s) => a + (s.total_score || 0), 0) / submissions.length) * 100) / 100
          : null,
      questions: [],
    };

    const sQuestions = db
      .prepare(
        `SELECT q.*, sq.pos FROM ${T().survey_questions} sq
         JOIN ${T().questions} q ON q.id = sq.question_id
         WHERE sq.survey_id = ? ORDER BY sq.pos`,
      )
      .all(survey.id) as any[];

    for (const qr of sQuestions) {
      const q = rowToQuestion(qr);
      stats.max_score += q.score || 0;
      const answers = db
        .prepare(
          `SELECT a.* FROM ${T().answers} a
           JOIN ${T().submissions} s ON s.id = a.submission_id
           WHERE a.question_id = ? AND s.survey_id = ? AND a.answer IS NOT NULL`,
        )
        .all(q.id, survey.id) as any[];

      const item: SurveyStats['questions'][number] = {
        question_id: q.id,
        type: q.type,
        stem: qr.stem,
        score: q.score,
        answered_count: answers.length,
        correct_count: answers.filter((a) => a.is_correct === 1).length,
      };

      if (q.type === 'single' || q.type === 'multi' || q.type === 'boolean') {
        const dist: Record<string, number> = {};
        for (const a of answers) {
          const keys = safeJsonParse<string[]>(a.answer, []);
          for (const k of keys) dist[k] = (dist[k] || 0) + 1;
        }
        item.option_distribution = dist;
      } else if (q.type === 'scale') {
        const vals = answers.map((a) => safeJsonParse<number>(a.answer, NaN)).filter((v) => Number.isFinite(v));
        item.scale_mean = vals.length
          ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100
          : null;
      } else if (q.type === 'fill') {
        const counts = new Map<string, number>();
        for (const a of answers) {
          const arr = safeJsonParse<string[]>(a.answer, []);
          const got = arr.join(' | ');
          counts.set(got, (counts.get(got) ?? 0) + 1);
        }
        item.fill_top = Array.from(counts.entries())
          .sort((x, y) => y[1] - x[1])
          .slice(0, 10)
          .map(([value, count]) => ({ value, count }));
      } else if (q.type === 'open') {
        item.open_answers = answers.map((a) => ({
          submission_id: a.submission_id,
          text: safeJsonParse<string>(a.answer, ''),
        }));
      }
      stats.questions.push(item);
    }

    // 匿名问卷不输出个人成绩明细
    if (isQuiz && survey.identity_mode === 'realname') {
      stats.roster = submissions.map((s) => ({
        student_id: s.student_id ?? '',
        total_score: s.total_score || 0,
      }));
    }
    return stats;
  }
}

export type Core = ReturnType<typeof createCore>;
