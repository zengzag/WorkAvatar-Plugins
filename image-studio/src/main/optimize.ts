/**
 * 提示词优化：把用户的一句话需求改写为更适合文生图模型的画面描述。
 * 仅做文本改写，不涉及图片生成；模型由用户在设置中指定，缺省走宿主默认模型。
 */

const SYSTEM_PROMPT = `You are a senior prompt engineer for text-to-image models (Volcengine Seedream, Qwen Image, OpenAI GPT Image).
Your only job is to polish, structure and enrich the user's own request so the image model understands it better.

Rules:
- Preserve every element the user asked for, including titles, labels, annotations and any text they want in the image. Never delete or rename them.
- Keep the user's core subject, intent and language; never switch to a different topic.
- Rewrite the wording to be clear and specific: add missing visual details such as subject attributes, composition, viewpoint, lighting, materials, color and mood.
- Reorganize related details into a logical order so the prompt reads fluently.
- Do NOT add new requirements or constraints of your own: no extra bans, no "no text" rules, no style restrictions, no aspect ratio mandates, no negative prompts.
- Never mention camera brands, artist names or software names.
- Output ONLY the rewritten prompt as a single paragraph. No quotes, no labels, no explanations, no markdown.
- Write in the same language as the user's request.`

export interface OptimizeInput {
  prompt: string
  purposeLabel?: string
  aspect?: string
  styleLabel?: string
}

/** 组装优化请求的用户消息：把用途/比例/风格作为上下文，核心仍是用户原始需求 */
export function buildOptimizeMessage(input: OptimizeInput): string {
  const lines = [
    `Scene type: ${input.purposeLabel || 'general image'}`,
    `Aspect ratio: ${input.aspect || '1:1'}`,
  ]
  if (input.styleLabel) lines.push(`Style hint: ${input.styleLabel}`)
  lines.push('', `User request: ${input.prompt.trim()}`)
  return lines.join('\n')
}

/** 清理模型输出：去代码块、去前缀标签、去首尾引号，合并多余空行 */
export function cleanOptimizedPrompt(raw: string): string {
  let text = String(raw || '').trim()
  text = text.replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '')
  text = text.replace(/^(optimized\s*prompt|prompt|提示词|优化后的?提示词)\s*[:：]\s*/i, '')
  text = text.replace(/\s*\n+\s*/g, ' ').trim()
  text = text.replace(/^["'“”「」]+|["'“”「」]+$/g, '')
  return text.trim()
}

export const OPTIMIZE_SYSTEM_PROMPT = SYSTEM_PROMPT
