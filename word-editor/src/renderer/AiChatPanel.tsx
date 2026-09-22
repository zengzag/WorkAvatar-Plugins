// 右侧 AI 助手面板：
// - 无对话时为欢迎页（分组能力卡片 + 示例 + 起步输入框），对标 WPS/飞书的场景化入口
// - 选中编辑器文字后出现「选中横幅」与划词指令（润色/缩写/扩写/翻译/解释…），即「选中即改」
// - 对话进行中保留文档级快捷 chips；消息流复用宿主 GenericChatView

import { useEffect, useState, type ReactNode } from 'react'
import { Select, Button, Tooltip, Input } from 'antd'
import {
  PlusOutlined, FolderOpenOutlined, DeleteOutlined, SendOutlined, CloseOutlined,
  EditOutlined, HighlightOutlined, CheckCircleOutlined, ReadOutlined,
  BulbOutlined, RobotOutlined,
} from '@ant-design/icons'
import { useWordEditorStore, type ScopeHint } from './word-editor.store'
import { we, getHostCapabilities, hostT } from './store'
import {
  AI_COMMAND_GROUPS, AI_QUICK_COMMANDS, AI_SELECTION_COMMANDS, AI_EXAMPLES,
  MAX_QUOTED_SELECTION, type AiCommand,
} from './ai-commands'

const GROUP_ICONS: Record<string, ReactNode> = {
  write: <EditOutlined />,
  polish: <HighlightOutlined />,
  review: <CheckCircleOutlined />,
  read: <ReadOutlined />,
}

/** 选中文字横幅：展示引用预览 + 划词指令 */
function SelectionBanner() {
  const lastSelection = useWordEditorStore((s) => s.lastSelection)
  const isStreaming = useWordEditorStore((s) => s.isStreaming)
  const clearSelectionText = useWordEditorStore((s) => s.clearSelectionText)
  const { sendMessage } = useWordEditorStore.getState()

  if (!lastSelection?.text) return null
  const sel = lastSelection

  const runSelectionCommand = (cmd: AiCommand) => {
    if (useWordEditorStore.getState().isStreaming) return
    const clipped = sel.text.length > MAX_QUOTED_SELECTION
      ? `${sel.text.slice(0, MAX_QUOTED_SELECTION)}\n（选中内容较长，已截断）`
      : sel.text
    const content = `${cmd.prompt}\n\n【我选中的文字】\n"""\n${clipped}\n"""`
    const scopeHint: ScopeHint = {
      kind: 'selection',
      text: sel.text.slice(0, 8000),
      anchor: sel.anchor,
      focus: sel.focus,
      blockPreview: sel.blockPreview,
    }
    void sendMessage(content, undefined, scopeHint)
  }

  return (
    <div className="we-ai-banner">
      <div className="we-ai-banner-head">
        <HighlightOutlined className="we-ai-banner-icon" />
        <span className="we-ai-banner-title">{hostT('ai.selected', { count: sel.text.length })}</span>
        <Button
          size="small"
          type="text"
          icon={<CloseOutlined />}
          onClick={clearSelectionText}
        />
      </div>
      <div className="we-ai-banner-quote">{sel.text}</div>
      <div className="we-ai-banner-actions">
        {AI_SELECTION_COMMANDS.map((cmd) => (
          <Button
            key={cmd.key}
            size="small"
            disabled={isStreaming}
            onClick={() => runSelectionCommand(cmd)}
          >
            {hostT(`ai.sel.${cmd.key}`)}
          </Button>
        ))}
      </div>
    </div>
  )
}

