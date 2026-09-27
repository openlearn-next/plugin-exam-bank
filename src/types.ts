/**
 * 题库与随堂测验插件 — 共享类型定义（前后端同构）
 */

export type QuestionType =
  | 'single' // 单选
  | 'multi' // 多选
  | 'boolean' // 判断
  | 'fill' // 填空（文本比对自动判分）
  | 'scale' // 1-5 量表（问卷专用，不判分）
  | 'open'; // 简答/开放题（教师批阅）

export interface QuestionOption {
  key: string;
  text: string;
}

export interface Question {
  id: string;
  type: QuestionType;
  stem: string;
  options?: QuestionOption[];
  /** 标准答案：single/multi/boolean → key 数组；fill → 期望文本数组；scale/open → 无 */
  answer?: string[];
  /** 填空比对是否忽略大小写/空白 */
  answerStrict?: boolean;
  score: number;
  tags?: string[];
  mediaUrl?: string;
  created_at?: number;
  updated_at?: number;
}

export type SurveyMode = 'quiz' | 'survey';
export type IdentityMode = 'realname' | 'anonymous';
export type SurveyStatus = 'draft' | 'published' | 'closed';

export interface SurveyConfig {
  /** 测验限时（秒），0 / 缺省不限时 */
  timeLimitSec?: number;
  /** 打乱题目顺序 */
  shuffle?: boolean;
  /** 是否展示实时统计 */
  liveStats?: boolean;
}

export interface Survey {
  id: string;
  title: string;
  description?: string;
  mode: SurveyMode;
  identity_mode: IdentityMode;
  status: SurveyStatus;
  config?: SurveyConfig;
  lesson_id?: string;
  class_id?: string;
  question_ids: string[];
  created_at: number;
  published_at?: number;
  closed_at?: number;
}

export interface SurveyQuestion extends Question {
  pos: number;
}

export interface AnswerInput {
  question_id: string;
  /** 值形态与题型匹配：option key / key[] / 文本 / 数字(量表) */
  answer: string | string[] | number;
}

export interface SubmissionResult {
  submissionId: string;
  totalScore: number;
  maxScore: number;
  /** 每题判分明细（quiz 模式返回，survey 只返回确认） */
  items?: Array<{ question_id: string; is_correct: boolean; score: number }>;
}

export interface AnswerRecord {
  id: string;
  submission_id: string;
  question_id: string;
  answer: string | string[] | number;
  is_correct: number | null;
  score: number;
  graded_by?: string;
  submitted_at?: number;
}

export interface SubmissionSummary {
  id: string;
  survey_id: string;
  student_id: string | null;
  submitted_at: number;
  total_score: number;
}

export interface SurveyStats {
  survey_id: string;
  title: string;
  mode: SurveyMode;
  identity_mode: IdentityMode;
  status: SurveyStatus;
  submission_count: number;
  max_score: number;
  avg_score: number | null;
  questions: Array<{
    question_id: string;
    type: QuestionType;
    stem: string;
    score: number;
    answered_count: number;
    correct_count: number;
    /** 选项分布（single/multi/boolean） */
    option_distribution?: Record<string, number>;
    /** 量表均值（scale） */
    scale_mean?: number | null;
    /** 排名前 N 的填空答案 */
    fill_top?: Array<{ value: string; count: number }>;
    /** 开放题答案列表（survey 权限可读） */
    open_answers?: Array<{ submission_id: string; text: string }>;
  }>;
  /** 实名模式：班级 × 个体成绩 */
  roster?: Array<{ student_id: string; student_name?: string; total_score: number }>;
}

/** 后端判分入口（同构给前端预测用） */
export function gradeAnswer(
  question: Pick<Question, 'type' | 'answer' | 'answerStrict'>,
  input: string | string[] | number,
): { is_correct: boolean | null; normalized: string | string[] | number } {
  switch (question.type) {
    case 'single':
    case 'boolean': {
      const got = Array.isArray(input) ? input[0] : String(input ?? '');
      const want = question.answer?.[0];
      return { is_correct: want != null && got === want, normalized: got };
    }
    case 'multi': {
      const got = (Array.isArray(input) ? input : [String(input ?? '')]).slice().sort();
      const want = (question.answer ?? []).slice().sort();
      const eq = got.length === want.length && got.every((v, i) => v === want[i]);
      return { is_correct: eq, normalized: got };
    }
    case 'fill': {
      const norm = (s: string, strict?: boolean) =>
        strict ? s : s.trim().toLowerCase().replace(/\s+/g, '');
      const got = Array.isArray(input) ? input.map(String) : [String(input ?? '')];
      const want = (question.answer ?? []).map((a) => norm(a, question.answerStrict));
      const is_correct = got.every((g) => want.includes(norm(g, question.answerStrict)));
      return { is_correct, normalized: got };
    }
    case 'scale': {
      const n = typeof input === 'number' ? input : parseInt(String(input ?? ''), 10);
      return { is_correct: null, normalized: Number.isNaN(n) ? 0 : n };
    }
    case 'open':
    default:
      return { is_correct: null, normalized: Array.isArray(input) ? input.join('\n') : String(input ?? '') };
  }
}
