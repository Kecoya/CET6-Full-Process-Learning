本目录存放"听力专项训练"的全部命题提示词（软编码）。
后端 app.py 每次生成/评分时都会重新读取这里的文件，所以你随时用记事本/VSCode 修改、保存即可生效，
无需改代码、无需重启服务器（刷新浏览器或重新生成即可看到效果）。

文件说明：
- system_generate.txt   生成听力原文+题目的"系统提示词"（命题总规则、选项设计、输出 JSON 格式）
- system_evaluate.txt   AI 评分理解度的"系统提示词"
- types.json            三种题型的显示信息（label 名称 / emoji / qcount 题数 / words 词数说明）
- spec_conversation.txt 长对话的命题细节（考点、干扰项、典型题干等）—— 改这里就能调整长对话风格
- spec_passage.txt      听力篇章的命题细节
- spec_lecture.txt      讲话·报道·讲座的命题细节

规则：
- 这些文件"覆盖"app.py 里的内置默认值。若删除某个文件，后端会回退到代码内置默认（不影响运行）。
- spec_*.txt 是纯文本，可直接换行书写；types.json 必须保持合法 JSON（注意逗号、引号）。
- 修改 system_generate.txt 里 JSON 结构字段时，务必保持字段名与 app.py 的 validate_exercise 一致
  （dialogue / questions / options A-D / answer 等），否则后端会判定生成失败并自动重试。
