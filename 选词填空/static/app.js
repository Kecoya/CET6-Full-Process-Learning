
    /* =========================================================
       CET-6 选词填空 (Banked Cloze)  —  前端
       ========================================================= */
    'use strict';

    const APP_DIR = '选词填空';

    const state = {
        exercise: null,
        stage: 'source',
        reached: { source: true },
        fills: {},         // {26:'C', ...} 用户为每个空选的字母
        pending: null,     // 当前选中的词库字母
        wordByLetter: {},  // {'A':'word', ...}
        scored: false
    };
    const timer = { handle: null, deadline: 0, remain: 0, paused: false, mins: 8 };

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
        showLoading('正在生成 CET-6 选词填空…');
        try {
            const d = await apiPost('/api/generate', { topic, model: currentModel(), vocabCheck: document.getElementById('vocabChk').checked });
            loadExercise(d.exercise);
            const savedName = d.saved ? d.saved.split(/[\\/]/).pop() : '';
            toast(savedName ? ('已生成并存档：my/' + savedName) : '生成完成，开始作答', 'ok');
            reach('answer'); setStage('answer'); startTimer();
        } catch (e) { toast(e.message || '生成失败', 'err'); console.error(e); }
        finally { hideLoading(); }
    }

    function loadExercise(d) {
        d.title = d.title || 'CET-6 选词填空';
        state.exercise = d;
        state.fills = {}; state.pending = null; state.scored = false;
        state.wordByLetter = {};
        (d.word_bank || []).forEach(w => { state.wordByLetter[w.letter] = w.word; });
        document.getElementById('ansBadge').textContent = '🔤 ' + (d.title || '');
        renderCloze();
    }

    function renderCloze() {
        const ex = state.exercise;
        const box = document.getElementById('passageBox');
        const html = ex.passage.replace(/__(\d+)__/g, (m, no) =>
            `<span class="blank-slot" data-no="${no}" onclick="clickBlank(${no})"><span class="bnum">${no}</span><span class="bword" id="bw-${no}"></span></span>`);
        box.innerHTML = `<div class="passage-title">${escapeHtml(ex.title)}</div><div class="cloze-passage">${html}</div>`;
        const bank = document.getElementById('wordBank'); bank.innerHTML = '';
        (ex.word_bank || []).forEach(w => {
            const chip = document.createElement('span');
            chip.className = 'word-chip'; chip.dataset.letter = w.letter;
            chip.id = 'chip-' + w.letter;
            chip.innerHTML = `<span class="wletter">${w.letter}</span>${escapeHtml(w.word)}`;
            chip.onclick = () => clickChip(w.letter);
            bank.appendChild(chip);
        });
        document.getElementById('totalQ').textContent = '10';
        document.getElementById('answeredCount').textContent = '0';
        document.getElementById('scoreBtn').disabled = true;
    }

    function clickChip(letter) {
        const used = Object.values(state.fills).includes(letter);
        if (used) { toast('该词已使用', 'err'); return; }
        state.pending = (state.pending === letter) ? null : letter;
        document.querySelectorAll('.word-chip').forEach(c => c.classList.toggle('selected', c.dataset.letter === state.pending));
    }

    function clickBlank(no) {
        const slot = document.querySelector(`.blank-slot[data-no="${no}"]`);
        if (state.pending) {
            // 若该空原有词，先释放
            if (state.fills[no]) { /* overwrite, old letter becomes free automatically */ }
            state.fills[no] = state.pending;
            state.pending = null;
            document.querySelectorAll('.word-chip').forEach(c => c.classList.remove('selected'));
        } else if (state.fills[no]) {
            // 清空该空
            delete state.fills[no];
            toast('已清空第 ' + no + ' 空', 'ok');
        } else {
            toast('请先点击下方词库选择一个词', 'err'); return;
        }
        refreshSlots();
    }

    function refreshSlots() {
        const usedLetters = new Set(Object.values(state.fills));
        document.querySelectorAll('.word-chip').forEach(c => c.classList.toggle('used', usedLetters.has(c.dataset.letter)));
        for (let no = 26; no <= 35; no++) {
            const slot = document.querySelector(`.blank-slot[data-no="${no}"]`);
            const wEl = document.getElementById('bw-' + no);
            if (!slot || !wEl) continue;
            const letter = state.fills[no];
            if (letter) { slot.classList.add('filled'); wEl.textContent = state.wordByLetter[letter] || letter; }
            else { slot.classList.remove('filled'); wEl.textContent = ''; }
            if (!state.scored) { slot.classList.remove('correct', 'wrong'); }
        }
        const filled = Object.keys(state.fills).length;
        document.getElementById('answeredCount').textContent = filled;
        document.getElementById('scoreBtn').disabled = (filled < 10);
    }

    /* ===== SCORE (本地) ===== */
    function submitScore() {
        stopTimer();
        const ex = state.exercise; let correct = 0;
        const review = [];
        for (let no = 26; no <= 35; no++) {
            const ans = ex.answers[no];
            const yours = state.fills[no];
            const slot = document.querySelector(`.blank-slot[data-no="${no}"]`);
            if (slot) {
                slot.classList.remove('correct', 'wrong');
                if (yours === ans) { slot.classList.add('correct'); correct++; }
                else if (yours) slot.classList.add('wrong');
            }
            const bl = (ex.blanks || []).find(b => String(b.no) === String(no)) || {};
            review.push({ no, yours, ans, correct: yours === ans, pos: bl.pos_needed || '', gclue: bl.grammar_clue || '', mclue: bl.meaning_clue || '' });
        }
        state.scored = true;
        renderScore(correct, 10);
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
            </div>`;
        setTimeout(() => { document.getElementById('scoreRing').style.setProperty('--p', pct + '%'); }, 60);
    }

    function renderReview(review) {
        const ex = state.exercise;
        const rows = review.map(r => `
            <div class="question-block">
                <div class="q-head"><span class="q-num">空 ${r.no}</span>
                    <span class="badge ${r.correct ? 'green' : 'warn'}">你的选择：${r.yours ? r.yours + ' · ' + escapeHtml(state.wordByLetter[r.yours] || '') : '未填'} ${r.correct ? '✓' : '✗'}</span>
                    <span class="correct-answer-pill" style="margin-left:auto">正确：${r.ans} · ${escapeHtml(state.wordByLetter[r.ans] || '')}</span>
                </div>
                <div class="answer-explanation show">
                    <div class="explanation-text">
                        ${r.pos ? `<b>所需词性：</b>${escapeHtml(r.pos)}<br>` : ''}
                        ${r.gclue ? `<b>语法线索：</b>${escapeHtml(r.gclue)}<br>` : ''}
                        ${r.mclue ? `<b>语义线索：</b>${escapeHtml(r.mclue)}` : ''}
                    </div>
                </div>
            </div>`).join('');
        const notes = (ex.notes && ex.notes.length)
            ? `<div class="cloze-notes"><h5>📌 词族与干扰说明</h5><ul>${ex.notes.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul></div>` : '';
        document.getElementById('reviewContent').innerHTML = rows + notes;
    }

    /* ===== TIMER ===== */
    function startTimer() {
        timer.mins = Math.max(1, parseInt(document.getElementById('timerMinutes').value, 10) || 8);
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
        el.classList.toggle('warn', remain <= 180 && remain > 60);
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
        state.exercise = null; state.fills = {}; state.pending = null; state.scored = false; state.reached = { source: true };
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
