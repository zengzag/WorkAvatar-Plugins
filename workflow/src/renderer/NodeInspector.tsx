/** 节点属性：基础信息默认展开，模型 / 工具 / 临时角色细节收进「高级设置」 */
import { Input, InputNumber, Segmented, Select, Typography, theme } from 'antd'
import { useEffect, useState } from 'react'
import { invoke, t } from './host'
import { ModelSelect } from './ModelSelect'
import type { WorkflowNode, WorkflowTemplate } from '../shared/types'

interface Props {
  template: WorkflowTemplate
  node: WorkflowNode | null
  onChange: (template: WorkflowTemplate) => void
}

interface EmployeeOption {
  id: string
  name: string
  description?: string
}

interface ToolOption {
  id: string
  title?: string
  description?: string
}

async function loadToolOptions(): Promise<ToolOption[]> {
  try {
    const api = (window as { electronAPI?: { tool?: { listBuiltin?: () => Promise<unknown> } } }).electronAPI
    const list = await api?.tool?.listBuiltin?.()
    return Array.isArray(list) ? (list as ToolOption[]).filter(item => item && typeof item.id === 'string') : []
  } catch {
    return []
  }
}

export function NodeInspector({ template, node, onChange }: Props) {
  const { token } = theme.useToken()
  const [employees, setEmployees] = useState<EmployeeOption[]>([])
  const [employeesLoading, setEmployeesLoading] = useState(true)
  const [toolOptions, setToolOptions] = useState<ToolOption[]>([])
  const [advancedOpen, setAdvancedOpen] = useState(false)

  useEffect(() => {
    void invoke<{ list: EmployeeOption[] }>('employee-options')
      .then(res => setEmployees(res?.list || []))
      .catch(() => setEmployees([]))
      .finally(() => setEmployeesLoading(false))
    void loadToolOptions().then(setToolOptions)
  }, [])

  if (!node) return null

  const data = node.data
  const roleSource = data.ephemeralRole ? 'ephemeral' : 'employee'
  const showRole = node.type === 'agent' || node.type === 'review'
  const isReview = node.type === 'review'

  const patch = (partial: Partial<WorkflowNode['data']>) => {
    onChange({
      ...template,
      graph: {
        ...template.graph,
        nodes: template.graph.nodes.map(item => (item.id === node.id ? { ...item, data: { ...item.data, ...partial } } : item)),
      },
    })
  }

  const setRoleSource = (value: string | number) => {
    if (value === 'employee') {
      patch({ ephemeralRole: undefined })
    } else {
      patch({ employeeId: undefined, ephemeralRole: data.ephemeralRole || { key: '', name: '', systemPrompt: '', tools: [] } })
    }
  }

  const patchRole = (partial: Partial<NonNullable<WorkflowNode['data']['ephemeralRole']>>) => {
    patch({ ephemeralRole: { key: '', name: '', systemPrompt: '', tools: [], ...data.ephemeralRole, ...partial } })
  }

  const hasAdvanced = showRole

  return (
    <div>
      <div className="wf-field">
        <label className="wf-field-label">{t('field.label')}</label>
        <Input
          value={data.label}
          placeholder={t('field.labelPlaceholder')}
          onChange={event => patch({ label: event.target.value })}
        />
      </div>

      {showRole ? (
        <>
          <div className="wf-field">
            <label className="wf-field-label">{isReview ? t('field.reviewer') : t('field.executor')}</label>
            <Segmented
              block
              value={roleSource}
              onChange={setRoleSource}
              options={[
                { label: t('field.roleEmployee'), value: 'employee' },
                { label: t('field.roleEphemeral'), value: 'ephemeral' },
              ]}
            />
          </div>

          {roleSource === 'employee' ? (
            <div className="wf-field">
              <Select
                style={{ width: '100%' }}
                value={data.employeeId}
                placeholder={t('field.employeePlaceholder')}
                onChange={value => patch({ employeeId: value })}
                options={employees.map(employee => ({ value: employee.id, label: employee.name }))}
                showSearch
                optionFilterProp="label"
                allowClear
                loading={employeesLoading}
                notFoundContent={employeesLoading ? undefined : (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('field.employeeEmpty')}</Typography.Text>
                )}
              />
            </div>
          ) : (
            <>
              <div className="wf-field">
                <label className="wf-field-label">{t('field.ephemeralName')}</label>
                <Input
                  value={data.ephemeralRole?.name}
                  placeholder={t('field.ephemeralNamePlaceholder')}
                  onChange={event => patchRole({ name: event.target.value })}
                />
              </div>
              <div className="wf-field">
                <label className="wf-field-label">{t('field.ephemeralPrompt')}</label>
                <Input.TextArea
                  value={data.ephemeralRole?.systemPrompt}
                  placeholder={t('field.ephemeralPromptPlaceholder')}
                  autoSize={{ minRows: 4, maxRows: 10 }}
                  onChange={event => patchRole({ systemPrompt: event.target.value })}
                />
              </div>
            </>
          )}
        </>
      ) : null}

      <div className="wf-field">
        <label className="wf-field-label">{isReview ? t('field.reviewCriteria') : t('field.instruction')}</label>
        <Input.TextArea
          value={data.instruction}
          placeholder={t('field.instructionPlaceholder')}
          autoSize={{ minRows: node.type === 'input' ? 3 : 5, maxRows: 14 }}
          onChange={event => patch({ instruction: event.target.value })}
        />
        <div className="wf-help">
          {node.type === 'input' ? t('field.inputInstructionHint') : t('field.instructionHint')}
        </div>
      </div>

      {node.type === 'loop' ? (
        <div className="wf-field">
          <label className="wf-field-label">{t('field.maxRounds')}</label>
          <InputNumber
            min={1}
            max={10}
            value={data.maxRounds ?? 3}
            onChange={value => patch({ maxRounds: value ?? 3 })}
            style={{ width: '100%' }}
          />
          <div className="wf-help">{t('field.maxRoundsHint')}</div>
        </div>
      ) : null}

      {isReview ? (
        <div className="wf-help" style={{ marginTop: -4 }}>{t('field.verdictHint')}</div>
      ) : null}

      {hasAdvanced ? (
        <div className="wf-advanced">
          <button className="wf-adv-toggle" onClick={() => setAdvancedOpen(v => !v)}>
            {advancedOpen ? '▾' : '▸'} {t('field.advanced')}
          </button>
          {advancedOpen ? (
            <div className="wf-adv-body">
              <div className="wf-field">
                <label className="wf-field-label">{t('field.model')}</label>
                <ModelSelect
                  providerId={data.providerId}
                  modelId={data.modelId}
                  onChange={(providerId, modelId) => patch({ providerId: providerId || undefined, modelId: modelId || undefined })}
                />
                <div className="wf-help">{t('field.modelHint')}</div>
              </div>
              {roleSource === 'ephemeral' ? (
                <div className="wf-field">
                  <label className="wf-field-label">{t('field.ephemeralTools')}</label>
                  <Select
                    mode="tags"
                    style={{ width: '100%' }}
                    value={data.ephemeralRole?.tools || []}
                    placeholder={t('field.ephemeralToolsPlaceholder')}
                    onChange={(value: string[]) => patchRole({ tools: value })}
                    options={toolOptions.map(tool => ({
                      value: tool.id,
                      label: tool.title ? `${tool.title} (${tool.id})` : tool.id,
                    }))}
                    tokenSeparators={[',']}
                    maxTagCount="responsive"
                  />
                  <div className="wf-help">{t('field.ephemeralToolsHint')}</div>
                </div>
              ) : null}
              <div className="wf-help" style={{ color: token.colorTextQuaternary }}>{t('field.roleSourceHint')}</div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
