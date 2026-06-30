# -*- coding: utf-8 -*-
"""
四六级大纲词汇加载与"超纲词"检测。

用途：在 AI 生成 CET-6 听力原文后，扫描原文用词是否落在《全国大学英语四、六级
考试大纲·词表（2016 修订版）》范围内；不在范围内的词交由后端调 DeepSeek 做同义
替换或整句改写，使原文用词符合大纲。

设计要点（对应考纲词表说明）：
- 词表每行一个词目；六级词在行首以 ★ 标记。
- 同形异音/异义词用上标分列（lead¹ / lead²），归一化为同一词形。
- 有两种拼法的并列用 '/'（adviser/advisor），拆成两个词都收入。
- 形如 labo(u)r 的，按"有括注 / 无括注"各收一个（labor / labour）。
- 考纲明确"派生词原则上不单列"（列了 serious 就不另列 seriously/seriousness），
  因此检测时对常见屈折/派生后缀做还原，避免把合规派生词误判为超纲。
- 专有名词（人名/地名/机构缩写）按大小写启发式跳过，不计为超纲。
"""

import io
import re
import threading
from pathlib import Path

# 上标数字 → 普通数字
SUPER_MAP = str.maketrans("⁰¹²³⁴⁵⁶⁷⁸⁹", "0123456789")

# 默认词表位置：CET-6学习/材料/四六级大纲词汇.txt（可被环境变量覆盖）
DEFAULT_VOCAB = Path(__file__).resolve().parent.parent / "材料" / "四六级大纲词汇.txt"

# 合法词目行：可选 ★ 开头，首字符为字母，其余仅含字母/'/-/()及上标
_WORD_RE = re.compile(r"^(★)?[A-Za-z][A-Za-z'\-/()¹²³⁴⁵⁶⁷⁸⁹⁰]*$")

_lock = threading.Lock()
_cache = {"vocab": None, "cet6": None, "path": None}


def _normalize_line(line):
    """把一行词目归一化为若干小写词形（处理 ★、上标、'/'、括注）。"""
    line = line.strip()
    if not line or line[0] in "=#":
        return []
    if not _WORD_RE.match(line):
        return []
    line = line.lstrip("★").translate(SUPER_MAP)
    line = re.sub(r"\d+$", "", line)  # 去掉同形异词的尾随数字（lead1 → lead）
    out = []
    for part in line.split("/"):
        part = part.strip()
        if not part:
            continue
        m = re.search(r"\(([a-z]*)\)", part)  # labo(u)r 之类
        if m:
            ins = m.group(1)
            out.append(part.replace("(" + ins + ")", "").lower())   # labor
            out.append(part.replace("(" + ins + ")", ins).lower())  # labour
        else:
            out.append(part.lower())
    return [w for w in out if w]


def load_vocab(path=None):
    """加载并缓存词表。返回 (vocab_set, cet6_set)；文件缺失返回 (None, None)。"""
    path = Path(path) if path else DEFAULT_VOCAB
    with _lock:
        if _cache["vocab"] is not None and _cache["path"] == str(path):
            return _cache["vocab"], _cache["cet6"]
        vocab, cet6 = set(), set()
        try:
            with io.open(path, "r", encoding="utf-8") as f:
                for line in f:
                    is6 = line.lstrip().startswith("★")
                    for w in _normalize_line(line):
                        vocab.add(w)
                        if is6:
                            cet6.add(w)
        except OSError:
            return None, None
        _cache["vocab"] = vocab
        _cache["cet6"] = cet6
        _cache["path"] = str(path)
        return vocab, cet6


# 常见不规则复数 / 不规则动词过去式与过去分词 → 词目。考纲词表只列词目，故需映射。
_IRREGULAR = {
    "children": "child", "men": "man", "women": "woman", "people": "person",
    "feet": "foot", "teeth": "tooth", "geese": "goose", "mice": "mouse",
    "spoke": "speak", "spoken": "speak", "drawn": "draw", "drew": "draw",
    "dug": "dig", "taught": "teach", "shaken": "shake", "risen": "rise", "rose": "rise",
    "shown": "show", "blown": "blow", "thrown": "throw", "flown": "fly", "grown": "grow",
    "broken": "break", "frozen": "freeze", "froze": "freeze", "stolen": "steal",
    "worn": "wear", "torn": "tear", "sworn": "swear", "born": "bear", "borne": "bear",
    "hid": "hide", "hidden": "hide", "rang": "ring", "rung": "ring", "sang": "sing", "sung": "sing",
    "swam": "swim", "swum": "swim", "began": "begin", "begun": "begin",
    "fought": "fight", "caught": "catch", "brought": "bring", "bought": "buy", "sought": "seek",
    "thought": "think", "lain": "lie", "laid": "lay", "arisen": "arise",
    "ate": "eat", "eaten": "eat", "fell": "fall", "beaten": "beat",
    "became": "become", "chose": "choose", "chosen": "choose", "drove": "drive", "driven": "drive",
    "rode": "ride", "ridden": "ride", "wrote": "write", "written": "write",
    "forgot": "forget", "forgotten": "forget", "gave": "give", "given": "give",
    "went": "go", "gone": "go", "knew": "know", "known": "know", "took": "take", "taken": "take",
    "made": "make", "came": "come", "saw": "see", "found": "find", "told": "tell",
    "felt": "feel", "met": "meet", "sent": "send", "spent": "spend", "built": "build",
    "meant": "mean", "led": "lead", "held": "hold", "won": "win", "stood": "stand", "sat": "sit",
    "ran": "run", "paid": "pay", "understood": "understand", "learnt": "learn", "dreamt": "dream",
    # -ly 拼写不规则的派生（full→fully 丢一个 l，后缀规则还原不出）
    "fully": "full", "truly": "true", "duly": "due", "wholly": "whole",
}

