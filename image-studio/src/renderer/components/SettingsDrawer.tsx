/**
 * 设置抽屉：服务商（下拉选择后配置单个服务商）/ 生成偏好 / 关于。
 */
import { useEffect, useMemo, useState } from 'react'
import {
  App,
  Button,
  Drawer,
  Input,
  InputNumber,
  Segmented,
  Select,
  Switch,
  Tabs,
  Tag,
  Typography,
  theme,
} from 'antd'
import {
  CheckCircleFilled,
  ExclamationCircleFilled,
  FolderOpenOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import {
  ASPECTS,
  PLUGIN_VERSION,
  PROVIDERS,
  PROVIDER_IDS,
  PURPOSE_IDS,
  PURPOSE_PRESETS,
  getModelSpec,
  type ProviderId,
  type PurposeId,
  type QualityTier,
  type ResolutionTier,
} from '../../shared/types'
import {
  invoke,
  modelDesc,
  providerLabel,
  saveDefaults,
  saveProvider,
  setSettingsProvider,
  setSettingsTab,
  t,
  testProvider,
  useStudio,
} from '../store'

interface Props {
  open: boolean
  onClose: () => void
}

const QUALITY_IDS: QualityTier[] = ['low', 'medium', 'high', 'auto']

export function SettingsDrawer({ open, onClose }: Props) {
  const state = useStudio()
  return (
    <Drawer
      open={open}
      onClose={onClose}
      size={580}
      title={
        <span className="is-drawer-title">
          <SettingOutlined /> {t('settingsTitle')}
        </span>
      }
      className="is-settings-drawer"
    >
      <Tabs
        activeKey={state.settingsTab}
        onChange={setSettingsTab}
        items={[
          { key: 'providers', label: t('tabProviders'), children: <ProvidersTab /> },
          { key: 'defaults', label: t('tabDefaults'), children: <DefaultsTab /> },
          { key: 'about', label: t('tabAbout'), children: <AboutTab /> },
        ]}
      />
    </Drawer>
  )
}

function ProvidersTab() {
  const state = useStudio()
  const provider = state.settingsProvider
  return (
    <div className="is-settings-list">
      <div className="is-settings-field">
        <label>{t('settingsProviderSelect')}</label>
        <Select
          value={provider}
          onChange={(value) => setSettingsProvider(value as ProviderId)}
          style={{ width: '100%' }}
          options={PROVIDER_IDS.map((id) => ({
            value: id,
            label: providerLabel(id),
            hasKey: Boolean(state.settings?.providers[id]?.hasKey),
          }))}
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
        <div className="is-settings-hint">{t('settingsProviderHint')}</div>
      </div>
      <ProviderCard key={provider} provider={provider} publicConfig={state.settings?.providers[provider]} />
    </div>
  )
}

function ProviderCard({
  provider,
  publicConfig,
}: {
  provider: ProviderId
  publicConfig?: { hasKey: boolean; keyMask: string; baseUrl: string; defaultModel: string }
}) {
  const { message } = App.useApp()
  const { token } = theme.useToken()
  const meta = PROVIDERS[provider]
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(publicConfig?.baseUrl || meta.defaultBaseUrl)
  const [model, setModel] = useState(publicConfig?.defaultModel || meta.defaultModel)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null)
  const [customModel, setCustomModel] = useState(false)

  useEffect(() => {
    if (!publicConfig) return
    setBaseUrl(publicConfig.baseUrl)
    setModel(publicConfig.defaultModel)
    setCustomModel(!meta.models.some((item) => item.id === publicConfig.defaultModel))
  }, [publicConfig?.baseUrl, publicConfig?.defaultModel])

  const hasKey = Boolean(publicConfig?.hasKey)

  const handleSave = async () => {
    setSaving(true)
    const res = await saveProvider(provider, {
      apiKey: apiKey.trim() ? apiKey.trim() : undefined,
      baseUrl,
      defaultModel: model,
    })
    setSaving(false)
    if (res) {
      setApiKey('')
      message.success(t('saved'))
    } else {
      message.error(t('errors.requestFailed'))
    }
  }

  const handleTest = async () => {
    setTesting(true)
    setStatus(null)
    const result = await testProvider({
      provider,
      apiKey: apiKey.trim() || undefined,
      baseUrl,
      model: model || meta.defaultModel,
    })
    setTesting(false)
    setStatus(result)
  }

  const handleClear = async () => {
    const res = await saveProvider(provider, { apiKey: '', baseUrl, defaultModel: model })
    if (res) {
      setApiKey('')
      setStatus(null)
      message.success(t('saved'))
    }
  }

  const modelOptions = meta.models.map((item) => ({ value: item.id, label: item.label }))

  return (
    <div className="is-provider-card">
      <div className="is-provider-card-head">
        <div className={`is-provider-logo ${provider}`}>{provider === 'volcengine' ? 'V' : provider === 'qwen' ? 'Q' : 'O'}</div>
        <div className="is-provider-card-title">
          <div>
            {providerLabel(provider)}
            {hasKey ? (
              <Tag color="success" className="is-provider-tag">
                {t('configured')}
              </Tag>
            ) : (
              <Tag color="warning" className="is-provider-tag">
                {t('missingKeyTag')}
              </Tag>
            )}
          </div>
          <div className="is-provider-card-desc">{t(`provider${provider === 'volcengine' ? 'Volcengine' : provider === 'qwen' ? 'Qwen' : 'Openai'}Desc`)}</div>
        </div>
      </div>

      <div className="is-settings-field">
        <label>{t('apiKey')}</label>
        <Input.Password
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={hasKey ? publicConfig?.keyMask || t('apiKeyKeep') : t('apiKeyPlaceholder')}
          autoComplete="off"
        />
        <div className="is-settings-hint">{t('apiKeyHint')}</div>
      </div>

      <div className="is-settings-field">
        <label>{t('baseUrl')}</label>
        <div className="is-inline">
          <Input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder={meta.defaultBaseUrl}
          />
          <Button size="small" type="text" onClick={() => setBaseUrl(meta.defaultBaseUrl)}>
            {t('baseUrlReset')}
          </Button>
        </div>
        {provider === 'qwen' && <div className="is-settings-hint">{t('qwenBaseUrlHint')}</div>}
      </div>

      <div className="is-settings-field">
        <label>{t('defaultModel')}</label>
        {customModel ? (
          <div className="is-inline">
            <Input value={model} onChange={(event) => setModel(event.target.value)} placeholder="Endpoint ID / Model ID" />
            <Button size="small" type="text" onClick={() => setCustomModel(false)}>
              {t('clear')}
            </Button>
          </div>
        ) : (
          <div className="is-inline">
            <Select
              value={meta.models.some((item) => item.id === model) ? model : undefined}
              onChange={(value) => setModel(value)}
              options={modelOptions}
              style={{ flex: 1 }}
              placeholder={t('modelPlaceholder')}
            />
            <Button size="small" type="text" onClick={() => setCustomModel(true)}>
              {t('custom')}
            </Button>
          </div>
        )}
        <div className="is-settings-hint">{modelDesc(provider, model)}</div>
      </div>

      <div className="is-settings-inline-row">
        <Typography.Text type="secondary" copyable={{ text: meta.docsUrl }} className="is-docs-link">
          {t('docs')}
        </Typography.Text>
        <div className="is-inline">
          {hasKey && (
            <Button size="small" danger type="text" onClick={() => void handleClear()}>
              {t('clear')}
            </Button>
          )}
          <Button size="small" onClick={() => void handleTest()} loading={testing}>
            {testing ? t('testing') : t('test')}
          </Button>
          <Button size="small" type="primary" onClick={() => void handleSave()} loading={saving}>
            {t('save')}
          </Button>
        </div>
      </div>

      {status && (
        <div
          className={`is-test-status ${status.ok ? 'is-ok' : 'is-fail'}`}
          style={{ color: status.ok ? token.colorSuccess : token.colorError }}
        >
          {status.ok ? <CheckCircleFilled /> : <ExclamationCircleFilled />}
          <span>{status.message}</span>
        </div>
      )}
    </div>
  )
}