/** 欢迎页：分组能力卡片 + 示例 + 起步输入框 */
function WelcomeView({ header }: { header: ReactNode }) {
  const isStreaming = useWordEditorStore((s) => s.isStreaming)
  const chatError = useWordEditorStore((s) => s.chatError)
  const hasCaret = useWordEditorStore((s) => !!s.lastSelection)
  const { sendMessage } = useWordEditorStore.getState()
  const [draft, setDraft] = useState('')

  const runCommand = (cmd: AiCommand) => {
    if (useWordEditorStore.getState().isStreaming || !useWordEditorStore.getState().doc) return
    const sel = useWordEditorStore.getState().lastSelection
    let scopeHint: ScopeHint | undefined
    if (cmd.scope === 'caret') {
      if (!sel) return
      scopeHint = { kind: 'caret', anchor: sel.anchor, blockPreview: sel.blockPreview }
    }
    void sendMessage(cmd.prompt, undefined, scopeHint)
  }

  const sendDraft = () => {
    const state = useWordEditorStore.getState()
    const text = draft.trim()
    if (!text || state.isStreaming || !state.doc) return
    setDraft('')
    void sendMessage(text)
  }

  return (
    <>
      <div className="we-ai-topbar">{header}</div>
      <div className="we-ai-welcome">
        <div className="we-ai-hero">
          <div className="we-ai-hero-badge"><RobotOutlined /></div>
          <div className="we-ai-hero-title">{hostT('ai.heroTitle')}</div>
          <div className="we-ai-hero-sub">{hostT('ai.heroSub')}</div>
        </div>

        <SelectionBanner />

        <div className="we-ai-capgrid">
          {AI_COMMAND_GROUPS.map((group) => (
            <div key={group.key} className="we-ai-capcard">
              <div className="we-ai-caphead">
                <span className="we-ai-capicon">{GROUP_ICONS[group.key]}</span>
                {hostT(`ai.group.${group.key}`)}
              </div>
              <div className="we-ai-capactions">
                {group.commands.map((cmd) => {
                  const disabled = isStreaming || (cmd.scope === 'caret' && !hasCaret)
                  return (
                    <button
                      key={cmd.key}
                      type="button"
                      className="we-ai-action"
                      disabled={disabled}
                      title={cmd.scope === 'caret' && !hasCaret ? hostT('ai.caretHint') : undefined}
                      onClick={() => runCommand(cmd)}
                    >
                      {hostT(`ai.cmd.${cmd.key}`)}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        <div className="we-ai-examples">
          <div className="we-ai-examples-title"><BulbOutlined />{hostT('ai.examplesTitle')}</div>
          {AI_EXAMPLES.map((key) => (
            <button key={key} type="button" className="we-ai-example" onClick={() => setDraft(hostT(`ai.example.${key}`))}>
              {hostT(`ai.example.${key}`)}
            </button>
          ))}
        </div>

        <div className="we-ai-input-wrap">
          <Input.TextArea
            className="we-ai-input"
            value={draft}
            variant="borderless"
            autoSize={{ minRows: 1, maxRows: 4 }}
            placeholder={hostT('page.docPlaceholder')}
            onChange={(e) => setDraft(e.target.value)}
            onPressEnter={(e) => {
              if (!e.shiftKey) {
                e.preventDefault()
                sendDraft()
              }
            }}
          />
          <div className="we-ai-input-foot">
            <span className="we-ai-input-tip">{hostT('ai.inputTip')}</span>
            <Button
              type="primary"
              size="small"
              icon={<SendOutlined />}
              loading={isStreaming}
              disabled={!draft.trim()}
              onClick={sendDraft}
            >
              {hostT('ai.send')}
            </Button>
          </div>
        </div>
        {chatError && <div className="we-ai-error">{hostT(chatError)}</div>}
      </div>
    </>
  )
}

export function AiChatPanel() {
  const messages = useWordEditorStore((s) => s.messages)
  const isStreaming = useWordEditorStore((s) => s.isStreaming)
  const chatError = useWordEditorStore((s) => s.chatError)
  const providers = useWordEditorStore((s) => s.providers)
  const conversationId = useWordEditorStore((s) => s.conversationId)
  const chats = useWordEditorStore((s) => s.chats)
  const workspacePath = useWordEditorStore((s) => s.workspacePath)
  const { sendMessage, cancelChat, newChat, loadChats, loadChatHistory, deleteChat, openChatDir, deleteMessage, toggleSegment } = useWordEditorStore.getState()

  const GenericChatView = getHostCapabilities()?.GenericChatView

  useEffect(() => {
    void loadChats()
    const unsub = we.onChatsChanged(() => void loadChats())
    return unsub
  }, [])

  const handleSend = (text: string, images?: string[]) => {
    if (!useWordEditorStore.getState().doc) return
    void sendMessage(text, images)
  }

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {chats.length > 0 && (
        <Select
          size="small"
          style={{ flex: 1, minWidth: 0 }}
          placeholder={hostT('page.chatHistory')}
          value={conversationId ?? undefined}
          onChange={(id) => void loadChatHistory(id)}
          options={chats.map((c) => ({ value: c.conversationId, label: c.title }))}
          allowClear
          onClear={() => newChat()}
          popupRender={(menu) => (
            <>
              {menu}
              {conversationId && (
                <div style={{ padding: 4, borderTop: '1px solid var(--we-border)' }}>
                  <Button
                    size="small"
                    danger
                    block
                    icon={<DeleteOutlined />}
                    onClick={() => void deleteChat(conversationId)}
                  >
                    {hostT('page.delete')}
                  </Button>
                </div>
              )}
            </>
          )}
        />
      )}
      {conversationId && workspacePath && (
        <Tooltip title={hostT('chat.openTaskDir')}>
          <Button size="small" type="text" icon={<FolderOpenOutlined />} onClick={() => void openChatDir(conversationId)} />
        </Tooltip>
      )}
      <Tooltip title={hostT('chat.newChat')}>
        <Button size="small" type="text" icon={<PlusOutlined />} onClick={newChat} />
      </Tooltip>
    </div>
  )

  if (!GenericChatView) {
    return <div style={{ padding: 24, textAlign: 'center', color: 'var(--we-muted)' }}>{hostT('page.unsupported')}</div>
  }

  const hasMessages = messages.length > 0

  if (!hasMessages) {
    return (
      <div className="we-ai-root">
        <WelcomeView header={header} />
      </div>
    )
  }

  return (
    <div className="we-ai-root">
      <div className="we-ai-topbar">{header}</div>
      <SelectionBanner />
      <div className="we-ai-quickbar">
        {AI_QUICK_COMMANDS.map((cmd) => (
          <Button
            key={cmd.key}
            className="we-ai-chip"
            size="small"
            disabled={isStreaming}
            onClick={() => void sendMessage(cmd.prompt)}
          >
            {hostT(`ai.cmd.${cmd.key}`)}
          </Button>
        ))}
      </div>
      <div className="we-ai-chat">
        <GenericChatView
          messages={messages}
          isStreaming={isStreaming}
          chatError={chatError ? hostT(chatError) : null}
          conversationId={conversationId}
          providers={providers}
          placeholder={hostT('page.docPlaceholder')}
          onSend={handleSend}
          onStop={cancelChat}
          onToggleSegment={toggleSegment}
          onDeleteMessage={(msgId) => deleteMessage(msgId)}
        />
      </div>
    </div>
  )
}
