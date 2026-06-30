
    /* =========================================================
       CET-6 写作 (Writing)  —  前端 + AI 评分(14档)
       ========================================================= */
    'use strict';

    const APP_DIR = '写作';
    const MIN_WORDS = 150, MAX_WORDS = 200;

    const state = {
        exercise: null,
        stage: 'source',
        reached: { source: true },
        answer: '',
        scored: false
    };
    const timer = { handle: null, deadline: 0, remain: 0, paused: false, mins: 30 };

    document.addEventListener('DOMContentLoaded', () => { renderStepper(); checkHealth(); });

    function currentModel() { return document.getElementById('modelSelect').value || null; }

    async function checkHealth() {
        const backEl = document.getElementById('statusBackend'), keyEl = document.getElementById('statusKey'), hintEl = document.getElementById('statusHint');
        try {
            const res = await fetch('/api/health'); const d = await res.json();
            backEl.innerHTML = '🔌 后端：<span class="ok">已连接</span>';
            if (d.hasKey) { keyEl.innerHTML = '🔑 DeepSeek Key：<span class="ok">已配置</span>'; hintEl.textContent = ''; }
            else { keyEl.innerHTML = '🔑 DeepSeek Key：<span class="err">未配置</span>'; hintEl.textContent = '请在 ' + APP_DIR + '/.env 设置 DEEPSEEK_API_KEY（可复制 .env.example）'; }
        } catch (e) {
            backEl.innerHTML = '🔌 后端：<span class="err">未连接</span>'; keyEl.textContent = '';
            hintEl.textContent = '请先启动后端：在 ' + APP_DIR + '/ 目录运行 python app.py';
        }
    }

    /* ===== STEPPER ===== */
    const STAGES = ['source', 'answer', 'score'];
    const STAGE_LABEL = { source: '出题', answer: '做题', score: '评分' };
    function renderStepper() {
        const wrap = document.getElementById('stepper'); wrap.innerHTML = '';
        STAGES.forEach((s, i) => {
            const el = document.createElement('div');
            const cur = state.stage === s, done = STAGES.indexOf(state.stage) > i;
            el.className = 'step' + (cur ? ' active' : '') + (done ? ' done' : '') + (state.reached[s] ? ' reachable' : '');
            el.innerHTML = `<span class="dot">${done ? '✓' : (i + 1)}</span><span>${STAGE_LABEL[s]}</span>`;
            if (state.reached[s]) el.onclick = () => setStage(s);
            wrap.appendChild(el);
            if (i < STAGES.length - 1) { const ar = document.createElement('span'); ar.className = 'step-arrow'; ar.textContent = '›'; wrap.appendChild(ar); }
        });
    }
    function setStage(s) {
        state.stage = s;
        STAGES.forEach(x => document.getElementById('stage-' + x).classList.toggle('hidden', x !== s));
        renderStepper(); window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    function reach(s) { state.reached[s] = true; }

    /* ===== API ===== */
    async function apiPost(url, body) {
        let res;
        try { res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
        catch (e) { throw new Error('无法连接后端（请确认已运行 python app.py）：' + e.message); }
        let data = null; try { data = await res.json(); } catch (_) {}
        if (!res.ok || !data) throw new Error((data && data.error) || ('请求失败 (' + res.status + ')'));
        return data;
    }
    function showLoading(msg) { document.getElementById('loadingText').textContent = msg || 'AI 思考中…'; document.getElementById('loadingOverlay').classList.add('show'); }
    function hideLoading() { document.getElementById('loadingOverlay').classList.remove('show'); }

    /* ===== GENERATE ===== */
    async function generateExercise() {
        const topic = document.getElementById('topicInput').value;
        showLoading('正在生成 CET-6 写作题…');
        try {
            const d = await apiPost('/api/generate', { topic, model: currentModel(), vocabCheck: document.getElementById('vocabChk').checked });
            loadExercise(d.exercise);
            const savedName = d.saved ? d.saved.split(/[\\/]/).pop() : '';
            toast(savedName ? ('已生成并存档：my/' + savedName) : '生成完成，开始写作', 'ok');
            reach('answer'); setStage('answer'); startTimer();
        } catch (e) { toast(e.message || '生成失败', 'err'); console.error(e); }
        finally { hideLoading(); }
    }

    function loadExercise(d) {
        d.topic = d.topic || 'CET-6 写作';
        state.exercise = d;
        state.answer = ''; state.scored = false;
        document.getElementById('ansBadge').textContent = '✍️ ' + (d.topic || '') + (d.prompt_type ? ' · ' + d.prompt_type : '');
        const outline = (d.outline && d.outline.length)
            ? `<div class="outline-box"><b>📝 写作思路参考</b><ul>${d.outline.map(o => `<li>${escapeHtml(o)}</li>`).join('')}</ul></div>` : '';
        document.getElementById('promptBox').innerHTML =
            `<div class="source-box">${escapeHtml(d.prompt || '')}</div>` + outline;
        document.getElementById('answerInput').value = '';
        updateWordCount();
        document.getElementById('scoreBtn').disabled = false;
    }

    function updateWordCount() {
        const v = document.getElementById('answerInput').value;
        const n = v.trim() ? v.trim().split(/\s+/).length : 0;
        const el = document.getElementById('wordCounter');
        el.textContent = n + ' 词' + (n < MIN_WORDS ? '（还差 ' + (MIN_WORDS - n) + '）' : n > MAX_WORDS ? '（超 ' + (n - MAX_WORDS) + '）' : ' ✓');
        el.className = 'word-counter ' + (n < MIN_WORDS ? 'short' : (n <= MAX_WORDS ? 'ok' : 'long'));
    }

    /* ===== SCORE (AI) ===== */
    async function submitScore() {
        const ex = state.exercise;
        const answer = document.getElementById('answerInput').value.trim();
        if (!answer) { if (!confirm('你还没有写作文，确定要提交评分吗？')) return; }
        stopTimer();
        state.answer = answer;
        showLoading('AI 正在评估你的作文…');
        try {
            const d = await apiPost('/api/evaluate', { exercise: ex, answer, model: currentModel() });
            renderScore(d.result || {});
            renderReference();
            state.scored = true;
            reach('score'); setStage('score');
            toast('评分完成 📊', 'ok');
        } catch (e) { toast(e.message || '评分失败', 'err'); console.error(e); startTimer(); }
        finally { hideLoading(); }
    }

    function renderScore(r) {
        const score = Math.max(0, Math.min(100, parseInt(r.score) || 0));
        const level = r.level || '中等';
        const wc = r.word_count || '—';
        const strengths = (Array.isArray(r.strengths) ? r.strengths : []).map(x => `<li>${escapeHtml(String(x))}</li>`).join('');
        const errors = (Array.isArray(r.errors) ? r.errors : []).map(x => `<li>${escapeHtml(String(x))}</li>`).join('');
        document.getElementById('scoreContent').innerHTML = `
            <div class="score-wrap">
                <div class="score-ring" id="scoreRing" style="--p:0%"><div class="inner"><div class="num">${score}</div><div class="lbl">写作得分 / 100</div></div></div>
                <div class="level-badge level-${escapeHtml(level)}">${escapeHtml(level)} · ${wc} 词</div>
                <div class="eval-grid">
                    <div class="eval-card"><h5>🎯 切题与论点</h5><p>${escapeHtml(r.task_achievement || '—')}</p></div>
                    <div class="eval-card"><h5>🧭 结构与连贯</h5><p>${escapeHtml(r.coherence || '—')}</p></div>
                    <div class="eval-card"><h5>📚 词汇</h5><p>${escapeHtml(r.vocab || '—')}</p></div>
                    <div class="eval-card"><h5>🔧 语法句式</h5><p>${escapeHtml(r.grammar || '—')}</p></div>
                    ${strengths ? `<div class="eval-card eval-full"><h5>✅ 亮点</h5><ul class="missed-list">${strengths}</ul></div>` : ''}
                    ${errors ? `<div class="eval-card eval-full"><h5>⚠️ 典型问题</h5><ul class="missed-list">${errors}</ul></div>` : ''}
                    <div class="eval-card eval-full"><h5>💡 提升建议</h5><p style="white-space:pre-line">${escapeHtml(r.feedback || '—')}</p></div>
                </div>
            </div>`;
        setTimeout(() => { document.getElementById('scoreRing').style.setProperty('--p', score + '%'); }, 60);
    }

    function renderReference() {
        const ex = state.exercise;
        const phrases = (ex.key_phrases || []).map(p => `<li>${escapeHtml(p)}</li>`).join('');
        document.getElementById('referenceContent').innerHTML = `
            <div class="reference-box"><h4>📝 参考范文（150–200 词）</h4>${escapeHtml(ex.sample_essay || '')}</div>
            ${phrases ? `<div class="key-terms-box"><h5>🔑 高级表达与句型</h5><ul>${phrases}</ul></div>` : ''}`;
    }

    /* ===== TIMER ===== */
    function startTimer() {
        timer.mins = Math.max(1, parseInt(document.getElementById('timerMinutes').value, 10) || 30);
        timer.deadline = Date.now() + timer.mins * 60000; timer.paused = false;
        document.getElementById('pauseBtn').textContent = '⏸️ 暂停';
        if (timer.handle) clearInterval(timer.handle);
        timer.handle = setInterval(tickTimer, 1000); tickTimer();
    }
    function tickTimer() {
        if (timer.paused) return;
        const remain = Math.max(0, Math.round((timer.deadline - Date.now()) / 1000));
        const el = document.getElementById('timerDisplay');
        el.textContent = formatTime(remain);
        el.classList.toggle('warn', remain <= 300 && remain > 60);
        el.classList.toggle('danger', remain <= 60 && remain > 0);
        if (remain <= 0) { stopTimer(); toast('⏰ 时间到！', 'err'); if (document.getElementById('strictChk').checked && state.stage === 'answer') submitScore(); }
    }
    function togglePauseTimer() {
        if (!timer.handle) return;
        timer.paused = !timer.paused;
        if (timer.paused) { timer.remain = Math.max(0, Math.round((timer.deadline - Date.now()) / 1000)); document.getElementById('pauseBtn').textContent = '▶️ 继续'; }
        else { timer.deadline = Date.now() + timer.remain * 1000; document.getElementById('pauseBtn').textContent = '⏸️ 暂停'; }
    }
    function resetTimer() { stopTimer(); document.getElementById('timerDisplay').classList.remove('warn', 'danger'); startTimer(); }
    function stopTimer() { if (timer.handle) { clearInterval(timer.handle); timer.handle = null; } }
    function formatTime(sec) { const m = Math.floor(sec / 60), s = sec % 60; return m + ':' + String(s).padStart(2, '0'); }

    /* ===== UTIL ===== */
    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    let toastTimer = null;
    function toast(msg, type) {
        const el = document.getElementById('toast'); el.textContent = msg;
        el.className = 'show' + (type === 'err' ? ' err' : type === 'ok' ? ' ok' : '');
        if (toastTimer) clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.className = ''; }, 4200);
    }
    function restart() {
        if (!confirm('开始新的一篇？当前内容将被替换。')) return;
        stopTimer();
        state.exercise = null; state.answer = ''; state.scored = false; state.reached = { source: true };
        setStage('source'); document.getElementById('topicInput').value = '';
        toast('已重置，请输入主题或留空随机出题', 'ok');
    }
    async function saveExercise() {
        if (!state.exercise) { toast('当前没有可保存的练习', 'err'); return; }
        try {
            const ex = Object.assign({}, state.exercise, { user_answer: state.answer });
            const d = await apiPost('/api/save', { exercise: ex });
            toast('已保存到 my/' + (d.path || '').split(/[\\/]/).pop(), 'ok');
        } catch (e) { toast(e.message || '保存失败', 'err'); }
    }
