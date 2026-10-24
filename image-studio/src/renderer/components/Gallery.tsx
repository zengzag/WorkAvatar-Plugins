/**
 * 作品库：筛选 / 排序 / 列数 + 瀑布流卡片 + 生成中骨架。
 */
import { useMemo } from 'react'
import { App, Button, Empty, Segmented, Select, Tooltip } from 'antd'
import {
  ClockCircleOutlined,
  CloudDownloadOutlined,
  CopyOutlined,
  DeleteOutlined,
  FolderOpenOutlined,
  PictureOutlined,
  StarFilled,
  StarOutlined,
  SwapOutlined,
} from '@ant-design/icons'
import { PURPOSE_IDS, type GeneratedImage, type PurposeId } from '../../shared/types'
import {
  copyImage,
  deleteImage,
  downloadImage,
  openDataDir,
  setComposer,
  setGalleryFilter,
  setPreview,
  setPurposeFilter,
  setSearch,
  setSort,
  setColumns,
  t,
  toggleFavorite,
  toFileUrl,
  useAsReference,
  useStudio,
} from '../store'
import { Elapsed } from '../useTick'

const ACTIVE_STAGES = new Set(['queued', 'requesting', 'downloading', 'saving'])
const EXAMPLE_KEYS = ['portrait', 'product', 'poster', 'scenery']

