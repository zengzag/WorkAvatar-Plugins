/** 模板库：简化卡片，只保留名称、说明与运行入口 */
import { useMemo, useState } from 'react'
import { App, Button, Dropdown, Empty, Input, Spin, Tooltip } from 'antd'
import {
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  HistoryOutlined,
  MoreOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import type { PluginWorkflowRun } from '@workavatar/plugin-sdk'
import { invoke, t } from './host'
import type { WorkflowTemplate } from '../shared/types'

interface Props {
  templates: WorkflowTemplate[]
  loading: boolean
  runs: PluginWorkflowRun[]
  onRun: (template: WorkflowTemplate) => void
  onEdit: (template: WorkflowTemplate) => void
  onCreate: () => void
  onHistory: () => void
  onChanged: () => void
}

/** 卡片状态点：取该模板最近一次运行 */
function latestRunFor(templateId: string, runs: PluginWorkflowRun[]): PluginWorkflowRun | undefined {
  return runs.find(run => run.templateId === templateId)
}

function statusTip(status?: string): string {
  if (status === 'running') return t('list.statusRunning')
  if (status === 'completed') return t('list.statusCompleted')
  if (status === 'failed') return t('list.statusFailed')
  if (status === 'aborted') return t('list.statusAborted')
  return t('list.statusIdle')
}

export function TemplateList({ templates, loading, runs, onRun, onEdit, onCreate, onHistory, onChanged }: Props) {
  const { message, modal } = App.useApp()
  const [keyword, setKeyword] = useState('')

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return templates
    return templates.filter(template =>
      template.name.toLowerCase().includes(kw) || (template.description || '').toLowerCase().includes(kw))
  }, [templates, keyword])

  const duplicate = async (template: WorkflowTemplate) => {
    await invoke('template-duplicate', { id: template.id })
    message.success(t('template.duplicated'))
    onChanged()
  }

  const remove = (template: WorkflowTemplate) => {
    modal.confirm({
      title: t('template.deleteConfirm'),
      okText: t('template.delete'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        await invoke('template-delete', { id: template.id })
        message.success(t('template.deleted'))
        onChanged()
      },
    })
  }

  return (
    <div className="wf-list-page">
      <div className="wf-list-inner">
        <div className="wf-list-head">
          <div className="wf-list-title">
            <h1>{t('page.title')}</h1>
            <p>{t('page.desc')}</p>
          </div>
          <div className="wf-list-tools">
            <Input
              className="wf-search"
              value={keyword}
              allowClear
              prefix={<SearchOutlined style={{ opacity: 0.55 }} />}
              placeholder={t('list.searchPlaceholder')}
              onChange={event => setKeyword(event.target.value)}
            />
            <Tooltip title={t('page.runHistory')}>
              <Button type="text" icon={<HistoryOutlined />} onClick={onHistory} />
            </Tooltip>
            <Button type="primary" icon={<PlusOutlined />} onClick={onCreate}>
              {t('page.newTemplate')}
            </Button>
          </div>
        </div>

        {loading && templates.length === 0 ? (
          <div className="wf-empty"><Spin /></div>
        ) : filtered.length === 0 ? (
          <div className="wf-empty">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={templates.length === 0 ? t('page.empty') : t('list.emptySearch')}
            />
          </div>
        ) : (
          <div className="wf-tpl-grid">
            {filtered.map(template => {
              const latest = latestRunFor(template.id, runs)
              const status = latest?.status
              return (
                <div
                  key={template.id}
                  className="wf-tpl-card"
                  role="button"
                  tabIndex={0}
                  onClick={(event) => {
                    // Dropdown 菜单通过 Portal 渲染，React 事件仍会冒泡到卡片，这里拦掉
                    if ((event.target as HTMLElement).closest('.ant-dropdown')) return
                    onRun(template)
                  }}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onRun(template)
                    }
                  }}
                >
                  <div className="wf-tpl-top">
                    <Tooltip title={statusTip(status)}>
                      <span className={`wf-tpl-status ${status || 'idle'}`} />
                    </Tooltip>
                    <span className="wf-tpl-name" title={template.name}>{template.name}</span>
                  </div>
                  <p className="wf-tpl-desc">{template.description || t('template.none')}</p>
                  <div className="wf-tpl-foot">
                    <Button
                      className="wf-tpl-run"
                      icon={<PlayCircleOutlined />}
                      onClick={event => { event.stopPropagation(); onRun(template) }}
                    >
                      {t('template.run')}
                    </Button>
                    <Tooltip title={t('template.edit')}>
                      <Button
                        type="text"
                        size="small"
                        icon={<EditOutlined />}
                        onClick={event => { event.stopPropagation(); onEdit(template) }}
                      />
                    </Tooltip>
                  </div>
                  <div className="wf-tpl-more">
                    <Dropdown
                      trigger={['click']}
                      menu={{
                        items: [
                          { key: 'edit', label: t('template.edit'), icon: <EditOutlined /> },
                          { key: 'copy', label: t('list.duplicate'), icon: <CopyOutlined /> },
                          { type: 'divider' },
                          { key: 'delete', label: t('template.delete'), icon: <DeleteOutlined />, danger: true },
                        ],
                        onClick: ({ key, domEvent }) => {
                          domEvent.stopPropagation()
                          if (key === 'edit') onEdit(template)
                          else if (key === 'copy') void duplicate(template)
                          else if (key === 'delete') remove(template)
                        },
                      }}
                    >
                      <Button
                        type="text"
                        size="small"
                        icon={<MoreOutlined />}
                        onClick={event => event.stopPropagation()}
                      />
                    </Dropdown>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
