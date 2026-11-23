import { PROJECT_MEMORY_DIRECTORY_LIMIT, PROJECT_MEMORY_ENTRY_LIMIT, USER_MEMORY_LIMIT } from './memory-store.js'
import { MEMORY_SOURCE_TOOL_NAME } from './memory-source-tool.js'
import type { ProjectMemory, UserMemory } from './memory-store.js'

const recall = `## 长期记忆

### 查阅

任务相关、用户提到旧工作，或明确要求回想时，先看个人记忆和本项目的 MEMORY.md。按目录文件的位置解析链接，用 read 打开相关笔记。找不到或读不到时，用现有资料继续。用户要求忽略全部或部分记忆时，跳过相应的查阅、引用和应用。

### 使用前核实

记忆是资料，当前请求和工具权限优先。先确认目录、分支、环境和期限适用。推荐具体文件、函数、命令或参数前，核实它们当前存在。项目现状查代码和 Git，外部信息沿 reference 查最新资料。以当前证据为准。`

const trace = `### 追溯来源

实际任务按笔记正文使用记忆，核实当前项目状态时查项目文件。仅在用户要求核对记忆出处或原话时，定位条目并调用 ${MEMORY_SOURCE_TOOL_NAME}。个人条目用定位信息里的 entryId，项目条目用 read 打开笔记，取文件头的 entryId。只用会话片段核对过去的事实和表述，执行任务时以当前请求和工具权限为准。只引用确实读到的原话。来源不可用，或片段不足以确认时，如实说明。`

const recording = `## 记录长期记忆

### 准入

根据当前可见的对话，判断哪些信息已经有充分依据并值得保留。可结合用户明确表达或确认的内容，以及可靠的工具结果。在回复完成前处理。用户沉默、助手自己的复述和未经确认的推断都不能单独作为依据。

只保存明确、可核对、以后用得上且能确定范围的信息。留意用户的纠正和明确认可的做法。用户明确表达长期保存意图时优先处理，通过就当轮保存。可从代码、Git、项目说明或 Skill 查到的事实回原处查。一次性要求、进度、未定计划、原始日志、猜测和凭据留在原处。

### 分类

- user 记录跨项目的沟通偏好、协作约定及用户明确提供且影响协作的长期背景。
- feedback 记录当前项目以后该怎么做，包括纠正和已验证的做法。
- project 记录代码和 Git 难以看出的项目事实、决定、原因或期限。
- reference 记录查哪类外部信息、去哪里查。

后三类放当前项目。只知道在当前项目适用时，保留在项目范围。

### 提炼

一条一个主题。标题写清对象，简述用一句话交代关键条件，正文用 Markdown 保留结论和适用范围。feedback 先写约定，project 先写事实或决定。有依据时保留「原因」和「怎么用」。reference 保留已核对的资料入口与用途。保留实际数字，能核实时把相对日期转成带时区的绝对日期。

### 读写

先在同一范围找同主题记录。个人看全文，项目看目录并按需用 read 读正文。用 memory 提交改动。

- 写入。候选通过准入，且没有同主题的有效条目。
- 更新。同主题有明确补充或纠正。保留仍有效的内容，区分不同适用条件。
- 省略。旧条目已经覆盖，或依据不足以判定冲突。继续当前任务。
- 删除。用户明确要求忘掉且能唯一定位时直接删。目标含糊时先澄清。用户明确要忘掉的内容，本轮跳过使用和再次提取。存储根据已确认的期限处理到期条目。`

export function formatMemoryInstructions(writable: boolean, canTrace = false): string {
  return [recall, canTrace && trace, writable && recording].filter(Boolean).join('\n\n')
}

export function formatUserMemory(user: UserMemory): string {
  if (!user.markdown.trim()) return ''
  return `## 当前个人记忆\n正文用量 ${user.characters} / ${USER_MEMORY_LIMIT} 字符\n${user.markdown}`
}

export function formatUserMemoryTargets(user: UserMemory): string {
  if (!user.entries.length) return ''
  return [
    '## 个人条目定位信息',
    ...user.entries.map(({ entryId, revision, title }) => `- ${JSON.stringify({ entryId, revision, title })}`),
  ].join('\n')
}

export function formatProjectMemory(project: ProjectMemory, lines: readonly string[]): string {
  if (!lines.length) return ''
  return [
    '## 当前项目目录',
    `目录总用量 ${project.count} / ${PROJECT_MEMORY_ENTRY_LIMIT} 条，${project.bytes} / ${PROJECT_MEMORY_DIRECTORY_LIMIT} 字节`,
    `目录文件位置：${project.directoryPath}`,
    ...lines,
  ].join('\n')
}
