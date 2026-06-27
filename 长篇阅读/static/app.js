
    /* =========================================================
       CET-6 长篇阅读 / 段落匹配 (Matching)  —  前端
       ========================================================= */
    'use strict';

    const APP_DIR = '长篇阅读';

    const state = {
        exercise: null,
        stage: 'source',
        reached: { source: true },
        sel: {},          // {36:'B', ...}
        labels: [],       // ['A','B',...]
        scored: false
    };
    const timer = { handle: null, deadline: 0, remain: 0, paused: false, mins: 15 };

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
        showLoading('正在生成 CET-6 长篇阅读（约 1200 词，可能需 30–60 秒）…');
        try {
            const d = await apiPost('/api/generate', { topic, model: currentModel() });
            loadExercise(d.exercise);
            const savedName = d.saved ? d.saved.split(/[\\/]/).pop() : '';
            toast(savedName ? ('已生成并存档：my/' + savedName) : '生成完成，开始作答', 'ok');
            reach('answer'); setStage('answer'); startTimer();
        } catch (e) { toast(e.message || '生成失败', 'err'); console.error(e); }
        finally { hideLoading(); }
    }

    function loadExercise(d) {
        d.title = d.title || 'CET-6 长篇阅读';
        state.exercise = d;
        state.sel = {}; state.scored = false;
        state.labels = (d.passage || []).map(p => p.label);
        document.getElementById('ansBadge').textContent = '📄 ' + (d.title || '');
        renderMatching();
    }

    function renderMatching() {
        const ex = state.exercise;
        const pbox = document.getElementById('passageBox');
        pbox.innerHTML = `<div class="passage-title">${escapeHtml(ex.title)}</div>` +
            ex.passage.map(p => `<div class="para" id="para-${p.label}" data-label="${p.label}"><span class="para-label">${p.label}.</span>${escapeHtml(p.text)}</div>`).join('');
        const sbox = document.getElementById('statementsBox'); sbox.innerHTML = '';
        const opts = ['<option value="">选段</option>'].concat(state.labels.map(L => `<option value="${L}">${L}</option>`)).join('');
        (ex.statements || []).forEach(st => {
            const card = document.createElement('div');
            card.className = 'statement-card'; card.id = 'st-' + st.no;
            card.innerHTML = `<div class="st-head"><span class="st-no">${st.no}</span></div>` +
                `<div class="st-text">${escapeHtml(st.text)}</div>` +
                `<div class="para-select-row"><span class="hint" style="margin:0">对应段落</span>` +
                `<select onchange="selectPara(${st.no}, this.value)" data-no="${st.no}">${opts}</select></div>`;
            sbox.appendChild(card);
        });
        document.getElementById('totalQ').textContent = (ex.statements || []).length;
        document.getElementById('answeredCount').textContent = '0';
        document.getElementById('scoreBtn').disabled = true;
    }

    function selectPara(no, letter) {
        if (letter) state.sel[no] = letter; else delete state.sel[no];
        // 短暂高亮所选段落
        document.querySelectorAll('.match-passage .para').forEach(p => p.classList.remove('hl'));
        if (letter) {
            const para = document.getElementById('para-' + letter);
            if (para) { para.classList.add('hl'); setTimeout(() => para.classList.remove('hl'), 1200); }
        }
        const answered = Object.keys(state.sel).length;
        document.getElementById('answeredCount').textContent = answered;
        document.getElementById('scoreBtn').disabled = (answered < (state.exercise.statements || []).length);
    }

    /* ===== SCORE (本地) ===== */
    function submitScore() {
        stopTimer();
        const ex = state.exercise; let correct = 0;
        const review = [];
        (ex.statements || []).forEach(st => {
            const ans = ex.answers[st.no];
            const yours = state.sel[st.no];
            const ok = yours === ans;
            if (ok) correct++;
            const card = document.getElementById('st-' + st.no);
            if (card) { card.classList.remove('correct', 'wrong'); card.classList.add(ok ? 'correct' : 'wrong'); }
            // 高亮正确段落
            if (ans) { const p = document.getElementById('para-' + ans); if (p) p.classList.add('hl'); }
            const exp = (ex.explanations || []).find(e => String(e.no) === String(st.no)) || {};
            review.push({ no: st.no, text: st.text, yours, ans, ok, paragraph: exp.paragraph || ans, clue: exp.clue || '' });
        });
        state.scored = true;
        renderScore(correct, (ex.statements || []).length);
        renderReview(review);
        reach('score'); setStage('score');
        toast('评分完成 📊', 'ok');
    }

    function renderScore(correct, total) {
        const pct = total ? Math.round(correct / total * 100) : 0;
        const level = pct >= 80 ? '优秀' : pct >= 60 ? '良好' : pct >= 40 ? '中等' : '需加强';
        document.getElementById('scoreContent').innerHTML = `
            <div class="score-wrap">
                <div class="score-ring" id="scoreRing" style="--p:0%"><div class="inner"><div class="num">${pct}</div><div class="lbl">正确率 / 100</div></div></div>
                <div class="level-badge level-${level}">${escapeHtml(level)} · ${correct}/${total} 正确</div>
                <p class="hint">正确段落已在原文中高亮；逐句解析见下。</p>
            </div>`;
        setTimeout(() => { document.getElementById('scoreRing').style.setProperty('--p', pct + '%'); }, 60);
    }

    function renderReview(review) {
        const rows = review.map(r => `
            <div class="question-block">
                <div class="q-head"><span class="q-num">${r.no}</span>
                    <span class="badge ${r.ok ? 'green' : 'warn'}">你选：${r.yours || '未选'} ${r.ok ? '✓' : '✗'}</span>
                    <span class="correct-answer-pill" style="margin-left:auto">正确段落：${r.ans}</span>
                </div>
                <div class="q-stem">${escapeHtml(r.text)}</div>
                <div class="answer-explanation show"><div class="explanation-text">${escapeHtml(r.clue || ('出自段落 ' + r.paragraph))}</div></div>
            </div>`).join('');
        document.getElementById('reviewContent').innerHTML = rows;
    }

    /* ===== TIMER ===== */
    function startTimer() {
        timer.mins = Math.max(1, parseInt(document.getElementById('timerMinutes').value, 10) || 15);
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
        state.exercise = null; state.sel = {}; state.scored = false; state.reached = { source: true };
        setStage('source'); document.getElementById('topicInput').value = '';
        toast('已重置，请输入主题或留空随机出题', 'ok');
    }
    async function saveExercise() {
        if (!state.exercise) { toast('当前没有可保存的练习', 'err'); return; }
        try {
            const d = await apiPost('/api/save', { exercise: state.exercise });
            toast('已保存到 my/' + (d.path || '').split(/[\\/]/).pop(), 'ok');
        } catch (e) { toast(e.message || '保存失败', 'err'); }
    }
