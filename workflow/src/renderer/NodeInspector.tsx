/** 节点属性面板：名称 / 角色来源 / 临时角色 / 工具 / 指令 / 循环轮次 */
import { Form, Input, InputNumber, Segmented, Select, Typography, theme } from 'antd'
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

/** 宿主工具目录（用于「可用工具」下拉的真实选项，避免让用户手输工具 id） */
async function loadToolOptions(): Promise<ToolOption[]> {
  try {
    const api = (window as { electronAPI?: { tool?: { listBuiltin?: () => Promise<unknown> } } }).electronAPI
    const list = await api?.tool?.listBuiltin?.()
    return Array.isArray(list) ? (list as ToolOption[]).filter(x => x && typeof x.id === 'string') : []
  } catch {
    return []
  }
}

export function NodeInspector({ template, node, onChange }: Props) {
  const { token } = theme.useToken()
  const [employees, setEmployees] = useState<EmployeeOption[]>([])
  const [employeesLoading, setEmployeesLoading] = useState(true)
  const [toolOptions, setToolOptions] = useState<ToolOption[]>([])

  useEffect(() => {
    void invoke<{ list: EmployeeOption[] }>('employee-options')
      .then(res => setEmployees(res?.list || []))
      .catch(() => setEmployees([]))
      .finally(() => setEmployeesLoading(false))
    void loadToolOptions().then(setToolOptions)
  }, [])

  if (!node) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {t('canvas.selectNode')}
      </Typography.Text>
    )
  }

  const data = node.data
  // 以「是否声明临时角色」判定来源：新节点默认落在数字员工选择器，
  // 切到临时角色时才创建角色对象——避免按 employeeId 判定时「点数字员工又弹回去」
  const roleSource = data.ephemeralRole ? 'ephemeral' : 'employee'

  /** 局部更新节点数据并回写整份模板 */
  const patch = (partial: Partial<WorkflowNode['data']>) => {
    onChange({
      ...template,
      graph: {
        ...template.graph,
        nodes: template.graph.nodes.map(n => (n.id === node.id ? { ...n, data: { ...n.data, ...partial } } : n)),
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

  const showRole = node.type === 'agent' || node.type === 'review'

  return (
    <Form layout="vertical" size="small" style={{ padding: 12 }}>
      <Form.Item label={t('field.label')}>
        <Input
          value={data.label}
          placeholder={t('field.labelPlaceholder')}
          onChange={(e) => patch({ label: e.target.value })}
        />
      </Form.Item>

      {showRole && (
        <>
          <Form.Item label={t('field.roleSource')} extra={<Typography.Text type="secondary" style={{ fontSize: 11 }}>{t('field.roleSourceHint')}</Typography.Text>}>
            <Segmented
              block
              value={roleSource}
              onChange={setRoleSource}
              options={[
                { label: t('field.roleEmployee'), value: 'employee' },
                { label: t('field.roleEphemeral'), value: 'ephemeral' },
              ]}
            />
          </Form.Item>

          {roleSource === 'employee' ? (
            <Form.Item label={t('field.employee')}>
              <Select
                value={data.employeeId}
                placeholder={t('field.employeePlaceholder')}
                onChange={(value) => patch({ employeeId: value })}
                options={employees.map(e => ({ value: e.id, label: e.name }))}
                showSearch
                optionFilterProp="label"
                allowClear
                loading={employeesLoading}
                notFoundContent={
                  employeesLoading ? undefined : (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {t('field.employeeEmpty')}
                    </Typography.Text>
                  )
                }
              />
            </Form.Item>
          ) : (
            <>
              <Form.Item label={t('field.ephemeralName')} required style={{ marginBottom: 8 }}>
                <Input
                  value={data.ephemeralRole?.name}
                  placeholder={t('field.ephemeralNamePlaceholder')}
                  onChange={(e) => patchRole({ name: e.target.value })}
                />
              </Form.Item>
              <Form.Item label={t('field.ephemeralPrompt')} required style={{ marginBottom: 8 }}>
                <Input.TextArea
                  value={data.ephemeralRole?.systemPrompt}
                  placeholder={t('field.ephemeralPromptPlaceholder')}
                  autoSize={{ minRows: 4, maxRows: 12 }}
                  onChange={(e) => patchRole({ systemPrompt: e.target.value })}
                />
              </Form.Item>
              <Form.Item
                label={t('field.ephemeralTools')}
                style={{ marginBottom: 8 }}
                extra={<Typography.Text type="secondary" style={{ fontSize: 11 }}>{t('field.ephemeralToolsHint')}</Typography.Text>}
              >
                <Select
                  mode="tags"
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
              </Form.Item>
            </>
          )}
        </>
      )}

      {showRole && (
        <Form.Item
          label={t('field.model')}
          style={{ marginBottom: 8 }}
          extra={<Typography.Text type="secondary" style={{ fontSize: 11 }}>{t('field.modelHint')}</Typography.Text>}
        >
          <ModelSelect
            providerId={data.providerId}
            modelId={data.modelId}
            onChange={(providerId, modelId) => patch({ providerId: providerId || undefined, modelId: modelId || undefined })}
          />
        </Form.Item>
      )}

      <Form.Item
        label={t('field.instruction')}
        extra={
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            {node.type === 'input' ? t('field.inputInstructionHint') : t('field.instructionHint')}
          </Typography.Text>
        }
      >
        <Input.TextArea
          value={data.instruction}
          placeholder={t('field.instructionPlaceholder')}
          autoSize={{ minRows: node.type === 'input' ? 3 : 5, maxRows: 16 }}
          onChange={(e) => patch({ instruction: e.target.value })}
        />
      </Form.Item>

      {node.type === 'loop' && (
        <Form.Item label={t('field.maxRounds')} extra={<Typography.Text type="secondary" style={{ fontSize: 11 }}>{t('field.maxRoundsHint')}</Typography.Text>}>
          <InputNumber
            min={1}
            max={10}
            value={data.maxRounds ?? 3}
            onChange={(value) => patch({ maxRounds: value ?? 3 })}
            style={{ width: '100%' }}
          />
        </Form.Item>
      )}

      {node.type === 'review' && (
        <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', padding: `0 0 ${token.paddingXXS}px` }}>
          {t('field.verdictHint')}
        </Typography.Text>
      )}
    </Form>
  )
}
