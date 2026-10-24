/**
 * 作品大图预览：左右切换、参数详情、快捷操作，以及「标题排版」——
 * 用 Canvas 把清晰文字叠加到图上另存为新作品，避免 AI 生成文字错字。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { App, Button, Input, Modal, Segmented, Select, Tooltip, theme } from 'antd'
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
  importDerivedImage,
  readImageData,
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

type OverlayPosition = 'topLeft' | 'bottomLeft' | 'bottomRight' | 'center'
type OverlayColor = 'light' | 'dark'
type OverlaySize = 'small' | 'medium' | 'large'

const POSITIONS: OverlayPosition[] = ['topLeft', 'bottomLeft', 'bottomRight', 'center']
const COLORS: OverlayColor[] = ['light', 'dark']
const SIZES: OverlaySize[] = ['small', 'medium', 'large']

const FONT_STACK = '"PingFang SC", "Microsoft YaHei", "Segoe UI", "Helvetica Neue", Arial, sans-serif'
const SIZE_RATIO: Record<OverlaySize, number> = { small: 0.034, medium: 0.048, large: 0.066 }

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  fontSize: number,
  weight: number,
  maxWidth: number,
  maxLines: number
): string[] {
  ctx.font = `${weight} ${fontSize}px ${FONT_STACK}`
  const lines: string[] = []
  let line = ''
  for (const char of Array.from(text)) {
    const next = line + char
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line)
      line = char
      if (lines.length >= maxLines) break
    } else {
      line = next
    }
  }
  if (lines.length < maxLines && line) lines.push(line)
  return lines
}

export function PreviewModal() {
  const { token } = theme.useToken()
  const { message, modal } = App.useApp()
  const state = useStudio()
  const [zoom, setZoom] = useState(false)
  const [overlayTitle, setOverlayTitle] = useState('')
  const [overlaySubtitle, setOverlaySubtitle] = useState('')
  const [overlayPosition, setOverlayPosition] = useState<OverlayPosition>('bottomLeft')
  const [overlayColor, setOverlayColor] = useState<OverlayColor>('light')
  const [overlaySize, setOverlaySize] = useState<OverlaySize>('medium')
  const [applying, setApplying] = useState(false)

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

  const applyOverlay = async () => {
    if (!overlayTitle.trim()) {
      message.warning(t('overlayEmpty'))
      return
    }
    setApplying(true)
    try {
      const dataUrl = await readImageData(image.id, true)
      if (!dataUrl) throw new Error('no image data')
      const img = new Image()
      img.src = dataUrl
      await img.decode()
      const width = img.naturalWidth
      const height = img.naturalHeight
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('canvas unavailable')
      ctx.drawImage(img, 0, 0, width, height)

      const titleSize = Math.round(width * SIZE_RATIO[overlaySize])
      const subtitleSize = Math.round(titleSize * 0.52)
      const pad = Math.round(width * 0.065)
      const maxWidth = width - pad * 2
      const titleLines = wrapText(ctx, overlayTitle.trim(), titleSize, 700, maxWidth, 3)
      const subtitleLines = overlaySubtitle.trim()
        ? wrapText(ctx, overlaySubtitle.trim(), subtitleSize, 500, maxWidth, 2)
        : []
      const lineGap = Math.round(titleSize * 0.24)
      const titleHeight = titleLines.length * (titleSize + lineGap)
      const subtitleHeight = subtitleLines.length * (subtitleSize + lineGap * 0.7)
      const totalHeight = titleHeight + (subtitleLines.length ? subtitleHeight + lineGap * 0.4 : 0)

      // 文字底层柔和压暗/提亮，保证任意画面上的可读性
      const scrim = overlayColor === 'light' ? '0, 0, 0' : '255, 255, 255'
      ctx.save()
      if (overlayPosition === 'center') {
        const radius = Math.max(width, height) * 0.62
        const gradient = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, radius)
        gradient.addColorStop(0, `rgba(${scrim}, 0.56)`)
        gradient.addColorStop(1, `rgba(${scrim}, 0)`)
        ctx.fillStyle = gradient
        ctx.fillRect(0, 0, width, height)
      } else {
        const fromTop = overlayPosition === 'topLeft'
        const gradient = ctx.createLinearGradient(0, fromTop ? 0 : height, 0, fromTop ? height * 0.52 : height * 0.48)
        gradient.addColorStop(0, `rgba(${scrim}, 0.6)`)
        gradient.addColorStop(1, `rgba(${scrim}, 0)`)
        ctx.fillStyle = gradient
        ctx.fillRect(0, 0, width, height)
      }
      ctx.restore()

      const textColor = overlayColor === 'light' ? '#ffffff' : '#111827'
      const startY =
        overlayPosition === 'center'
          ? (height - totalHeight) / 2
          : overlayPosition === 'topLeft'
            ? pad * 1.15
            : height - pad - totalHeight
      const align: CanvasTextAlign =
        overlayPosition === 'center' ? 'center' : overlayPosition === 'bottomRight' ? 'right' : 'left'
      const x = align === 'center' ? width / 2 : align === 'right' ? width - pad : pad

      ctx.textAlign = align
      ctx.textBaseline = 'top'
      ctx.fillStyle = textColor
      ctx.shadowColor = overlayColor === 'light' ? 'rgba(0, 0, 0, 0.45)' : 'rgba(255, 255, 255, 0.55)'
      ctx.shadowBlur = Math.round(titleSize * 0.22)
      ctx.shadowOffsetY = Math.round(titleSize * 0.05)

      let cursorY = startY
      ctx.font = `700 ${titleSize}px ${FONT_STACK}`
      for (const line of titleLines) {
        ctx.fillText(line, x, cursorY)
        cursorY += titleSize + lineGap
      }
      if (subtitleLines.length) {
        cursorY += lineGap * 0.4
        ctx.globalAlpha = 0.92
        ctx.font = `500 ${subtitleSize}px ${FONT_STACK}`
        for (const line of subtitleLines) {
          ctx.fillText(line, x, cursorY)
          cursorY += subtitleSize + lineGap * 0.7
        }
        ctx.globalAlpha = 1
      }

      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('export failed')
      const buffer = await blob.arrayBuffer()
      const created = await importDerivedImage({
        buffer,
        sourceId: image.id,
        label: t('overlayLabel'),
        title: overlayTitle.trim(),
        subtitle: overlaySubtitle.trim(),
        position: overlayPosition,
        color: overlayColor,
        size: overlaySize,
      })
      if (!created) throw new Error('save failed')
      message.success(t('overlayApplied'))
      setPreview(created.id)
    } catch (err: any) {
      message.error(err?.message || t('overlayFailed'))
    } finally {
      setApplying(false)
    }
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

          <div className="is-preview-section is-overlay">
            <div className="is-preview-label">{t('overlayTitle')}</div>
            <Input
              size="small"
              value={overlayTitle}
              onChange={(event) => setOverlayTitle(event.target.value)}
              placeholder={t('titlePlaceholder')}
              maxLength={60}
            />
            <Input
              size="small"
              value={overlaySubtitle}
              onChange={(event) => setOverlaySubtitle(event.target.value)}
              placeholder={t('subtitlePlaceholder')}
              maxLength={80}
            />
            <div className="is-overlay-controls">
              <Select
                size="small"
                value={overlayPosition}
                onChange={(value) => setOverlayPosition(value as OverlayPosition)}
                style={{ width: 104 }}
                options={POSITIONS.map((position) => ({
                  value: position,
                  label: t(`overlayPos.${position}`),
                }))}
              />
              <Segmented
                size="small"
                value={overlayColor}
                onChange={(value) => setOverlayColor(value as OverlayColor)}
                options={COLORS.map((color) => ({ value: color, label: t(`overlayColor.${color}`) }))}
              />
              <Segmented
                size="small"
                value={overlaySize}
                onChange={(value) => setOverlaySize(value as OverlaySize)}
                options={SIZES.map((size) => ({ value: size, label: t(`overlaySize.${size}`) }))}
              />
            </div>
            <Button size="small" block loading={applying} onClick={() => void applyOverlay()}>
              {t('overlayApply')}
            </Button>
            <div className="is-field-hint">{t('overlayHint')}</div>
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
