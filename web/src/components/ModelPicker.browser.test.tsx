import type { ModelDiscovery, ModelSelection } from '@agent-learning/model'
import { expect, test } from '@playwright/experimental-ct-react'
import { ModelPicker } from './ModelPicker'

const first = { provider: 'a', modelId: 'first', reasoningEffort: 'high' } as const
const second = { provider: 'b', modelId: 'second' } as const
const discovery: ModelDiscovery = {
  providers: [
    { id: 'a', name: 'Provider A', status: { state: 'configured' } },
    { id: 'b', name: 'Provider B', status: { state: 'configured' } },
  ],
  models: [
    { id: 'first', name: 'Model A', provider: 'a', api: 'test', contextWindow: 8000, maxTokens: 1000,
      reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'high' },
    { id: 'second', name: 'Model B', provider: 'b', api: 'test', contextWindow: 8000, maxTokens: 1000 },
  ],
}

test('模型搜索按提供方分组，目标没有推理档位时选择只包含模型', async ({ mount, page }) => {
  const selected: ModelSelection[] = []
  const onSelect = (selection: ModelSelection) => { selected.push(selection) }
  const props = { discovery, disabled: false, placeholder: '选择模型', onSelect }
  const component = await mount(<ModelPicker {...props} selection={first} model={discovery.models[0]} />)
  const effort = page.getByRole('combobox', { name: '推理强度' })
  await expect(effort).toHaveText('高')
  await effort.click()
  await expect(page.getByRole('option').allTextContents()).resolves.toEqual(['低', '高'])
  await page.keyboard.press('Escape')
  const model = page.getByRole('combobox', { name: '模型', exact: true })
  await model.press('Enter')
  const search = page.getByRole('searchbox', { name: '搜索模型' })
  await expect(search).toBeFocused()
  await search.fill('second')
  await expect(page.getByRole('group', { name: 'Provider A' })).toHaveCount(0)
  await page.getByRole('group', { name: 'Provider B' }).getByRole('button', { name: 'Model B' }).click()
  await expect.poll(() => selected).toEqual([second])
  await component.update(<ModelPicker {...props} selection={second} model={discovery.models[1]} />)
  await expect(model).toHaveText('Model B')
  await expect(effort).toHaveCount(0)
})