function DefaultsTab() {
  const state = useStudio()
  const { message } = App.useApp()
  const defaults = state.settings?.defaults
  const provider = defaults?.provider || 'volcengine'
  const meta = PROVIDERS[provider]
  const spec = getModelSpec(provider, state.settings?.providers[provider]?.defaultModel || meta.defaultModel)

  const update = async (patch: Parameters<typeof saveDefaults>[0]) => {
    const res = await saveDefaults(patch)
    if (!res) message.error(t('errors.requestFailed'))
  }

  const chooseDir = async () => {
    const res = await invoke<{ path?: string }>('pick-download-dir', defaults?.downloadDir)
    if (res?.path) await update({ downloadDir: res.path })
  }

  const openDir = async () => {
    const res = await invoke<{ error?: string }>('open-download-dir', defaults?.downloadDir)
    if (res?.error) message.warning(res.error)
  }

  const purpose = (defaults?.purpose && PURPOSE_IDS.includes(defaults.purpose) ? defaults.purpose : 'ppt-slide') as PurposeId

  const optimizeValue =
    defaults?.optimizeProviderId && defaults?.optimizeModelId
      ? `${defaults.optimizeProviderId}::${defaults.optimizeModelId}`
      : undefined
  const optimizeOptions = useMemo(() => {
    const groups = new Map<string, { label: string; options: Array<{ value: string; label: string }> }>()
    for (const item of state.llmModels) {
      if (!groups.has(item.providerId)) groups.set(item.providerId, { label: item.providerName, options: [] })
      groups.get(item.providerId)!.options.push({
        value: `${item.providerId}::${item.modelId}`,
        label: item.modelName,
      })
    }
    return [...groups.values()]
  }, [state.llmModels])

  const toolValue =
    defaults?.toolProvider && defaults?.toolModel ? `${defaults.toolProvider}::${defaults.toolModel}` : undefined
  const toolOptions = useMemo(
    () =>
      PROVIDER_IDS.map((id) => {
        const configured = state.settings?.providers[id]?.defaultModel
        const models = PROVIDERS[id].models.map((item) => ({ value: `${id}::${item.id}`, label: item.label }))
        if (configured && !PROVIDERS[id].models.some((item) => item.id === configured)) {
          models.push({ value: `${id}::${configured}`, label: configured })
        }
        return { label: providerLabel(id), options: models }
      }),
    [state.settings]
  )

  return (
    <div className="is-settings-list">
      <div className="is-settings-field">
        <label>{t('defaultsPurpose')}</label>
        <Select
          value={purpose}
          onChange={(value) => {
            const preset = PURPOSE_PRESETS[value as PurposeId]
            void update({ purpose: value as PurposeId, aspect: preset.aspect, tier: preset.tier })
          }}
          style={{ width: '100%' }}
          options={PURPOSE_IDS.map((id) => ({ value: id, label: t(`purpose.${id}.name`) }))}
        />
        <div className="is-settings-hint">{t(`purpose.${purpose}.desc`)}</div>
      </div>

      <div className="is-settings-field">
        <label>{t('defaultsProvider')}</label>
        <Segmented
          value={provider}
          onChange={(value) => {
            const next = value as ProviderId
            const nextMeta = PROVIDERS[next]
            void update({ provider: next, tier: nextMeta.models[0].defaultTier })
          }}
          options={PROVIDER_IDS.map((id) => ({ value: id, label: providerLabel(id) }))}
        />
      </div>

      <div className="is-settings-field">
        <label>{t('defaultsAspect')}</label>
        <Select
          value={defaults?.aspect}
          onChange={(value) => void update({ aspect: value })}
          options={ASPECTS.map((item) => ({ value: item.value, label: item.label }))}
          style={{ width: 160 }}
        />
      </div>

      <div className="is-settings-field">
        <label>{t('defaultsTier')}</label>
        <Segmented
          value={defaults?.tier}
          onChange={(value) => void update({ tier: value as ResolutionTier })}
          options={spec.tiers.map((tier) => ({ value: tier, label: tier }))}
        />
      </div>

      {spec.supportsQuality && (
        <div className="is-settings-field">
          <label>{t('qualityLabel')}</label>
          <Select
            value={defaults?.quality}
            onChange={(value) => void update({ quality: value as QualityTier })}
            style={{ width: 160 }}
            options={QUALITY_IDS.map((quality) => ({ value: quality, label: t(`quality.${quality}`) }))}
          />
        </div>
      )}

      <div className="is-settings-field">
        <label>{t('defaultsCount')}</label>
        <InputNumber
          min={1}
          max={provider === 'qwen' ? spec.maxOutputs : 15}
          value={defaults?.count}
          onChange={(value) => void update({ count: Number(value) || 1 })}
          style={{ width: 120 }}
        />
      </div>

      <div className="is-settings-switch-row">
        <span>
          {t('defaultsWatermark')}
          <span className="is-settings-hint is-inline-hint">{t('watermarkHint')}</span>
        </span>
        <Switch checked={defaults?.watermark} onChange={(checked) => void update({ watermark: checked })} />
      </div>

      <div className="is-settings-switch-row">
        <span>{t('defaultsPromptEnhance')}</span>
        <Switch checked={defaults?.promptExtend} onChange={(checked) => void update({ promptExtend: checked })} />
      </div>

      <div className="is-settings-field">
        <label>{t('optimizeModelLabel')}</label>
        <Select
          value={optimizeValue}
          onChange={(value) => {
            if (!value) {
              void update({ optimizeProviderId: '', optimizeModelId: '' })
              return
            }
            const [providerId, ...rest] = String(value).split('::')
            void update({ optimizeProviderId: providerId, optimizeModelId: rest.join('::') })
          }}
          options={optimizeOptions}
          placeholder={t('optimizeModelPlaceholder')}
          style={{ width: '100%' }}
          allowClear
          showSearch
          optionFilterProp="label"
          notFoundContent={t('optimizeModelEmpty')}
        />
        <div className="is-settings-hint">{t('optimizeModelHint')}</div>
      </div>

      <div className="is-settings-field">
        <label>{t('toolModelLabel')}</label>
        <Select
          value={toolValue}
          onChange={(value) => {
            if (!value) {
              void update({ toolProvider: '', toolModel: '' })
              return
            }
            const [providerId, ...rest] = String(value).split('::')
            void update({ toolProvider: providerId as ProviderId, toolModel: rest.join('::') })
          }}
          options={toolOptions}
          placeholder={t('toolModelPlaceholder')}
          style={{ width: '100%' }}
          allowClear
          showSearch
          optionFilterProp="label"
        />
        <div className="is-settings-hint">{t('toolModelHint')}</div>
      </div>

      <div className="is-settings-switch-row">
        <span>{t('defaultsGroup')}</span>
        <Switch checked={defaults?.sequential} onChange={(checked) => void update({ sequential: checked })} />
      </div>

      <div className="is-settings-field">
        <label>{t('downloadDir')}</label>
        <div className="is-inline">
          <Input readOnly value={defaults?.downloadDir || ''} placeholder={t('downloadDirEmpty')} />
          <Button size="small" icon={<FolderOpenOutlined />} onClick={() => void chooseDir()}>
            {t('chooseDir')}
          </Button>
          <Button size="small" type="text" onClick={() => void openDir()}>
            {t('openFolder')}
          </Button>
        </div>
        <div className="is-settings-hint">{t('downloadDirHint')}</div>
      </div>
    </div>
  )
}

