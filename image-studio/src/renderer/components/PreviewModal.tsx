/**
 * 作品大图预览：左右切换、参数详情与快捷操作。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { App, Button, Modal, Tooltip, theme } from 'antd'
import {
  CloudDownloadOutlined,
  CopyOutlined,
  DeleteOutlined,
  FolderOpenOutlined,
  LeftOutlined,
  RightOutlined,
  SaveOutlined,
  StarFilled,
  StarOutlined,
  SwapOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
} from '@ant-design/icons'
import type { GeneratedImage } from '../../shared/types'
import {
  copyImage,
  copyText,
  deleteImage,
  downloadImage,
  regenerateFrom,
  saveImageAs,
  setPreview,
  showInFolder,
  t,
  toggleFavorite,
  toFileUrl,
  useAsReference,
  useStudio,
} from '../store'

export function PreviewModal() {
  const { token } = theme.useToken()
  const { message, modal } = App.useApp()
  const state = useStudio()
  const [zoom, setZoom] = useState(false)

  const ordered = useMemo(() => [...state.images].sort((a, b) => b.createdAt - a.createdAt), [state.images])
  const index = state.previewId ? ordered.findIndex((item) => item.id === state.previewId) : -1
  const image = index >= 0 ? ordered[index] : null

  const go = useCallback(
    (delta: number) => {
      if (ordered.length === 0) return
      const next = (index + delta + ordered.length) % ordered.length
      setZoom(false)
      setPreview(ordered[next].id)
    },
    [index, ordered]
  )

  useEffect(() => {
    if (!image) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') go(-1)
      else if (event.key === 'ArrowRight') go(1)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [image, go])

  useEffect(() => {
    setZoom(false)
  }, [state.previewId])

  const params = useMemo(() => {
    if (!image) return {} as Record<string, unknown>
    try {
      return JSON.parse(image.paramsJson || '{}') as Record<string, unknown>
    } catch {
      return {} as Record<string, unknown>
    }
  }, [image])

  if (!image) return null

  const duration = image.durationMs > 0 ? `${(image.durationMs / 1000).toFixed(1)}s` : '—'
  const seed = image.seed ?? (params.seed as number | null) ?? null
  const purposeKey = image.purpose && image.purpose !== 'free' ? `purpose.${image.purpose}.name` : ''

  const copyPrompt = async () => {
    const ok = await copyText(image.prompt)
    if (ok) message.success(t('copyPromptSuccess'))
    else message.error(t('errors.copyFailed'))
  }

  return (
    <Modal
      open
      centered
      width={1180}
      footer={null}
      onCancel={() => setPreview(null)}
      className="is-preview-modal"
      styles={{ body: { padding: 0 } }}
      title={null}
    >
      <div className="is-preview">
        <div className="is-preview-stage">
          <div className={`is-preview-image-wrap ${zoom ? 'is-zoomed' : ''}`}>
            <img
              src={toFileUrl(image.filePath)}
              alt={image.prompt.slice(0, 60)}
              draggable={false}
              onClick={() => setZoom((value) => !value)}
            />
          </div>
          {ordered.length > 1 && (
            <>
              <button type="button" className="is-preview-nav is-left" onClick={() => go(-1)} aria-label={t('prev')}>
                <LeftOutlined />
              </button>
              <button type="button" className="is-preview-nav is-right" onClick={() => go(1)} aria-label={t('next')}>
                <RightOutlined />
              </button>
            </>
          )}
          <div className="is-preview-tools">
            <Tooltip title={t('preview')}>
              <button type="button" onClick={() => setZoom((value) => !value)}>
                {zoom ? <ZoomOutOutlined /> : <ZoomInOutlined />}
              </button>
            </Tooltip>
            <span className="is-preview-index">
              {index + 1}/{ordered.length}
            </span>
          </div>
        </div>

        <aside className="is-preview-side">
          <div className="is-preview-head">
            <div>
              <div className="is-preview-model">{image.model}</div>
              <div className="is-preview-sub">
                {purposeKey ? <span className="is-preview-purpose">{t(purposeKey)}</span> : null}
                <span>{image.width}×{image.height}</span>
              </div>
            </div>
            <Button
              size="small"
              type="text"
              icon={image.favorite ? <StarFilled style={{ color: '#faad14' }} /> : <StarOutlined />}
              onClick={() => void toggleFavorite(image.id)}
            >
              {image.favorite ? t('unfavorite') : t('favorite')}
            </Button>
          </div>

          <div className="is-preview-section">
            <div className="is-preview-label">{t('prompt')}</div>
            <div className="is-preview-prompt">{image.prompt}</div>
            <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => void copyPrompt()}>
              {t('copyPrompt')}
            </Button>
          </div>

          {image.negativePrompt && (
            <div className="is-preview-section">
              <div className="is-preview-label">{t('negativePrompt')}</div>
              <div className="is-preview-negative">{image.negativePrompt}</div>
            </div>
          )}

          <div className="is-preview-section">
            <div className="is-preview-label">{t('params')}</div>
            <dl className="is-preview-params">
              <div>
                <dt>{t('size')}</dt>
                <dd>
                  {image.width}×{image.height}
                </dd>
              </div>
              <div>
                <dt>{t('model')}</dt>
                <dd>{image.model}</dd>
              </div>
              <div>
                <dt>{t('seedLabel')}</dt>
                <dd>{seed === null || seed === undefined ? '—' : seed}</dd>
              </div>
              <div>
                <dt>{t('duration')}</dt>
                <dd>{duration}</dd>
              </div>
              <div>
                <dt>{t('createdAt')}</dt>
                <dd>{new Date(image.createdAt).toLocaleString()}</dd>
              </div>
            </dl>
          </div>

          <div className="is-preview-actions">
            <Button
              icon={<CloudDownloadOutlined />}
              onClick={async () => {
                const path = await downloadImage(image.id)
                if (path) message.success(path)
                else message.error(t('errors.imageNotFound'))
              }}
            >
              {t('download')}
            </Button>
            <Button
              icon={<SaveOutlined />}
              onClick={async () => {
                const path = await saveImageAs(image.id)
                if (path) message.success(path)
              }}
            >
              {t('saveAs')}
            </Button>
            <Button
              icon={<CopyOutlined />}
              onClick={async () => {
                const ok = await copyImage(image.id)
                if (ok) message.success(t('copyImageSuccess'))
                else message.error(t('errors.copyFailed'))
              }}
            >
              {t('copyImage')}
            </Button>
            <Button
              icon={<SwapOutlined />}
              onClick={async () => {
                const res = await useAsReference(image.id)
                if (res.ok) {
                  message.success(t('useAsReference'))
                  setPreview(null)
                } else if (res.error) {
                  message.warning(res.error)
                }
              }}
            >
              {t('useAsReference')}
            </Button>
            <Button icon={<FolderOpenOutlined />} onClick={() => showInFolder(image.id)}>
              {t('showInFolder')}
            </Button>
            <Button
              danger
              icon={<DeleteOutlined />}
              onClick={() =>
                modal.confirm({
                  title: t('deleteTitle'),
                  content: t('deleteDesc'),
                  okText: t('delete'),
                  cancelText: t('cancelAction'),
                  okButtonProps: { danger: true },
                  onOk: async () => {
                    const ok = await deleteImage(image.id)
                    if (ok) {
                      message.success(t('deleted'))
                      setPreview(null)
                    } else {
                      message.error(t('errors.imageNotFound'))
                    }
                  },
                })
              }
            >
              {t('delete')}
            </Button>
          </div>

          <div className="is-preview-footer" style={{ borderColor: token.colorBorderSecondary }}>
            <Button type="primary" block onClick={() => regenerateFrom(image as GeneratedImage)}>
              {t('regenerate')}
            </Button>
          </div>
        </aside>
      </div>
    </Modal>
  )
}
