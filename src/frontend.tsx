/**
 * @openlearn/plugin-exam-bank — 前端
 *
 * 槽位注册：
 * - teacher.tab          「题库与测验」管理页（题库 / 组卷·问卷 / 统计报告）
 * - classroom.tool       白板工具架按钮（仅图标；控制面板 createPortal 到 body 防挤压）
 * - student.view         学生答题视图（实名 / 匿名按 identity_mode 切换）
 *
 * 实时：socketService 监听 exambank-survey-state / exambank-stats-update。
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import { createPortal } from 'react-dom';

let ctx: any = null;

// ── 共享小工具 ──────────────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  single: '单选',
  multi: '多选',
  boolean: '判断',
  fill: '填空',
  scale: '量表',
  open: '简答',
};

const btn: React.CSSProperties = {
  padding: '6px 14px',
  borderRadius: 8,
  border: '1px solid #d1d5db',
  background: '#fff',
  cursor: 'pointer',
  fontSize: 13,
};
const btnPrimary: React.CSSProperties = { ...btn, background: '#4f46e5', borderColor: '#4f46e5', color: '#fff' };
const card: React.CSSProperties = {
  border: '1px solid #e5e7eb',
  borderRadius: 12,
  padding: 14,
  background: '#fff',
};
const input: React.CSSProperties = {
  padding: '6px 10px',
  borderRadius: 8,
  border: '1px solid #d1d5db',
  fontSize: 13,
  width: '100%',
  boxSizing: 'border-box',
};

function invoke<T = any>(type: string, payload?: any): Promise<T> {
  if (!ctx) return Promise.reject(new Error('plugin context not ready'));
  return ctx.invokeCommand(type, payload);
}

async function fetchTeacherStats(surveyId: string) {
  const res = await invoke<any>('exambank.stats.query', { surveyId });
  if (res?.success) return res.stats;
  throw new Error(res?.error || 'stats query failed');
}

// ── 纯 CSS 小图表（M1 轻量实现，避免增加打包依赖） ─────────────────────

function BarRow({ label, count, total, color }: { label: string; count: number; total: number; color?: string }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
      <span style={{ width: 90, fontSize: 12, color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={label}>
        {label}
      </span>
      <div style={{ flex: 1, height: 18, background: '#f3f4f6', borderRadius: 6, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color || '#6366f1', borderRadius: 6, transition: 'width 0.4s' }} />
      </div>
      <span style={{ width: 70, fontSize: 12, color: '#6b7280', textAlign: 'right' }}>
        {count} · {pct}%
      </span>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// 1. 题库管理
// ════════════════════════════════════════════════════════════════════════

interface QuestionDraft {
  id?: string;
  type: string;
  stem: string;
  options: { key: string; text: string }[];
  answer: string[];
  fillAnswerText: string;
  score: number;
  tags: string;
}

const EMPTY_DRAFT: QuestionDraft = {
  type: 'single',
  stem: '',
  options: [
    { key: 'A', text: '' },
    { key: 'B', text: '' },
  ],
  answer: [],
  fillAnswerText: '',
  score: 1,
  tags: '',
};

function QuestionEditor({ draft, onChange, onSave }: { draft: QuestionDraft; onChange: (d: QuestionDraft) => void; onSave: () => void }) {
  const d = draft;
  const isChoice = d.type === 'single' || d.type === 'multi';
  return (
    <div style={card}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center' }}>
        <select value={d.type} onChange={(e) => onChange({ ...d, type: e.target.value, answer: [] })} style={{ ...input, width: 100 }}>
          {Object.entries(TYPE_LABELS).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
        <input placeholder="分值" type="number" min={0} value={d.score} onChange={(e) => onChange({ ...d, score: Number(e.target.value) || 0 })} style={{ ...input, width: 70 }} />
        <input placeholder="标签（逗号分隔）" value={d.tags} onChange={(e) => onChange({ ...d, tags: e.target.value })} style={{ ...input, flex: 1 }} />
      </div>
      <textarea placeholder="题干" value={d.stem} onChange={(e) => onChange({ ...d, stem: e.target.value })} style={{ ...input, minHeight: 60, marginBottom: 8 }} />
      {isChoice && (
        <>
          {d.options.map((opt, i) => (
            <div key={opt.key} style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center' }}>
              <input
                type={d.type === 'single' ? 'radio' : 'checkbox'}
                name="q-answer"
                checked={d.answer.includes(opt.key)}
                onChange={() => {
                  if (d.type === 'single') onChange({ ...d, answer: [opt.key] });
                  else onChange({ ...d, answer: d.answer.includes(opt.key) ? d.answer.filter((k) => k !== opt.key) : [...d.answer, opt.key] });
                }}
              />
              <span style={{ width: 16, fontSize: 13 }}>{opt.key}</span>
              <input placeholder={`选项 ${opt.key} 内容`} value={opt.text} onChange={(e) => {
                const opts = d.options.slice();
                opts[i] = { ...opt, text: e.target.value };
                onChange({ ...d, options: opts });
              }} style={input} />
            </div>
          ))}
          <button style={btn} onClick={() => onChange({ ...d, options: [...d.options, { key: String.fromCharCode(65 + d.options.length), text: '' }] })}>
            + 添加选项
          </button>
        </>
      )}
      {d.type === 'fill' && (
        <input placeholder="期望答案（多个用 | 分隔）" value={d.fillAnswerText} onChange={(e) => onChange({ ...d, fillAnswerText: e.target.value })} style={{ ...input, marginBottom: 6 }} />
      )}
      {(d.type === 'scale' || d.type === 'open') && (
        <p style={{ fontSize: 12, color: '#9ca3af', margin: '4px 0 8px' }}>
          {d.type === 'scale' ? '量表题 1-5 分自评，不作答判分' : '简答/开放题，学生提交后由教师批阅'}
        </p>
      )}
      <div style={{ marginTop: 10 }}>
        <button style={btnPrimary} onClick={onSave}>保存题目</button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════

function QuestionBankSection({ notice }: { notice: (m: string, ok?: boolean) => void }) {
  const [questions, setQuestions] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<QuestionDraft>(EMPTY_DRAFT);
  const [editing, setEditing] = useState(false);
  const [importText, setImportText] = useState('');
  const [showImport, setShowImport] = useState(false);

  const reload = useCallback(() => {
    invoke<any>('exambank.question.list').then((r) => {
      if (r?.success) setQuestions(r.questions);
      else notice(r?.error || '加载题库失败', false);
    }).catch((e) => notice(String(e), false));
  }, [notice]);

  useEffect(() => { reload(); }, [reload]);

  const save = async () => {
    const d = draft;
    if (!d.stem.trim()) return notice('题干不能为空', false);
    const payload: any = {
      id: d.id,
      type: d.type,
      stem: d.stem,
      score: d.score,
      tags: d.tags.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
    };
    if (d.type === 'single' || d.type === 'multi') {
      payload.options = d.options.filter((o) => o.text.trim());
      if (payload.options.length < 2) return notice('至少需要两个非空选项', false);
      if (!d.answer.length) return notice('请勾选正确答案', false);
      payload.answer = d.answer;
    } else if (d.type === 'boolean') {
      payload.options = [{ key: 'true', text: '正确' }, { key: 'false', text: '错误' }];
      if (!d.answer.length) return notice('请勾选正确答案', false);
      payload.answer = d.answer;
    } else if (d.type === 'fill') {
      const answers = d.fillAnswerText.split('|').map((s) => s.trim()).filter(Boolean);
      if (!answers.length) return notice('请填写期望答案', false);
      payload.answer = answers;
    }
    try {
      const r = await invoke<any>('exambank.question.save', payload);
      if (r?.success) { notice('题目已保存'); setDraft(EMPTY_DRAFT); setEditing(false); reload(); }
      else notice(r?.error || '保存失败', false);
    } catch (e) { notice(String(e), false); }
  };

  const del = async (id: string) => {
    const r = await invoke<any>('exambank.question.delete', { id }).catch((e) => ({ success: false, error: String(e) }));
    if (r?.success) { notice('已删除'); reload(); } else notice(r?.error || '删除失败', false);
  };

  const doImport = async () => {
    let list: any[];
    try { list = JSON.parse(importText); } catch { return notice('JSON 解析失败', false); }
    if (!Array.isArray(list)) return notice('需要题目数组', false);
    const r = await invoke<any>('exambank.question.import', { questions: list });
    if (r?.success) { notice(`成功导入 ${r.imported} 题`); setImportText(''); setShowImport(false); reload(); }
    else notice(r?.error || '导入失败', false);
  };

  const filtered = questions.filter(
    (q) => !search || q.stem.includes(search) || (q.tags ?? []).some((t: string) => t.includes(search)),
  );

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 16, height: '100%', minHeight: 0 }}>
      <div style={{ overflow: 'auto', minHeight: 0 }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <button style={btnPrimary} onClick={() => { setDraft(EMPTY_DRAFT); setEditing(true); }}>+ 新建题目</button>
          <button style={btn} onClick={() => setShowImport(!showImport)}>批量导入</button>
        </div>
        {showImport && (
          <div style={{ marginBottom: 12 }}>
            <textarea placeholder='粘贴 JSON 数组，如 [{"type":"single","stem":"...","options":[{"key":"A","text":"..."}],"answer":["A"]}]' value={importText} onChange={(e) => setImportText(e.target.value)} style={{ ...input, minHeight: 100, fontFamily: 'monospace', fontSize: 12 }} />
            <button style={{ ...btnPrimary, marginTop: 6 }} onClick={doImport}>执行导入</button>
          </div>
        )}
        {editing && (
          <div style={{ marginBottom: 12 }}>
            <QuestionEditor
              draft={draft}
              onChange={setDraft}
              onSave={save}
            />
          </div>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <input placeholder="搜索题干 / 标签…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ ...input, marginBottom: 10 }} />
        <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtered.map((q) => (
            <div key={q.id} style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <span style={{ fontSize: 11, color: '#6d28d9', background: '#f5f3ff', padding: '2px 8px', borderRadius: 6, marginRight: 8 }}>{TYPE_LABELS[q.type] || q.type}</span>
                  {q.score != null && <span style={{ fontSize: 11, color: '#6b7280' }}>{q.score} 分</span>}
                  <p style={{ margin: '6px 0', fontSize: 13 }}>{q.stem}</p>
                  {q.options && (
                    <p style={{ margin: 0, fontSize: 12, color: '#6b7280' }}>
                      {q.options.map((o: any) => o.key).join(' / ')}
                      {q.answer?.length ? ` 答: ${q.answer.join(',')}` : ''}
                    </p>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  <button style={btn} onClick={() => { setDraft({
                    id: q.id, type: q.type, stem: q.stem,
                    options: q.options?.length ? q.options : [{ key: 'A', text: '' }, { key: 'B', text: '' }],
                    answer: q.answer ?? [], fillAnswerText: (q.answer ?? []).join('|'), score: q.score ?? 1,
                    tags: (q.tags ?? []).join(','),
                  }); setEditing(true); }}>编辑</button>
                  <button style={{ ...btn, color: '#dc2626', borderColor: '#fecaca' }} onClick={() => del(q.id)}>删除</button>
                </div>
              </div>
            </div>
          ))}
          {filtered.length === 0 && <p style={{ color: '#9ca3af', fontSize: 13 }}>暂无题目，先在左侧新建或导入。</p>}
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// 2. 组卷 / 问卷设计
// ════════════════════════════════════════════════════════════════════════

function SurveyDesigner({ notice }: { notice: (m: string, ok?: boolean) => void }) {
  const [questions, setQuestions] = useState<any[]>([]);
  const [surveys, setSurveys] = useState<any[]>([]);
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<'quiz' | 'survey'>('quiz');
  const [identity, setIdentity] = useState<'realname' | 'anonymous'>('realname');
  const [examMode, setExamMode] = useState(false);
  const [timeLimitMin, setTimeLimitMin] = useState(0);
  const [picked, setPicked] = useState<string[]>([]);

  const reload = useCallback(async () => {
    const [qs, ss] = await Promise.all([invoke<any>('exambank.question.list'), invoke<any>('exambank.survey.list')]);
    if (qs?.success) setQuestions(qs.questions);
    if (ss?.success) setSurveys(ss.surveys);
  }, []);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { setIdentity(mode === 'survey' ? 'anonymous' : 'realname'); }, [mode]);

  const saveSurvey = async () => {
    if (!title.trim()) return notice('请填写标题', false);
    if (!picked.length) return notice('请至少选择一道题目', false);
    const r = await invoke<any>('exambank.survey.save', {
      title: title.trim(), mode, identity_mode: identity, question_ids: picked,
      config: mode === 'quiz' && examMode ? { examMode: true, timeLimitSec: timeLimitMin > 0 ? timeLimitMin * 60 : 0 } : {},
    });
    if (r?.success) { notice('已保存为草稿'); setTitle(''); setPicked([]); reload(); }
    else notice(r?.error || '保存失败', false);
  };

  const publish = async (id: string) => {
    const r = await invoke<any>('exambank.survey.publish', { id });
    if (r?.success) { notice('已发布，学生端将实时收到答题推送'); reload(); }
    else notice(r?.error || '发布失败', false);
  };

  const close = async (id: string) => {
    const r = await invoke<any>('exambank.survey.close', { id });
    if (r?.success) { notice('已关闭'); reload(); } else notice(r?.error || '关闭失败', false);
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 16, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, overflow: 'auto' }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input placeholder="试卷/问卷标题" value={title} onChange={(e) => setTitle(e.target.value)} style={{ ...input, flex: 1 }} />
          <select value={mode} onChange={(e) => setMode(e.target.value as any)} style={{ ...input, width: 120 }}>
            <option value="quiz">随堂测验</option>
            <option value="survey">问卷调查</option>
          </select>
          <select value={identity} onChange={(e) => setIdentity(e.target.value as any)} style={{ ...input, width: 110 }} disabled={mode === 'quiz'}>
            <option value="realname">实名作答</option>
            <option value="anonymous">匿名作答</option>
          </select>
        </div>
        <div style={{ fontSize: 12, color: '#9ca3af' }}>已选 {picked.length} 题</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {questions.map((q) => (
            <label key={q.id} style={{ ...card, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '8px 12px' }}>
              <input
                type="checkbox"
                checked={picked.includes(q.id)}
                onChange={() => setPicked(picked.includes(q.id) ? picked.filter((x) => x !== q.id) : [...picked, q.id])}
              />
              <span style={{ fontSize: 11, color: '#6d28d9' }}>{TYPE_LABELS[q.type]}</span>
              <span style={{ fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.stem}</span>
            </label>
          ))}
        </div>
        {mode === 'quiz' && (
          <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 14, padding: '10px 14px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
              <input type="checkbox" checked={examMode} onChange={(e) => setExamMode(e.target.checked)} />
              🔒 考试模式（全屏锁定）
            </label>
            {examMode && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                限时（分钟，0 不限）：
                <input type="number" min={0} value={timeLimitMin} onChange={(e) => setTimeLimitMin(Number(e.target.value) || 0)}
                  style={{ ...input, width: 70 }} />
              </label>
            )}
          </div>
        )}
        <button style={{ ...btnPrimary, alignSelf: 'flex-start' }} onClick={saveSurvey}>保存草稿</button>
      </div>
      <div style={{ overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <p style={{ fontSize: 13, fontWeight: 600, color: '#374151', margin: 0 }}>已创建的卷 / 问卷</p>
        {surveys.map((s) => (
          <div key={s.id} style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong style={{ fontSize: 13 }}>{s.title}</strong>
              <span style={{
                fontSize: 11, padding: '2px 8px', borderRadius: 6,
                background: s.status === 'published' ? '#dcfce7' : s.status === 'closed' ? '#f3f4f6' : '#fef3c7',
                color: s.status === 'published' ? '#166534' : s.status === 'closed' ? '#6b7280' : '#92400e',
              }}>
                {s.status === 'published' ? '进行中' : s.status === 'closed' ? '已关闭' : '草稿'}
              </span>
            </div>
            <p style={{ fontSize: 11, color: '#9ca3af', margin: '4px 0 8px' }}>
              {s.mode === 'quiz' ? '随堂测验' : '问卷'} · {s.identity_mode === 'anonymous' ? '匿名' : '实名'} · {s.question_ids?.length ?? 0} 题
            </p>
            <div style={{ display: 'flex', gap: 6 }}>
              {s.status === 'draft' && <button style={btnPrimary} onClick={() => publish(s.id)}>发布</button>}
              {s.status === 'published' && <button style={{ ...btn, color: '#dc2626', borderColor: '#fecaca' }} onClick={() => close(s.id)}>关闭</button>}
            </div>
          </div>
        ))}
        {surveys.length === 0 && <p style={{ color: '#9ca3af', fontSize: 13 }}>暂无草稿或问卷。</p>}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// 3. 统计报告
// ════════════════════════════════════════════════════════════════════════

function StatsReport({ notice, focusSurveyId }: { notice: (m: string, ok?: boolean) => void; focusSurveyId?: string }) {
  const [surveys, setSurveys] = useState<any[]>([]);
  const [selected, setSelected] = useState<string>(focusSurveyId ?? '');
  const [stats, setStats] = useState<any>(null);
  const submittingRef = useRef(false);

  const reloadList = useCallback(async () => {
    const r = await invoke<any>('exambank.survey.list');
    if (r?.success) {
      setSurveys(r.surveys);
      if (!selected && r.surveys.length) setSelected(r.surveys[0].id);
    }
  }, [selected]);

  const loadStats = useCallback(async (id: string) => {
    if (!id) return;
    try {
      setStats(await fetchTeacherStats(id));
    } catch (e) { notice(String(e), false); }
  }, [notice]);

  useEffect(() => { reloadList(); }, [reloadList]);
  useEffect(() => { if (selected) loadStats(selected); }, [selected, loadStats]);

  // 实时增量刷新（订阅 socket 统计事件）
  useEffect(() => {
    if (!ctx?.services?.socketService || !selected) return;
    const socket = ctx.services.socketService;
    const handler = (data: any) => {
      if (data?.surveyId === selected && !submittingRef.current) loadStats(selected);
    };
    socket.on('exambank-stats-update', handler);
    return () => socket.off('exambank-stats-update', handler);
  }, [selected, loadStats, submittingRef]);

  if (!stats) {
    return <p style={{ color: '#9ca3af', fontSize: 13 }}>选择一份卷 / 问卷查看统计。</p>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <select value={selected} onChange={(e) => setSelected(e.target.value)} style={{ ...input, width: 260 }}>
          {surveys.map((s) => (
            <option key={s.id} value={s.id}>{s.title}</option>
          ))}
        </select>
        <button style={btn} onClick={() => loadStats(selected)}>刷新</button>
        <span style={{ fontSize: 12, color: '#6b7280' }}>
          {stats.submission_count} 份作答
          {stats.mode === 'quiz' && stats.avg_score != null ? ` · 平均 ${stats.avg_score} / ${stats.max_score} 分` : ''}
        </span>
      </div>
      <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {stats.questions.map((q: any) => (
          <div key={q.question_id} style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 11, color: '#6d28d9', background: '#f5f3ff', padding: '2px 8px', borderRadius: 6 }}>{TYPE_LABELS[q.type]}</span>
              <span style={{ fontSize: 12, color: '#6b7280' }}>作答 {q.answered_count}{q.type !== 'scale' && q.type !== 'open' ? ` · 正确 ${q.correct_count}` : ''}</span>
            </div>
            <p style={{ margin: '0 0 10px', fontSize: 13 }}>{q.stem}</p>
            {q.option_distribution && (
              <div>
                {Object.entries(q.option_distribution).map(([k, v]) => (
                  <BarRow key={k} label={k} count={v as number} total={q.answered_count} />
                ))}
              </div>
            )}
            {q.scale_mean != null && (
              <p style={{ fontSize: 13, color: '#4f46e5', fontWeight: 600 }}>平均评分：{q.scale_mean} / 5</p>
            )}
            {q.fill_top && (
              <div>{q.fill_top.slice(0, 5).map((f: any) => (
                <BarRow key={f.value} label={f.value} count={f.count} total={q.answered_count} color="#0ea5e9" />
              ))}</div>
            )}
            {q.open_answers && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {q.open_answers.slice(0, 10).map((a: any) => (
                  <p key={a.submission_id} style={{ fontSize: 12, color: '#374151', margin: 0, padding: '4px 8px', background: '#f9fafb', borderRadius: 6 }}>
                    {a.text}
                  </p>
                ))}
              </div>
            )}
          </div>
        ))}
        {stats.roster && stats.roster.length > 0 && (
          <div style={card}>
            <p style={{ fontSize: 13, fontWeight: 600, margin: '0 0 6px' }}>成绩明细</p>
            {stats.roster.slice(0, 30).map((r: any) => (
              <div key={r.student_id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0', borderBottom: '1px solid #f3f4f6' }}>
                <span>{r.student_id}</span>
                <span>{r.total_score} 分</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// 4. 教师主 Tab 面板
// ════════════════════════════════════════════════════════════════════════

function MainTabPanel() {
  const [view, setView] = useState<'bank' | 'design' | 'stats'>('bank');
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notice = useCallback((msg: string, ok = true) => {
    setToast({ msg, ok });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);

  return (
    <div style={{ padding: 20, height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {([['bank', '题库'], ['design', '组卷与问卷'], ['stats', '统计报告']] as const).map(([v, l]) => (
          <button key={v} onClick={() => setView(v)} style={v === view ? btnPrimary : btn}>{l}</button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {view === 'bank' && <QuestionBankSection notice={notice} />}
        {view === 'design' && <SurveyDesigner notice={notice} />}
        {view === 'stats' && <StatsReport notice={notice} />}
      </div>
      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          padding: '10px 20px', borderRadius: 10, fontSize: 13,
          background: toast.ok ? '#ecfdf5' : '#fef2f2', color: toast.ok ? '#065f46' : '#991b1b',
          border: `1px solid ${toast.ok ? '#a7f3d0' : '#fecaca'}`, zIndex: 10000,
        }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// 5. 课堂工具按钮（防挤压：面板 createPortal 到 body）
// ════════════════════════════════════════════════════════════════════════

function ClassroomToolButton() {
  const [isOpen, setIsOpen] = useState(false);
  const [surveys, setSurveys] = useState<any[]>([]);
  const [submitStats, setSubmitStats] = useState<{ surveyId: string; count: number } | null>(null);

  const loadSurveys = useCallback(() => {
    invoke<any>('exambank.survey.list').then((r) => {
      if (r?.success) setSurveys(r.surveys.filter((s: any) => s.status !== 'closed'));
    }).catch(() => {});
  }, []);

  useEffect(() => { if (isOpen) loadSurveys(); }, [isOpen, loadSurveys]);

  useEffect(() => {
    if (!ctx?.services?.socketService) return;
    const socket = ctx.services.socketService;
    const onSubmitted = (data: any) => setSubmitStats({ surveyId: data.surveyId, count: data.submissionCount });
    socket.on('exambank-stats-update', onSubmitted);
    return () => socket.off('exambank-stats-update', onSubmitted);
  }, []);

  return (
    <>
      <button
        onClick={() => setIsOpen(!isOpen)}
        style={{
          width: 40, height: 40, borderRadius: '50%', border: 'none', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
          background: isOpen ? '#4f46e5' : '#f3f4f6', color: isOpen ? '#fff' : '#374151',
        }}
        title="题库与随堂测验"
      >
        ✎
      </button>
      {isOpen && createPortal(
        <div style={{
          position: 'fixed', top: 96, right: 24, width: 340, maxHeight: '70vh', overflow: 'auto',
          background: '#fff', borderRadius: 14, boxShadow: '0 16px 40px rgba(0,0,0,0.18)', padding: 16, zIndex: 9999,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>课堂快速发布</h3>
            <button style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 15 }} onClick={() => setIsOpen(false)}>✕</button>
          </div>
          {submitStats && (
            <p style={{ fontSize: 12, color: '#4f46e5', margin: '0 0 8px' }}>
              最新提交：{submitStats.count} 份
            </p>
          )}
          {surveys.filter((s: any) => s.status === 'draft' || s.status === 'published').map((s: any) => (
            <div key={s.id} style={{ ...card, display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, padding: '8px 12px' }}>
              <div>
                <p style={{ margin: 0, fontSize: 13 }}>{s.title}</p>
                <p style={{ margin: 0, fontSize: 11, color: '#9ca3af' }}>
                  {s.mode === 'quiz' ? '测验' : '问卷'} · {s.status === 'published' ? '进行中' : '草稿'}
                </p>
              </div>
              {s.status === 'draft' ? (
                <button style={{ ...btn, fontSize: 12 }} onClick={async () => {
                  const r = await invoke<any>('exambank.survey.publish', { id: s.id });
                  if (r?.success) { ctx?.services?.uiService?.showToast?.('已发布', '学生端已收到实时推送', 'success'); loadSurveys(); }
                }}>发布</button>
              ) : (
                <button style={{ ...btn, fontSize: 12 }} onClick={async () => {
                  await invoke('exambank.survey.close', { id: s.id });
                  loadSurveys();
                }}>关闭</button>
              )}
            </div>
          ))}
          {surveys.filter((s: any) => s.status !== 'closed').length === 0 && (
            <p style={{ fontSize: 13, color: '#9ca3af' }}>暂无可发布的卷/问卷，请到「题库与测验」页创建。</p>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

// ════════════════════════════════════════════════════════════════════════
// 6. 学生答题视图（student.view 仪表盘槽位 + student.classroom.overlay 课中浮层槽位）
// ════════════════════════════════════════════════════════════════════════

/** 单槽位设计：仅 student.classroom.overlay 渲染答题弹窗（课中场景），无多实例冲突 */