function AboutTab() {
  const state = useStudio()
  const { message } = App.useApp()

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  }

  return (
    <div className="is-settings-list">
      <div className="is-about-head">
        <div className="is-about-logo">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2.4l2.55 6.05L20.6 11l-6.05 2.55L12 19.6l-2.55-6.05L3.4 11l6.05-2.55z" />
            <path d="M18.6 15.4l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" />
          </svg>
        </div>
        <div>
          <div className="is-about-title">{t('title')}</div>
          <div className="is-about-version">
            {t('version')} {PLUGIN_VERSION}
          </div>
        </div>
      </div>
      <div className="is-about-desc">{t('aboutDesc')}</div>

      <div className="is-settings-field">
        <label>{t('dataDir')}</label>
        <div className="is-inline">
          <Input readOnly value={state.dataDir} />
          <Button
            size="small"
            icon={<FolderOpenOutlined />}
            onClick={async () => {
              const res = await invoke<{ error?: string }>('open-data-dir')
              if (res?.error) message.warning(res.error)
            }}
          >
            {t('openFolder')}
          </Button>
        </div>
        <div className="is-settings-hint">{t('dataDirHint')}</div>
      </div>

      <div className="is-about-stats">
        <div>
          <span>{t('countLabel', { count: state.total })}</span>
        </div>
        <div>{t('storageUsed', { size: formatBytes(state.usageBytes) })}</div>
      </div>

      <div className="is-settings-field">
        <label>{t('usage')}</label>
        <div className="is-settings-hint">{t('usageHint')}</div>
      </div>

      <Typography.Text type="secondary" className="is-about-platform">
        {t('subtitle')}
      </Typography.Text>
    </div>
  )
}
