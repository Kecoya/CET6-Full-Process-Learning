# -*- coding: utf-8 -*-
"""
CET-6 精读训练（逐段翻译 + AI 纠错） —— Flask 后端
运行：python app.py   （然后自动打开 http://127.0.0.1:5561）
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

BASE_DIR = Path(__file__).resolve().parent
MY_DIR = BASE_DIR.parent / "my"
ENV_FILE = BASE_DIR / ".env"

DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions"
DEFAULT_MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-v4-flash")
DEFAULT_PORT = 5561
TYPE_LABEL = "精读训练"

app = Flask(__name__)


def load_env(path):
    if not path.exists():
        return
    with io.open(path, "r", encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_env(ENV_FILE)


def get_key():
    return os.environ.get("DEEPSEEK_API_KEY", "").strip()


PROMPTS_DIR = BASE_DIR / "prompts"


def _read_text_file(path):
    try:
        with io.open(path, "r", encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


def load_gen_prompt():
    t = _read_text_file(PROMPTS_DIR / "system_generate.txt").strip()
    return t if t else "你是 CET-6 精读命题专家。根据关键词生成约 700 词、6–8 段的英文文章+中文参考译文+key_terms，严格只输出 JSON。"


def load_eval_prompt():
    t = _read_text_file(PROMPTS_DIR / "system_evaluate.txt").strip()
    return t if t else "你是 CET-6 逐段翻译纠错导师。对照原文与参考译文，指出译错处及原因，严格只输出 JSON。"


class ApiError(Exception):
    def __init__(self, message, status=500):
        super().__init__(message)
        self.message = message
        self.status = status


def safe_text(resp):
    try:
        j = resp.json()
        return (j.get("error") or {}).get("message") or json.dumps(j, ensure_ascii=False)[:300]
    except ValueError:
        return resp.text[:300]


def call_deepseek(messages, model=None, max_tokens=8000):
    key = get_key()
    if not key:
        raise ApiError("服务端未配置 DEEPSEEK_API_KEY。请在 精读训练/.env 中设置 DEEPSEEK_API_KEY=sk-...", 503)
    payload = {
        "model": model or DEFAULT_MODEL,
        "messages": messages,
        "temperature": 0.7,
        "response_format": {"type": "json_object"},
        "max_tokens": max_tokens,
        "stream": False,
    }
    try:
        resp = requests.post(
            DEEPSEEK_URL,
            headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
            json=payload, timeout=180,
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
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise ApiError("DeepSeek 返回结构异常：%s" % json.dumps(data, ensure_ascii=False)[:500], 502)


def parse_json_loose(raw):
    s = raw.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", s, re.I)
    if fence:
        s = fence.group(1).strip()
    a, b = s.find("{"), s.rfind("}")
    if a != -1 and b != -1 and b > a:
        s = s[a:b + 1]
    return json.loads(s)


def validate_article(d):
    errs = []
    if not isinstance(d, dict):
        raise ValueError("返回不是对象")
    paras = d.get("paragraphs")
    if not isinstance(paras, list) or len(paras) < 4:
        errs.append("paragraphs 须为至少 4 段（目标 6–8 段）")
    else:
        for i, p in enumerate(paras):
            if not isinstance(p, dict) or not isinstance(p.get("en"), str) or len(p["en"].strip()) < 20:
                errs.append("paragraphs[%d].en 无效或过短" % i)
            if not isinstance(p.get("reference"), str) or not p["reference"].strip():
                errs.append("paragraphs[%d].reference 缺失" % i)
            if not isinstance(p.get("key_terms"), list):
                p["key_terms"] = []
            p.setdefault("no", i + 1)
    if errs:
        raise ValueError("；".join(errs))


def build_gen_user(keywords, word_target):
    kw = keywords.strip() if keywords and keywords.strip() else "（关键词为空，请自行从六级高频题材中选取一个，如科技与伦理/教育心理/健康/环境/职场经济/社会现象等）"
    return ("请生成一篇 CET-6 精读训练文章：目标约 %d 词、6–8 段、每段约 90–110 词，正式书面英语、六级词汇难度。\n"
            "关键词（领域/方向/内容）：%s\n"
            "每段附「中文参考译文」与 2–4 个「六级重点词/短语(key_terms)」。输出 JSON。" % (word_target, kw))


def build_eval_user(en, reference, user_translation):
    return ("【本段英文原文】\n%s\n\n【参考译文】\n%s\n\n【学习者译文】\n%s\n\n"
            "请逐处比对，指出学习者译错或不妥之处并讲清原因。" % (en, reference, user_translation or "(空)"))


def write_to_my(exercise, label="精读训练", with_time=False):
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


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/health")
def health():
    return jsonify({"ok": True, "hasKey": bool(get_key()), "model": DEFAULT_MODEL})


@app.route("/api/generate", methods=["POST"])
def api_generate():
    data = request.get_json(silent=True) or {}
    keywords = data.get("keywords") or ""
    word_target = int(data.get("wordTarget") or 700)
    word_target = max(300, min(1500, word_target))
    model = data.get("model") or None
    user_msg = build_gen_user(keywords, word_target)
    article = None
    reminder = ""
    last_err = "未知错误"
    for _attempt in range(2):
        try:
            raw = call_deepseek(
                [{"role": "system", "content": load_gen_prompt()}, {"role": "user", "content": user_msg + reminder}],
                model,
            )
            article = parse_json_loose(raw)
            validate_article(article)
            break
        except ApiError as e:
            return jsonify({"error": e.message}), e.status
        except (ValueError, json.JSONDecodeError) as e:
            last_err = str(e)
            reminder = ("\n\n【修正要求】上次的输出有问题（%s）。请重新生成并严格只输出一个 JSON 对象，"
                        "paragraphs 为 6–8 段，每段含 en(英文)、reference(中文参考译文)、key_terms。" % last_err)
    else:
        return jsonify({"error": "生成未达标（%s），请再试一次。" % last_err}), 502

    article["type"] = "intensive"
    article["type_label"] = TYPE_LABEL
    # 真实统计词数（防 AI 虚报）
    real_wc = sum(len(p["en"].split()) for p in article["paragraphs"])
    article["word_count"] = real_wc
    saved = None
    try:
        saved = str(write_to_my(article, label="精读生成", with_time=True).relative_to(BASE_DIR.parent))
    except Exception as e:  # noqa: broad-except
        app.logger.warning("auto-save generation log failed: %s", e)
    return jsonify({"article": article, "saved": saved})


@app.route("/api/evaluate", methods=["POST"])
def api_evaluate():
    data = request.get_json(silent=True) or {}
    en = data.get("en") or ""
    reference = data.get("reference") or ""
    user_translation = data.get("answer") or ""
    model = data.get("model") or None
    if not en.strip() or not reference.strip():
        return jsonify({"error": "缺少段落原文/参考译文"}), 400
    user_msg = build_eval_user(en, reference, user_translation)
    try:
        raw = call_deepseek([{"role": "system", "content": load_eval_prompt()}, {"role": "user", "content": user_msg}],
                            model, max_tokens=4000)
        result = parse_json_loose(raw)
    except ApiError as e:
        return jsonify({"error": e.message}), e.status
    except (ValueError, json.JSONDecodeError) as e:
        return jsonify({"error": "AI 评价结果无法解析：%s" % e}), 502
    return jsonify({"result": result})


@app.route("/api/save", methods=["POST"])
def api_save():
    data = request.get_json(silent=True) or {}
    exercise = data.get("exercise")
    if not isinstance(exercise, dict):
        return jsonify({"error": "缺少练习数据"}), 400
    try:
        path = write_to_my(exercise, label="精读训练", with_time=False)
        return jsonify({"ok": True, "path": str(path.relative_to(BASE_DIR.parent))})
    except OSError as e:
        return jsonify({"error": "保存失败：%s" % e}), 500


def open_browser(port):
    webbrowser.open("http://127.0.0.1:%d" % port)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", DEFAULT_PORT))
    host = os.environ.get("HOST", "127.0.0.1")
    if not os.environ.get("NO_OPEN_BROWSER"):
        threading.Timer(1.2, lambda: open_browser(port)).start()
    print("=" * 56)
    print("  CET-6 精读训练  ->  http://%s:%d" % (host, port))
    print("  API Key 状态：" + ("已配置 [OK]" if get_key() else "未配置 [X]  请编辑 .env"))
    print("  按 Ctrl+C 退出")
    print("=" * 56)
    app.run(host=host, port=port, debug=False)