# 常见派生前缀（去掉后若剩余仍在词表，则视为合规派生）。
_PREFIXES = ("un", "in", "im", "il", "ir", "dis", "non", "re", "over", "under",
             "out", "mis", "pre", "anti", "mid", "co", "semi", "sub", "super",
             "inter", "trans", "fore", "self")


def _clean_token(tok):
    """剥离缩约/所有格附着，返回待检测的词基（don't→do, parents'→parents, you'll→you）。"""
    low = tok.lower()
    if low in _NONT:                                     # won't→will, can't→can（不规则缩约）
        return _NONT[low]
    tok = re.sub(r"n't$", "", tok)                       # don't→do, isn't→is
    tok = re.sub(r"'(s|ll|re|ve|d|m)$", "", tok)         # parent's→parent, you'll→you
    tok = tok.rstrip("'")                                # parents'→parents
    return tok


# 不规则缩约（直接 n't 剥离会出错：won't→wo、can't→ca）
_NONT = {"won't": "will", "can't": "can", "shan't": "shall", "mayn't": "may"}


def _stems(w):
    """生成 w 的候选词干（去屈折/派生后缀）。考纲派生词不单列，故需宽松还原。"""
    cands = {w}
    if w in _IRREGULAR:                          # children→child / drawn→draw
        cands.add(_IRREGULAR[w])

    def add(base):
        if len(base) >= 3:
            cands.add(base)
            cands.add(base + "e")  # hoped→hop→hope

    # 去前缀（un-/in-/dis-/re-/non-/over- 等）；仅当剩余仍是词时才由词表命中过滤
    for p in _PREFIXES:
        if w.startswith(p) and len(w) - len(p) >= 3:
            cands.add(w[len(p):])

    if w.endswith("ies") and len(w) > 5:
        add(w[:-3] + "y"); add(w[:-3])           # cities→city
    elif w.endswith("es") and len(w) > 4:
        add(w[:-2]); add(w[:-1])                  # boxes→box
    elif w.endswith("s") and len(w) > 3:
        add(w[:-1])                               # cats→cat

    if w.endswith("ied") and len(w) > 4:
        add(w[:-3] + "y")                         # carried→carry
    elif w.endswith("ed") and len(w) > 4:
        base = w[:-2]; add(base)
        if len(base) >= 2 and base[-1] == base[-2]:
            cands.add(base[:-1])                  # stopped→stopp→stop

    if w.endswith("ing") and len(w) > 4:
        base = w[:-3]; add(base)                  # making→mak→make
        if len(base) >= 2 and base[-1] == base[-2]:
            cands.add(base[:-1])                  # running→runn→run

    if w.endswith("ly") and len(w) > 4:
        add(w[:-2])                               # seriously→serious

    # 比较级 / 最高级（-er / -est / -ier / -iest）。仅当词干真的在词表里才生效，安全。
    if w.endswith("iest") and len(w) > 5:
        add(w[:-4] + "y")                         # happiest→happy
    elif w.endswith("ier") and len(w) > 4:
        add(w[:-3] + "y")                         # easier→easy
    if w.endswith("est") and len(w) > 4:
        add(w[:-3]); cands.add(w[:-3] + "e")      # largest→large
    if w.endswith("er") and len(w) > 3:
        add(w[:-2])                               # faster→fast / larger→large(走 +e)

    for suf in ("ment", "ness", "tion", "sion", "ity", "able", "ible",
                "less", "ful", "ous", "ive", "ism", "ist", "ize", "ise",
                "ify", "ate", "ant", "ent", "or", "ery", "ance", "ence"):
        if w.endswith(suf) and len(w) - len(suf) >= 3:
            add(w[:-len(suf)])
    return cands