export function Gallery() {
  const state = useStudio()
  const { message, modal } = App.useApp()
  const job = state.job
  const active = Boolean(job && ACTIVE_STAGES.has(job.stage))

  const filtered = useMemo(() => {
    const keyword = state.search.trim().toLowerCase()
    let list = state.images
    if (state.filter === 'favorite') list = list.filter((image) => image.favorite)
    if (state.purposeFilter !== 'all') {
      const purpose = state.purposeFilter as PurposeId
      list = list.filter((image) => (image.purpose || 'free') === purpose)
    }
    if (keyword) {
      list = list.filter(
        (image) =>
          image.prompt.toLowerCase().includes(keyword) ||
          image.model.toLowerCase().includes(keyword) ||
          image.negativePrompt.toLowerCase().includes(keyword)
      )
    }
    const sorted = [...list]
    sorted.sort((a, b) => {
      const diff = state.sort === 'new' ? b.createdAt - a.createdAt : a.createdAt - b.createdAt
      if (diff !== 0) return diff
      return state.sort === 'new' ? b.id.localeCompare(a.id) : a.id.localeCompare(b.id)
    })
    return sorted
  }, [state.images, state.filter, state.purposeFilter, state.search, state.sort])

  const skeletonCount = active && job ? Math.max(1, job.total - job.completed) : 0
  const showEmpty = state.images.length === 0 && !active

  const handleDelete = (id: string) => {
    modal.confirm({
      title: t('deleteTitle'),
      content: t('deleteDesc'),
      okText: t('delete'),
      cancelText: t('cancelAction'),
      okButtonProps: { danger: true },
      onOk: async () => {
        const ok = await deleteImage(id)
        if (ok) message.success(t('deleted'))
        else message.error(t('errors.imageNotFound'))
      },
    })
  }

  const renderCard = (image: GeneratedImage) => (
    <article className="is-card" key={image.id} onClick={() => setPreview(image.id)}>
      <div
        className="is-card-media"
        style={{ aspectRatio: `${image.width || 1} / ${image.height || 1}` }}
      >
        <img
          src={toFileUrl(image.thumbPath || image.filePath)}
          alt={image.prompt.slice(0, 40)}
          loading="lazy"
          draggable={false}
        />
        {image.favorite && (
          <span className="is-card-fav">
            <StarFilled />
          </span>
        )}
        {image.purpose && image.purpose !== 'free' && (
          <span className="is-card-purpose">{t(`purpose.${image.purpose}.name`)}</span>
        )}
        <div className="is-card-overlay">
          <div className="is-card-actions" onClick={(event) => event.stopPropagation()}>
            <Tooltip title={image.favorite ? t('unfavorite') : t('favorite')}>
              <button
                type="button"
                className={`is-card-action ${image.favorite ? 'is-active' : ''}`}
                onClick={() => void toggleFavorite(image.id)}
              >
                {image.favorite ? <StarFilled /> : <StarOutlined />}
              </button>
            </Tooltip>
            <Tooltip title={t('download')}>
              <button
                type="button"
                className="is-card-action"
                onClick={async () => {
                  const path = await downloadImage(image.id)
                  if (path) message.success(path)
                  else message.error(t('errors.imageNotFound'))
                }}
              >
                <CloudDownloadOutlined />
              </button>
            </Tooltip>
            <Tooltip title={t('copyImage')}>
              <button
                type="button"
                className="is-card-action"
                onClick={async () => {
                  const ok = await copyImage(image.id)
                  if (ok) message.success(t('copyImageSuccess'))
                  else message.error(t('errors.copyFailed'))
                }}
              >
                <CopyOutlined />
              </button>
            </Tooltip>
            <Tooltip title={t('useAsReference')}>
              <button
                type="button"
                className="is-card-action"
                onClick={async () => {
                  const res = await useAsReference(image.id)
                  if (res.ok) message.success(t('useAsReference'))
                  else if (res.error) message.warning(res.error)
                }}
              >
                <SwapOutlined />
              </button>
            </Tooltip>
            <Tooltip title={t('delete')}>
              <button type="button" className="is-card-action" onClick={() => handleDelete(image.id)}>
                <DeleteOutlined />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
      <div className="is-card-body">
        <div className="is-card-prompt" title={image.prompt}>
          {image.prompt}
        </div>
        <div className="is-card-meta">
          <span className={`is-meta-dot ${image.provider}`} />
          <span>{shortModel(image.model)}</span>
          <span className="is-meta-sep">·</span>
          <span>
            {image.width}×{image.height}
          </span>
          <span className="is-meta-time">{formatDate(image.createdAt)}</span>
        </div>
      </div>
    </article>
  )

  return (
    <main className="is-gallery">
      <div className="is-gallery-toolbar">
        <div className="is-gallery-tabs">
          <Segmented
            value={state.filter}
            onChange={(value) => setGalleryFilter(value as 'all' | 'favorite')}
            options={[
              { value: 'all', label: `${t('all')} ${state.images.length}` },
              {
                value: 'favorite',
                label: `${t('favorites')} ${state.images.filter((image) => image.favorite).length}`,
              },
            ]}
          />
        </div>
        <div className="is-gallery-actions">
          <Select
            size="small"
            value={state.purposeFilter}
            onChange={(value) => setPurposeFilter(value as PurposeId | 'all')}
            style={{ width: 148 }}
            options={[
              { value: 'all', label: t('purposeAll') },
              ...PURPOSE_IDS.map((purpose) => ({ value: purpose, label: t(`purpose.${purpose}.name`) })),
            ]}
          />
          <Select
            size="small"
            value={state.sort}
            onChange={(value) => setSort(value)}
            style={{ width: 122 }}
            options={[
              { value: 'new', label: t('sortNewest') },
              { value: 'old', label: t('sortOldest') },
            ]}
          />
          <Tooltip title={t('columns')}>
            <Segmented
              size="small"
              value={state.columns}
              onChange={(value) => setColumns(Number(value))}
              options={[3, 4, 5].map((value) => ({ value, label: value }))}
            />
          </Tooltip>
          <Tooltip title={t('openDataDir')}>
            <Button size="small" type="text" icon={<FolderOpenOutlined />} onClick={() => void openDataDir()} />
          </Tooltip>
        </div>
      </div>

      {showEmpty ? (
        <div className="is-empty">
          <div className="is-empty-art">
            <PictureOutlined />
          </div>
          <div className="is-empty-title">{t('emptyTitle')}</div>
          <div className="is-empty-desc">{t('emptyDesc')}</div>
          <div className="is-empty-sub">{t('emptySubDesc')}</div>
          <div className="is-empty-examples">
            {EXAMPLE_KEYS.map((key) => (
              <button
                type="button"
                key={key}
                className="is-empty-example"
                onClick={() => setComposer({ prompt: t(`inspirations.${key}`) })}
              >
                {t(`inspirations.${key}`)}
              </button>
            ))}
          </div>
        </div>
      ) : filtered.length === 0 && !active ? (
        <div className="is-empty">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <div>
                <div className="is-empty-title">{t('noResults')}</div>
                <div className="is-empty-desc">{t('noResultsDesc')}</div>
              </div>
            }
          >
            {state.search && (
              <Button size="small" onClick={() => setSearch('')}>
                {t('clearSearch')}
              </Button>
            )}
          </Empty>
        </div>
      ) : (
        <div
          className="is-grid"
          style={{ gridTemplateColumns: `repeat(${state.columns}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: skeletonCount }).map((_, index) => (
            <div className="is-card is-skeleton" key={`skeleton_${index}`}>
              <div className="is-skeleton-box">
                <ClockCircleOutlined />
                <span>
                  {index === 0 && job
                    ? t('generatingStage', { stage: t(`stage.${job.stage}`) })
                    : t('generating')}
                </span>
                {index === 0 && job && (
                  <Elapsed startedAt={job.startedAt} className="is-skeleton-elapsed" />
                )}
              </div>
            </div>
          ))}
          {filtered.map(renderCard)}
        </div>
      )}
    </main>
  )
}

function shortModel(model: string): string {
  return model
    .replace(/^doubao-/, '')
    .replace(/^qwen-image-/, 'Qwen ')
    .replace(/-\d{6}$/, '')
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
