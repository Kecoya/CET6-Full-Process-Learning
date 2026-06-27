# -*- coding: utf-8 -*-
"""
CET-6 听力专项训练 —— Flask 后端
职责：
  1. 提供 Web 页面（templates/index.html + static/）
  2. 代理 DeepSeek 调用（API Key 只存在服务端，不进浏览器）
  3. 集中命题 / 评分提示词与题型规格
  4. 校验 AI 返回的 JSON
  5. 把生成的练习落盘到 ../my/

运行：python app.py   （然后自动打开 http://127.0.0.1:5555）
"""

import io
import json
import os
import re
import threading
import webbrowser
from datetime import datetime
from pathlib import Path

import requests
from flask import Flask, jsonify, render_template, request

import vocab  # 四六级大纲词表加载 + 超纲词检测（本目录 vocab.py）

BASE_DIR = Path(__file__).resolve().parent
MY_DIR = BASE_DIR.parent / "my"          # CET-6学习/my
ENV_FILE = BASE_DIR / ".env"

DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions"
DEFAULT_MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-v4-flash")

app = Flask(__name__)


# ----------------------------------------------------------------------
# .env 加载（无 python-dotenv 依赖的最小实现）
# ----------------------------------------------------------------------
def load_env(path):
    if not path.exists():
        return
    with io.open(path, "r", encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            os.environ.setdefault(k, v)


load_env(ENV_FILE)


def get_key():
    return os.environ.get("DEEPSEEK_API_KEY", "").strip()


# ----------------------------------------------------------------------
# 题型规格 + 提示词（集中管理，前端不再硬编码）
# ----------------------------------------------------------------------
TYPE_META = {
    "conversation": {
        "label": "长对话",
        "emoji": "💬",
        "qcount": 4,
        "words": "280–320",
        "spec": """长对话 Long Conversation（口语场景对话，真题 Section A，每篇 4 题）：
- ⚠️ 必须是真实的一男一女多轮对话：speaker 严格在 W(女) 与 M(男) 之间交替（W、M、W、M…这样轮流），男女双方各发言 4-6 次，共约 9-11 轮。绝不能只有单一性别、绝不能用 N。原文 280–320 词/篇（考纲；真题中位约 327），语速 140–160 词/分钟，口语化但得体。
- 固定场景轮换：职场财经(求职/跳槽/离职/创业/公司文化/预算理财) 或 生活服务(租房/购物/健身/旅行/就医) 或 媒体访谈(电台主持人 W 访谈嘉宾 M)。
- 行文逻辑：寒暄或开场点题 → 抛出问题/主题 → 讨论多个方案(转折后才是关键) → 结尾达成共识/给建议/约定下一步。
- 出 4 道题，严格顺序出题：第1轮(开头来意)→Q1，中段→Q2/Q3，结尾结论或下一步→Q4。
- 考点：开头来意/核心诉求；say/think/suggest 后内容；建议句型(Why not…/You'd better…/Maybe you should…)；态度情绪(worried/relieved/disappointed/satisfied)；方案对比(转折后为最终方案)；结尾下一步行动或约定。
- 干扰项三类：① 对话中提到但被否定的备选方案；② 只提到半句、缺关键限定；③ 混淆人物（把男生的想法安到女生身上）。
- 真题题干模板：What do we learn about the man/woman? / What does the man/woman say about...? / Why does the woman...? / What does the man suggest the woman do? / What will the woman probably do next? / How does the woman describe...?""",
    },
    "passage": {
        "label": "听力篇章",
        "emoji": "📢",
        "qcount": 3,
        "words": "240–260",
        "spec": """听力篇章 Passage（独白，无对话，真题 Section B，每篇 3 或 4 题，多为 3 题）：
- 单人朗读独白，原文 240–260 词/篇（考纲；真题中位约 254），语速 140–160 词/分钟；长难句增多、逻辑连接词密集、学术基础词汇。
- 题材：科普常识/自然生物 / 心理学社会现象 / 人物历史科技史 / 教育育儿健康。
- 总分结构：开头总起介绍主体 → 中间分点举例或讲实验或生平阶段 → 结尾总结观点或启示。
- 出 3 道题（偶尔 4），均匀分布（开头1/中段1/结尾1），不集中在某段。
- 考点：篇章首句（主题/研究对象/人物身份）；逻辑信号词后（转折 but yet / 因果 so because / 递进 besides / 举例 for instance）；实验或调查结论（research shows / a study found that）；特殊定义或专有概念；人物关键节点；尾段总结（作者观点/建议/长远影响）。
- 强干扰项三大陷阱：① 细节碎片（原文出现原词但只是举例，非核心结论）；② 程度偷换（some→all，may→must）；③ 因果颠倒（A导致B 写成 B造成A）。
- 真题题干模板：What does the passage say about...? / What do we learn about...? / What did the study find about...? / Why did...? / What are people advised to do...? / What does the passage suggest parents do?""",
    },
    "lecture": {
        "label": "讲话·报道·讲座",
        "emoji": "🎓",
        "qcount": 3,
        "words": "370–430",
        "spec": """讲话/报道/讲座 Recording（CET-6 最高权重题型，单题分值最高，真题 Section C，每篇多 3 题）：
- 单人学术或正式讲话，原文约 370–430 词/篇，目标约 400 词（考纲"3 篇共约 1200 词"；真题中位约 398），语速 140–160 词/分钟；学术词汇多、长难句密集、信息密度大。
- 题材：职场管理就业 / 科技产业 / 健康心理生理 / 社会经济文化 / 教育家庭。
- 结构：开场点题(Good afternoon. In today's lecture...) → 展开论证或叙述（数据/案例/对比/引用研究）→ 收束结论或呼吁。
- 出 3 道题（偶尔 4），严格顺序，覆盖主旨 + 细节 + 推断。
- 考点与听力篇章一致，且更重视“逻辑信号词后”与“实验/调查结论(research shows / a study found)”；首尾必考。
- 强干扰项三大陷阱同听力篇章（细节碎片 / 程度偷换 / 因果颠倒），迷惑性最强。
- 真题题干模板：What does the speaker say about...?（最高频）/ What do we learn about...? / What is the impact of...? / Why are...? / What should...avoid doing? / When are...more likely to..., according to the researchers?""",
    },
}

SYS_GEN = (
    "你是中国大学英语六级考试(CET-6)听力命题专家。你产出的听力原文与题目必须与真实六级真题高度一致："
    "词数、词汇难度（六级 4000–6000 词带，含学术/正式用词与一定低频词、常见六级核心词）、"
    "句式复杂度（含从句、并列句、长难句）均贴近真题。\n\n"
    "【通用命题规则（三类题型都必须遵守）】\n"
    "1. 顺序原则：题目出现顺序 = 音频信息出现顺序，绝不乱序。\n"
    "2. 同义替换原则：正确答案几乎不用原文原句，须同义改写、概括性强；干扰项则大量堆砌原文单词以迷惑考生。\n"
    "3. 不考生僻细节：不考无关次要数字、无关次要人名地名。\n"
    "4. 答案均衡：整套练习 A/B/C/D 四个选项数量大致均衡，避免大量连选同一项。\n"
    "5. 不绝对化：含 only/never/always/all/must 等绝对化表述的几乎都是干扰项，不作为正确答案。\n\n"
    "【选项设计】\n"
    "每题 4 个选项 A/B/C/D。正确项为定位句或观点句的同义改写；干扰项三类："
    "① 原文出现但答非所问（次要细节）；② 时间或程度偷换（计划 vs 已发生、some→all、may→must）；"
    "③ 主体混淆（A 做的事安到 B 身上）。\n\n"
    "严格只输出一个 JSON 对象，结构如下：\n"
    "{\n"
    "  \"title\": \"简洁英文标题\",\n"
    "  \"topic\": \"话题(中文短语)\",\n"
    "  \"type\": \"conversation|passage|lecture\",\n"
    "  \"type_label\": \"长对话|听力篇章|讲话·报道·讲座\",\n"
    "  \"context\": \"1-2句中文背景说明，供精听阶段参考，不要剧透答案\",\n"
    "  \"dialogue\": [{\"speaker\":\"W|M|N\",\"content\":\"一句或一小段英文\"}],\n"
    "  \"questions\": [{\"question\":\"英文题干\",\"options\":{\"A\":\"...\",\"B\":\"...\",\"C\":\"...\",\"D\":\"...\"},"
    "\"answer\":\"A|B|C|D\",\"explanation\":\"中文解析，说明为何选该项、其它项为何错\"}],\n"
    "  \"word_count\": 数字(仅统计 dialogue 中所有英文词数)\n"
    "}\n"
    "硬性要求：\n"
    "1. 严格遵守给定题型的词数/说话人/题数/考点/干扰项规格（见用户消息）。\n"
    "2. 长对话：speaker 必须严格在 W(女) 与 M(男) 间交替、男女双方都多次发言（绝不能只有单一性别、绝不能用 N）；短文与讲座：dialogue 为单段，speaker 固定为 \"N\"。\n"
    "3. 题目须覆盖\"主旨 + 具体细节 + 推断\"三类；每个问题恰好 4 个选项 A/B/C/D；answer 为唯一正确字母。\n"
    "4. content 内每段为自然可朗读的英文，不要包含中文、不要包含括号备注、不要包含\"(implied)\"之类元注释。\n"
    "5. word_count 必须真实统计原文英文词数，不得虚报。\n"
    "只输出 JSON，不要任何解释或前后缀文字。"
)

SYS_EVAL = (
    "你是 CET-6 听力理解评估专家。学习者刚完成一次盲听训练：在两次不看原文的盲听后分别写下对原文的理解，随后完成选择题。"
    "请综合\"学习者自述的理解文本\"与\"选项正误\"两方面，评判其对这段听力的真实理解程度。\n"
    "严格只输出一个 JSON 对象：\n"
    "{\n"
    "  \"score\": 0到100的整数,\n"
    "  \"level\": \"优秀|良好|中等|需加强\",\n"
    "  \"main_idea\": \"主旨把握点评(中文,1-2句)\",\n"
    "  \"details\": \"细节捕捉点评(中文,1-2句)\",\n"
    "  \"vocab\": \"词汇/表达理解点评(中文,1-2句)\",\n"
    "  \"missed_points\": [\"遗漏或理解错误的关键点(中文,可多条)\"],\n"
    "  \"option_accuracy\": \"如 2/4\",\n"
    "  \"feedback\": \"中文,2-4条可执行的提升建议,用换行分隔\"\n"
    "}\n"
    "评分依据：以理解文本与原文的主旨/细节重合度为主，选项正误为辅。理解文本为空、与原文几乎无关或严重跑题时，score 应很低（≤30）。只输出 JSON。"
)


# ----------------------------------------------------------------------
# 软编码提示词：优先读 prompts/ 目录的文件，缺失则回退到上面内置的默认值
# 每次 generate / evaluate 请求都重新读取，所以随时改 prompts/ 文件即时生效
# ----------------------------------------------------------------------
PROMPTS_DIR = BASE_DIR / "prompts"


def _read_text_file(path):
    try:
        with io.open(path, "r", encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


def load_gen_prompt():
    t = _read_text_file(PROMPTS_DIR / "system_generate.txt").strip()
    return t if t else SYS_GEN


def load_eval_prompt():
    t = _read_text_file(PROMPTS_DIR / "system_evaluate.txt").strip()
    return t if t else SYS_EVAL


def load_types():
    """合并内置默认 TYPE_META + prompts/types.json + prompts/spec_<type>.txt；每次请求重读。"""
    meta = {k: dict(v) for k, v in TYPE_META.items()}  # 浅拷贝默认值
    tj_text = _read_text_file(PROMPTS_DIR / "types.json")
    if tj_text.strip():
        try:
            tj = json.loads(tj_text)
            if isinstance(tj, dict):
                for k, v in tj.items():
                    if k in meta and isinstance(v, dict):
                        for kk, vv in v.items():
                            if kk != "spec":
                                meta[k][kk] = vv
        except Exception as e:
            app.logger.warning("types.json 解析失败，使用默认: %s", e)
    for k in list(meta.keys()):
        sp = _read_text_file(PROMPTS_DIR / ("spec_" + k + ".txt")).strip()
        if sp:
            meta[k]["spec"] = sp
    return meta


# ----------------------------------------------------------------------
# DeepSeek 调用 + JSON 解析
# ----------------------------------------------------------------------
def call_deepseek(messages, model=None):
    key = get_key()
    if not key:
        raise ApiError("服务端未配置 DEEPSEEK_API_KEY。请在 听力专项训练/.env 中设置 DEEPSEEK_API_KEY=sk-...", 503)
    payload = {
        "model": model or DEFAULT_MODEL,
        "messages": messages,
        "temperature": 0.7,
        "response_format": {"type": "json_object"},
        "max_tokens": 4096,
        "stream": False,
    }
    try:
        resp = requests.post(
            DEEPSEEK_URL,
            headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
            json=payload,
            timeout=120,
        )
    except requests.RequestException as e:
        raise ApiError("无法连接 DeepSeek（网络问题）：%s" % e, 502)

    if resp.status_code == 401:
        raise ApiError("DeepSeek API Key 无效 (401)，请检查 .env 中的 DEEPSEEK_API_KEY。", 401)
    if resp.status_code == 429:
        raise ApiError("请求过于频繁或额度不足 (429)，请稍后重试。", 429)
    if resp.status_code == 422:
        raise ApiError("DeepSeek 参数有误 (422)：%s" % safe_text(resp), 422)
    if not resp.ok:
        raise ApiError("DeepSeek 请求失败 (%s)：%s" % (resp.status_code, safe_text(resp)), 502)

    try:
        data = resp.json()
    except ValueError:
        raise ApiError("DeepSeek 返回非 JSON。", 502)

    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise ApiError("DeepSeek 返回结构异常：%s" % json.dumps(data, ensure_ascii=False)[:500], 502)

    return content


def safe_text(resp):
    try:
        j = resp.json()
        return (j.get("error") or {}).get("message") or json.dumps(j, ensure_ascii=False)[:300]
    except ValueError:
        return resp.text[:300]


def parse_json_loose(raw):
    """容错解析：去掉 ```json 围栏，截取首个 { 到最后一个 }。"""
    s = raw.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", s, re.I)
    if fence:
        s = fence.group(1).strip()
    a, b = s.find("{"), s.rfind("}")
    if a != -1 and b != -1 and b > a:
        s = s[a:b + 1]
    return json.loads(s)


# ----------------------------------------------------------------------
# 业务校验
# ----------------------------------------------------------------------
def validate_exercise(d):
    errs = []
    if not isinstance(d, dict):
        raise ValueError("返回不是对象")
    if not isinstance(d.get("dialogue"), list) or not d["dialogue"]:
        errs.append("dialogue 缺失或为空")
    else:
        for i, t in enumerate(d["dialogue"]):
            if not isinstance(t, dict) or not isinstance(t.get("content"), str) or not t["content"].strip():
                errs.append("dialogue[%d].content 无效" % i)
    if not isinstance(d.get("questions"), list) or not d["questions"]:
        errs.append("questions 缺失或为空")
    else:
        for i, q in enumerate(d["questions"]):
            if not isinstance(q, dict) or not isinstance(q.get("question"), str):
                errs.append("questions[%d].question 无效" % i)
            opts = q.get("options") if isinstance(q, dict) else None
            if not isinstance(opts, dict) or any(k not in opts for k in "ABCD"):
                errs.append("questions[%d] 选项必须含 A/B/C/D" % i)
            if q.get("answer") not in ("A", "B", "C", "D"):
                errs.append("questions[%d].answer 必须是 A/B/C/D" % i)
    if errs:
        raise ValueError("；".join(errs))


def check_conversation(exercise):
    """长对话专项校验：必须是一男一女交替的多轮对话（双方都多次发言）。返回 (ok, reason)。"""
    segs = exercise.get("dialogue", [])
    speakers = [s.get("speaker") for s in segs]
    if any(sp not in ("W", "M") for sp in speakers):
        return False, "出现了非 W/M 的 speaker，长对话应只含一男(M)一女(W)"
    if speakers.count("W") < 2 or speakers.count("M") < 2:
        return False, "只有单一性别发言，应为男女双方都多次发言"
    return True, ""


# ----------------------------------------------------------------------
# 自定义异常
# ----------------------------------------------------------------------
class ApiError(Exception):
    def __init__(self, message, status=500):
        super().__init__(message)
        self.message = message
        self.status = status


# ----------------------------------------------------------------------
# 提示词构造
# ----------------------------------------------------------------------
def build_gen_user(type_key, topic, meta):
    m = meta[type_key]
    t = topic.strip() if topic and topic.strip() else "（请随机选取一个六级常见话题，如校园生活、职场沟通、科技发展、环境保护、健康医疗、社会现象、教育学习等）"
    return ("题型规格：%s\n话题/关键词：%s\n请据此生成 %d 道题，输出 JSON。" % (m["spec"], t, m["qcount"]))


def build_custom_user(type_key, raw_text, meta):
    m = meta[type_key]
    return (
        "请基于下方用户提供的英文原文命题。规则：\n"
        "- 不要改写、增删原文；把原文按自然句切分后放入 dialogue（每个 content 为一句或一个自然小段）。\n"
        "- speaker：长对话若能判断男女交替则用 W/M，否则统一用 \"N\"；短文/讲座统一用 \"N\"。\n"
        "- 据此原文出 %d 道题（主旨+细节+推断），每题 4 选项、含迷惑项、answer 唯一。\n"
        "- word_count 按用户原文实际英文词数统计。\n"
        "- type 固定为 \"%s\"，type_label 为 \"%s\"。\n"
        "用户原文：\n\"\"\"\n%s\n\"\"\"\n只输出 JSON。" % (m["qcount"], type_key, m["label"], raw_text.strip())
    )


def build_eval_user(exercise, u1, u2, selections):
    transcript = "\n".join("%s: %s" % (d.get("speaker", "N"), d.get("content", "")) for d in exercise["dialogue"])
    sel_lines = []
    for i, q in enumerate(exercise["questions"]):
        s = selections.get(str(i + 1)) or selections.get(i + 1) or "未选"
        ok = (s == q["answer"])
        sel_lines.append("Q%d: 选 %s（正 %s）%s" % (i + 1, s, q["answer"], "✓" if ok else "✗"))
    ans_line = "  ".join("Q%d: %s" % (i + 1, q["answer"]) for i, q in enumerate(exercise["questions"]))
    return (
        "【原文】\n%s\n\n【题型】%s\n【第一遍后理解】\n%s\n\n【第二遍后理解】\n%s\n\n"
        "【选择题作答】\n%s\n【正确答案】%s\n请评估。"
        % (transcript, exercise.get("type_label", ""), u1 or "(空)", u2 or "(空)", "\n".join(sel_lines), ans_line)
    )


# ----------------------------------------------------------------------
# 路由
# ----------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/health")
def health():
    return jsonify({"ok": True, "hasKey": bool(get_key()), "model": DEFAULT_MODEL})


@app.route("/api/types")
def api_types():
    """返回题型显示信息，供前端卡片渲染（数据驱动，跟随 prompts/types.json）。"""
    meta = load_types()
    return jsonify({"types": {
        k: {"label": v.get("label", k), "emoji": v.get("emoji", ""),
            "qcount": v.get("qcount", 0), "words": v.get("words", "")}
        for k, v in meta.items()
    }})


def write_to_my(exercise, label="听力专项", with_time=False):
    """把练习写入 my/ 目录。
    with_time=True：文件名含时分秒（生成日志，避免短时间多次生成重名）；
    默认按天命名（手动保存，重名自动加序号）。
    """
    MY_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.now()
    base = now.strftime("%y%m%d-%H%M%S") if with_time else now.strftime("%y%m%d")
    path = MY_DIR / (base + label + ".txt")
    n = 1
    while path.exists():
        path = MY_DIR / ("%s-%d%s.txt" % (base, n, label))
        n += 1
    with io.open(path, "w", encoding="utf-8") as f:
        f.write(json.dumps(exercise, ensure_ascii=False, indent=2))
    return path


def refine_vocab(exercise, model=None):
    """按四六级大纲词表扫描原文，把疑似超纲词交 DeepSeek 裁定并替换。

    流程：词表扫描 → 候选词 → DeepSeek 逐个判断（保留合法六级词、仅替换真超纲词）
    → 返回 (new_dialogue_or_None, replaced_list)。
    任何环节出错都回退到不修订（不阻断生成）。词表缺失时直接返回 (None, [])。
    """
    vocab_set, _ = vocab.load_vocab()
    if not vocab_set:
        return None, []
    candidates = vocab.scan_out_of_scope(vocab.transcript_text(exercise), vocab_set)
    if not candidates:
        return None, []

    sys_msg = (
        "你是 CET-6 听力原文的词汇合规审定员。下面给出一篇听力原文，以及一个由程序用"
        "《四六级大纲词表》自动扫描得出的『疑似超纲词』候选列表。\n"
        "重要：大纲词表并不完整，许多合法的六级词（如 workplace / teamwork / digitization / childhood）"
        "未必被词表收录。因此你必须逐个判断：\n"
        " - 若该词其实是常见或六级水平词汇（哪怕词表漏收），请保留，不要替换。\n"
        " - 仅当某词确实生僻、超出六级范围时，才替换为意思最接近的『六级内』同义词；"
        "若单字替换不自然则改写整句。\n"
        "严格要求：\n"
        " 1. 只修订『确实超纲』的词所在句，其余原句一字不改；不得增删整句。\n"
        " 2. 必须保持原文原意与全部信息点（人物/事件/数字/因果/观点/态度），使基于原文的题目与答案依然成立。\n"
        " 3. 修订后句子须自然、连贯、可朗读，难度维持六级听力水平。\n"
        " 4. 长对话须保持 W/M 交替结构，speaker 标签不变。\n"
        " 5. 严格只输出一个 JSON 对象：\n"
        ' {"dialogue":[{"speaker":"W|M|N","content":"..."}],'
        '"replaced":[{"from":"原超纲词","to":"替换为的大纲词或改写说明","reason":"为何替换"}]}\n'
        "若没有任何词需要替换，dialogue 原样返回、replaced 返回空数组 []。"
    )
    cand_str = ", ".join(sorted({c["word"] for c in candidates}))
    user_msg = (
        "疑似超纲词候选（小写，已去重）：%s\n\n"
        "原始 dialogue：\n%s\n\n请逐个裁定并输出修订结果。"
        % (cand_str, json.dumps(exercise["dialogue"], ensure_ascii=False))
    )
    try:
        raw = call_deepseek(
            [{"role": "system", "content": sys_msg}, {"role": "user", "content": user_msg}],
            model,
        )
        data = parse_json_loose(raw)
    except Exception as e:  # noqa: broad-except - 词汇修订失败不应阻断生成
        app.logger.warning("vocab refine deepseek call failed: %s", e)
        return None, [{"from": c["word"], "to": "", "reason": "扫描到疑似超纲词，但自动修订未完成"} for c in candidates]

    if not isinstance(data, dict):
        return None, []
    new_dialogue = data.get("dialogue")
    replaced = data.get("replaced") or []
    if not isinstance(new_dialogue, list) or not new_dialogue:
        return None, replaced
    # 结构校验：每段须有非空 content
    ok_struct = all(isinstance(t, dict) and isinstance(t.get("content"), str) and t["content"].strip()
                    for t in new_dialogue)
    if not ok_struct:
        return None, replaced
    return new_dialogue, replaced


@app.route("/api/generate", methods=["POST"])
def api_generate():
    data = request.get_json(silent=True) or {}
    type_key = (data.get("type") or "").strip()
    meta = load_types()                       # 每次请求重读 prompts/，随时改随时生效
    if type_key not in meta:
        return jsonify({"error": "题型无效，应为 conversation / passage / lecture"}), 400
    custom_text = (data.get("customText") or "").strip()
    topic = data.get("topic") or ""
    model = data.get("model") or None

    if custom_text:
        if len(custom_text.split()) < 40:
            return jsonify({"error": "自定义原文过短（少于 40 词），请补充后再生成。"}), 400
        user_msg = build_custom_user(type_key, custom_text, meta)
    else:
        user_msg = build_gen_user(type_key, topic, meta)

    sys_gen = load_gen_prompt()               # 软编码的系统提示词
    # 生成 + 校验 + （长对话）男女交替校验；任一不达标自动重试一次
    exercise = None
    reminder = ""
    last_err = "未知错误"
    for _attempt in range(2):
        try:
            raw = call_deepseek(
                [{"role": "system", "content": sys_gen}, {"role": "user", "content": user_msg + reminder}],
                model,
            )
            exercise = parse_json_loose(raw)
            validate_exercise(exercise)
            if type_key == "conversation":
                ok, why = check_conversation(exercise)
                if not ok:
                    raise ValueError(why)
            break
        except ApiError as e:
            return jsonify({"error": e.message}), e.status
        except (ValueError, json.JSONDecodeError) as e:
            last_err = str(e)
            reminder = (
                "\n\n【修正要求】上次的输出有问题（%s）。请重新生成并严格只输出一个 JSON 对象，"
                "不要任何前后缀或解释；若是长对话，speaker 必须严格在 W(女) 与 M(男) 间交替、男女双方各发言多次。"
                % last_err
            )
    else:
        # 两次都不达标
        return jsonify({"error": "生成未达标（%s），请再试一次。" % last_err}), 502

    exercise["type"] = type_key
    exercise["type_label"] = meta[type_key]["label"]

    # 超纲词校验与替换（仅 AI 生成模式；自定义原文模式尊重"原文保留不变"）
    exercise["vocab_adjustments"] = []
    vocab_check = data.get("vocabCheck")
    if vocab_check is None:
        vocab_check = os.environ.get("CET_VOCAB_CHECK", "1") not in ("0", "false", "False", "")
    if vocab_check and not custom_text:
        try:
            new_dialogue, replaced = refine_vocab(exercise, model)
            if new_dialogue:
                if type_key == "conversation":
                    ok, _ = check_conversation({"dialogue": new_dialogue})
                    if ok:
                        exercise["dialogue"] = new_dialogue
                else:
                    exercise["dialogue"] = new_dialogue
            if replaced:
                exercise["vocab_adjustments"] = replaced
        except ApiError:
            raise  # 密钥/网络类错误继续上抛
        except Exception as e:  # noqa: broad-except - 词汇修订失败不应阻断生成
            app.logger.warning("vocab refine skipped: %s", e)

    # 生成后立即落盘为日志（失败不影响生成结果本身）
    saved = None
    try:
        saved = str(write_to_my(exercise, label="听力生成", with_time=True).relative_to(BASE_DIR.parent))
    except Exception as e:  # noqa: broad-except - 日志保存失败不应阻断生成
        app.logger.warning("auto-save generation log failed: %s", e)
    return jsonify({"exercise": exercise, "saved": saved})


@app.route("/api/evaluate", methods=["POST"])
def api_evaluate():
    data = request.get_json(silent=True) or {}
    exercise = data.get("exercise")
    u1 = data.get("u1") or ""
    u2 = data.get("u2") or ""
    selections = data.get("selections") or {}
    model = data.get("model") or None
    if not isinstance(exercise, dict):
        return jsonify({"error": "缺少练习数据"}), 400
    try:
        validate_exercise(exercise)
    except ValueError as e:
        return jsonify({"error": "练习数据无效：%s" % e}), 400

    user_msg = build_eval_user(exercise, u1, u2, selections)
    try:
        raw = call_deepseek([{"role": "system", "content": load_eval_prompt()}, {"role": "user", "content": user_msg}], model)
        result = parse_json_loose(raw)
    except ApiError as e:
        return jsonify({"error": e.message}), e.status
    except (ValueError, json.JSONDecodeError) as e:
        return jsonify({"error": "AI 评分结果无法解析：%s" % e}), 502

    # 服务端兜底统计选项正确率（防 AI 算错）
    correct = sum(1 for i, q in enumerate(exercise["questions"]) if selections.get(str(i + 1)) == q["answer"])
    total = len(exercise["questions"])
    result.setdefault("option_accuracy", "%d/%d" % (correct, total))
    return jsonify({"result": result, "option_accuracy_server": "%d/%d" % (correct, total)})


@app.route("/api/save", methods=["POST"])
def api_save():
    data = request.get_json(silent=True) or {}
    exercise = data.get("exercise")
    if not isinstance(exercise, dict):
        return jsonify({"error": "缺少练习数据"}), 400
    try:
        path = write_to_my(exercise, label="听力专项", with_time=False)
        return jsonify({"ok": True, "path": str(path.relative_to(BASE_DIR.parent))})
    except OSError as e:
        return jsonify({"error": "保存失败：%s" % e}), 500


# ----------------------------------------------------------------------
# 启动
# ----------------------------------------------------------------------
def open_browser(port):
    webbrowser.open("http://127.0.0.1:%d" % port)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5555))
    host = os.environ.get("HOST", "127.0.0.1")
    if not os.environ.get("NO_OPEN_BROWSER"):
        threading.Timer(1.2, lambda: open_browser(port)).start()
    print("=" * 56)
    print("  CET-6 听力专项训练  ->  http://%s:%d" % (host, port))
    print("  API Key 状态：" + ("已配置 [OK]" if get_key() else "未配置 [X]  请编辑 .env"))
    print("  按 Ctrl+C 退出")
    print("=" * 56)
    app.run(host=host, port=port, debug=False)