/** 插件专属 socket：宿主 SocketService 绑定的首条连接不在 class 房间（页面多连接竞态），
 *  自建连接 + 主动 join-room 保证实时推送可达。单例复用。 */
let pluginSocket: ReturnType<typeof io> | null = null;
function getPluginSocket() {
  if (!pluginSocket || pluginSocket.disconnected) {
    pluginSocket = io({ transports: ['websocket', 'polling'] });
  }
  return pluginSocket;
}

function StudentAnswerView(props: { lessonId?: string; studentId?: string }) {
  const [active, setActive] = useState<any | null>(null); // { surveyId, title, mode, identity_mode, questions }
  const [answersMap, setAnswersMap] = useState<Record<string, any>>({});
  const [submitted, setSubmitted] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [history, setHistory] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('exambank:submitted') ?? '[]'); } catch { return []; }
  });

  const submitRef = useRef(false);

  // 考试倒计时：publishedAt + timeLimitSec → 剩余秒数
  // 场景区分：考试进行中加入（到期自动交卷） vs 考试结束后加入（显示已结束，不交空卷）
  const mountAtRef = useRef(Date.now());
  const endsAt = active?.config?.timeLimitSec > 0 && active?.publishedAt ? active.publishedAt + active.config.timeLimitSec * 1000 : null;
  const examLiveAtMount = endsAt === null ? null : endsAt > mountAtRef.current;
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    if (!endsAt) return;
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [endsAt]);
  const remainingSec = endsAt ? Math.max(0, Math.round((endsAt - nowTick) / 1000)) : null;
  useEffect(() => {
    if (examLiveAtMount && endsAt && remainingSec === 0 && active && !submitRef.current) {
      console.info('[exam-bank] 考试时间到，自动交卷');
      submit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remainingSec]);

  // 晚进/刷新恢复：挂载时主动查询本课节进行中的卷（脱敏，无标准答案）
  useEffect(() => {
    const lessonId = props.lessonId || ctx?.context?.get?.()?.lessonId;
    if (!lessonId) return;
    invoke('exambank.survey.active_for_lesson', { lessonId })
      .then((r: any) => {
        const act = r?.active;
        // 关键：把本插件持有的 socket 拉进班级房间 —— 页面存在多条 socket 连接，
        // 宿主 SocketService 绑定的首条连接未加入 class 房间，实时推送收不到。
        // 服务端 join-room 处理器幂等，重复 join 无副作用。
        if (act?.classId && ctx?.services?.socketService) {
          ctx.services.socketService.emit('join-room', `class-${act.classId}`);
        }
        if (act?.survey && !submitRef.current) {
          setActive({
            surveyId: act.survey.id,
            title: act.survey.title,
            mode: act.survey.mode,
            identity_mode: act.survey.identity_mode,
            config: act.survey.config,
            publishedAt: act.survey.published_at,
            questions: act.questions,
          });
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 实时推送：使用插件专属 socket（自 join 班级房间，重连自动重入）。
  // 不用宿主 SocketService —— 它绑定的首条连接未加入 class 房间（页面存在多条
  // socket 连接，房间成员在课节视图的私有连接上）。
  useEffect(() => {
    const socket = getPluginSocket();
    const onState = (data: any) => {
      console.info('[exam-bank] survey-state push received:', data?.action, data?.surveyId);
      if (data.action === 'published') {
        setSubmitted(false); setResult(null); setAnswersMap({});
        if (history.includes(data.surveyId) && data.mode === 'quiz') return;
        setSubmittedFlag(!!history.includes(data.surveyId));
        setActive({ ...data, publishedAt: Date.now() });
      } else if (data.action === 'closed') {
        if (active?.surveyId === data.surveyId) setActive(null);
      }
    };
    const joinClassRoom = () => {
      const lessonId = props.lessonId || ctx?.context?.get?.()?.lessonId;
      if (!lessonId) return;
      invoke('exambank.survey.active_for_lesson', { lessonId })
        .then((r: any) => {
          console.info('[exam-bank] restore response:', JSON.stringify(r).slice(0, 240));
          const act = r?.active;
          if (act?.classId) socket.emit('join-room', `class-${act.classId}`);
          if (act?.survey && !submitRef.current) {
            setActive({
              surveyId: act.survey.id,
              title: act.survey.title,
              mode: act.survey.mode,
              identity_mode: act.survey.identity_mode,
              config: act.survey.config,
              publishedAt: act.survey.published_at,
              questions: act.questions,
            });
          }
        })
        .catch(() => {});
    };
    socket.on('exambank-survey-state', onState);
    socket.on('connect', joinClassRoom);
    joinClassRoom();
    return () => {
      socket.off('exambank-survey-state', onState);
      socket.off('connect', joinClassRoom);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.lessonId, active, history]);

  function setSubmittedFlag(v: boolean) { setSubmitted(v); }

  const submit = async () => {
    if (!active || submitRef.current) return;
    submitRef.current = true;
    const token = (() => {
      let t = localStorage.getItem('exambank:anon_token');
      if (!t) { t = crypto.randomUUID(); localStorage.setItem('exambank:anon_token', t); }
      return t;
    })();
    const answers = active.questions.map((q: any) => ({ question_id: q.id, answer: answersMap[q.id] ?? '' }));
    try {
      const r = await invoke<any>('exambank.answer.submit', {
        surveyId: active.surveyId,
        student_id: props.studentId || null,
        anonymous_token: active.identity_mode === 'anonymous' ? token : undefined,
        answers,
      });
      if (r?.success) {
        setResult(r.submit ?? true);
        setSubmitted(true);
        setHistory((prev) => {
          const next = prev.includes(active.surveyId) ? prev : [...prev, active.surveyId];
          localStorage.setItem('exambank:submitted', JSON.stringify(next));
          return next;
        });
      } else {
        ctx?.services?.uiService?.showToast?.('提交失败', r?.error ?? '', 'error');
      }
    } finally {
      submitRef.current = false;
    }
  };

  if (result) {
    return (
      <div style={{ padding: 24 }}>
        <h2 style={{ fontSize: 18, color: '#065f46' }}>已提交 ✓</h2>
        {active?.mode === 'quiz' && typeof result === 'object' && result && (
          <p style={{ fontSize: 14 }}>得分：{result.totalScore} / {result.maxScore}</p>
        )}
        {active?.mode === 'survey' && <p style={{ fontSize: 14 }}>感谢你的参与！</p>}
      </div>
    );
  }

  if (!active) return null;

  const setAnswer = (qid: string, v: any) => setAnswersMap((prev) => ({ ...prev, [qid]: v }));

  // ── 考试模式（config.examMode）：全屏锁定接管视图 ──
  if (active.config?.examMode && examLiveAtMount === false) {
    // 考试已结束才加入：显示结束态，不交空卷
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ textAlign: 'center', color: '#e2e8f0' }}>
          <div style={{ fontSize: 42, marginBottom: 12 }}>⏱</div>
          <h2 style={{ fontSize: 18, margin: '0 0 8px' }}>{active.title}</h2>
          <p style={{ fontSize: 13, color: '#94a3b8', margin: 0 }}>考试时间已结束，无法再进入作答。</p>
        </div>
      </div>
    );
  }
  if (active.config?.examMode) {
    return (
      <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: '#0f172a', overflow: 'auto', color: '#e2e8f0' }}>
        <div style={{ position: 'sticky', top: 0, background: '#0f172a', borderBottom: '1px solid #334155', padding: '14px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', zIndex: 5 }}>
          <div>
            <h2 style={{ fontSize: 17, margin: 0, color: '#fff' }}>🔒 {active.title}</h2>
            <p style={{ fontSize: 11, color: '#94a3b8', margin: '3px 0 0' }}>
              考试模式 · {active.mode === 'quiz' ? '实名作答' : active.identity_mode === 'anonymous' ? '匿名作答' : '作答中'} · 交卷前不可退出
            </p>
          </div>
          {active.config?.timeLimitSec > 0 && remainingSec !== null && (
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: remainingSec > 60 ? '#4ade80' : remainingSec > 10 ? '#facc15' : '#f87171' }}>
                {String(Math.floor(remainingSec / 60)).padStart(2, '0')}:{String(remainingSec % 60).padStart(2, '0')}
              </div>
              <div style={{ fontSize: 10, color: '#94a3b8' }}>剩余时间</div>
            </div>
          )}
        </div>
        <div style={{ maxWidth: 760, margin: '24px auto', padding: '0 20px 40px' }}>
          {active.questions.map((q: any, idx: number) => (
            <div key={q.id} style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 12, padding: 16, marginBottom: 14 }}>
              <p style={{ margin: '0 0 10px', fontSize: 14, color: '#e2e8f0' }}>
                <strong>{idx + 1}.</strong> {q.stem}
                {q.score != null && q.score > 0 ? <span style={{ fontSize: 11, color: '#64748b' }}>（{q.score} 分）</span> : null}
              </p>
              {(q.type === 'single' || q.type === 'boolean') &&
                (q.options ?? []).map((opt: any) => (
                  <label key={opt.key} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', cursor: 'pointer', color: '#cbd5e1' }}>
                    <input type="radio" name={`q-${q.id}`} checked={answersMap[q.id] === opt.key} onChange={() => setAnswer(q.id, opt.key)} />
                    <span style={{ fontSize: 13 }}>{opt.text}</span>
                  </label>
                ))}
              {q.type === 'multi' &&
                (q.options ?? []).map((opt: any) => (
                  <label key={opt.key} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', cursor: 'pointer', color: '#cbd5e1' }}>
                    <input
                      type="checkbox"
                      checked={(answersMap[q.id] ?? []).includes(opt.key)}
                      onChange={() => {
                        const cur: string[] = answersMap[q.id] ?? [];
                        setAnswer(q.id, cur.includes(opt.key) ? cur.filter((x) => x !== opt.key) : [...cur, opt.key]);
                      }}
                    />
                    <span style={{ fontSize: 13 }}>{opt.text}</span>
                  </label>
                ))}
              {q.type === 'fill' && (
                <input placeholder="在此填写答案…" value={answersMap[q.id] ?? ''} onChange={(e) => setAnswer(q.id, e.target.value)}
                  style={{ ...input, background: '#0f172a', borderColor: '#334155', color: '#e2e8f0' }} />
              )}
              {q.type === 'open' && (
                <textarea placeholder="在此作答…" value={answersMap[q.id] ?? ''} onChange={(e) => setAnswer(q.id, e.target.value)}
                  style={{ ...input, minHeight: 90, background: '#0f172a', borderColor: '#334155', color: '#e2e8f0' }} />
              )}
            </div>
          ))}
          <button style={{ ...btnPrimary, padding: '10px 32px' }} onClick={submit} disabled={submitted}>
            {submitted ? '已交卷' : '交卷'}
          </button>
        </div>
      </div>
    );
  }

  // 课中弹出形态：固定居中模态（学生上课中被锁定在课节视图，仪表盘槽位不可见）
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(15,23,42,0.45)', overflow: 'auto' }}>
      <div style={{ maxWidth: 760, margin: '40px auto', padding: 24, background: '#fff', borderRadius: 16, boxShadow: '0 20px 50px rgba(0,0,0,0.25)' }}>
      <h2 style={{ fontSize: 18, marginBottom: 4 }}>{active.title}</h2>
      <p style={{ fontSize: 12, color: '#9ca3af', margin: '0 0 16px' }}>
        {active.mode === 'quiz' ? '随堂测验' : '问卷调查'} · {active.identity_mode === 'anonymous' ? '匿名作答' : '实名作答'}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {active.questions.map((q: any, idx: number) => (
          <div key={q.id} style={card}>
            <p style={{ margin: '0 0 8px', fontSize: 14 }}>
              <strong>{idx + 1}.</strong> {q.stem}
              {q.score != null && q.score > 0 ? <span style={{ fontSize: 11, color: '#9ca3af' }}>（{q.score} 分）</span> : null}
            </p>
            {q.mediaUrl && <img src={q.mediaUrl} alt="" style={{ maxWidth: '100%', borderRadius: 8, marginBottom: 8 }} />}
            {(q.type === 'single' || q.type === 'boolean') &&
              (q.options ?? []).map((opt: any) => (
                <label key={opt.key} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name={`q-${q.id}`}
                    checked={answersMap[q.id] === opt.key}
                    onChange={() => setAnswer(q.id, opt.key)}
                  />
                  <span style={{ fontSize: 13 }}>{opt.text}</span>
                </label>
              ))}
            {q.type === 'multi' &&
              q.options.map((opt: any) => (
                <label key={opt.key} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={(answersMap[q.id] ?? []).includes(opt.key)}
                    onChange={() => {
                      const cur: string[] = answersMap[q.id] ?? [];
                      setAnswer(q.id, cur.includes(opt.key) ? cur.filter((x) => x !== opt.key) : [...cur, opt.key]);
                    }}
                  />
                  <span style={{ fontSize: 13 }}>{opt.text}</span>
                </label>
              ))}
            {q.type === 'fill' && (
              <input placeholder="在此填写答案…" value={answersMap[q.id] ?? ''} onChange={(e) => setAnswer(q.id, e.target.value)} style={input} />
            )}
            {q.type === 'scale' && (
              <div style={{ display: 'flex', gap: 10 }}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <label key={n} style={{ display: 'flex', gap: 4, alignItems: 'center', cursor: 'pointer', fontSize: 13 }}>
                    <input type="radio" name={`q-${q.id}`} checked={answersMap[q.id] === n} onChange={() => setAnswer(q.id, n)} />
                    {n}
                  </label>
                ))}
              </div>
            )}
            {q.type === 'open' && (
              <textarea placeholder="在此作答…" value={answersMap[q.id] ?? ''} onChange={(e) => setAnswer(q.id, e.target.value)} style={{ ...input, minHeight: 80 }} />
            )}
          </div>
        ))}
      </div>
      <button style={{ ...btnPrimary, marginTop: 16 }} onClick={submit} disabled={submitted}>
        {submitted ? '已提交' : '提交'}
      </button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// activate / deactivate
