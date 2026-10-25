/**
 * 左侧生成面板：提示词（核心，首屏）→ 用途 / 模型（紧凑）→ 参考图 → 更多参数（默认收起）。
 * 以 PPT 配图 / 科研配图为主路径，低频配置统一收纳，减少首屏干扰。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  App,
  Button,
  Collapse,
  Input,
  InputNumber,
  Progress,
  Segmented,
  Select,
  Switch,
  Tooltip,
} from 'antd'
import {
  ApartmentOutlined,
  BarChartOutlined,
  BorderOuterOutlined,
  BranchesOutlined,
  BulbOutlined,
  ClearOutlined,
  CloseOutlined,
  CopyOutlined,
  EditOutlined,
  ExperimentOutlined,
  FileTextOutlined,
  FundProjectionScreenOutlined,
  LayoutOutlined,
  LeftOutlined,
  PartitionOutlined,
  PictureOutlined,
  RightOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  UndoOutlined,
} from '@ant-design/icons'
import {
  ASPECTS,
  PROVIDERS,
  PROVIDER_IDS,
  PURPOSE_IDS,
  PURPOSE_PRESETS,
  getModelSpec,
  getSupportedAspects,
  getSupportedTiers,
  resolveSize,
  type AspectRatio,
  type DensityId,
  type PaletteId,
  type ProviderId,
  type PurposeId,
  type QualityTier,
  type ResolutionTier,
  type TextSpace,
} from '../../shared/types'
import { composePrompt } from '../../shared/prompt'
import {
  addReference,
  applyPurpose,
  buildRequest,
  cancelJob,
  copyText,
  generate,
  modelDesc,
  openSettings,
  optimizePrompt,
  providerLabel,
  removeReference,
  setComposer,
  switchModel,
  t,
  useStudio,
} from '../store'
import { ReferenceUploader } from './ReferenceUploader'
import { Elapsed } from '../useTick'

const STYLE_KEYS = [
  '',
  'flatVector',
  'isometric',
  'schematic',
  'blueprint',
  'lineart',
  'gradient',
  'illustration',
  'threeD',
  'minimal',
  'photography',
  'chinese',
  'poster',
  'anime',
  'cyberpunk',
]
const PALETTE_IDS: PaletteId[] = ['auto', 'academic', 'corporate', 'warm', 'mono', 'darkTech', 'pastel']
const DENSITY_IDS: DensityId[] = ['minimal', 'balanced', 'rich']
const TEXT_SPACES: TextSpace[] = ['none', 'top', 'bottom', 'left', 'right']
const QUALITY_IDS: QualityTier[] = ['low', 'medium', 'high', 'auto']

const ACTIVE_STAGES = new Set(['queued', 'requesting', 'downloading', 'saving'])

const PURPOSE_ICONS: Record<PurposeId, React.ReactNode> = {
  'ppt-slide': <FundProjectionScreenOutlined />,
  'ppt-cover': <LayoutOutlined />,
  'sci-schematic': <ExperimentOutlined />,
  'paper-figure': <FileTextOutlined />,
  chart: <BarChartOutlined />,
  infographic: <PartitionOutlined />,
  architecture: <ApartmentOutlined />,
  flowchart: <BranchesOutlined />,
  poster: <BorderOuterOutlined />,
  free: <PictureOutlined />,
}

export function ComposerPanel() {
  const { message } = App.useApp()
  const state = useStudio()
  const composer = state.composer
  const settings = state.settings
  const providerMeta = PROVIDERS[composer.provider]
  const spec = getModelSpec(composer.provider, composer.model)
  const providerPublic = settings?.providers[composer.provider]
  const hasKey = Boolean(providerPublic?.hasKey)
  const job = state.job
  const active = Boolean(job && ACTIVE_STAGES.has(job.stage))
  const showNoKey = state.ready && !hasKey

  const [customModelOpen, setCustomModelOpen] = useState(false)
  const [customModelValue, setCustomModelValue] = useState('')
  const [optimizing, setOptimizing] = useState(false)
  /** 优化前的输入，用于撤回（用户手动编辑后失效） */
  const [optimizeUndo, setOptimizeUndo] = useState<string | null>(null)

  const styleRowRef = useRef<HTMLDivElement>(null)
  const [styleScroll, setStyleScroll] = useState({ left: false, right: false })

  // 风格 chips 横向滚动：按可视宽度判断左右是否还有未展示的项
  const syncStyleScroll = () => {
    const el = styleRowRef.current
    if (!el) return
    setStyleScroll({
      left: el.scrollLeft > 4,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4,
    })
  }

  useEffect(() => {
    syncStyleScroll()
    const el = styleRowRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(syncStyleScroll)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const scrollStyles = (direction: 1 | -1) => {
    const el = styleRowRef.current
    if (!el) return
    el.scrollBy({ left: direction * Math.max(120, el.clientWidth * 0.7), behavior: 'smooth' })
  }

  const supportedAspects = useMemo(
    () => getSupportedAspects(composer.provider, composer.model),
    [composer.provider, composer.model]
  )
  const supportedTiers = useMemo(
    () => getSupportedTiers(composer.provider, composer.model, composer.aspect),
    [composer.provider, composer.model, composer.aspect]
  )
  const resolved = useMemo(
    () =>
      resolveSize(
        composer.provider,
        composer.model,
        composer.aspect,
        composer.tier,
        composer.customSizeEnabled ? composer.customSize : undefined
      ),
    [composer.provider, composer.model, composer.aspect, composer.tier, composer.customSizeEnabled, composer.customSize]
  )
  const request = useMemo(
    () => buildRequest(),
    // 仅在影响提示词编排的字段变化时重算
    [
      composer.provider,
      composer.model,
      composer.prompt,
      composer.negativePrompt,
      composer.purpose,
      composer.styleKey,
      composer.palette,
      composer.density,
      composer.textSpace,
      composer.noText,
      composer.titleEnabled,
      composer.title,
      composer.subtitle,
      composer.textLanguage,
      composer.transparent,
      composer.aspect,
      composer.tier,
    ]
  )
  const finalPrompt = useMemo(
    () => composePrompt(request, spec.supportsNegativePrompt).prompt,
    [request, spec.supportsNegativePrompt]
  )
  const purposePreset = PURPOSE_PRESETS[composer.purpose]
  const aspectFallback =
    !supportedAspects.includes(purposePreset.aspect) && composer.purpose !== 'free'
      ? { recommended: purposePreset.aspect, used: composer.aspect }
      : null

  const runOptimize = async () => {
    const raw = composer.prompt.trim()
    if (!raw) {
      message.warning(t('errors.emptyPrompt'))
      return
    }
    setOptimizing(true)
    setOptimizeUndo(null)
    try {
      const res = await optimizePrompt({
        prompt: raw,
        purposeLabel: t(`purpose.${composer.purpose}.name`),
        aspect: composer.aspect,
        styleLabel: composer.styleKey ? t(`styles.${composer.styleKey}`) : '',
      })
      if (res.prompt) {
        setOptimizeUndo(raw)
        setComposer({ prompt: res.prompt })
        message.success(t('optimized'))
      } else {
        message.warning(res.error || t('errors.optimizeFailed'))
      }
    } finally {
      setOptimizing(false)
    }
  }

  const revertOptimize = () => {
    if (optimizeUndo === null) return
    setComposer({ prompt: optimizeUndo })
    setOptimizeUndo(null)
  }

  const runGenerate = () => {
    void generate().then((res) => {
      if (!res.ok && res.error) message.warning(res.error)
    })
  }

  const providerOptions = PROVIDER_IDS.map((provider) => ({
    value: provider,
    label: providerLabel(provider),
    hasKey: Boolean(settings?.providers[provider]?.hasKey),
  }))

  const modelOptions = PROVIDERS[composer.provider].models.map((model) => ({
    value: model.id,
    label: model.label,
    desc: modelDesc(composer.provider, model.id),
  }))
  if (!modelOptions.some((item) => item.value === composer.model)) {
    modelOptions.push({ value: composer.model, label: composer.model, desc: '' })
  }

  // 信息行只展示当前实际配置，避免把模型「支持的能力」误读为已生效参数
  const actualAspect = composer.customSizeEnabled ? t('custom') : composer.aspect

  const layoutSummary = [
    composer.customSizeEnabled ? composer.customSize || t('custom') : composer.aspect,
    composer.tier,
    t(`density.${composer.density}`),
    composer.noText ? t('noTextShort') : '',
  ]
    .filter(Boolean)
    .join(' · ')

  const layoutGroup = (
    <div className="is-param-group">
      <div className="is-param-group-title">
        <span>{t('sectionLayout')}</span>
        <span className="is-param-group-hint">
          {t('estimatedSize')} {resolved.width}×{resolved.height}
        </span>
      </div>
      <div className="is-ratio-grid">
        {ASPECTS.map((aspect) => {
          const enabled = supportedAspects.includes(aspect.value)
          const [w, h] = aspect.value.split(':').map(Number)
          const ratio = w / h
          const boxWidth = ratio >= 1 ? 22 : 22 * ratio
          const boxHeight = ratio >= 1 ? 22 / ratio : 22
          return (
            <Tooltip
              key={aspect.value}
              title={enabled ? `${t('aspect')} ${aspect.value}` : t('aspectDisabled', { aspects: supportedAspects.join(' / ') })}
            >
              <button
                type="button"
                disabled={!enabled}
                className={`is-ratio-item ${composer.aspect === aspect.value && !composer.customSizeEnabled ? 'is-active' : ''}`}
                onClick={() => setComposer({ aspect: aspect.value as AspectRatio, customSizeEnabled: false })}
              >
                <span className="is-ratio-frame">
                  <span className="is-ratio-shape" style={{ width: boxWidth, height: boxHeight }} />
                </span>
                <span className="is-ratio-label">{aspect.label}</span>
              </button>
            </Tooltip>
          )
        })}
      </div>
      {aspectFallback && (
        <div className="is-section-warn">
          {t('aspectFallbackHint', {
            recommended: aspectFallback.recommended,
            used: aspectFallback.used,
            model: spec.label,
          })}
        </div>
      )}

      <div className="is-field-row is-param-row">
        <span className="is-field-label">{t('resolutionLabel')}</span>
        <Segmented
          size="small"
          value={composer.customSizeEnabled ? 'custom' : composer.tier}
          onChange={(value) => {
            if (value === 'custom') {
              setComposer({ customSizeEnabled: true })
              return
            }
            setComposer({ customSizeEnabled: false, tier: value as ResolutionTier })
          }}
          options={[
            ...supportedTiers.map((tier) => ({ value: tier, label: tier })),
            ...(spec.supportsCustomSize ? [{ value: 'custom', label: t('custom') }] : []),
          ]}
        />
      </div>
      {composer.customSizeEnabled && (
        <Input
          size="small"
          className="is-custom-size"
          value={composer.customSize}
          onChange={(event) => setComposer({ customSize: event.target.value })}
          placeholder={t('customSizePlaceholder')}
        />
      )}

      <div className="is-field-row is-param-row">
        <span className="is-field-label">{t('textSpaceLabel')}</span>
        <Select
          size="small"
          value={composer.textSpace}
          onChange={(value) => setComposer({ textSpace: value as TextSpace })}
          options={TEXT_SPACES.map((space) => ({ value: space, label: t(`textSpace.${space}`) }))}
          style={{ width: 120 }}
        />
      </div>

      <div className="is-field-row is-param-row">
        <span className="is-field-label">{t('paletteLabel')}</span>
        <Select
          size="small"
          value={composer.palette}
          onChange={(value) => setComposer({ palette: value as PaletteId })}
          options={PALETTE_IDS.map((palette) => ({ value: palette, label: t(`palette.${palette}`) }))}
          style={{ width: 120 }}
        />
      </div>

      <div className="is-field-row is-param-row">
        <span className="is-field-label">{t('densityLabel')}</span>
        <Segmented
          size="small"
          value={composer.density}
          onChange={(value) => setComposer({ density: value as DensityId })}
          options={DENSITY_IDS.map((density) => ({ value: density, label: t(`density.${density}`) }))}
        />
      </div>

      <div className="is-field-row is-param-row">
        <Tooltip title={t('noTextHint')}>
          <span className="is-field-label">{t('noTextLabel')}</span>
        </Tooltip>
        <Switch size="small" checked={composer.noText} onChange={(checked) => setComposer({ noText: checked })} />
      </div>
    </div>
  )

  const textGroup = (
    <div className="is-param-group">
      <div className="is-param-group-title">
        <span>{t('sectionTitleText')}</span>
        <Switch
          size="small"
          checked={composer.titleEnabled}
          onChange={(checked) => setComposer({ titleEnabled: checked })}
        />
      </div>
      {composer.titleEnabled ? (
        <div className="is-text-body">
          <Input
            size="small"
            value={composer.title}
            onChange={(event) => setComposer({ title: event.target.value })}
            placeholder={t('titlePlaceholder')}
            maxLength={60}
          />
          <Input
            size="small"
            value={composer.subtitle}
            onChange={(event) => setComposer({ subtitle: event.target.value })}
            placeholder={t('subtitlePlaceholder')}
            maxLength={80}
          />
          <div className="is-field-row">
            <span className="is-field-label">{t('textLanguage')}</span>
            <Segmented
              size="small"
              value={composer.textLanguage}
              onChange={(value) => setComposer({ textLanguage: value as 'zh' | 'en' })}
              options={[
                { value: 'zh', label: t('langZh') },
                { value: 'en', label: t('langEn') },
              ]}
            />
          </div>
          <div className="is-field-hint">{t('titleEnabledWarn')}</div>
        </div>
      ) : (
        <div className="is-section-hint">{t('titleEnabledHint')}</div>
      )}
    </div>
  )

  const advancedGroup = (
    <div className="is-param-group">
      <div className="is-param-group-title">{t('paramGroupAdvanced')}</div>
      <div className="is-field-row is-param-row">
        <span className="is-field-label">{t('count')}</span>
        <InputNumber
          size="small"
          min={1}
          max={spec.maxOutputs}
          value={composer.count}
          onChange={(value) => setComposer({ count: Number(value) || 1 })}
          style={{ width: 96 }}
        />
      </div>

      {spec.supportsQuality && (
        <div className="is-field-row is-param-row">
          <span className="is-field-label">{t('qualityLabel')}</span>
          <Select
            size="small"
            value={composer.quality}
            onChange={(value) => setComposer({ quality: value as QualityTier })}
            options={QUALITY_IDS.map((quality) => ({ value: quality, label: t(`quality.${quality}`) }))}
            style={{ width: 120 }}
          />
        </div>
      )}

      {spec.supportsSequential && (
        <div className="is-field-row is-param-row">
          <span className="is-field-label">{t('groupGeneration')}</span>
          <div className="is-inline">
            <Switch
              size="small"
              checked={composer.sequential}
              onChange={(checked) => setComposer({ sequential: checked })}
            />
            {composer.sequential && (
              <Tooltip title={t('maxImages')}>
                <InputNumber
                  size="small"
                  min={1}
                  max={15}
                  value={composer.maxImages}
                  onChange={(value) => setComposer({ maxImages: Number(value) || 1 })}
                  style={{ width: 78 }}
                />
              </Tooltip>
            )}
          </div>
        </div>
      )}

      {spec.supportsTransparent && (
        <div className="is-field-row is-param-row">
          <span className="is-field-label">{t('transparentBg')}</span>
          <Switch
            size="small"
            checked={composer.transparent}
            onChange={(checked) => setComposer({ transparent: checked })}
          />
        </div>
      )}

      <div className="is-field-row is-param-row">
        <span className="is-field-label">{t('seed')}</span>
        <div className="is-inline">
          <InputNumber
            size="small"
            min={0}
            max={2147483647}
            value={composer.seed ?? undefined}
            placeholder={t('seedPlaceholder')}
            onChange={(value) => setComposer({ seed: value === null || value === undefined ? null : Number(value) })}
            style={{ width: 120 }}
          />
          <Button size="small" onClick={() => setComposer({ seed: Math.floor(Math.random() * 2147483647) })}>
            {t('seedRandom')}
          </Button>
          {composer.seed !== null && (
            <Button size="small" type="text" icon={<ClearOutlined />} onClick={() => setComposer({ seed: null })} />
          )}
        </div>
      </div>

      <div className="is-field-row is-param-row">
        <span className="is-field-label">
          {t('watermark')}
          <span className="is-field-hint">{t('watermarkHint')}</span>
        </span>
        <Switch size="small" checked={composer.watermark} onChange={(checked) => setComposer({ watermark: checked })} />
      </div>

      {spec.optimizeModes.length > 1 && (
        <div className="is-field-row is-param-row">
          <span className="is-field-label">{t('optimizeMode')}</span>
          <Select
            size="small"
            value={composer.optimizeMode}
            onChange={(value) => setComposer({ optimizeMode: value })}
            style={{ width: 160 }}
            options={[
              { value: 'standard', label: t('optimizeStandard') },
              { value: 'fast', label: t('optimizeFast') },
            ]}
          />
        </div>
      )}

      {spec.supportsPromptExtend && (
        <>
          <div className="is-field-row is-param-row">
            <span className="is-field-label">
              {t('promptEnhance')}
              <span className="is-field-hint">{t('promptEnhanceHint')}</span>
            </span>
            <Switch
              size="small"
              checked={composer.promptExtend}
              onChange={(checked) => setComposer({ promptExtend: checked })}
            />
          </div>
          {composer.promptExtend && (
            <div className="is-field-row is-param-row">
              <span className="is-field-label">{t('promptEnhanceMode')}</span>
              <Segmented
                size="small"
                value={composer.promptExtendMode}
                onChange={(value) => setComposer({ promptExtendMode: value as 'direct' | 'agent' })}
                options={[
                  { value: 'direct', label: t('modeDirect') },
                  {
                    value: 'agent',
                    label: t('modeAgent'),
                    disabled: composer.references.length > 0 || !spec.promptExtendModes.includes('agent'),
                  },
                ]}
              />
            </div>
          )}
        </>
      )}

      {spec.supportsNegativePrompt && (
        <div className="is-field-block is-param-row">
          <div className="is-field-label">{t('negativePrompt')}</div>
          <Input.TextArea
            value={composer.negativePrompt}
            onChange={(event) => setComposer({ negativePrompt: event.target.value })}
            placeholder={t('negativePromptPlaceholder')}
            autoSize={{ minRows: 2, maxRows: 3 }}
            className="is-negative-input"
          />
        </div>
      )}
    </div>
  )

  return (
    <aside
      className="is-composer"
      onPaste={(event) => {
        const files = Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith('image/'))
        if (files.length === 0) return
        event.preventDefault()
        const file = files[0]
        const reader = new FileReader()
        reader.onload = () => {
          const result = addReference({
            id: `ref_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            dataUrl: String(reader.result || ''),
            name: file.name || 'pasted.png',
          })
          if (result.error) message.warning(result.error)
        }
        reader.readAsDataURL(file)
      }}
    >
      <div className="is-composer-scroll">
        {/* 核心区：提示词 */}
        <section className="is-hero">
          <div className="is-hero-head">
            <span className="is-hero-title">{t('promptLabel')}</span>
            <div className="is-hero-side">
              <Tooltip title={t('sectionPurpose')}>
                <Select
                  size="small"
                  value={composer.purpose}
                  onChange={(value) => applyPurpose(value as PurposeId)}
                  className="is-purpose-select"
                  popupMatchSelectWidth={292}
                  listHeight={440}
                  options={PURPOSE_IDS.map((purpose) => ({
                    value: purpose,
                    label: t(`purpose.${purpose}.name`),
                    desc: t(`purpose.${purpose}.desc`),
                  }))}
                  labelRender={({ value }) => (
                    <span className="is-purpose-current">
                      {PURPOSE_ICONS[value as PurposeId]}
                      {t(`purpose.${String(value)}.name`)}
                    </span>
                  )}
                  optionRender={(option) => {
                    const data = option.data as { value: PurposeId; desc: string }
                    return (
                      <div className="is-purpose-option">
                        <span className="is-purpose-option-icon">{PURPOSE_ICONS[data.value]}</span>
                        <div className="is-purpose-option-copy">
                          <div className="is-purpose-option-name">{option.label}</div>
                          <div className="is-purpose-option-desc">{data.desc}</div>
                        </div>
                      </div>
                    )
                  }}
                />
              </Tooltip>
              <span className="is-hero-count">{t('promptCount', { count: composer.prompt.length })}</span>
            </div>
          </div>
          <div className="is-prompt-wrap is-hero-prompt">
            <Input.TextArea
              value={composer.prompt}
              onChange={(event) => {
                // 手动编辑后不再提供「撤回优化」，避免覆盖用户改动
                if (optimizeUndo !== null) setOptimizeUndo(null)
                setComposer({ prompt: event.target.value })
              }}
              placeholder={t(`purpose.${composer.purpose}.placeholder`)}
              autoSize={{ minRows: 5, maxRows: 12 }}
              className="is-prompt-input"
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault()
                  runGenerate()
                }
              }}
            />
            <div className="is-prompt-tools">
              <div className="is-prompt-tools-left">
                <Tooltip title={t('optimizeHint')}>
                  <Button
                    size="small"
                    type="text"
                    icon={<BulbOutlined />}
                    loading={optimizing}
                    disabled={!composer.prompt.trim()}
                    onClick={() => void runOptimize()}
                  >
                    {t('optimize')}
                  </Button>
                </Tooltip>
                {optimizeUndo !== null && (
                  <Tooltip title={t('revertOptimizeHint')}>
                    <Button size="small" type="text" icon={<UndoOutlined />} onClick={revertOptimize}>
                      {t('revertOptimize')}
                    </Button>
                  </Tooltip>
                )}
                {composer.prompt && (
                  <Button
                    size="small"
                    type="text"
                    icon={<CloseOutlined />}
                    onClick={() => {
                      setOptimizeUndo(null)
                      setComposer({ prompt: '' })
                    }}
                  >
                    {t('clear')}
                  </Button>
                )}
              </div>
              <span className="is-prompt-shortcut">{t('promptShortcut')}</span>
            </div>
          </div>

          <div className="is-style-row">
            <span className="is-row-label">{t('styleLabel')}</span>
            <button
              type="button"
              className="is-style-nav"
              aria-label={t('scrollLeft')}
              disabled={!styleScroll.left}
              onClick={() => scrollStyles(-1)}
            >
              <LeftOutlined />
            </button>
            <div className="is-style-scroll is-scroll-row" ref={styleRowRef} onScroll={syncStyleScroll}>
              {STYLE_KEYS.map((key) => (
                <button
                  type="button"
                  key={key || 'none'}
                  className={`is-style-chip ${composer.styleKey === key ? 'is-active' : ''}`}
                  onClick={() => setComposer({ styleKey: composer.styleKey === key ? '' : key })}
                >
                  {key ? t(`styles.${key}`) : t('styles.none')}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="is-style-nav"
              aria-label={t('scrollRight')}
              disabled={!styleScroll.right}
              onClick={() => scrollStyles(1)}
            >
              <RightOutlined />
            </button>
          </div>

          {aspectFallback && (
            <div className="is-section-warn is-warn-tight">
              {t('aspectFallbackHint', {
                recommended: aspectFallback.recommended,
                used: aspectFallback.used,
                model: spec.label,
              })}
            </div>
          )}

          <Collapse
            ghost
            className="is-final-prompt"
            items={[
              {
                key: 'final',
                label: <span className="is-final-prompt-label">{t('finalPrompt')}</span>,
                children: (
                  <div className="is-final-prompt-body">
                    <div className="is-final-prompt-text">{finalPrompt || t('finalPromptEmpty')}</div>
                    <div className="is-final-prompt-actions">
                      <span className="is-field-hint">{t('finalPromptHint')}</span>
                      <Button
                        size="small"
                        type="text"
                        icon={<CopyOutlined />}
                        disabled={!finalPrompt}
                        onClick={async () => {
                          if (await copyText(finalPrompt)) message.success(t('copySuccess'))
                          else message.error(t('errors.copyFailed'))
                        }}
                      >
                        {t('copyFinalPrompt')}
                      </Button>
                    </div>
                  </div>
                ),
              },
            ]}
          />
        </section>

        {/* 服务商与模型：两个紧凑下拉 */}
        <div className="is-compact-block">
          <div className="is-model-row">
            <Select
              size="small"
              value={composer.provider}
              onChange={(value) => {
                const next = value as ProviderId
                const defaultModel = settings?.providers[next]?.defaultModel || PROVIDERS[next].defaultModel
                switchModel(next, defaultModel)
              }}
              options={providerOptions}
              className="is-provider-select"
              popupMatchSelectWidth={260}
              labelRender={({ value }) => (
                <span className="is-provider-current">
                  <span className={`is-provider-dot ${String(value)}`} />
                  {providerLabel(value as ProviderId)}
                </span>
              )}
              optionRender={(option) => {
                const data = option.data as { value: ProviderId; label: string; hasKey: boolean }
                return (
                  <div className="is-provider-option">
                    <span className={`is-provider-dot ${data.value}`} />
                    <span className="is-provider-option-name">{data.label}</span>
                    <span className={`is-provider-option-status ${data.hasKey ? 'is-ok' : 'is-missing'}`}>
                      {data.hasKey ? t('configured') : t('missingKeyTag')}
                    </span>
                  </div>
                )
              }}
            />
            <Select
              size="small"
              value={composer.model}
              onChange={(value) => switchModel(composer.provider, String(value))}
              options={modelOptions}
              className="is-model-select"
              popupMatchSelectWidth={320}
              optionRender={(option) => {
                const data = option.data as { desc?: string }
                return (
                  <div className="is-model-option">
                    <div className="is-model-option-title">{option.label}</div>
                    {data?.desc ? <div className="is-model-option-desc">{data.desc}</div> : null}
                  </div>
                )
              }}
            />
            <Tooltip title={t('customModel')}>
              <Button
                size="small"
                type="text"
                icon={<EditOutlined />}
                onClick={() => {
                  setCustomModelValue(composer.model)
                  setCustomModelOpen((open) => !open)
                }}
              />
            </Tooltip>
          </div>

          <div className="is-model-meta">
            <span className={`is-status-dot ${hasKey ? 'is-ok' : 'is-missing'}`} />
            <span>{hasKey ? t('configured') : t('missingKeyTag')}</span>
            <span className="is-meta-sep">·</span>
            <span>
              {resolved.width}×{resolved.height}
            </span>
            <span className="is-meta-sep">·</span>
            <span>{actualAspect}</span>
            {spec.maxRefImages > 0 && (
              <>
                <span className="is-meta-sep">·</span>
                <span>{t('refsUsed', { count: composer.references.length, max: spec.maxRefImages })}</span>
              </>
            )}
            <button className="is-link" type="button" onClick={() => openSettings(true, 'providers', composer.provider)}>
              <SettingOutlined /> {t('configuredLink')}
            </button>
          </div>

          {providerMeta.models.every((model) => model.id !== composer.model) && (
            <div className="is-section-hint">{t('customModelTag')}</div>
          )}

          {customModelOpen && (
            <div className="is-custom-model">
              <Input
                size="small"
                value={customModelValue}
                onChange={(event) => setCustomModelValue(event.target.value)}
                placeholder="Endpoint ID / Model ID"
                onPressEnter={() => {
                  if (customModelValue.trim()) {
                    switchModel(composer.provider, customModelValue.trim())
                    setCustomModelOpen(false)
                  }
                }}
              />
              <Button
                size="small"
                type="primary"
                onClick={() => {
                  if (customModelValue.trim()) {
                    switchModel(composer.provider, customModelValue.trim())
                    setCustomModelOpen(false)
                  }
                }}
              >
                {t('save')}
              </Button>
            </div>
          )}
        </div>

        {/* 参考图：一行紧凑入口 */}
        <ReferenceUploader
          references={composer.references}
          max={spec.maxRefImages}
          disabled={spec.maxRefImages === 0}
          onAdd={addReference}
          onRemove={removeReference}
          onError={(text) => message.warning(text)}
        />

        {/* 低频配置：默认收起 */}
        <Collapse
          ghost
          className="is-more-params"
          items={[
            {
              key: 'more',
              label: <span className="is-more-params-label">{t('moreParams')}</span>,
              extra: <span className="is-more-params-summary">{layoutSummary}</span>,
              children: (
                <div className="is-more-params-body">
                  {layoutGroup}
                  {textGroup}
                  {advancedGroup}
                </div>
              ),
            },
          ]}
        />
      </div>

      <div className="is-composer-footer">
        {showNoKey && (
          <div className="is-no-key">
            <div>
              <div className="is-no-key-title">{t('noKeyTitle')}</div>
              <div className="is-no-key-desc">{t('noKeyDesc')}</div>
            </div>
            <Button
              size="small"
              type="primary"
              ghost
              onClick={() => openSettings(true, 'providers', composer.provider)}
            >
              {t('goSettings')}
            </Button>
          </div>
        )}

        {active && job ? (
          <div className="is-job-status">
            <div className="is-job-status-row">
              <span>
                {t('generatingStage', { stage: t(`stage.${job.stage}`) })}
                {job.total > 1 ? ` · ${Math.min(job.completed + 1, job.total)}/${job.total}` : ''}
              </span>
              <span className="is-job-elapsed">
                <Elapsed startedAt={job.startedAt} />
              </span>
            </div>
            <Progress
              percent={job.total > 1 ? Math.round((job.completed / job.total) * 100) : undefined}
              status="active"
              showInfo={job.total > 1}
              size="small"
            />
            <Button block icon={<CloseOutlined />} onClick={() => void cancelJob()}>
              {t('cancel')}
            </Button>
          </div>
        ) : (
          <Button
            type="primary"
            block
            size="large"
            className="is-generate-btn"
            icon={<ThunderboltOutlined />}
            disabled={!composer.prompt.trim() || !hasKey}
            onClick={runGenerate}
          >
            {t('generate')}
          </Button>
        )}

        <div className="is-footer-hint">
          {composer.purpose === 'ppt-slide' || composer.purpose === 'ppt-cover' ? t('pptHint') : t('submitHint')}
        </div>
      </div>
    </aside>
  )
}
