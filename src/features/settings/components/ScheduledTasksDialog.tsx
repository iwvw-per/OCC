// ============================================
// ScheduledTasksDialog — 定时任务管理
// ============================================
//
// 列出、创建、编辑、启停、删除定时任务。任务在指定目录新建会话并发送
// prompt。因为 opencode 没有服务端调度接口，任务仅在应用打开时触发，
// 对话框顶部对此限制做了说明。

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '../../../components/ui/Dialog'
import { Button } from '../../../components/ui/Button'
import { Input, Textarea } from '../../../components/ui/Input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/Select'
import { Switch } from '../../../components/ui/Switch'
import { TrashIcon, PlusIcon, ClockIcon } from '../../../components/Icons'
import { useModels } from '../../../hooks/useModels'
import {
  scheduledTaskStore,
  useScheduledTasks,
  createScheduledTask,
  type ScheduledTask,
  type ScheduledTaskKind,
} from '../../../store/scheduledTaskStore'

interface ScheduledTasksDialogProps {
  isOpen: boolean
  onClose: () => void
  defaultDirectory: string
}

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6]

function formatNextRun(ms: number | undefined): string {
  if (!ms) return '-'
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return '-'
  }
}

export function ScheduledTasksDialog({ isOpen, onClose, defaultDirectory }: ScheduledTasksDialogProps) {
  const { t } = useTranslation(['settings', 'common'])
  const tasks = useScheduledTasks()
  const { models } = useModels()
  const [editing, setEditing] = useState<ScheduledTask | null>(null)

  const modelOptions = useMemo(() => models.map(m => ({ value: `${m.providerId}/${m.id}`, label: m.name })), [models])

  const startCreate = () => {
    setEditing(
      createScheduledTask({
        name: '',
        schedule: { kind: 'daily', times: ['09:00'] },
        execution: {
          prompt: '',
          providerID: models[0]?.providerId ?? '',
          modelID: models[0]?.id ?? '',
          directory: defaultDirectory,
        },
      }),
    )
  }

  const saveEditing = () => {
    if (!editing) return
    const name = editing.name.trim() || editing.execution.prompt.slice(0, 20) || t('scheduledTasks.untitled')
    scheduledTaskStore.upsert({ ...editing, name })
    setEditing(null)
  }

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={t('scheduledTasks.title', { defaultValue: '定时任务' })}
      width={560}
      fullscreenOnMobile
    >
      <div className="flex flex-col gap-4">
        <p className="text-ui-sm text-text-400">
          {t('scheduledTasks.clientOnlyHint', {
            defaultValue: '任务仅在应用打开时触发；应用关闭期间不会补跑。',
          })}
        </p>

        {editing ? (
          <ScheduledTaskEditor
            task={editing}
            modelOptions={modelOptions}
            onChange={setEditing}
            onCancel={() => setEditing(null)}
            onSave={saveEditing}
          />
        ) : (
          <>
            <div className="flex justify-end">
              <Button variant="primary" size="sm" onClick={startCreate}>
                <PlusIcon size={14} />
                <span className="ml-1">{t('scheduledTasks.new', { defaultValue: '新建任务' })}</span>
              </Button>
            </div>

            {tasks.length === 0 ? (
              <p className="py-6 text-center text-ui-caption text-text-500">
                {t('scheduledTasks.empty', { defaultValue: '还没有定时任务' })}
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {tasks.map(task => (
                  <div
                    key={task.id}
                    className="flex items-center gap-3 rounded-lg border border-border-200 p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-ui-caption font-medium text-text-100">
                          {task.name}
                        </span>
                        {task.lastStatus && (
                          <span
                            className={
                              task.lastStatus === 'error'
                                ? 'text-ui-xs text-danger-100'
                                : 'text-ui-xs text-text-400'
                            }
                          >
                            {t(`scheduledTasks.status_${task.lastStatus}` as const, { defaultValue: task.lastStatus })}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-ui-xs text-text-500">
                        <ClockIcon size={12} />
                        <span>
                          {t('scheduledTasks.nextRun', { defaultValue: '下次' })}: {formatNextRun(task.nextRunAt)}
                        </span>
                      </div>
                    </div>
                    <Switch
                      checked={task.enabled}
                      onCheckedChange={value => scheduledTaskStore.setEnabled(task.id, value)}
                    />
                    <Button variant="ghost" size="sm" onClick={() => setEditing({ ...task })}>
                      {t('common:edit', { defaultValue: '编辑' })}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => scheduledTaskStore.remove(task.id)}>
                      <TrashIcon size={14} />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  )
}

function ScheduledTaskEditor({
  task,
  modelOptions,
  onChange,
  onCancel,
  onSave,
}: {
  task: ScheduledTask
  modelOptions: { value: string; label: string }[]
  onChange: (task: ScheduledTask) => void
  onCancel: () => void
  onSave: () => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const modelValue =
    task.execution.providerID && task.execution.modelID
      ? `${task.execution.providerID}/${task.execution.modelID}`
      : ''

  const patchSchedule = (patch: Partial<ScheduledTask['schedule']>) =>
    onChange({ ...task, schedule: { ...task.schedule, ...patch } })

  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-ui-sm text-text-400">{t('scheduledTasks.name', { defaultValue: '名称' })}</span>
        <Input value={task.name} onChange={e => onChange({ ...task, name: e.target.value })} />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-ui-sm text-text-400">{t('scheduledTasks.prompt', { defaultValue: '提示词' })}</span>
        <Textarea
          value={task.execution.prompt}
          onChange={e => onChange({ ...task, execution: { ...task.execution, prompt: e.target.value } })}
          rows={3}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-ui-sm text-text-400">{t('scheduledTasks.directory', { defaultValue: '目录' })}</span>
        <Input
          value={task.execution.directory}
          onChange={e => onChange({ ...task, execution: { ...task.execution, directory: e.target.value } })}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-ui-sm text-text-400">{t('scheduledTasks.model', { defaultValue: '模型' })}</span>
        <Select
          value={modelValue}
          onValueChange={value => {
            const [providerID, ...rest] = value.split('/')
            onChange({ ...task, execution: { ...task.execution, providerID, modelID: rest.join('/') } })
          }}
        >
          <SelectTrigger>
            <SelectValue placeholder={t('scheduledTasks.selectModel', { defaultValue: '选择模型' })} />
          </SelectTrigger>
          <SelectContent position="popper">
            {modelOptions.map(opt => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      <div className="flex flex-col gap-2">
        <span className="text-ui-sm text-text-400">{t('scheduledTasks.schedule', { defaultValue: '计划' })}</span>
        <Select
          value={task.schedule.kind}
          onValueChange={value => patchSchedule({ kind: value as ScheduledTaskKind })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value="daily">{t('scheduledTasks.kindDaily', { defaultValue: '每天' })}</SelectItem>
            <SelectItem value="weekly">{t('scheduledTasks.kindWeekly', { defaultValue: '每周' })}</SelectItem>
            <SelectItem value="once">{t('scheduledTasks.kindOnce', { defaultValue: '一次' })}</SelectItem>
            <SelectItem value="cron">{t('scheduledTasks.kindCron', { defaultValue: 'Cron 表达式' })}</SelectItem>
          </SelectContent>
        </Select>

        {(task.schedule.kind === 'daily' || task.schedule.kind === 'weekly') && (
          <Input
            value={(task.schedule.times ?? []).join(', ')}
            placeholder="09:00, 18:00"
            onChange={e =>
              patchSchedule({
                times: e.target.value
                  .split(',')
                  .map(s => s.trim())
                  .filter(Boolean),
              })
            }
          />
        )}

        {task.schedule.kind === 'weekly' && (
          <div className="flex flex-wrap gap-1">
            {WEEKDAYS.map(day => {
              const active = task.schedule.weekdays?.includes(day) ?? false
              return (
                <button
                  key={day}
                  type="button"
                  onClick={() => {
                    const current = new Set(task.schedule.weekdays ?? [])
                    if (active) current.delete(day)
                    else current.add(day)
                    patchSchedule({ weekdays: Array.from(current).sort() })
                  }}
                  className={`h-7 w-9 rounded-md border text-ui-sm ${
                    active ? 'border-accent-main-100 bg-bg-200 text-text-100' : 'border-border-200 text-text-400'
                  }`}
                >
                  {t(`scheduledTasks.weekday_${day}` as const, { defaultValue: String(day) })}
                </button>
              )
            })}
          </div>
        )}

        {task.schedule.kind === 'once' && (
          <div className="flex gap-2">
            <Input
              type="date"
              value={task.schedule.date ?? ''}
              onChange={e => patchSchedule({ date: e.target.value })}
            />
            <Input
              type="time"
              value={task.schedule.time ?? ''}
              onChange={e => patchSchedule({ time: e.target.value })}
            />
          </div>
        )}

        {task.schedule.kind === 'cron' && (
          <Input
            value={task.schedule.cron ?? ''}
            placeholder="0 9 * * *"
            onChange={e => patchSchedule({ cron: e.target.value })}
          />
        )}
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('common:cancel', { defaultValue: '取消' })}
        </Button>
        <Button variant="primary" size="sm" onClick={onSave} disabled={!task.execution.prompt.trim()}>
          {t('common:save', { defaultValue: '保存' })}
        </Button>
      </div>
    </div>
  )
}