// ════════════════════════════════════════════════════════════════════════

async function activate(hostCtx: any) {
  ctx = hostCtx;
  console.info('[exam-bank] plugin frontend activating, manifest =', hostCtx?.manifest?.id);
  (window as any).__examBankActivated = true;

  // 注册 1：教师侧边栏标签页
  hostCtx.ui.registerExtensionPoint('teacher.tab', {
    id: 'exam-bank-manager',
    label: '题库与测验',
    icon: 'BookOpen',
    component: MainTabPanel,
    position: 20,
  });

  // 注册 2：课堂白板工具架（classroomTools 里的声明需与此对应）
  hostCtx.ui.registerExtensionPoint('classroom.tool', {
    id: 'exam-bank-quick-publish',
    name: '快速发布测验/问卷',
    component: ClassroomToolButton,
  });

  // 注册 3：课中浮层（学生上课被锁定在课节视图时的答题弹窗入口）。
  // 注意：不再同时注册 student.view 仪表盘槽位 —— 多实例会因共享 socket 监听
  // 与状态而重复弹窗；课中场景由 overlay 单实例覆盖。
  hostCtx.ui.registerExtensionPoint('student.classroom.overlay', {
    id: 'exam-bank-overlay',
    label: '随堂测验/问卷弹窗',
    component: StudentAnswerView,
  });
  console.info('[exam-bank] extension points registered (overlay slot), window flag set');
  (window as any).__examBankRegistered = true;
}

function deactivate() {
  if (ctx?.ui) {
    ctx.ui.unregisterExtensionPoint?.('teacher.tab', 'exam-bank-manager');
    ctx.ui.unregisterExtensionPoint?.('classroom.tool', 'exam-bank-quick-publish');
    ctx.ui.unregisterExtensionPoint?.('student.classroom.overlay', 'exam-bank-overlay');
  }
  ctx = null;
}

export default { activate, deactivate };
