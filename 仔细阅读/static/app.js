
    /* =========================================================
       CET-6 仔细阅读 (Careful Reading)  —  前端 + DeepSeek(经后端)
       ========================================================= */
    'use strict';

    const APP_DIR = '仔细阅读';

    // ---- global state ----
    const state = {
        exercise: null,
        stage: 'source',
        reached: { source: true },
        selections: {},     // {1:'A', 2:'C', ...}
        scored: false
    };

    // ---- timer ----
    const timer = { handle: null, deadline: 0, remain: 0, paused: false, mins: 15 };

    document.addEventListener('DOMContentLoaded', () => {
        renderStepper();
        checkHealth();
    });

    function currentModel() {
        return document.getElementById('modelSelect').value || null;
    }

    async function checkHealth() {
        const backEl = document.getElementById('statusBackend');
        const keyEl = document.getElementById('statusKey');
        const hintEl = document.getElementById('statusHint');
        try {
            const res = await fetch('/api/health');
            const d = await res.json();
            backEl.innerHTML = '🔌 后端：<span class="ok">已连接</span>';
            if (d.hasKey) {
                keyEl.innerHTML = '🔑 DeepSeek Key：<span class="ok">已配置</span>';
                hintEl.textContent = '';
            } else {
                keyEl.innerHTML = '🔑 DeepSeek Key：<span class="err">未配置</span>';
                hintEl.textContent = '请在 ' + APP_DIR + '/.env 设置 DEEPSEEK_API_KEY（可复制 .env.example）';
            }
        } catch (e) {
            backEl.innerHTML = '🔌 后端：<span class="err">未连接</span>';
            keyEl.textContent = '';
            hintEl.textContent = '请先启动后端：在 ' + APP_DIR + '/ 目录运行 python app.py';
        }
    }

    /* ============== STEPPER / STAGES ============== */
    const STAGES = ['source', 'answer', 'score'];
    const STAGE_LABEL = { source: '出题', answer: '做题', score: '评分' };
    function renderStepper() {
        const wrap = document.getElementById('stepper');
        wrap.innerHTML = '';
        STAGES.forEach((s, i) => {
            const el = document.createElement('div');
            const cur = state.stage === s;
            const done = STAGES.indexOf(state.stage) > i;
            el.className = 'step' + (cur ? ' active' : '') + (done ? ' done' : '') + (state.reached[s] ? ' reachable' : '');
            el.innerHTML = `<span class="dot">${done ? '✓' : (i + 1)}</span><span>${STAGE_LABEL[s]}</span>`;
            if (state.reached[s]) el.onclick = () => setStage(s);
            wrap.appendChild(el);
            if (i < STAGES.length - 1) {
                const ar = document.createElement('span'); ar.className = 'step-arrow'; ar.textContent = '›';
                wrap.appendChild(ar);
            }
        });
    }
    function setStage(s) {
        state.stage = s;
        STAGES.forEach(x => document.getElementById('stage-' + x).classList.toggle('hidden', x !== s));
        renderStepper();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    function reach(s) { state.reached[s] = true; }

    /* ============== BACKEND API ============== */
    async function apiPost(url, body) {
        let res;
        try {
            res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        } catch (e) {
            throw new Error('无法连接后端（请确认已运行 python app.py）：' + e.message);
        }
        let data = null;
        try { data = await res.json(); } catch (_) { /* non-json */ }
        if (!res.ok || !data) {
            throw new Error((data && data.error) || ('请求失败 (' + res.status + ')'));
        }
        return data;
    }
    function showLoading(msg) { document.getElementById('loadingText').textContent = msg || 'AI 思考中…'; document.getElementById('loadingOverlay').classList.add('show'); }
    function hideLoading() { document.getElementById('loadingOverlay').classList.remove('show'); }

    /* ============== GENERATE ============== */
    async function generateExercise() {
        const topic = document.getElementById('topicInput').value;
        showLoading('正在生成 CET-6 仔细阅读原文与题目…');
        try {
            const d = await apiPost('/api/generate', { topic, model: currentModel(), vocabCheck: document.getElementById('vocabChk').checked });
            loadExercise(d.exercise);
            const savedName = d.saved ? d.saved.split(/[\\/]/).pop() : '';
            toast(savedName ? ('已生成并存档：my/' + savedName) : '生成完成，开始作答', 'ok');
            reach('answer'); setStage('answer');
            startTimer();
        } catch (e) {
            toast(e.message || '生成失败', 'err');
            console.error(e);
        } finally {
            hideLoading();
        }
    }

    function loadExercise(d) {
        d.title = d.title || 'CET-6 仔细阅读';
        d.topic = d.topic || '';
        (d.questions || []).forEach(q => { q.explanation = q.explanation || ''; });
        state.exercise = d;
        state.selections = {};
        state.scored = false;
        document.getElementById('ansBadge').textContent = '📘 ' + (d.topic || d.title);
        renderPassage();
        renderAnswer();
    }

    function renderPassage() {
        const ex = state.exercise;
        const box = document.getElementById('passageBox');
        box.innerHTML = `<div class="passage-title">${escapeHtml(ex.title)}</div>` +
            '<div class="reading-passage">' + ex.passage.split(/\n+/).map(p => `<p>${escapeHtml(p)}</p>`).join('') + '</div>';
    }

    /* ============== ANSWER (MCQ) ============== */
    function renderAnswer() {
        const wrap = document.getElementById('answerContent');
        wrap.innerHTML = '';
        const qs = state.exercise.questions;
        document.getElementById('totalQ').textContent = qs.length;
        document.getElementById('answeredCount').textContent = 0;
        document.getElementById('scoreBtn').disabled = true;

        qs.forEach((q, i) => {
            const idx = i + 1;
            const block = document.createElement('div');
            block.className = 'question-block';
            const head = document.createElement('div');
            head.className = 'q-head';
            head.innerHTML = `<span class="q-num">Q${idx}</span>`;
            block.appendChild(head);
            const stem = document.createElement('div');
            stem.className = 'q-stem';
            stem.textContent = q.stem;
            block.appendChild(stem);
            ['A', 'B', 'C', 'D'].forEach(letter => {
                const opt = document.createElement('div');
                opt.className = 'option-item';
                opt.dataset.q = idx; opt.dataset.letter = letter;
                opt.innerHTML = `<div class="option-letter">${letter}</div><div class="option-text">${escapeHtml(q.options[letter])}</div>`;
                opt.onclick = () => selectOption(idx, letter, opt);
                block.appendChild(opt);
            });
            const exp = document.createElement('div');
            exp.className = 'answer-explanation';
            exp.id = 'exp-' + idx;
            exp.innerHTML = `<div class="exp-head"><h4>解析</h4><div class="correct-answer-pill">正确答案：${q.answer}</div></div>` +
                `<div class="explanation-text">${escapeHtml(q.explanation)}</div>`;
            block.appendChild(exp);
            wrap.appendChild(block);
        });
    }
    function selectOption(qIdx, letter, el) {
        const block = el.closest('.question-block');
        block.querySelectorAll('.option-item').forEach(o => o.classList.remove('selected'));
        el.classList.add('selected');
        state.selections[qIdx] = letter;
        const answered = Object.keys(state.selections).length;
        document.getElementById('answeredCount').textContent = answered;
        document.getElementById('scoreBtn').disabled = (answered < state.exercise.questions.length);
    }

    /* ============== SCORE (本地) ============== */
    function submitScore() {
        stopTimer();
        const ex = state.exercise;
        let correct = 0;
        ex.questions.forEach((q, i) => {
            const idx = i + 1;
            const yourAns = state.selections[idx];
            document.getElementById('exp-' + idx).classList.add('show');
            document.querySelectorAll(`.option-item[data-q="${idx}"]`).forEach(o => {
                o.classList.remove('correct', 'wrong');
                if (o.dataset.letter === q.answer) o.classList.add('correct');
                else if (o.dataset.letter === yourAns) o.classList.add('wrong');
            });
            if (yourAns === q.answer) correct++;
        });
        state.scored = true;
        renderScore(correct, ex.questions.length);
        reach('score'); setStage('score');
        toast('评分完成 📊', 'ok');
    }

    function renderScore(correct, total) {
        const pct = total ? Math.round(correct / total * 100) : 0;
        const level = pct >= 80 ? '优秀' : pct >= 60 ? '良好' : pct >= 40 ? '中等' : '需加强';
        const wrap = document.getElementById('scoreContent');
        wrap.innerHTML = `
            <div class="score-wrap">
                <div class="score-ring" id="scoreRing" style="--p:0%"><div class="inner"><div class="num">${pct}</div><div class="lbl">正确率 / 100</div></div></div>
                <div class="level-badge level-${level}">${escapeHtml(level)} · ${correct}/${total} 正确</div>
                <p class="hint">已逐题揭示正确答案（绿）与你的选择（红），并附解析。</p>
            </div>`;
        setTimeout(() => { document.getElementById('scoreRing').style.setProperty('--p', pct + '%'); }, 60);
        document.getElementById('reviewContent').innerHTML = '';
    }

    /* ============== TIMER ============== */
    function startTimer() {
        timer.mins = Math.max(1, parseInt(document.getElementById('timerMinutes').value, 10) || 15);
        timer.deadline = Date.now() + timer.mins * 60000;
        timer.paused = false;
        document.getElementById('pauseBtn').textContent = '⏸️ 暂停';
        tickTimer();
        if (timer.handle) clearInterval(timer.handle);
        timer.handle = setInterval(tickTimer, 1000);
    }
    function tickTimer() {
        if (timer.paused) return;
        const remain = Math.max(0, Math.round((timer.deadline - Date.now()) / 1000));
        const el = document.getElementById('timerDisplay');
        el.textContent = formatTime(remain);
        el.classList.toggle('warn', remain <= 300 && remain > 60);
        el.classList.toggle('danger', remain <= 60 && remain > 0);
        if (remain <= 0) {
            stopTimer();
            toast('⏰ 时间到！', 'err');
            if (document.getElementById('strictChk').checked && state.stage === 'answer') {
                submitScore();
            }
        }
    }
    function togglePauseTimer() {
        if (!timer.handle) return;
        timer.paused = !timer.paused;
        if (timer.paused) {
            timer.remain = Math.max(0, Math.round((timer.deadline - Date.now()) / 1000));
            document.getElementById('pauseBtn').textContent = '▶️ 继续';
        } else {
            timer.deadline = Date.now() + timer.remain * 1000;
            document.getElementById('pauseBtn').textContent = '⏸️ 暂停';
        }
    }
    function resetTimer() {
        stopTimer();
        document.getElementById('timerDisplay').textContent = formatTime((parseInt(document.getElementById('timerMinutes').value, 10) || 15) * 60);
        document.getElementById('timerDisplay').classList.remove('warn', 'danger');
        startTimer();
    }
    function stopTimer() { if (timer.handle) { clearInterval(timer.handle); timer.handle = null; } }
    function formatTime(sec) {
        const m = Math.floor(sec / 60), s = sec % 60;
        return m + ':' + String(s).padStart(2, '0');
    }

    /* ============== UTIL ============== */
    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    let toastTimer = null;
    function toast(msg, type) {
        const el = document.getElementById('toast');
        el.textContent = msg;
        el.className = 'show' + (type === 'err' ? ' err' : type === 'ok' ? ' ok' : '');
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { el.className = ''; }, 4200);
    }
    function restart() {
        if (!confirm('开始新的一篇？当前内容将被替换。')) return;
        stopTimer();
        state.exercise = null; state.selections = {}; state.scored = false;
        state.reached = { source: true };
        setStage('source');
        document.getElementById('topicInput').value = '';
        toast('已重置，请输入主题或留空随机出题', 'ok');
    }
    async function saveExercise() {
        if (!state.exercise) { toast('当前没有可保存的练习', 'err'); return; }
        try {
            const d = await apiPost('/api/save', { exercise: state.exercise });
            toast('已保存到 my/' + (d.path || '').split(/[\\/]/).pop(), 'ok');
        } catch (e) {
            toast(e.message || '保存失败', 'err');
        }
    }
