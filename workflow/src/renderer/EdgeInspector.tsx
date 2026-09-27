/** 连线属性面板：分支标签仅对评审/条件出边有意义，普通边给出风险提示与一键清除 */
import { Alert, Button, Form, Segmented, Typography } from 'antd'
import { t } from './host'
import type { WorkflowEdge, WorkflowTemplate } from '../shared/types'

interface Props {
  template: WorkflowTemplate
  edge: WorkflowEdge
  onChange: (template: WorkflowTemplate) => void
}

export function EdgeInspector({ template, edge, onChange }: Props) {
  const patch = (partial: Partial<WorkflowEdge>) => {
    onChange({
      ...template,
      graph: {
        ...template.graph,
        edges: template.graph.edges.map(e => (e.id === edge.id ? { ...e, ...partial } : e)),
      },
    })
  }

  const sourceNode = template.graph.nodes.find(n => n.id === edge.source)
  const targetNode = template.graph.nodes.find(n => n.id === edge.target)
  const isConditional = sourceNode?.type === 'review' || sourceNode?.type === 'condition'
  // 历史数据里的自定义标签：作为附加选项展示，避免 Segmented 显示为空
  const customWhen = edge.when && edge.when !== 'pass' && edge.when !== 'fail' ? edge.when : undefined

  return (
    <Form layout="vertical" size="small" style={{ padding: 12 }}>
      <Form.Item label={t('edge.path')}>
        <Typography.Text style={{ fontSize: 12 }}>
          {sourceNode?.data.label || edge.source} → {targetNode?.data.label || edge.target}
        </Typography.Text>
      </Form.Item>

      {isConditional && (
        <Form.Item
          label={t('edge.branchType')}
          extra={<Typography.Text type="secondary" style={{ fontSize: 11 }}>{t('edge.labelHint')}</Typography.Text>}
        >
          <Segmented
            block
            value={edge.when ?? ''}
            onChange={(value) => patch({ when: String(value) || undefined })}
            options={[
              { label: t('edge.defaultBranch'), value: '' },
              { label: t('verdict.pass'), value: 'pass' },
              { label: t('verdict.fail'), value: 'fail' },
              ...(customWhen ? [{ label: customWhen, value: customWhen }] : []),
            ]}
          />
        </Form.Item>
      )}

      {!isConditional && edge.when && (
        <Alert
          type="warning"
          showIcon
          message={t('edge.labeledWarning')}
          action={
            <Button size="small" type="text" onClick={() => patch({ when: undefined })}>
              {t('edge.clearLabel')}
            </Button>
          }
        />
      )}
      {!isConditional && !edge.when && (
        <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block' }}>
          {t('edge.normalHint')}
        </Typography.Text>
      )}
    </Form>
  )
}