def _is_proper_or_num(token):
    """启发式跳过专有名词/缩写/含数字词（按原大小写判断，需在 lower 化之前调用）。"""
    if any(ch.isdigit() for ch in token):
        return True
    # 含大写字母视为专有名词/缩写（U.S. / NASA / Mary / Aberdeen）；句首常见词本就不超纲
    if token and token[0].isupper():
        return True
    return False


# 高频核心词（be/do/have 等不规则变位、代词、冠词、介词、连词、常用不规则动词过去式等）。
# 考纲词表只列词目（如 be / keep），不列 is / kept 等屈折形式；这些词显然属于 CET 范围，
# 直接判定为合规，避免误报。
_CORE = set("""
a an the
am is are was were be been being
have has had having do does did done doing
go goes going went gone come comes coming came
get gets getting got gotten make makes making made
take takes taking took taken keep keeps keeping kept
know knows knowing knew known think thinks thinking thought
see sees seeing saw seen say says saying said
tell tells telling told give gives giving gave given
find finds finding found leave leaves leaving left
feel feels feeling felt put puts putting
bring brings bringing brought begin begins beginning began begun
write writes writing wrote written sit sits sitting sat
stand stands standing stood lose loses losing lost
pay pays paying paid meet meets meeting met
run runs running ran spend spends spending spent
grow grows growing grew grown lead leads leading led
build builds building built happen happens happening happened
become becomes becoming became understand understands understanding understood
let lets letting mean means meaning meant
read reads reading win wins winning won
hold holds holding held fall falls falling fell fallen
send sends sending sent sing sings singing sang sung
drink drinks drinking drank drunk ring rings ringing rang rung
swim swims swimming swam sunk
will would can could shall should may might must ought
not no yes
i you he she it we they me him her us them
my your his its our their mine yours hers ours theirs
this that these those who whom whose which what
of in on at to for from with by about as into through during
before after above below up down out off over under again further then once
here there when where why how
and but or nor so yet if because while although though unless since until
very just also only more most much many some any all both each few little other another same such
even still back away again now ever never always often sometimes
don't didn't doesn't isn't aren't wasn't weren't won't wouldn't can't couldn't
shouldn't i'm you're it's they're we're that's there's here's what's
""".split())


def _in_core(w):
    return w in _CORE


def _word_in_scope(w, vocab):
    """单个（已小写、已剥附着、已去前缀的）词是否在范围内。"""
    if not w or _in_core(w):
        return True
    return any(c in vocab for c in _stems(w))


def scan_out_of_scope(text, vocab):
    """扫描英文文本，返回疑似超纲词候选列表 [{word, context}]。

    含连字符的复合词：拆开后若各部分均在范围内，则视为合规，不计。
    缩约/所有格已剥（don't/parent's/parents'）。
    本函数只做"候选筛选"——最终是否真超纲、是否替换，交由后端 DeepSeek 裁定，
    以免因词表本身缺收（如 workplace/gender 等合法六级词）而误改。
    """
    if not vocab or not text:
        return []
    found = []
    seen = set()
    for sent in re.split(r"(?<=[.!?])\s+", text):
        for tok in re.findall(r"[A-Za-z][A-Za-z'\-]*", sent):
            if _is_proper_or_num(tok):
                continue
            base = _clean_token(tok).strip("-")
            if len(base) < 3:                            # 丢弃 ca/wo/s/th 等剥附着后的残片
                continue
            if "-" in base:
                # 复合词：各部分均在范围内则合规
                parts = [p for p in base.split("-") if p]
                if parts and all(_word_in_scope(p.lower(), vocab) for p in parts):
                    continue
                # 否则把整词作为候选（让 DeepSeek 判断）
                w = base.lower()
            else:
                w = base.lower()
                if _word_in_scope(w, vocab):
                    continue
            if not w or w in seen:
                continue
            seen.add(w)
            ctx = sent.strip()
            if len(ctx) > 180:
                ctx = ctx[:180] + "…"
            found.append({"word": w, "context": ctx})
    return found


def transcript_text(exercise):
    """把 exercise 的 dialogue 拼成纯文本，便于扫描。"""
    return "\n".join(seg.get("content", "") for seg in exercise.get("dialogue", []))


# ---------------- 自检 ----------------
if __name__ == "__main__":
    vocab, cet6 = load_vocab()
    print("vocab size:", len(vocab) if vocab else None, "| CET6 ★:", len(cet6) if cet6 else None)
    sample = (
        "Welcome to Money Matters, a weekly program that helps you manage your money. "
        "Mary Johnson will talk about budgeting and the allure of prestigious goods. "
        "The serendipitous catastrophes of modern ephemeral consumerism baffled researchers."
    )
    flagged = scan_out_of_scope(sample, vocab)
    for f in flagged:
        print("  FLAG:", f["word"], "|", f["context"])
