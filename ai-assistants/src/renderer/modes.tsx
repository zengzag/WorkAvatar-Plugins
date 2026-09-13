/**
 * 视图模式选项（设置面板用）。
 */
import type { ReactNode } from 'react'
import { IconSingle, IconSplit, IconTabs } from './icons'
import type { AiWebLayoutMode } from '../shared/sites'

export interface ModeOption {
  value: AiWebLayoutMode
  label: ReactNode
}

export function buildModeOptions(t: (key: string) => string): ModeOption[] {
  return [
    {
      value: 'single',
      label: (
        <span className="aiweb-mode-opt">
          <IconSingle />
          <span>{t('mode.single')}</span>
        </span>
      ),
    },
    {
      value: 'split',
      label: (
        <span className="aiweb-mode-opt">
          <IconSplit />
          <span>{t('mode.split')}</span>
        </span>
      ),
    },
    {
      value: 'tabs',
      label: (
        <span className="aiweb-mode-opt">
          <IconTabs />
          <span>{t('mode.tabs')}</span>
        </span>
      ),
    },
  ]
}
