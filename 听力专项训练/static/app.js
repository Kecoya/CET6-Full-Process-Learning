
    /* =========================================================
       CET-6 听力专项训练  —  纯前端 + DeepSeek API
       ========================================================= */
    'use strict';

    // 仅用于界面渲染（题型卡、徽章）；命题细节由后端 app.py 的 TYPE_META + SYS_GEN 统一管理
    const TYPE_META = {
        conversation: { label: '长对话', emoji: '💬', qcount: 4, words: '约 280–320 词 · 4 题 · W/M 交替' },
        passage:      { label: '听力篇章', emoji: '📢', qcount: 3, words: '约 240–260 词 · 3(或4)题 · 单人独白' },
        lecture:      { label: '讲话·报道·讲座', emoji: '🎓', qcount: 3, words: '约 370–430 词 · 3(或4)题 · 学术讲座' }
    };

    // ---- global state ----
    const state = {
        selectedType: 'lecture',
        types: null,           // 从 /api/types 拉取的题型信息；null 时回退到内置 TYPE_META
        exercise: null,        // parsed exercise object
        sentences: [],         // [{speaker, text}] flat sentence list for intensive
        stage: 'source',
        reached: { source: true },
        selections: {},        // {1:'A', 2:'C', ...}
        scored: false
    };

    // ---- TTS player (single sequencer for blind + intensive) ----
    const player = { playing: false, idx: 0, list: [], onDone: null, onEach: null, gap: 160 };
    // tracks the blind-round play button currently active, so stopping mid-play can re-enable it
    let activeRoundBtn = null;

    // ---- voices ----
    let voices = [], femaleVoices = [], maleVoices = [];

    /* ============== INIT ============== */
    document.addEventListener('DOMContentLoaded', () => {
        // voices
        if (speechSynthesis.onvoiceschanged !== undefined) speechSynthesis.onvoiceschanged = initVoices;
        setTimeout(initVoices, 100);

        renderStepper();
        checkHealth();
        loadTypes();   // 拉取题型信息后渲染题型卡（数据驱动，跟随 prompts/types.json）
    });

    function currentModel() {
        return document.getElementById('modelSelect').value || null; // null => 使用 .env 默认模型
    }

    function currentTypes() {
        return state.types || TYPE_META;   // /api/types 失败时回退到内置
    }

    async function loadTypes() {
        try {
            const r = await fetch('/api/types');
            const d = await r.json();
            if (d && d.types) state.types = d.types;
        } catch (e) { /* 回退到内置 TYPE_META */ }
        const keys = Object.keys(currentTypes());
        if (keys.length && !(state.selectedType in currentTypes())) state.selectedType = keys[0];
        renderTypeCards();
        renderCustomTypeSelect();
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
                hintEl.textContent = '请在 听力专项训练/.env 设置 DEEPSEEK_API_KEY（可复制 .env.example）';
            }
        } catch (e) {
            backEl.innerHTML = '🔌 后端：<span class="err">未连接</span>';
            keyEl.textContent = '';
            hintEl.textContent = '请先启动后端：在 听力专项训练/ 目录运行 python app.py';
        }
    }

    /* ============== VOICES (ported from existing app) ============== */
    // 只保留美式英语(en-US)声源；女声名启发式用于分组，分组不准时仍可在任一下拉里手动选。
    const F_VOICE_RE = /(female|woman|girl|zira|jenny|aria|emma|ava|mia|libby|sonia|natasha|sara|jessa|michelle|neural.*female|^google\s+us|女)/i;
    function isUS(v) { return (v.lang || '').replace('_', '-').toLowerCase() === 'en-us'; }

    function initVoices() {
        // 记住当前已选中的值：Chrome 会在试听/加载语音数据时多次触发 voiceschanged，
        // 重新填充下拉会把它清空回"自动选择"。这里填充后恢复原选择，根治"被清空"。
        const prevF = document.getElementById('femaleVoiceSelect').value;
        const prevM = document.getElementById('maleVoiceSelect').value;
        // 注意：此处不再 speechSynthesis.cancel()，避免 voiceschanged 在盲听播放途中触发时打断音频
        voices = speechSynthesis.getVoices();   // 保留原始下标，pickVoice 用 index 取
        femaleVoices = []; maleVoices = [];
        voices.forEach((v, i) => {
            if (!isUS(v)) return;                // 只要 en-US
            if (F_VOICE_RE.test(v.name)) femaleVoices.push({ voice: v, index: i });
            else maleVoices.push({ voice: v, index: i });
        });
        populateVoiceSelects(prevF, prevM);
    }
    function populateVoiceSelects(prevF, prevM) {
        const fs = document.getElementById('femaleVoiceSelect');
        const ms = document.getElementById('maleVoiceSelect');
        prevF = prevF || fs.value || 'auto';
        prevM = prevM || ms.value || 'auto';
        fs.innerHTML = '<option value="auto">自动选择</option>';
        ms.innerHTML = '<option value="auto">自动选择</option>';
        if (femaleVoices.length) {
            const g = document.createElement('optgroup'); g.label = '女声 (en-US)';
            femaleVoices.forEach(it => { const o = document.createElement('option'); o.value = 'f-' + it.index; o.textContent = it.voice.name; g.appendChild(o); });
            fs.appendChild(g);
        }
        if (maleVoices.length) {
            const g = document.createElement('optgroup'); g.label = '男声 (en-US)';
            maleVoices.forEach(it => { const o = document.createElement('option'); o.value = 'm-' + it.index; o.textContent = it.voice.name; g.appendChild(o); });
            ms.appendChild(g);
        }
        // 恢复之前的选择（该选项仍存在时），避免重填丢失
        if (Array.from(fs.options).some(o => o.value === prevF)) fs.value = prevF;
        if (Array.from(ms.options).some(o => o.value === prevM)) ms.value = prevM;
    }
    function pickVoice(gender) {
        // 接受原文 speaker 码 'W'/'M'/'N'，也接受 'woman'/'man'/'narrator'。
        // 男声仅当 M / man / male；其余（含 W、N、narrator）按女声。
        const g = String(gender || '').toLowerCase();
        const isMale = (g === 'man' || g === 'm' || g === 'male');
        const sel = document.getElementById(isMale ? 'maleVoiceSelect' : 'femaleVoiceSelect');
        if (sel.value !== 'auto') {
            const idx = parseInt(sel.value.split('-')[1]);
            if (voices[idx]) return voices[idx];
        }
        const pool = isMale ? maleVoices : femaleVoices;
        if (pool.length) {
            const us = pool.find(it => it.voice.lang.toLowerCase().includes('en-us'));
            return (us || pool[0]).voice;
        }
        const en = voices.filter(v => v.lang.includes('en'));
        return en.length ? en[0] : (voices[0] || null);
    }
    function makeUtterance(text, gender) {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'en-US';
        u.rate = parseFloat(document.getElementById('speedSelect').value) || 1;
        const v = pickVoice(gender);
        if (v) u.voice = v;
        return u;
    }
    function testVoice(gender) {
        stopPlayback();
        speechSynthesis.speak(makeUtterance(gender === 'man'
            ? "This is a test of the male voice for CET-6 listening practice."
            : "This is a test of the female voice for CET-6 listening practice.", gender));
    }

    /* ============== PLAYER ============== */
    function currentGap() {
        // 句间停顿（毫秒），由顶部"句间停顿"下拉控制；默认 160ms（比旧版 320 紧凑）。
        const v = parseInt(document.getElementById('gapSelect') && document.getElementById('gapSelect').value, 10);
        return (v >= 0) ? v : 160;
    }
    function playSequence(list, { onDone, onEach, gap } = {}) {
        stopPlayback();
        if (!list || !list.length) { if (onDone) onDone(); return; }
        player.playing = true; player.idx = 0; player.list = list;
        player.onDone = onDone || null; player.onEach = onEach || null; player.gap = (gap != null) ? gap : currentGap();
        if (player.onEach) player.onEach(0);
        stepPlayer();
    }
    function stepPlayer() {
        if (!player.playing) return;
        if (player.idx >= player.list.length) {
            player.playing = false;
            const cb = player.onDone; player.onDone = null; player.onEach = null;
            if (cb) cb();
            return;
        }
        const item = player.list[player.idx];
        const u = makeUtterance(item.text, item.speaker);
        u.onend = () => { if (!player.playing) return; player.idx++; if (player.onEach) player.onEach(player.idx); setTimeout(stepPlayer, player.gap); };
        u.onerror = () => { if (!player.playing) return; player.idx++; if (player.onEach) player.onEach(player.idx); setTimeout(stepPlayer, player.gap); };
        speechSynthesis.speak(u);
    }
    function stopPlayback() {
        player.playing = false; player.onDone = null; player.onEach = null;
        speechSynthesis.cancel();
        clearSentenceHighlight();
        // if a blind round was stopped mid-play, re-enable its button so the user can replay
        if (activeRoundBtn) {
            const status = activeRoundBtn.parentElement.querySelector('.round-title span');
            activeRoundBtn.disabled = false;
            if (status) status.textContent = '';
            activeRoundBtn = null;
        }
    }
    function playOne(text, gender, { onEnd } = {}) {
        speechSynthesis.cancel();
        const u = makeUtterance(text, gender);
        u.onend = () => { if (onEnd) onEnd(); };
        u.onerror = () => { if (onEnd) onEnd(); };
        speechSynthesis.speak(u);
    }

    /* ============== TABS / TYPE CARDS ============== */
    function switchTab(which) {
        const isGen = (which === 'gen');
        document.getElementById('tab-gen').classList.toggle('active', isGen);
        document.getElementById('tab-custom').classList.toggle('active', !isGen);
        document.getElementById('panel-gen').classList.toggle('hidden', !isGen);
        document.getElementById('panel-custom').classList.toggle('hidden', isGen);
    }
    function renderTypeCards() {
        const wrap = document.getElementById('typeCards');
        wrap.innerHTML = '';
        Object.entries(currentTypes()).forEach(([key, m]) => {
            const el = document.createElement('div');
            el.className = 'type-card' + (key === state.selectedType ? ' selected' : '');
            el.innerHTML = `<span class="emoji">${m.emoji}</span><div class="t-name">${m.label}</div><div class="t-meta">${m.words}</div>`;
            el.onclick = () => { state.selectedType = key; renderTypeCards(); };
            wrap.appendChild(el);
        });
    }
    function renderCustomTypeSelect() {
        const sel = document.getElementById('customTypeSelect');
        sel.innerHTML = '';
        Object.entries(currentTypes()).forEach(([key, m]) => {
            const o = document.createElement('option'); o.value = key; o.textContent = `${m.emoji} ${m.label}`;
            sel.appendChild(o);
        });
    }

    /* ============== STEPPER / STAGES ============== */
    const STAGES = ['source', 'blind', 'answer', 'score', 'intensive'];
    const STAGE_LABEL = { source: '生成', blind: '盲听', answer: '答题', score: '评分', intensive: '精听' };
    function renderStepper() {
        const wrap = document.getElementById('stepper');
        wrap.innerHTML = '';
        STAGES.forEach((s, i) => {
            const el = document.createElement('div');
            const cur = state.stage === s;
            const done = stageIndex(state.stage) > i;
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
    function stageIndex(s) { return STAGES.indexOf(s); }
    function setStage(s) {
        state.stage = s;
        STAGES.forEach(x => document.getElementById('stage-' + x).classList.toggle('hidden', x !== s));
        renderStepper();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        if (s === 'answer') maybeStartTimer();
        else stopTimer();
    }
    function reach(s) { state.reached[s] = true; }

    /* ============== BACKEND API ============== */
    // 所有 DeepSeek 调用、命题/评分提示词、JSON 校验都在后端 app.py 完成；
    // 前端只发送参数、接收结果、负责渲染与播放（含 API Key 在内的密钥绝不进入浏览器）。

    async function apiPost(url, body) {
        let res;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
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

    /* ============== GENERATE ============== */
    function showLoading(msg) { document.getElementById('loadingText').textContent = msg || 'AI 思考中…'; document.getElementById('loadingOverlay').classList.add('show'); }
    function hideLoading() { document.getElementById('loadingOverlay').classList.remove('show'); }

    async function generateExercise() {
        const typeKey = state.selectedType;
        const topic = document.getElementById('topicInput').value;
        const vocabCheck = document.getElementById('vocabChk').checked;
        await runGeneration({ type: typeKey, topic, customText: null, vocabCheck, loadingMsg: '正在生成 CET-6 听力原文与题目…' });
    }
    async function generateFromCustom() {
        const typeKey = document.getElementById('customTypeSelect').value;
        const raw = document.getElementById('customTextInput').value;
        if (!raw.trim()) { toast('请先粘贴英文原文', 'err'); return; }
        if (raw.trim().split(/\s+/).length < 40) { if (!confirm('原文较短（少于 40 词），可能不适合命题，仍要继续吗？')) return; }
        await runGeneration({ type: typeKey, topic: '', customText: raw, loadingMsg: '正在根据你的原文生成选项与答案…' });
    }

    async function runGeneration({ type, topic, customText, vocabCheck, loadingMsg }) {
        showLoading(loadingMsg);
        try {
            const payload = { type, topic, customText, model: currentModel() };
            if (vocabCheck !== undefined) payload.vocabCheck = vocabCheck;
            const d = await apiPost('/api/generate', payload);
            validateExercise(d.exercise); // 前端兜底校验（后端已校验过）
            loadExercise(d.exercise);
            const savedName = d.saved ? d.saved.split(/[\\/]/).pop() : '';
            const adj = (d.exercise && Array.isArray(d.exercise.vocab_adjustments)) ? d.exercise.vocab_adjustments : [];
            const replaced = adj.filter(a => a && a.to);  // 真正做了替换的
            let msg = savedName ? ('已生成并存档：my/' + savedName) : '生成完成，开始盲听';
            if (replaced.length) msg += `；已替换 ${replaced.length} 个超纲词`;
            toast(msg, 'ok');
            reach('blind'); setStage('blind');
        } catch (e) {
            toast(e.message || '生成失败', 'err');
            console.error(e);
        } finally {
            hideLoading();
        }
    }

    function validateExercise(d) {
        const errs = [];
        if (!d || typeof d !== 'object') errs.push('返回不是对象');
        if (!Array.isArray(d.dialogue) || !d.dialogue.length) errs.push('dialogue 缺失或为空');
        else d.dialogue.forEach((t, i) => { if (!t || typeof t.content !== 'string' || !t.content.trim()) errs.push(`dialogue[${i}].content 无效`); });
        if (!Array.isArray(d.questions) || !d.questions.length) errs.push('questions 缺失或为空');
        else d.questions.forEach((q, i) => {
            if (!q || typeof q.question !== 'string') errs.push(`questions[${i}].question 无效`);
            if (!q.options || ['A', 'B', 'C', 'D'].some(k => !q.options[k])) errs.push(`questions[${i}] 选项必须含 A/B/C/D`);
            if (!['A', 'B', 'C', 'D'].includes(q.answer)) errs.push(`questions[${i}].answer 必须是 A/B/C/D`);
        });
        if (errs.length) throw new Error('生成内容格式不符：' + errs.join('；'));
    }

    /* ============== LOAD EXERCISE ============== */
    function loadExercise(d) {
        // normalize
        d.type = d.type || 'lecture';
        d.type_label = d.type_label || (currentTypes()[d.type] ? currentTypes()[d.type].label : '听力');
        d.title = d.title || 'CET-6 听力专项训练';
        d.context = d.context || '';
        d.questions.forEach(q => { q.explanation = q.explanation || ''; });

        state.exercise = d;
        state.selections = {};
        state.scored = false;

        // build flat sentence list for intensive
        state.sentences = [];
        d.dialogue.forEach(seg => {
            splitSentences(seg.content).forEach(st => state.sentences.push({ speaker: seg.speaker || 'N', text: st }));
        });
        if (!state.sentences.length) state.sentences = d.dialogue.map(seg => ({ speaker: seg.speaker || 'N', text: seg.content }));

        // reset blind UI
        document.getElementById('r1Status').textContent = '';
        document.getElementById('r2Status').textContent = '';
        document.getElementById('r1PlayBtn').disabled = false;
        document.getElementById('r2PlayBtn').disabled = true;
        document.getElementById('r1InputWrap').classList.add('hidden');
        document.getElementById('r2InputWrap').classList.add('hidden');
        document.getElementById('round1Block').classList.remove('done');
        document.getElementById('round2Block').classList.remove('done');
        document.getElementById('u1Input').value = '';
        document.getElementById('u2Input').value = '';
        document.getElementById('showStemsChk').checked = false;

        // blind options panel: 默认折叠，重新渲染（仅选项、不显示题干）
        renderBlindOptions();
        const bo = document.getElementById('blindOptions');
        const bot = document.getElementById('blindOptionsToggle');
        if (bo) bo.classList.add('hidden');
        if (bot) bot.textContent = '👁️ 查看选项（题干仍隐藏）';

        // badges
        const m = currentTypes()[d.type] || { label: d.type_label, emoji: '🎧' };
        document.getElementById('blindTypeBadge').textContent = `${m.emoji || '🎧'} ${d.type_label}`;
        document.getElementById('intensiveTypeBadge').textContent = `${m.emoji || '🎧'} ${d.type_label}`;

        // answer
        renderAnswer();
        // intensive
        renderIntensive();
    }

    /* ============== BLIND LISTENING ============== */
    // 盲听阶段可选展开"选项"面板：只显示四个选项，绝不显示题干；默认折叠，由用户决定。
    function renderBlindOptions() {
        const wrap = document.getElementById('blindOptions');
        if (!wrap || !state.exercise) { if (wrap) wrap.innerHTML = ''; return; }
        wrap.innerHTML = state.exercise.questions.map((q, i) => `
            <div class="blind-q">
                <div class="blind-q-num">第 ${i + 1} 题</div>
                ${['A', 'B', 'C', 'D'].map(L => `<div class="blind-opt"><b>${L}.</b> ${escapeHtml(q.options[L])}</div>`).join('')}
            </div>`).join('');
    }
    function toggleBlindOptions() {
        const w = document.getElementById('blindOptions');
        const btn = document.getElementById('blindOptionsToggle');
        if (!w) return;
        const hidden = w.classList.toggle('hidden');
        if (btn) btn.textContent = hidden ? '👁️ 查看选项（题干仍隐藏）' : '🙈 收起选项';
    }
    function startBlindRound(n) {
        const list = state.exercise.dialogue.map(seg => ({ text: seg.content, speaker: seg.speaker || 'N' }));
        const btn = document.getElementById('r' + n + 'PlayBtn');
        const status = document.getElementById('r' + n + 'Status');
        btn.disabled = true;
        status.textContent = '⏳ 播放中…';
        activeRoundBtn = btn;
        playSequence(list, {
            gap: currentGap(),
            onDone: () => {
                status.textContent = '✅ 已播完';
                btn.disabled = false;
                btn.textContent = '🔊 再听一遍';
                activeRoundBtn = null;
                document.getElementById('r' + n + 'InputWrap').classList.remove('hidden');
                document.getElementById('round' + n + 'Block').classList.add('done');
                if (n === 1) document.getElementById('r2PlayBtn').disabled = false;
                document.getElementById('u' + n + 'Input').focus();
            }
        });
    }
    function confirmUnderstanding(n) {
        const v = document.getElementById('u' + n + 'Input').value.trim();
        if (!v) { if (!confirm('还没有写下任何理解内容，确定要继续吗？')) return; }
        if (n === 1) {
            reach('answer'); // allow peeking, but actual answering unlocked after round2 confirm
        } else {
            reach('answer');
            setStage('answer');
        }
        if (n === 1) toast('已记录第一遍理解，请进行第二遍盲听', 'ok');
    }

    /* ============== ANSWER ============== */
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
            head.innerHTML = `<span class="q-num">Q${idx}</span><span class="badge warn">题干已隐藏（精听/评分后可显示）</span><button type="button" class="icon-btn" style="margin-left:auto" title="朗读本题题干与选项" onclick="playQuestion(${i})">🔊 播放题目</button>`;
            block.appendChild(head);

            const stem = document.createElement('div');
            stem.className = 'q-stem';
            stem.id = 'stem-' + idx;
            stem.textContent = q.question;
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
            exp.innerHTML = `<div class="exp-head"><h4>解析</h4><div class="correct-answer-pill">正确答案：${q.answer}</div></div><div class="explanation-text">题干：${escapeHtml(q.question)}<br><br>${escapeHtml(q.explanation)}</div>`;
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
    function toggleStems(show) {
        document.querySelectorAll('.q-stem').forEach(s => s.classList.toggle('visible', show));
    }

    /* ============== TIMER（可选答题倒计时） ============== */
    const timer = { handle: null, deadline: 0, remain: 0, paused: false, mins: 0 };
    function maybeStartTimer() {
        const bar = document.getElementById('answerTimerBar');
        if (state.scored) { if (bar) bar.classList.add('hidden'); stopTimer(); return; }
        const mins = Math.max(0, parseInt(document.getElementById('timerMinutes').value, 10) || 0);
        timer.mins = mins;
        if (mins <= 0) { if (bar) bar.classList.add('hidden'); stopTimer(); return; }
        if (bar) bar.classList.remove('hidden');
        startTimer(mins);
    }
    function startTimer(mins) {
        timer.deadline = Date.now() + mins * 60000; timer.paused = false;
        const pb = document.getElementById('pauseBtn'); if (pb) pb.textContent = '⏸️ 暂停';
        if (timer.handle) clearInterval(timer.handle);
        timer.handle = setInterval(tickTimer, 1000); tickTimer();
    }
    function tickTimer() {
        if (timer.paused) return;
        const remain = Math.max(0, Math.round((timer.deadline - Date.now()) / 1000));
        const el = document.getElementById('timerDisplay'); if (!el) return;
        el.textContent = formatTime(remain);
        el.classList.toggle('warn', remain <= 300 && remain > 60);
        el.classList.toggle('danger', remain <= 60 && remain > 0);
        if (remain <= 0) {
            stopTimer();
            toast('⏰ 时间到！', 'err');
            if (document.getElementById('strictChk').checked && state.stage === 'answer') submitScore();
        }
    }
    function togglePauseTimer() {
        if (!timer.handle) return;
        timer.paused = !timer.paused;
        const pb = document.getElementById('pauseBtn');
        if (timer.paused) { timer.remain = Math.max(0, Math.round((timer.deadline - Date.now()) / 1000)); if (pb) pb.textContent = '▶️ 继续'; }
        else { timer.deadline = Date.now() + timer.remain * 1000; if (pb) pb.textContent = '⏸️ 暂停'; }
    }
    function stopTimer() { if (timer.handle) { clearInterval(timer.handle); timer.handle = null; } }
    function formatTime(sec) { const m = Math.floor(sec / 60), s = sec % 60; return m + ':' + String(s).padStart(2, '0'); }

    /* ============== SCORE ============== */
    // 提示词与 DeepSeek 调用均在后端完成；此处仅提交数据并渲染结果。

    async function submitScore() {
        const ex = state.exercise;
        const u1 = document.getElementById('u1Input').value.trim();
        const u2 = document.getElementById('u2Input').value.trim();
        // selections: 后端期望 {1:'A', ...}；前端用 1-based 数字键，转成字符串键
        const selections = {};
        Object.keys(state.selections).forEach(k => { selections[String(k)] = state.selections[k]; });
        const selCount = ex.questions.filter((q, i) => state.selections[i + 1] === q.answer).length;

        showLoading('AI 正在评估你的理解程度…');
        try {
            const d = await apiPost('/api/evaluate', {
                exercise: ex, u1, u2, selections, model: currentModel()
            });
            const result = d.result;
            if (d.option_accuracy_server) result.option_accuracy = d.option_accuracy_server; // 后端兜底统计
            renderScore(result, selCount, ex.questions.length);
            // reveal answers
            ex.questions.forEach((q, i) => {
                const idx = i + 1;
                document.getElementById('exp-' + idx).style.display = 'block';
                document.querySelectorAll(`.option-item[data-q="${idx}"]`).forEach(o => {
                    o.classList.remove('correct', 'wrong');
                    if (o.dataset.letter === q.answer) o.classList.add('correct');
                    else if (o.classList.contains('selected')) o.classList.add('wrong');
                });
            });
            state.scored = true;
            renderIntensive();
            reach('score'); reach('intensive');
            setStage('score');
            toast('评分完成 📊', 'ok');
        } catch (e) {
            toast(e.message || '评分失败', 'err');
            console.error(e);
        } finally {
            hideLoading();
        }
    }

    function renderScore(r, correct, total) {
        const score = Math.max(0, Math.min(100, parseInt(r.score) || 0));
        const level = r.level || '中等';
        const wrap = document.getElementById('scoreContent');
        const missed = (Array.isArray(r.missed_points) ? r.missed_points : []).map(x => `<li>${escapeHtml(String(x))}</li>`).join('');
        const optAcc = r.option_accuracy || `${correct}/${total}`;
        wrap.innerHTML = `
            <div class="score-wrap">
                <div class="score-ring" id="scoreRing" style="--p:0%"><div class="inner"><div class="num">${score}</div><div class="lbl">理解度 / 100</div></div></div>
                <div class="level-badge level-${level}">${escapeHtml(level)}</div>
                <div class="eval-grid">
                    <div class="eval-card"><h5>🎯 选项正确率</h5><p style="font-size:18px;font-weight:700;color:#2e7d32">${escapeHtml(optAcc)}</p></div>
                    <div class="eval-card"><h5>🧭 主旨把握</h5><p>${escapeHtml(r.main_idea || '—')}</p></div>
                    <div class="eval-card"><h5>🔍 细节捕捉</h5><p>${escapeHtml(r.details || '—')}</p></div>
                    <div class="eval-card"><h5>📚 词汇理解</h5><p>${escapeHtml(r.vocab || '—')}</p></div>
                    ${missed ? `<div class="eval-card eval-full"><h5>⚠️ 遗漏/理解偏差的关键点</h5><ul class="missed-list">${missed}</ul></div>` : ''}
                    <div class="eval-card eval-full"><h5>💡 提升建议</h5><p style="white-space:pre-line">${escapeHtml(r.feedback || '—')}</p></div>
                </div>
            </div>`;
        // animate ring
        setTimeout(() => { document.getElementById('scoreRing').style.setProperty('--p', score + '%'); }, 60);
    }

    /* ============== INTENSIVE ============== */
    function renderIntensive() {
        // context
        document.getElementById('contextText').textContent = state.exercise.context || '（无背景说明）';
        // sentences
        const list = document.getElementById('sentenceList');
        list.innerHTML = '';
        state.sentences.forEach((s, i) => {
            const row = document.createElement('div');
            row.className = 'sentence-row';
            row.id = 'srow-' + i;
            const spk = s.speaker === 'M' ? '👨' : (s.speaker === 'W' ? '👩' : '🎙️');
            row.innerHTML = `
                <div class="spk">${spk}</div>
                <div class="stext" data-i="${i}">${escapeHtml(s.text)}</div>
                <div class="actions">
                    <button class="icon-btn" title="单句播放" onclick="event.stopPropagation();playSingleSentence(${i})">🔊</button>
                    <button class="icon-btn" title="从此句连续播放" onclick="event.stopPropagation();playFromSentence(${i})">▶️</button>
                </div>`;
            row.querySelector('.stext').onclick = () => playFromSentence(i);
            list.appendChild(row);
        });
        // questions with stems visible
        const qw = document.getElementById('intensiveQuestions');
        qw.innerHTML = '';
        const qh = document.createElement('h3');
        qh.style.cssText = 'margin:18px 0 10px;font-size:16px;color:#2c3e50';
        qh.textContent = '📝 题目与解析';
        qw.appendChild(qh);
        state.exercise.questions.forEach((q, i) => {
            const idx = i + 1;
            const block = document.createElement('div');
            block.className = 'question-block';
            const yourAns = state.selections[idx];
            const ok = yourAns === q.answer;
            block.innerHTML = `
                <div class="q-head"><span class="q-num">Q${idx}</span>${state.scored ? `<span class="badge ${ok ? '' : 'warn'}" style="${ok ? 'background:#e8f5e8;color:#2e7d32' : ''}">你的选择：${yourAns || '未选'} ${ok ? '✓' : '✗'}</span>` : ''}<button type="button" class="icon-btn" style="margin-left:auto" title="朗读题干与选项" onclick="playQuestion(${i})">🔊 读题</button></div>
                <div class="q-stem visible">${escapeHtml(q.question)}</div>
                ${['A','B','C','D'].map(letter => {
                    let cls = 'option-item';
                    if (letter === q.answer) cls += ' correct';
                    else if (state.scored && letter === yourAns) cls += ' wrong';
                    return `<div class="${cls}"><div class="option-letter">${letter}</div><div class="option-text">${escapeHtml(q.options[letter])}</div></div>`;
                }).join('')}
                <div class="answer-explanation" style="display:block"><div class="exp-head"><h4>解析</h4><div class="correct-answer-pill">正确答案：${q.answer}</div></div><div class="explanation-text">${escapeHtml(q.explanation)}</div></div>`;
            qw.appendChild(block);
        });
    }
    function playAllIntensive() {
        const list = state.sentences.map(s => ({ text: s.text, speaker: s.speaker }));
        playSequence(list, { onEach: i => highlightSentence(i), onDone: clearSentenceHighlight, gap: currentGap() });
    }
    function playFromSentence(i) {
        const slice = state.sentences.slice(i).map(s => ({ text: s.text, speaker: s.speaker }));
        playSequence(slice, { onEach: k => highlightSentence(i + k), onDone: clearSentenceHighlight, gap: currentGap() });
    }
    function playSingleSentence(i) {
        const s = state.sentences[i];
        highlightSentence(i);
        playOne(s.text, s.speaker, { onEnd: clearSentenceHighlight });
    }
    function playQuestion(i) {
        // 朗读题干 + 四个选项（题目由旁白女声朗读，模拟真题读题）
        const q = state.exercise && state.exercise.questions[i];
        if (!q) return;
        stopPlayback();
        const opts = ['A', 'B', 'C', 'D'].map(L => `${L}, ${q.options[L]}.`).join(' ');
        const text = `Question ${i + 1}. ${q.question}. ${opts}`;
        speechSynthesis.speak(makeUtterance(text, 'N'));
    }
    function highlightSentence(i) {
        clearSentenceHighlight();
        const row = document.getElementById('srow-' + i);
        if (row) { row.classList.add('playing'); row.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    }
    function clearSentenceHighlight() { document.querySelectorAll('.sentence-row.playing').forEach(r => r.classList.remove('playing')); }

    /* ============== UTIL ============== */
    function splitSentences(text) {
        if (!text) return [];
        // Protect abbreviation dots so they don't trigger a sentence split,
        // then split on whitespace that follows real sentence-ending punctuation.
        const PH = '\uE000'; // private-use char as a dot placeholder
        const guarded = text.replace(
            /\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Inc|Ltd|Co|Corp|e\.g|i\.e|etc|vs|U\.S|U\.K)\./gi,
            '$1' + PH
        );
        return guarded.split(/(?<=[.!?])\s+/)
            .map(s => s.split(PH).join('.').trim())
            .filter(s => s.length > 0);
    }
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
        if (!confirm('开始新的一组练习？当前内容将被替换。')) return;
        stopPlayback();
        state.exercise = null; state.selections = {}; state.scored = false;
        state.reached = { source: true };
        setStage('source');
        document.getElementById('topicInput').value = '';
        document.getElementById('customTextInput').value = '';
        toast('已重置，请选择题型或自定义原文', 'ok');
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
    