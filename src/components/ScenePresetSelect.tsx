import { useId } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { DEFAULT_SCENE_PRESET_ID, findScenePreset, type ScenePreset } from '../lib/scenePresets'
import { Tooltip } from './Tooltip'

interface ScenePresetSelectProps {
  presets: ScenePreset[]
  value: string
  onChange: (value: string) => void
  compact?: boolean
  className?: string
  disabled?: boolean
}

export function ScenePresetSelect({
  presets,
  value,
  onChange,
  compact = false,
  className,
  disabled = false,
}: ScenePresetSelectProps) {
  const selectId = useId()
  const activePreset = findScenePreset(presets, value)

  return (
    <div
      className={[
        'echo-scene-preset-select',
        compact && 'echo-scene-preset-select--compact',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <label htmlFor={selectId}>
        <SlidersHorizontal size={14} />
        预设
      </label>
      <Tooltip content={activePreset?.description || '默认处理'} side="bottom">
        <select
          id={selectId}
          value={activePreset ? value : DEFAULT_SCENE_PRESET_ID}
          onChange={(event) => onChange(event.currentTarget.value)}
          disabled={disabled}
        >
          <option value={DEFAULT_SCENE_PRESET_ID}>默认</option>
          {presets.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.name}
              {preset.isPro ? ' · Pro' : ''}
            </option>
          ))}
        </select>
      </Tooltip>
    </div>
  )
}
