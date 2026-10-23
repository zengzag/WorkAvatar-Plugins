// AI 助手指令定义（文档级场景指令 + 选区级改写指令）
//
// prompt 面向 LLM，固定英文；输出语言由系统提示词约束，跟随用户与文档语言
// 文档指令 ai.cmd.<key>、选区指令 ai.sel.<key>、分组 ai.group.<key>、示例 ai.example.<key>
// （i18n 死 key 扫描按 hostT 模板前缀收集，见 word-editor-i18n.test.ts）。

export type AiCommandScope = 'doc' | 'selection' | 'caret'

export interface AiCommand {
  /** 拼接 i18n key 的后缀（ai.cmd.* / ai.sel.*） */
  key: string
  /** 发送给模型的指令正文 */
  prompt: string
  scope: AiCommandScope
}

export interface AiCommandGroup {
  /** 拼接 ai.group.<key> */
  key: string
  commands: AiCommand[]
}

/** 文档级 / 光标级指令（欢迎页分组卡片 + 对话中快捷条） */
export const AI_COMMAND_GROUPS: AiCommandGroup[] = [
  {
    key: 'write',
    commands: [
      {
        key: 'outline',
        scope: 'doc',
        prompt: 'Organize this document\'s outline: read it through, use Heading 1 / Heading 2 named styles to make the chapter hierarchy clear, and reorder paragraphs where needed.',
      },
      {
        key: 'draft',
        scope: 'doc',
        prompt: 'Complete the body of each section from the existing headings and outline. Stay on topic, argue fully, and match the existing style.',
      },
      {
        key: 'continue',
        scope: 'caret',
        prompt: 'Continue writing from my caret position, following the preceding idea and matching the existing style, person, and tone.',
      },
    ],
  },
  {
    key: 'polish',
    commands: [
      {
        key: 'polish',
        scope: 'doc',
        prompt: 'Read the whole document and polish any awkward wording without changing its structure.',
      },
      {
        key: 'formal',
        scope: 'doc',
        prompt: 'Rewrite the whole document in a formal written tone without changing its content.',
      },
      {
        key: 'format',
        scope: 'doc',
        prompt: 'Improve the document\'s layout: fix heading levels, alignment, and lists so the structure is clear.',
      },
    ],
  },
  {
    key: 'review',
    commands: [
      {
        key: 'proofread',
        scope: 'doc',
        prompt: 'Check the whole document for typos, grammar errors, and punctuation, and fix them directly.',
      },
    ],
  },
  {
    key: 'read',
    commands: [
      {
        key: 'summary',
        scope: 'doc',
        prompt: 'Write a summary of this document and add it at the beginning.',
      },
      {
        key: 'todos',
        scope: 'doc',
        prompt: 'Read the document and collect its to-dos and action items into a checklist at the end, under a Heading 1 heading meaning "To-dos" in the document\'s language.',
      },
    ],
  },
]

/** 对话进行中的文档级快捷指令（横向 chips，单行可滚动） */
export const AI_QUICK_COMMANDS: AiCommand[] = AI_COMMAND_GROUPS.flatMap((g) => g.commands).filter(
  (c) => c.scope === 'doc'
)

/** 选中文字后的改写/问答指令（选中横幅内，文案走 ai.sel.<key>） */
export const AI_SELECTION_COMMANDS: AiCommand[] = [
  {
    key: 'polish',
    scope: 'selection',
    prompt: 'Polish the text I selected: improve the expression and fluency while preserving the meaning and style.',
  },
  {
    key: 'shorten',
    scope: 'selection',
    prompt: 'Shorten the text I selected, keeping the core information and removing redundancy.',
  },
  {
    key: 'expand',
    scope: 'selection',
    prompt: 'Expand the text I selected with the necessary detail and argument, matching the surrounding style.',
  },
  {
    key: 'formal',
    scope: 'selection',
    prompt: 'Rewrite the selected text in a formal written tone without changing the meaning.',
  },
  {
    key: 'translate',
    scope: 'selection',
    prompt: 'Translate the selected text into English or Chinese (detect the source language), and output only the translation without explanation.',
  },
  {
    key: 'explain',
    scope: 'selection',
    prompt: 'Explain what the selected text means in plain language; do not modify the document.',
  },
]

/** 欢迎页示例后缀（文案走 ai.example.<key>，点击后填入输入框可编辑） */
export const AI_EXAMPLES = ['1', '2', '3']

/** 拼进用户消息的选中原文上限（超长截断，AI 另有 doc_find 可定位） */
export const MAX_QUOTED_SELECTION = 6000
