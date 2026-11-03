/** 连线属性：分支标签仅对评审/条件出边有意义，普通边给出风险提示与一键清除 */
import { Alert, Button, Segmented, Typography } from 'antd'
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
        edges: template.graph.edges.map(item => (item.id === edge.id ? { ...item, ...partial } : item)),
      },
    })
  }

  const sourceNode = template.graph.nodes.find(node => node.id === edge.source)
  const targetNode = template.graph.nodes.find(node => node.id === edge.target)
  const isConditional = sourceNode?.type === 'review' || sourceNode?.type === 'condition'
  const customWhen = edge.when && edge.when !== 'pass' && edge.when !== 'fail' ? edge.when : undefined

  return (
    <div>
      <div className="wf-field">
        <label className="wf-field-label">{t('edge.path')}</label>
        <Typography.Text style={{ fontSize: 12 }}>
          {sourceNode?.data.label || edge.source} → {targetNode?.data.label || edge.target}
        </Typography.Text>
      </div>

      {isConditional ? (
        <div className="wf-field">
          <label className="wf-field-label">{t('edge.branchType')}</label>
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
          <div className="wf-help">{t('edge.labelHint')}</div>
        </div>
      ) : null}

      {!isConditional && edge.when ? (
        <Alert
          type="warning"
          showIcon
          message={t('edge.labeledWarning')}
          action={(
            <Button size="small" type="text" onClick={() => patch({ when: undefined })}>
              {t('edge.clearLabel')}
            </Button>
          )}
        />
      ) : null}
      {!isConditional && !edge.when ? (
        <div className="wf-help">{t('edge.normalHint')}</div>
      ) : null}
    </div>
  )
}
