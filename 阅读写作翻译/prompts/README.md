# CET-6 阅读写作翻译 — 命题提示词（真题数据驱动）

本目录存放六级考试**阅读、写作、翻译**五大题型的命题系统提示词（system prompt），每条提示词的规格都由 `材料/CET6真题提取数据/` 下 49 套真题（2019–2024）逐项统计得出，非凭空编写。统计过程见 `材料/CET6真题提取数据/_analyze_rw.py`，结果见 `analysis_rw.txt`。

## 提示词文件（每个 = 一个题型的完整 system prompt，可直接喂给 DeepSeek / 任何 OpenAI 兼容模型）

| 文件 | 题型 | 真题实测规格（关键） |
|---|---|---|
| `system_cloze.txt` | 选词填空 Section A | 原文 ~282 词、10 空、词库固定 15 词(A–O)，**必含同根不同形陷阱**(如 concede/conceded、correlation/correlate) |
| `system_matching.txt` | 长篇阅读 Section B (匹配) | 原文 **~1233 词**、10–14 段、10 条陈述句(每条 ~17 词)对段落同义改写 |
| `system_careful.txt` | 仔细阅读 Section C | 每篇 **~447 词**、5 题、题干 **What 占 80%**、选项中位 8 词 |
| `system_writing.txt` | 写作 | **全部 150–200 词议论文**；主题模板固定(importance of… / saying 谚语 / why students should… / 时代话题) |
| `system_translation.txt` | 翻译(汉译英) | **~174 中文字**；题材集中中国文化/国情/工程成就；专有名词首次出现括注英文 |

## 使用方法

每个文件是一个**自包含的 system prompt**（角色 + 真题规格 + 命题规则 + 严格 JSON 输出格式 + 硬性要求）。调用 DeepSeek（OpenAI 兼容协议）时：

- `messages[0]` = `{"role":"system","content": <本文件全文>}`
- `messages[1]` = `{"role":"user","content": "请生成一道[某题型]，话题：…，输出 JSON。"}`（或直接让其随机出题）
- 建议参数：`temperature: 0.7`，`response_format: {"type":"json_object"}`，`max_tokens: 4096+`（匹配/仔细阅读原文较长，建议 6000–8000）。

## 各题型输出 JSON 概览

**选词填空 cloze**
```json
{"type":"cloze","title":"...","topic":"...",
 "passage":"原文,空格用 __26__~__35__ 标记",
 "word_bank":[{"letter":"A","word":"..."}, ... 共15个],
 "answers":{"26":"C",...,"35":"K"},
 "blanks":[{"no":26,"answer_letter":"C","answer_word":"...","pos_needed":"名词","grammar_clue":"...","meaning_clue":"..."}, ...10条],
 "notes":["同根词族与干扰说明"],"word_count":282}
```

**长篇匹配 matching**
```json
{"type":"matching","title":"...","topic":"...",
 "passage":[{"label":"A","text":"..."}, ... 10–14段],
 "statements":[{"no":36,"text":"..."}, ... 10条],
 "answers":{"36":"B",...,"45":"N"},
 "explanations":[{"no":36,"paragraph":"B","clue":"定位词+改写说明"}, ...10条],
 "word_count":1233}
```

**仔细阅读 careful**
```json
{"type":"careful","title":"...","topic":"...",
 "passage":"~450词原文",
 "questions":[{"no":46,"stem":"...","options":{A,B,C,D},"answer":"A","explanation":"..."}, ... 5条],
 "word_count":447}
```

**写作 writing**
```json
{"type":"writing","genre":"essay","topic":"...",
 "prompt":"Directions: ... 150–200 words","prompt_type":"importance|saying|why-encourage|contemporary",
 "sample_essay":"范文(150–200词)","outline":["要点1","要点2","要点3"],
 "key_phrases":["高级表达(中英对照)"],"word_count":180}
```

**翻译 translation**
```json
{"type":"translation","topic":"...",
 "source":"中文原文(170–190字,专有名词括注英文)","reference":"参考译文",
 "key_terms":[{"cn":"牡丹","en":"peony","note":"..."}],
 "sentence_notes":[{"source":"中文难句","analysis":"翻译技巧解析"}],
 "char_count":178}
```

## 说明
- 这些提示词目前**独立于听力专项训练 app**（听力 app 的 `prompts/` 目录只服务于三种听力题型）。若要做成带训练流程的 app（类似听力专项训练的 盲听→答题→评分→精听 状态机），可仿照 `听力专项训练/app.py` 的 `load_*` 软编码模式，把这里的 system_*.txt 接入后端。
- 所有提示词都强调了真题实测的词数/题数/句式/干扰项规律，确保 AI 生成的题目与真题"相差无几"。如需调整某题型，直接改对应 txt 即可。
