// AI 助手指令定义（对标 WPS/飞书：文档级场景指令 + 选区级改写指令）
//
// prompt 面向 LLM，沿用中文不本地化；UI 文案用 key 拼 i18n 前缀：
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
        prompt: '请梳理并整理这篇文档的大纲结构：通读全文后用 Heading 1 / Heading 2 命名样式明确章节层级，必要时调整段落顺序，使整体结构更清晰。',
      },
      {
        key: 'draft',
        scope: 'doc',
        prompt: '请根据文档现有的标题和大纲补全各章节正文，内容紧扣主题、论述完整，风格与已有内容保持一致。',
      },
      {
        key: 'continue',
        scope: 'caret',
        prompt: '请从我的光标位置开始，顺着上文思路继续写作，保持原文的风格、人称和语气一致。',
      },
    ],
  },
  {
    key: 'polish',
    commands: [
      {
        key: 'polish',
        scope: 'doc',
        prompt: '请通读全文，把语言表达不够流畅的地方润色一遍，保持结构不变。',
      },
      {
        key: 'formal',
        scope: 'doc',
        prompt: '把全文调整为正式书面语气，保持内容不变。',
      },
      {
        key: 'format',
        scope: 'doc',
        prompt: '优化文档排版：修正标题层级、对齐和列表，使结构更清晰。',
      },
    ],
  },
  {
    key: 'review',
    commands: [
      {
        key: 'proofread',
        scope: 'doc',
        prompt: '检查全文错别字、语病和标点符号，直接修正。',
      },
    ],
  },
  {
    key: 'read',
    commands: [
      {
        key: 'summary',
        scope: 'doc',
        prompt: '为这篇文档生成一段摘要，加到文档开头。',
      },
      {
        key: 'todos',
        scope: 'doc',
        prompt: '请通读全文，把其中的待办事项和行动项整理成一份清单，插入到文档末尾，清单前用 Heading 1 样式加标题「待办事项」。',
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
    prompt: '请润色我选中的这段文字：优化表达、让语句更通顺，保持原意和风格不变。',
  },
  {
    key: 'shorten',
    scope: 'selection',
    prompt: '请把我选中的文字精简缩写，保留核心信息，去掉冗余表述。',
  },
  {
    key: 'expand',
    scope: 'selection',
    prompt: '请扩写我选中的这段内容，补充必要的细节和论述，与上下文风格保持一致。',
  },
  {
    key: 'formal',
    scope: 'selection',
    prompt: '请把我选中的文字调整为正式书面语气，保持原意不变。',
  },
  {
    key: 'translate',
    scope: 'selection',
    prompt: '请把我选中的文字翻译成英文或中文（按原文语言自动判断），只输出译文，不要解释。',
  },
  {
    key: 'explain',
    scope: 'selection',
    prompt: '请解释我选中的这段内容是什么意思，用通俗易懂的话说明即可，不要修改文档。',
  },
]

/** 欢迎页示例后缀（文案走 ai.example.<key>，点击后填入输入框可编辑） */
export const AI_EXAMPLES = ['1', '2', '3']

/** 拼进用户消息的选中原文上限（超长截断，AI 另有 doc_find 可定位） */
export const MAX_QUOTED_SELECTION = 6000
