/**
 * 参考图上传：默认一行紧凑入口，已有参考图时展示缩略图；支持点击/拖拽/粘贴。
 */
import { useRef, useState } from 'react'
import { Tooltip, theme } from 'antd'
import { CloseOutlined, PlusOutlined } from '@ant-design/icons'
import type { RefImage } from '../store'
import { t } from '../store'

interface Props {
  references: RefImage[]
  max: number
  disabled?: boolean
  onAdd: (image: RefImage) => { ok: boolean; error?: string } | void
  onRemove: (id: string) => void
  onError?: (message: string) => void
}

const MAX_FILE_SIZE = 20 * 1024 * 1024

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export function ReferenceUploader({ references, max, disabled, onAdd, onRemove, onError }: Props) {
  const { token } = theme.useToken()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const handleFiles = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue
      if (file.size > MAX_FILE_SIZE) {
        onError?.(t('errors.fileTooLarge'))
        continue
      }
      try {
        const dataUrl = await readFile(file)
        const result = onAdd({
          id: `ref_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          dataUrl,
          name: file.name || 'reference.png',
        })
        if (result && !result.ok && result.error) onError?.(result.error)
      } catch {
        onError?.(t('errors.requestFailed'))
      }
    }
  }

  const dropHandlers = {
    onDragOver: (event: React.DragEvent) => {
      event.preventDefault()
      setDragOver(true)
    },
    onDragLeave: () => setDragOver(false),
    onDrop: (event: React.DragEvent) => {
      event.preventDefault()
      setDragOver(false)
      if (event.dataTransfer?.files?.length) void handleFiles(event.dataTransfer.files)
    },
  }

  const fileInput = (
    <input
      ref={inputRef}
      type="file"
      accept="image/*"
      multiple
      hidden
      onChange={(event) => {
        if (event.target.files?.length) void handleFiles(event.target.files)
        event.target.value = ''
      }}
    />
  )

  if (disabled) {
    return <div className="is-ref-disabled">{t('referenceNotSupported')}</div>
  }

  if (references.length === 0) {
    return (
      <div className="is-compact-block">
        <button
          type="button"
          className={`is-ref-compact ${dragOver ? 'is-drop-active' : ''}`}
          onClick={() => inputRef.current?.click()}
          {...dropHandlers}
        >
          <PlusOutlined />
          <span>{t('addReference')}</span>
          <span className="is-ref-compact-meta">{t('referencesHint', { count: max })}</span>
        </button>
        {fileInput}
      </div>
    )
  }

  return (
    <div className="is-compact-block">
      <div className="is-compact-label">
        <span>{t('references')}</span>
        <span>
          {references.length}/{max}
        </span>
      </div>
      <div className={`is-reference-grid is-compact-grid ${dragOver ? 'is-drop-active' : ''}`} {...dropHandlers}>
        {references.map((item) => (
          <div className="is-reference-item" key={item.id} title={item.name}>
            <img src={item.dataUrl} alt={item.name} />
            <button
              type="button"
              className="is-reference-remove"
              onClick={(event) => {
                event.stopPropagation()
                onRemove(item.id)
              }}
              aria-label={t('remove')}
            >
              <CloseOutlined />
            </button>
          </div>
        ))}
        {references.length < max && (
          <Tooltip title={t('referencesHint', { count: max })}>
            <button
              type="button"
              className="is-reference-add"
              onClick={() => inputRef.current?.click()}
              style={{ borderColor: token.colorBorder, color: token.colorTextSecondary }}
            >
              <PlusOutlined />
            </button>
          </Tooltip>
        )}
        {dragOver && <div className="is-drop-mask">{t('dropHere')}</div>}
      </div>
      {fileInput}
    </div>
  )
}
