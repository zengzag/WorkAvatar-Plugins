// 右侧 AI 对话抽屉：复用宿主 GenericChatView，配置历史对话与常用指令

import { useEffect } from 'react'
import { Select, Button, Tooltip } from 'antd'
import { PlusOutlined, FolderOpenOutlined, DeleteOutlined } from '@ant-design/icons'
import { useWordEditorStore } from './word-editor.store'
import { we, getHostCapabilities, hostT } from './store'

const QUICK_COMMANDS: Array<{ key: string; text: string }> = [
  { key: 'rewrite', text: '请通读全文，把语言表达不够流畅的地方润色一遍，保持结构不变。' },
  { key: 'formal', text: '把全文调整为正式书面语气，保持内容不变。' },
  { key: 'format', text: '优化文档排版：修正标题层级、对齐和列表，使结构更清晰。' },
  { key: 'summary', text: '为这篇文档生成一段摘要，加到文档开头。' },
  { key: 'proofread', text: '检查全文错别字和标点，直接修正。' },
]

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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '8px 10px 0', display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {QUICK_COMMANDS.map((qc) => (
          <Button
            key={qc.key}
            size="small"
            onClick={() => handleSend(qc.text)}
            disabled={useWordEditorStore.getState().isStreaming}
          >
            {hostT(`page.aiQuick.${qc.key}`)}
          </Button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <GenericChatView
          messages={messages}
          isStreaming={isStreaming}
          chatError={chatError ? hostT(chatError) : null}
          conversationId={conversationId}
          providers={providers}
          placeholder={hostT('page.docPlaceholder')}
          header={header}
          onSend={handleSend}
          onStop={cancelChat}
          onToggleSegment={toggleSegment}
          onDeleteMessage={(msgId) => deleteMessage(msgId)}
        />
      </div>
    </div>
  )
}
