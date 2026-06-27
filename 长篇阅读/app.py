# -*- coding: utf-8 -*-
"""
CET-6 长篇阅读 / 段落匹配 (Matching, Section B) —— Flask 后端
运行：python app.py   （然后自动打开 http://127.0.0.1:5557）
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
DEFAULT_PORT = 5557
TYPE_LABEL = "长篇阅读"

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
    t = _read_text_file(PROMPTS_DIR / "system_matching.txt").strip()
    return t if t else "你是 CET-6 长篇阅读命题专家。生成约 1200 词、10–14 段原文 + 10 条陈述句(36–45)，每条对应一个段落，严格只输出 JSON。"


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


def call_deepseek(messages, model=None):
    key = get_key()
    if not key:
        raise ApiError("服务端未配置 DEEPSEEK_API_KEY。请在 长篇阅读/.env 中设置 DEEPSEEK_API_KEY=sk-...", 503)
    payload = {
        "model": model or DEFAULT_MODEL,
        "messages": messages,
        "temperature": 0.7,
        "response_format": {"type": "json_object"},
        "max_tokens": 10000,
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


def validate_exercise(d):
    errs = []
    if not isinstance(d, dict):
        raise ValueError("返回不是对象")
    passage = d.get("passage")
    if not isinstance(passage, list) or not (10 <= len(passage) <= 16):
        errs.append("passage 须为 10–14 段（数组）")
    else:
        labels = set()
        for i, p in enumerate(passage):
            if not isinstance(p, dict) or not isinstance(p.get("label"), str) or not isinstance(p.get("text"), str) or not p["text"].strip():
                errs.append("passage[%d] 须含 label/text" % i)
            else:
                labels.add(p["label"])
    statements = d.get("statements")
    if not isinstance(statements, list) or len(statements) != 10:
        errs.append("statements 须为 10 条")
    else:
        for i, st in enumerate(statements):
            if not isinstance(st, dict) or not isinstance(st.get("text"), str) or not st["text"].strip():
                errs.append("statements[%d].text 无效" % i)
    ans = d.get("answers")
    if not isinstance(ans, dict) or len(ans) != 10:
        errs.append("answers 须含 10 项(36–45)")
    else:
        if 'labels' in dir() and ans:
            for k, v in ans.items():
                if v not in labels:
                    errs.append("answers[%s]=%s 不在段落字母集合内" % (k, v))
                    break
    if not isinstance(d.get("explanations"), list):
        d["explanations"] = []
    if errs:
        raise ValueError("；".join(errs))


def build_gen_user(topic):
    t = topic.strip() if topic and topic.strip() else "（请随机选取一个六级常见话题，如商业消费、科技伦理、健康营养、教育心理、环境可持续等）"
    return ("请生成一篇 CET-6 长篇阅读（Section B 段落匹配）：约 1000–1300 词、10–14 段(标号 A 起)的原文，"
            "加 10 条陈述句(36–45)，每条是对某段落核心信息的同义改写，附 answers 与 explanations(定位词+改写)。\n"
            "话题/关键词：%s\n输出 JSON。" % t)


def write_to_my(exercise, label="长篇阅读", with_time=False):
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
    topic = data.get("topic") or ""
    model = data.get("model") or None
    user_msg = build_gen_user(topic)
    exercise = None
    reminder = ""
    last_err = "未知错误"
    for _attempt in range(2):
        try:
            raw = call_deepseek(
                [{"role": "system", "content": load_gen_prompt()}, {"role": "user", "content": user_msg + reminder}],
                model,
            )
            exercise = parse_json_loose(raw)
            validate_exercise(exercise)
            break
        except ApiError as e:
            return jsonify({"error": e.message}), e.status
        except (ValueError, json.JSONDecodeError) as e:
            last_err = str(e)
            reminder = ("\n\n【修正要求】上次的输出有问题（%s）。请重新生成并严格只输出一个 JSON 对象，"
                        "passage 为 10–14 段数组(每段含 label 与 text)，statements 恰好 10 条。" % last_err)
    else:
        return jsonify({"error": "生成未达标（%s），请再试一次。" % last_err}), 502

    exercise["type"] = "matching"
    exercise["type_label"] = TYPE_LABEL
    saved = None
    try:
        saved = str(write_to_my(exercise, label="长篇阅读生成", with_time=True).relative_to(BASE_DIR.parent))
    except Exception as e:  # noqa: broad-except
        app.logger.warning("auto-save generation log failed: %s", e)
    return jsonify({"exercise": exercise, "saved": saved})


@app.route("/api/save", methods=["POST"])
def api_save():
    data = request.get_json(silent=True) or {}
    exercise = data.get("exercise")
    if not isinstance(exercise, dict):
        return jsonify({"error": "缺少练习数据"}), 400
    try:
        path = write_to_my(exercise, label="长篇阅读", with_time=False)
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
    print("  CET-6 长篇阅读  ->  http://%s:%d" % (host, port))
    print("  API Key 状态：" + ("已配置 [OK]" if get_key() else "未配置 [X]  请编辑 .env"))
    print("  按 Ctrl+C 退出")
    print("=" * 56)
    app.run(host=host, port=port, debug=False)
