import type { Message, ToolPart } from '../../types/message'
import { isAbortedMessage, isVisibleReasoningContent, isVisibleTextContent } from '../../types/message'
import { messageCompletedAt } from '../../store/messagePartMerge'
import { collectChangedFiles } from '../message/parts/changedFiles'
import type { ChangedFile } from '../message/parts/changedFiles'

export const PAGE_MESSAGE_COUNT = 20
export const PAGE_EXTREME_RENDER_WEIGHT = 700
export const PAGE_OVERSCAN_VIEWPORTS = 2
export const PAGE_ADJACENT_OVERSCAN = 1

export interface MessageGroupRow {
  key: string
  messages: Message[]
  messageIds: string[]
  estimatedHeight: number
  renderWeight?: number
  continuesFromPrevious?: boolean
  continuesToNext?: boolean
}

export interface ChatPage {
  key: string
  rows: MessageGroupRow[]
  messageIds: string[]
  estimatedHeight: number
  renderWeight?: number
}

export interface StableChatPage extends ChatPage {
  key: string
}

export interface PageRange {
  startIndex: number
  endIndex: number
}

export type PageRenderSegment =
  | {
      kind: 'expanded'
      key: string
      page: StableChatPage
      measuredHeight: number
    }
  | {
      kind: 'collapsed'
      key: string
      height: number
    }

export type ExpandedPageSelection = Set<number>

const messageRenderWeightCache = new WeakMap<Message, number>()

export function computeAnchorRestoreScrollDelta(previousTopOffset: number, nextTopOffset: number): number {
  return nextTopOffset - previousTopOffset
}

/**
 * 向上加载历史后，视口应该回到哪个 scrollTop。
 *
 * 语义：**原本贴在视口顶部的内容，加载完成后仍然贴在顶部**；更早的内容
 * 出现在它上方（视口之外）。用户视觉上就是「往上翻出了更多内容」。
 *
 * @param sessionBaselineScrollTop 这一轮向上浏览**首次**触发加载时的 scrollTop
 * @param sessionStartHeight       同一时刻的内容总高度
 * @param currentHeight            当前内容总高度
 *
 * 为什么用「首次」而不是每批重置：一次快速上滑常常触发多批加载
 * （到阈值批一次，继续滑再批一次）。若每批各自以当时的 scrollTop 为基线，
 * 误差会逐批累积 —— 实测一次上滑里内容高度涨了 6557px，而视口只被补了
 * 2363px，用户就被甩到了新内容的顶部。
 *
 * 为什么用高度差而不是「距底部距离」：prepend 的过渡态容器高度会**先塌缩
 * 再回升**（实测 13181 → 5483 → 13904），过渡期距底部距离完全失真。
 * 高度差只用「起始值 → 当前值」，单调且与塌缩无关。
 */
export function computePrependRestoreScrollTop(
  sessionBaselineScrollTop: number,
  sessionStartHeight: number,
  currentHeight: number,
): number {
  const grown = currentHeight - sessionStartHeight
  // 高度还没回升（塌缩阶段）时不补偿，避免把视口往回拖
  if (grown <= 0) return sessionBaselineScrollTop
  return sessionBaselineScrollTop + grown
}

const TEXT_RENDER_FEATURE_PATTERN = /\n|^[ \t]*```([^\r\n]*)|!\[[^\]]*\]\([^)]*\)/gm

function estimateTextRenderWeight(text: string): number {
  if (!text) return 0
  if (!text.trim()) return 0

  let lineCount = 1
  let fenceCount = 0
  let mermaidBlocks = 0
  let images = 0
  TEXT_RENDER_FEATURE_PATTERN.lastIndex = 0
  for (let match = TEXT_RENDER_FEATURE_PATTERN.exec(text); match; match = TEXT_RENDER_FEATURE_PATTERN.exec(text)) {
    if (match[0] === '\n') {
      lineCount += 1
    } else if (match[0].startsWith('!')) {
      images += 1
    } else {
      fenceCount += 1
      if (match[1]?.trim().toLowerCase() === 'mermaid') mermaidBlocks += 1
    }
  }
  const fencedBlocks = Math.ceil(fenceCount / 2)

  return Math.max(
    1,
    1 + Math.floor(text.length / 1400) + Math.floor(lineCount / 40) + fencedBlocks * 2 + mermaidBlocks * 4 + images * 2,
  )
}

export function estimateMessageRenderWeight(message: Message): number {
  const cached = messageRenderWeightCache.get(message)
  if (cached != null) return cached

  let weight = message.info.role === 'user' ? 1 : 2

  for (const part of message.content) {
    switch (part.type) {
      case 'text':
        weight += part.synthetic ? 1 : estimateTextRenderWeight(part.text)
        break
      case 'reasoning':
        weight += 1 + estimateTextRenderWeight(part.text)
        break
      case 'tool': {
        const outputLength = part.state.output?.length ?? part.state.error?.length ?? 0
        weight += 4 + Math.min(8, Math.floor(outputLength / 4000))
        break
      }
      default:
        break
    }
  }

  const result = Math.max(1, weight)
  messageRenderWeightCache.set(message, result)
  return result
}

function estimateMessageHeight(message: Message): number {
  if (message.info.role === 'user') {
    return Math.max(72, message.content.length * 40)
  }
  return Math.max(160, message.content.length * 80)
}

function estimateGroupHeight(messages: Message[]): number {
  let total = 24
  for (let index = 0; index < messages.length; index++) {
    if (index > 0) total += 8
    total += estimateMessageHeight(messages[index])
  }
  return total
}

function estimateRowHeight(
  messages: Message[],
  options?: { continuesFromPrevious?: boolean; continuesToNext?: boolean },
) {
  const paddingReduction = (options?.continuesFromPrevious ? 4 : 0) + (options?.continuesToNext ? 12 : 0)
  return estimateGroupHeight(messages) - paddingReduction
}

function estimateGroupRenderWeight(messages: Message[]): number {
  return messages.reduce((total, message) => total + estimateMessageRenderWeight(message), 0)
}

function buildMessageGroupRow(
  group: Message[],
  options?: { continuesFromPrevious?: boolean; continuesToNext?: boolean },
): MessageGroupRow {
  const firstId = group[0]?.info.id ?? 'empty'
  return {
    key: `row:${firstId}`,
    messages: group,
    messageIds: group.map(message => message.info.id),
    estimatedHeight: estimateRowHeight(group, options),
    renderWeight: estimateGroupRenderWeight(group),
    continuesFromPrevious: options?.continuesFromPrevious,
    continuesToNext: options?.continuesToNext,
  }
}

function buildMessageGroups(messages: Message[]): MessageGroupRow[] {
  const groups: Message[][] = []
  for (const message of messages) {
    const previous = groups[groups.length - 1]
    if (previous && message.info.role === 'assistant' && previous[0].info.role === 'assistant') {
      previous.push(message)
    } else {
      groups.push([message])
    }
  }

  return groups.map(group => buildMessageGroupRow(group))
}

function splitOversizedMessageGroups(
  rows: MessageGroupRow[],
  pageMessageCount: number,
  maxRenderWeight: number,
): MessageGroupRow[] {
  return rows.flatMap(row => {
    if (row.messages.length <= pageMessageCount && (row.renderWeight ?? 0) <= maxRenderWeight) return row

    const chunks: Message[][] = []
    let currentChunk: Message[] = []
    let currentWeight = 0
    for (const message of row.messages) {
      const messageWeight = estimateMessageRenderWeight(message)
      if (
        currentChunk.length > 0 &&
        (currentChunk.length >= pageMessageCount || currentWeight + messageWeight > maxRenderWeight)
      ) {
        chunks.push(currentChunk)
        currentChunk = []
        currentWeight = 0
      }
      currentChunk.push(message)
      currentWeight += messageWeight
    }
    if (currentChunk.length > 0) chunks.push(currentChunk)

    return chunks.map((chunk, index) =>
      buildMessageGroupRow(chunk, {
        continuesFromPrevious: index > 0,
        continuesToNext: index < chunks.length - 1,
      }),
    )
  })
}

export function buildChatPages(
  messages: Message[],
  pageMessageCount = PAGE_MESSAGE_COUNT,
  maxRenderWeight = PAGE_EXTREME_RENDER_WEIGHT,
): ChatPage[] {
  const rows = splitOversizedMessageGroups(buildMessageGroups(messages), pageMessageCount, maxRenderWeight)
  const renderPages: ChatPage[] = []

  let currentRows: MessageGroupRow[] = []
  let currentMessageCount = 0
  let currentRenderWeight = 0
  for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex--) {
    const row = rows[rowIndex]
    const rowRenderWeight = row.renderWeight ?? estimateGroupRenderWeight(row.messages)
    if (
      currentRows.length > 0 &&
      (currentMessageCount + row.messages.length > pageMessageCount ||
        currentRenderWeight + rowRenderWeight > maxRenderWeight)
    ) {
      renderPages.push(buildChatPage(currentRows))
      currentRows = []
      currentMessageCount = 0
      currentRenderWeight = 0
    }
    currentRows.unshift(row)
    currentMessageCount += row.messages.length
    currentRenderWeight += rowRenderWeight
  }

  if (currentRows.length > 0) {
    renderPages.push(buildChatPage(currentRows))
  }

  return renderPages
}

function buildChatPage(rows: MessageGroupRow[]): ChatPage {
  const messageIds = rows.flatMap(row => row.messageIds)
  const newestId = messageIds[messageIds.length - 1] ?? 'empty'
  const oldestId = messageIds[0] ?? newestId
  return {
    key: `${newestId}:${oldestId}:${messageIds.length}`,
    rows,
    messageIds,
    estimatedHeight: rows.reduce((sum, row) => sum + row.estimatedHeight, 0),
    renderWeight: rows.reduce((sum, row) => sum + (row.renderWeight ?? estimateGroupRenderWeight(row.messages)), 0),
  }
}

function connectAssistantPageBoundary(
  olderPage: StableChatPage,
  newerPage: StableChatPage,
): { olderPage: StableChatPage; newerPage: StableChatPage } | null {
  const olderBoundaryRow = olderPage.rows.at(-1)
  const newerBoundaryRow = newerPage.rows[0]
  if (
    olderBoundaryRow?.messages[0]?.info.role !== 'assistant' ||
    newerBoundaryRow?.messages[0]?.info.role !== 'assistant'
  ) {
    return null
  }

  const olderRows = olderPage.rows.slice()
  olderRows[olderRows.length - 1] = buildMessageGroupRow(olderBoundaryRow.messages, {
    continuesFromPrevious: olderBoundaryRow.continuesFromPrevious,
    continuesToNext: true,
  })
  const newerRows = newerPage.rows.slice()
  newerRows[0] = buildMessageGroupRow(newerBoundaryRow.messages, {
    continuesFromPrevious: true,
    continuesToNext: newerBoundaryRow.continuesToNext,
  })

  return {
    olderPage: { ...buildChatPage(olderRows), key: olderPage.key },
    newerPage: { ...buildChatPage(newerRows), key: newerPage.key },
  }
}

export function buildStableChatPages(
  messages: Message[],
  allocateKey: (page: ChatPage) => string,
  pageMessageCount = PAGE_MESSAGE_COUNT,
  maxRenderWeight = PAGE_EXTREME_RENDER_WEIGHT,
): StableChatPage[] {
  return buildChatPages(messages, pageMessageCount, maxRenderWeight).map(page => ({ ...page, key: allocateKey(page) }))
}

function flattenPageMessagesChronological(page: ChatPage): Message[] {
  return page.rows.flatMap(row => row.messages)
}

function flattenPagesMessageIdsChronological(pages: ChatPage[]): string[] {
  return pages
    .slice()
    .reverse()
    .flatMap(page => page.messageIds)
}

export function findMessageSequenceOffset(nextIds: string[], previousIds: string[]): number {
  if (previousIds.length === 0) return 0
  if (previousIds.length > nextIds.length) return -1

  const firstId = previousIds[0]
  for (let startIndex = 0; startIndex <= nextIds.length - previousIds.length; startIndex++) {
    if (nextIds[startIndex] !== firstId) continue

    let matches = true
    for (let index = 1; index < previousIds.length; index++) {
      if (nextIds[startIndex + index] !== previousIds[index]) {
        matches = false
        break
      }
    }
    if (matches) return startIndex
  }

  return -1
}

function rebuildPageWithFreshMessages(page: StableChatPage, nextById: Map<string, Message>): StableChatPage {
  let pageChanged = false
  const rows = page.rows.map(row => {
    const messages = row.messages.map(message => nextById.get(message.info.id) ?? message)
    if (messages.every((message, index) => message === row.messages[index])) return row
    pageChanged = true
    return {
      key: row.key,
      messages,
      messageIds: messages.map(message => message.info.id),
      estimatedHeight: estimateRowHeight(messages, row),
      renderWeight: estimateGroupRenderWeight(messages),
      continuesFromPrevious: row.continuesFromPrevious,
      continuesToNext: row.continuesToNext,
    }
  })

  if (!pageChanged) return page

  return {
    key: page.key,
    rows,
    messageIds: rows.flatMap(row => row.messageIds),
    estimatedHeight: rows.reduce((sum, row) => sum + row.estimatedHeight, 0),
    renderWeight: rows.reduce((sum, row) => sum + (row.renderWeight ?? estimateGroupRenderWeight(row.messages)), 0),
  }
}

export function reconcileStableChatPages(options: {
  currentPages: ChatPage[]
  nextMessages: Message[]
  allocateKey: (page: ChatPage) => string
  pageMessageCount?: number
  maxRenderWeight?: number
}): StableChatPage[] {
  const { currentPages, nextMessages, allocateKey } = options
  const pageMessageCount = options.pageMessageCount ?? PAGE_MESSAGE_COUNT
  const maxRenderWeight = options.maxRenderWeight ?? PAGE_EXTREME_RENDER_WEIGHT
  if (nextMessages.length === 0) return []
  if (currentPages.length === 0) {
    return buildStableChatPages(nextMessages, allocateKey, pageMessageCount, maxRenderWeight)
  }

  const previousIds = flattenPagesMessageIdsChronological(currentPages)
  const nextIds = nextMessages.map(message => message.info.id)
  const offset = findMessageSequenceOffset(nextIds, previousIds)
  if (offset === -1) {
    return buildStableChatPages(nextMessages, allocateKey, pageMessageCount, maxRenderWeight)
  }

  const nextById = new Map(nextMessages.map(message => [message.info.id, message]))
  const refreshedPages = currentPages.map(page => rebuildPageWithFreshMessages(page as StableChatPage, nextById))
  const prefixMessages = nextMessages.slice(0, offset)
  const suffixMessages = nextMessages.slice(offset + previousIds.length)

  let nextPages = refreshedPages
  if (suffixMessages.length > 0) {
    const newestPage = refreshedPages[0]
    const newestMessages = newestPage ? flattenPageMessagesChronological(newestPage) : []
    const suffixWeight = suffixMessages.reduce((sum, message) => sum + estimateMessageRenderWeight(message), 0)
    const newestWeight = newestPage?.renderWeight ?? 0

    if (
      newestPage &&
      newestPage.messageIds.length + suffixMessages.length <= pageMessageCount &&
      newestWeight + suffixWeight <= maxRenderWeight
    ) {
      const combinedRows = buildMessageGroups([...newestMessages, ...suffixMessages])
      const previousFirstRow = newestPage.rows[0]
      if (
        previousFirstRow?.continuesFromPrevious &&
        combinedRows[0]?.messageIds[0] === previousFirstRow.messageIds[0]
      ) {
        combinedRows[0] = buildMessageGroupRow(combinedRows[0].messages, { continuesFromPrevious: true })
      }
      const combinedPage = buildChatPage(combinedRows)
      nextPages = [{ ...combinedPage, key: newestPage.key }, ...refreshedPages.slice(1)]
    } else {
      let appendedPages = buildStableChatPages(suffixMessages, allocateKey, pageMessageCount, maxRenderWeight)
      let continuedNewestPage = newestPage
      const boundaryPage = appendedPages.at(-1)
      const connection = newestPage && boundaryPage ? connectAssistantPageBoundary(newestPage, boundaryPage) : null
      if (connection) {
        continuedNewestPage = connection.olderPage
        appendedPages = appendedPages.slice()
        appendedPages[appendedPages.length - 1] = connection.newerPage
      }
      nextPages = [...appendedPages, ...(continuedNewestPage ? [continuedNewestPage] : []), ...refreshedPages.slice(1)]
    }
  }

  if (prefixMessages.length > 0) {
    // 纯 prepend：已有页对象尽量保持引用不变，只在更老一侧挂新页。
    // 不改写 currentOldestPage（connect 会换新对象），避免视口内页重组抖动。
    let prependedOlderPages = buildStableChatPages(prefixMessages, allocateKey, pageMessageCount, maxRenderWeight)
    const currentOldestPage = nextPages.at(-1)
    const prefixBoundaryPage = prependedOlderPages[0]
    if (prefixBoundaryPage && currentOldestPage) {
      const olderBoundaryRow = prefixBoundaryPage.rows.at(-1)
      const newerBoundaryRow = currentOldestPage.rows[0]
      if (
        olderBoundaryRow?.messages[0]?.info.role === 'assistant' &&
        newerBoundaryRow?.messages[0]?.info.role === 'assistant'
      ) {
        const olderRows = prefixBoundaryPage.rows.slice()
        olderRows[olderRows.length - 1] = buildMessageGroupRow(olderBoundaryRow.messages, {
          continuesFromPrevious: olderBoundaryRow.continuesFromPrevious,
          continuesToNext: true,
        })
        prependedOlderPages = [
          { ...buildChatPage(olderRows), key: prefixBoundaryPage.key },
          ...prependedOlderPages.slice(1),
        ]
      }
    }
    nextPages = [...nextPages, ...prependedOlderPages]
  }

  return nextPages
}

export function buildPageOffsets(pages: ChatPage[], measuredPageHeights: Record<string, number>): number[] {
  const offsets = new Array<number>(pages.length + 1)
  offsets[0] = 0
  for (let index = 0; index < pages.length; index++) {
    offsets[index + 1] = offsets[index] + (measuredPageHeights[pages[index].key] ?? pages[index].estimatedHeight)
  }
  return offsets
}

export function seedMeasuredPageHeightsFromPreviousPages(options: {
  pages: ChatPage[]
  previousPages: ChatPage[]
  measuredPageHeights: Record<string, number>
}): Record<string, number> {
  const { pages, previousPages, measuredPageHeights } = options
  if (pages.length === 0 || previousPages.length === 0) return measuredPageHeights

  let nextHeights = measuredPageHeights
  for (const page of pages) {
    if (nextHeights[page.key] != null) continue

    const seedHeight = findMeasuredPageHeightSeed(page, previousPages, measuredPageHeights)
    if (seedHeight == null) continue

    if (nextHeights === measuredPageHeights) nextHeights = { ...measuredPageHeights }
    nextHeights[page.key] = seedHeight
  }

  return nextHeights
}

function findMeasuredPageHeightSeed(
  page: ChatPage,
  previousPages: ChatPage[],
  measuredPageHeights: Record<string, number>,
): number | null {
  let best: { messageCount: number; height: number } | null = null

  for (const previousPage of previousPages) {
    const measuredHeight = measuredPageHeights[previousPage.key]
    if (measuredHeight == null || measuredHeight <= 0) continue
    if (previousPage.messageIds.length === 0 || previousPage.messageIds.length > page.messageIds.length) continue
    if (findMessageSequenceOffset(page.messageIds, previousPage.messageIds) === -1) continue

    const estimatedAddedHeight = Math.max(0, page.estimatedHeight - previousPage.estimatedHeight)
    const height = Math.max(1, Math.ceil(measuredHeight + estimatedAddedHeight))
    if (!best || previousPage.messageIds.length > best.messageCount) {
      best = { messageCount: previousPage.messageIds.length, height }
    }
  }

  return best?.height ?? null
}

function findPageIndexAtOffset(offsets: number[], offset: number): number {
  let low = 0
  let high = offsets.length - 2
  let result = 0

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    if (offsets[mid] <= offset && offsets[mid + 1] > offset) return mid
    if (offsets[mid] > offset) {
      high = mid - 1
    } else {
      result = mid
      low = mid + 1
    }
  }

  return Math.max(0, Math.min(result, offsets.length - 2))
}

export function computeExpandedPageRange(options: {
  pages: ChatPage[]
  measuredPageHeights: Record<string, number>
  scrollOffsetFromBottom: number
  viewportHeight: number
  overscanPx?: number
  adjacentPageCount?: number
  adjacentPageMaxSourceHeight?: number
}): PageRange {
  const { pages, measuredPageHeights, scrollOffsetFromBottom, viewportHeight } = options
  if (pages.length === 0) return { startIndex: 0, endIndex: -1 }

  const offsets = buildPageOffsets(pages, measuredPageHeights)
  const viewportSpan = Math.max(1, viewportHeight)
  const overscanPx = Math.max(0, options.overscanPx ?? viewportSpan * PAGE_OVERSCAN_VIEWPORTS)
  const viewportStart = Math.max(0, scrollOffsetFromBottom - overscanPx)
  const viewportEnd = scrollOffsetFromBottom + viewportSpan + overscanPx
  const firstVisiblePageIndex = findPageIndexAtOffset(offsets, viewportStart)
  const lastVisiblePageIndex = findPageIndexAtOffset(offsets, Math.max(viewportStart, viewportEnd - 1))
  const adjacentPageCount = Math.max(0, Math.floor(options.adjacentPageCount ?? 0))
  const maxSourceHeight = options.adjacentPageMaxSourceHeight
  const canExpandFrom = (pageIndex: number) => {
    if (maxSourceHeight == null) return true
    const measuredHeight = measuredPageHeights[pages[pageIndex].key]
    return measuredHeight != null && measuredHeight <= maxSourceHeight
  }

  return {
    startIndex: canExpandFrom(firstVisiblePageIndex)
      ? Math.max(0, firstVisiblePageIndex - adjacentPageCount)
      : firstVisiblePageIndex,
    endIndex: canExpandFrom(lastVisiblePageIndex)
      ? Math.min(pages.length - 1, lastVisiblePageIndex + adjacentPageCount)
      : lastVisiblePageIndex,
  }
}

export function buildExpandedPageSelection(
  range: PageRange,
  forcedPageIndex?: number | readonly number[] | null,
): ExpandedPageSelection {
  const selection = new Set<number>()
  if (range.endIndex >= range.startIndex) {
    for (let index = range.startIndex; index <= range.endIndex; index++) selection.add(index)
  }
  if (typeof forcedPageIndex === 'number') {
    if (forcedPageIndex >= 0) selection.add(forcedPageIndex)
  } else if (forcedPageIndex) {
    for (const index of forcedPageIndex) {
      if (index >= 0) selection.add(index)
    }
  }
  return selection
}

export function expandSelectionWithPageKeys(options: {
  pages: ChatPage[]
  expandedPageSelection: ExpandedPageSelection
  pageKeys: ReadonlySet<string>
}): ExpandedPageSelection {
  const { pages, expandedPageSelection, pageKeys } = options
  if (pages.length === 0 || pageKeys.size === 0) return expandedPageSelection

  let nextSelection = expandedPageSelection
  for (let index = 0; index < pages.length; index += 1) {
    if (!pageKeys.has(pages[index].key) || nextSelection.has(index)) continue
    if (nextSelection === expandedPageSelection) nextSelection = new Set(expandedPageSelection)
    nextSelection.add(index)
  }

  return nextSelection
}

export function buildPageRenderSegments(options: {
  pages: StableChatPage[]
  expandedPageSelection: ExpandedPageSelection
  measuredPageHeights: Record<string, number>
}): PageRenderSegment[] {
  const { pages, expandedPageSelection, measuredPageHeights } = options
  if (pages.length === 0) return []

  const segments: PageRenderSegment[] = []
  const appendCollapsedSegment = (startPageIndex: number, endPageIndex: number) => {
    if (startPageIndex > endPageIndex) return

    let height = 0
    for (let index = startPageIndex; index <= endPageIndex; index++) {
      height += measuredPageHeights[pages[index].key] ?? pages[index].estimatedHeight
    }

    segments.push({
      kind: 'collapsed',
      key: `collapsed:${pages[startPageIndex].key}:${pages[endPageIndex].key}`,
      height,
    })
  }

  let collapsedStartIndex: number | null = null
  for (let index = 0; index < pages.length; index++) {
    if (!expandedPageSelection.has(index)) {
      if (collapsedStartIndex === null) collapsedStartIndex = index
      continue
    }

    if (collapsedStartIndex !== null) {
      appendCollapsedSegment(collapsedStartIndex, index - 1)
      collapsedStartIndex = null
    }

    const page = pages[index]
    segments.push({
      kind: 'expanded',
      key: page.key,
      page,
      measuredHeight: measuredPageHeights[page.key] ?? page.estimatedHeight,
    })
  }

  if (collapsedStartIndex !== null) appendCollapsedSegment(collapsedStartIndex, pages.length - 1)
  return segments
}

export function buildTurnDurationMap(messages: Message[], visibleMessages: Message[]): Map<string, number> {
  const map = new Map<string, number>()
  const visibleAssistantIds = new Set(
    visibleMessages.filter(message => message.info.role === 'assistant').map(message => message.info.id),
  )

  let currentUserCreated: number | null = null
  let currentVisibleAssistantId: string | null = null
  let currentLastCompleted: number | null = null

  const commitTurn = () => {
    if (currentUserCreated == null || currentVisibleAssistantId == null || currentLastCompleted == null) return
    map.set(currentVisibleAssistantId, currentLastCompleted - currentUserCreated)
  }

  for (const message of messages) {
    if (message.info.role === 'user') {
      commitTurn()
      currentUserCreated = message.info.time?.created ?? null
      currentVisibleAssistantId = null
      currentLastCompleted = null
      continue
    }

    if (currentUserCreated == null || message.info.role !== 'assistant') continue

    if (visibleAssistantIds.has(message.info.id)) {
      currentVisibleAssistantId = message.info.id
    }
    const completedAt = messageCompletedAt(message)
    if (completedAt != null) {
      currentLastCompleted = completedAt
    }
  }

  commitTurn()

  return map
}

/**
 * 每个用户回合里，最后一条可见 assistant 消息的 id 集合。
 * 用于「仅最新 Step」：中间 assistant 消息不显示 step 完成信息。
 */
export function buildTurnLatestAssistantIdSet(visibleMessages: Message[]): Set<string> {
  const latestIds = new Set<string>()
  let currentLatestAssistantId: string | null = null

  const commitTurn = () => {
    if (currentLatestAssistantId) latestIds.add(currentLatestAssistantId)
  }

  for (const message of visibleMessages) {
    if (message.info.role === 'user') {
      commitTurn()
      currentLatestAssistantId = null
      continue
    }
    if (message.info.role === 'assistant') {
      currentLatestAssistantId = message.info.id
    }
  }

  commitTurn()
  return latestIds
}

/** 过程折叠：虚拟时间线上的一行 */
export type ProcessTimelineItem =
  | {
      kind: 'message'
      key: string
      message: Message
      /** 过程壳内消息的内容范围 */
      processContentScope?: 'process' | 'final' | 'inline'
    }
  | {
      kind: 'process-shell'
      key: string
      userMessageId: string | null
      startedAt?: number
      durationMs?: number
      isActive: boolean
      /**
       * 这一轮被中断（用户主动停止 / 服务端判定空闲中止）。
       *
       * 由轮内带 `error.name === 'MessageAbortedError'` 的 assistant 消息判定。
       * 实测两种形态都会出现（2026-11-01，笔电主机）：
       *   - 多步中断：末尾补一条**内容为空**的 assistant（`finish:'error'`）；
       *   - 单步中断：**就是那条正在跑的消息**被打上 error（它带 reasoning/text/tool，
       *     且 `finish` 为 undefined —— 服务端只发 step.failed，不发 step.ended）。
       *
       * 渲染层据此在折叠块下方写明中断 —— 否则界面上只剩一个折叠块，
       * 用户分不清「被打断了」和「本来就没有回复」。
       */
      interrupted?: boolean
      /** 壳内消息（不含壳外 final） */
      children: Array<{
        message: Message
        /**
         * 内容范围：
         * - `inline` / `process`：只渲染过程项（历史轮次的折叠视图）；
         * - `final`：只渲染正文 —— 最终回答那条消息自身也以工具调用收尾时用它，
         *   否则正文会被整个折进折叠块（实测整轮回答「消失」）；
         * - `all`：整条原样渲染 —— 最后一轮用它，服务端写什么就显示什么，
         *   不做「哪句是最终回复」的猜测。
         */
        processContentScope: 'process' | 'inline' | 'final' | 'all'
      }>
      /** 壳外最终回答（结束后才有）。多段执行时是**最后一条**结论。 */
      finalMessage?: Message
      /**
       * 壳外全部最终回答（按时间顺序）。
       *
       * 一个 user 轮可能包含多段执行：后台任务完成通知（`synthetic`）会把 agent
       * 唤醒继续跑，每段各有自己的 `finish=stop` 结论（实测见
       * `chatPageModel.multiStop.test.ts`）。只保留最后一条会让前一段的结论
       * 被折进壳里 —— 展开「已处理」时多出内容、收起后又消失。
       *
       * 缺省时调用方回退到 `finalMessage`（单段执行的常见情形）。
       */
      finalMessages?: Message[]
    }

/** 两行是否可共享同一对象（VirtualRow 靠 item 引用短路） */
export function sameProcessTimelineItem(a: ProcessTimelineItem, b: ProcessTimelineItem): boolean {
  if (a === b) return true
  if (a.kind !== b.kind || a.key !== b.key) return false

  if (a.kind === 'message' && b.kind === 'message') {
    return a.message === b.message && a.processContentScope === b.processContentScope
  }

  if (a.kind === 'process-shell' && b.kind === 'process-shell') {
    if (
      a.userMessageId !== b.userMessageId ||
      a.startedAt !== b.startedAt ||
      a.durationMs !== b.durationMs ||
      a.isActive !== b.isActive ||
      a.finalMessage !== b.finalMessage ||
      a.interrupted !== b.interrupted ||
      a.children.length !== b.children.length
    ) {
      return false
    }
    const leftFinals = a.finalMessages ?? (a.finalMessage ? [a.finalMessage] : [])
    const rightFinals = b.finalMessages ?? (b.finalMessage ? [b.finalMessage] : [])
    if (leftFinals.length !== rightFinals.length) return false
    for (let i = 0; i < leftFinals.length; i++) {
      if (leftFinals[i] !== rightFinals[i]) return false
    }
    for (let i = 0; i < a.children.length; i++) {
      const left = a.children[i]
      const right = b.children[i]
      if (left.message !== right.message || left.processContentScope !== right.processContentScope) {
        return false
      }
    }
    return true
  }

  return false
}

/**
 * 流式时只脏最后一行：按 key 复用未变 timeline item，让 VirtualRow memo 命中历史行。
 * 数组本身若完全未变则复用 previous 数组引用。
 */
export function reuseProcessTimelineItems(
  previous: ProcessTimelineItem[] | undefined,
  next: ProcessTimelineItem[],
): ProcessTimelineItem[] {
  if (!previous || previous.length === 0) return next
  if (previous === next) return previous

  const prevByKey = new Map(previous.map(item => [item.key, item]))
  let allSame = previous.length === next.length
  const result = new Array<ProcessTimelineItem>(next.length)

  for (let i = 0; i < next.length; i++) {
    const item = next[i]
    const prev = prevByKey.get(item.key)
    if (prev && sameProcessTimelineItem(prev, item)) {
      result[i] = prev
      if (previous[i] !== prev) allSame = false
    } else {
      result[i] = item
      allSame = false
    }
  }

  return allSame ? previous : result
}

function isEffectiveAssistantMessage(message: Message): boolean {
  if (message.info.role !== 'assistant') return false
  // 流式中、或有任何内容、或有错误、或骨架带有统计信息，均视为有效助手消息
  if (message.isStreaming || messageCompletedAt(message) == null) return true
  if (message.content.length > 0) return true
  if ((message.info as { error?: unknown })?.error != null) return true
  if (message.isCompressed && message.compressedStats && (message.compressedStats.stepCount > 0 || message.compressedStats.reasoningCount > 0)) {
    return true
  }
  return false
}

/**
 * 这条消息是否以**可见正文**收尾（忽略空 text / 空 reasoning / 隐藏内容）。
 *
 * 用途：中断/失败轮里判断「模型是否已经写出了实质回答」。
 *
 * 服务端的语义很稳定（实测三台主机 308 轮 / 5861 条带 finish 的消息）：
 *   - `finish=tool-calls` 的消息**一定**以 tool 收尾（0 条反例）
 *   - 以正文收尾的消息，正文就是它那一段执行的结论
 *
 * 所以「末 part 是不是可见 text」等价于「这段正文有没有被后续工具调用打断」。
 */
function endsWithVisibleText(message: Message): boolean {
  for (let i = message.content.length - 1; i >= 0; i--) {
    const part = message.content[i]
    if (part.type === 'text') {
      if (isVisibleTextContent(part)) return true
      continue
    }
    if (part.type === 'reasoning') {
      if (isVisibleReasoningContent(part)) return false
      continue
    }
    // tool / 其他 part：打断了正文
    return false
  }
  return false
}

function assistantHasLiveWork(message: Message): boolean {
  if (message.info.role !== 'assistant') return false
  if (messageCompletedAt(message) == null || message.isStreaming) return true
  return message.content.some(
    p => p.type === 'tool' && (p.state.status === 'running' || p.state.status === 'pending'),
  )
}

function resolveTurnDurationMs(
  assistants: Message[],
  userStart: number | undefined,
  turnDurationMap: Map<string, number>,
): number | undefined {
  if (userStart == null) return undefined
  for (const m of [...assistants].reverse()) {
    const mapped = turnDurationMap.get(m.info.id)
    if (mapped != null && mapped > 0) return mapped
  }
  // 轮次骨架：过程已被剥掉，消息上只剩「用户创建 → 末条助手完成」的总时长。
  // 不读它，折叠块 header 就会显示「已处理 0ms」。
  for (const m of [...assistants].reverse()) {
    const skeleton = m.compressedStats?.durationMs
    if (skeleton != null && skeleton > 0) return skeleton
  }
  let latestEnd: number | undefined
  for (const m of assistants) {
    const completed = messageCompletedAt(m)
    if (completed != null && (latestEnd == null || completed > latestEnd)) latestEnd = completed
    for (const p of m.content) {
      if (p.type !== 'tool') continue
      const toolEnd = p.state.time?.end
      if (toolEnd != null && (latestEnd == null || toolEnd > latestEnd)) latestEnd = toolEnd
    }
  }
  if (latestEnd != null && latestEnd > userStart) return latestEnd - userStart
  return undefined
}

/**
 * 过程折叠时间线：按用户消息分组。
 *
 * 异步多发：
 * - 同一时刻只一个 Working，挂在最早仍 pending 的 user 回合
 * - 更晚空回合先只显示 user
 * - 后面回合 SSE live 一到，前面一律 Worked（不必等 completed / idle）
 * - 本轮 assistant 全 completed 且无 live → 永远 Worked，不因 session busy 重开
 *   （否则发送瞬间 streaming 先到、新 user 未入列，会把已 Worked 闪回 Working）
 *
 * isUserEntryReady：空壳等用户入场生长完成后再挂。
 */
export function buildProcessTimeline(
  visibleMessages: Message[],
  options: {
    turnDurationMap: Map<string, number>
    sessionIsStreaming: boolean
    /**
     * 服务端权威运行状态（`session.active`）。
     *
     * 与 `sessionIsStreaming` 互补：后者看本地消息是否在增长，刷新后的瞬间
     * 为 false（全是快照完成态）；这个值来自服务端，能立刻说明会话还在跑。
     * 缺省 false（历史存档、测试）。
     */
    serverRunning?: boolean
    messageHasProcess: (message: Message) => boolean
    messageHasFinal: (message: Message) => boolean
    /** 用户消息入场生长是否完成；缺省视为已完成（历史消息 / 测试） */
    isUserEntryReady?: (userMessageId: string) => boolean
  },
): ProcessTimelineItem[] {
  const {
    turnDurationMap,
    sessionIsStreaming,
    serverRunning = false,
    messageHasProcess,
    messageHasFinal,
    isUserEntryReady = () => true,
  } = options
  const items: ProcessTimelineItem[] = []

  type TurnBag = {
    user: Message | null
    assistants: Message[]
  }

  const turns: TurnBag[] = []
  let current: TurnBag | null = null

  for (const message of visibleMessages) {
    if (message.info.role === 'user') {
      if (current) turns.push(current)
      current = { user: message, assistants: [] }
      continue
    }
    if (message.info.role !== 'assistant') continue
    // 过滤完全没有任何有效内容/统计/错误的非流式空 assistant 消息，
    // 防止网络中转导致的幽灵空消息污染时间线并被装入过程壳
    if (!isEffectiveAssistantMessage(message)) continue
    if (!current) {
      // 历史续段 / 页首无 user：直接平铺，不挂壳
      items.push({ kind: 'message', key: message.info.id, message })
      continue
    }
    current.assistants.push(message)
  }
  if (current) turns.push(current)

  // 只关心带 user 的回合（过程壳的锚点）
  const userTurns = turns.filter((t): t is TurnBag & { user: Message } => t.user != null)

  // 后缀预计算：laterHasAssistant / laterHasLive 原本每个回合都向后扫一遍，
  // 最坏 O(turns²)。这里从右往左一次扫出「该下标之后是否存在」的布尔后缀数组，
  // 查询降为 O(1)，整体回到 O(turns)。
  const suffixHasAssistant = new Array<boolean>(userTurns.length + 1)
  const suffixHasLive = new Array<boolean>(userTurns.length + 1)
  suffixHasAssistant[userTurns.length] = false
  suffixHasLive[userTurns.length] = false
  for (let i = userTurns.length - 1; i >= 0; i--) {
    const assistants = userTurns[i].assistants
    suffixHasAssistant[i] = suffixHasAssistant[i + 1] || assistants.length > 0
    suffixHasLive[i] = suffixHasLive[i + 1] || assistants.some(assistantHasLiveWork)
  }

  const laterHasAssistant = (fromIndex: number) => suffixHasAssistant[fromIndex + 1] === true

  /** 更晚回合是否已有 live 助手——SSE 挂 Working 的绝对条件 */
  const laterHasLive = (fromIndex: number) => suffixHasLive[fromIndex + 1] === true

  const isTurnSettled = (turn: TurnBag & { user: Message }, index: number): boolean => {
    const assistants = turn.assistants
    // 后面 SSE live → 前面 Worked（须最先判断；前轮 completed 常晚到）
    if (laterHasLive(index)) return true
    if (assistants.some(assistantHasLiveWork)) return false
    /**
     * 末尾轮次以「要调工具」收尾 → 整轮还没结束。
     *
     * 工具循环里必然有空档：上一条助手消息已 completed（`finish` 是
     * `tool-calls`），下一步还没开始。此时 `assistantHasLiveWork` 全为 false。
     *
     * 判定结果现在只影响**状态标记**（最后一轮已经不再折叠，见下方
     * `isLastUserTurn` 分支），但仍要准 —— 否则换步间隙会把「Working」闪成
     * 「Worked」再闪回来。
     *
     * 必须叠 `sessionIsStreaming`：被中断/出错而停在 tool-calls 的历史轮次同样
     * 是这个 finish 值，那种轮次确实已经结束了。
     */
    if (sessionIsStreaming && index === userTurns.length - 1 && assistants.length > 0) {
      const last = assistants[assistants.length - 1]
      if (last.info.role === 'assistant' && last.info.finish === 'tool-calls') return false
    }
    if (assistants.length === 0) {
      // 空回合：idle 结束；或后面已有 assistant（被跳过）
      return !sessionIsStreaming || laterHasAssistant(index)
    }
    /**
     * 末尾轮次 + 会话仍在运行 → 整轮还没结束。
     *
     * ⚠️ 为什么这一条必须**先于**下面的「全 completed 即锁定」判断：
     * 重新进入会话时，首屏消息来自历史快照（骨架或分页），它们全是 completed；
     * 而 agent 其实还在跑，实时 delta 还没到。此时若只看消息状态，这一轮会被
     * 判成「已结束」→ `turnIsActive` 为 false → 折叠块按「历史轮次」处理并
     * 收起，用户一进来就看不到正在生成的内容（实测反馈）。
     *
     * 三层判据，从严到宽：
     *   1. 该轮有 live 工作（`assistantHasLiveWork`）→ 已在上面返回 false
     *   2. `serverRunning`（服务端 `session.active` 权威）→ 一定还在跑
     *   3. 本地 `sessionIsStreaming` + 末条不是 `finish: 'stop'` → 大概率还在跑
     *
     * 第 2 条是权威来源：它由 SSE 的 session 状态与回前台的主动对齐提供，
     * 不依赖消息快照的新鲜度，能消除「快照到手、增量未到」的盲区。
     * 第 3 条是兜底：服务端状态可能因订阅缺失而拿不到（如子会话）。
     */
    if (index === userTurns.length - 1) {
      if (serverRunning) return false
      if (sessionIsStreaming) {
        const lastAssistant = assistants[assistants.length - 1]
        const lastFinish = (lastAssistant?.info as { finish?: string } | undefined)?.finish
        // `stop` 表示模型已正常收尾，这一轮确实结束了
        if (lastFinish !== 'stop') return false
      }
    }
    // 全 completed 且无 live → 锁定 Worked。
    // 不要再用 sessionIsStreaming 重开：发送时 busy 常早于新 user 入列，会闪一下。
    // 工具循环间隙若下一助手还没到，会短暂 Worked；下一助手 live 后自然回到 Working。
    return assistants.every(m => messageCompletedAt(m) != null && !m.isStreaming)
  }

  const isTurnPending = (turn: TurnBag & { user: Message }, index: number): boolean => {
    if (isTurnSettled(turn, index)) return false
    if (turn.assistants.length > 0) return true
    return sessionIsStreaming && isUserEntryReady(turn.user.info.id)
  }

  // 唯一 Working：最早 pending 的用户回合
  let activeUserId: string | null = null
  for (let i = 0; i < userTurns.length; i++) {
    if (isTurnPending(userTurns[i], i)) {
      activeUserId = userTurns[i].user.info.id
      break
    }
  }

  for (const turn of turns) {
    if (turn.user) {
      items.push({ kind: 'message', key: turn.user.info.id, message: turn.user })
    }

    const assistants = turn.assistants
    if (!turn.user && assistants.length === 0) continue

    // 无 user 的续段：平铺
    if (!turn.user) {
      for (const m of assistants) {
        items.push({ kind: 'message', key: m.info.id, message: m })
      }
      continue
    }

    const userId = turn.user.info.id

    /**
     * 最后一轮：**流式进行中**时原样输出，不做内容拆分。
     *
     * 这一轮的内容是「服务端此刻正在写的东西」，顺序与内容都是权威的。任何
     * 折叠/拆分的尝试都要靠猜「哪一段才是最终回复」，而猜错的代价很难看：
     *   - 把中间说明当最终回复 → 过程内容泄露到折叠块外（实测一轮 10 分 25 秒
     *     只露出「18 个测试全部通过。现在构建并部署 agent。」）；
     *   - 把真正的回复当过程吞掉 → 回复凭空消失。
     *
     * ⚠️ 但**轮次结束后**必须回到与历史轮次相同的拆分规则：用户要的是
     * 「提问 + 回复」，过程收进折叠块。若结束后仍把全部内容塞进壳里，
     * 收起折叠块时**整轮的回复会一起消失**，只剩一行「Worked for 34s」
     * ——实测「查看 @cloudflare/kumo@2.15.0 更新内容」那个会话就是这样：
     * 收起后 2.5KB 的回复内容全部不见。
     *
     * 两者的边界是「这一轮是否还在生成」：生成中不拆（避免猜错），
     * 生成结束就按最终回复拆分。
     */
    const isLastUserTurn = userId === userTurns[userTurns.length - 1]?.user.info.id

    /**
     * 最终回复 = 轮内 `finish === 'stop'` 的那条 assistant 的正文。
     *
     * ⚠️ 不能按「最后一条带 text 的消息」猜。
     *
     * 服务端在 `session.step.ended` 里给出 `finish`（`FinishReason`）：
     *   - `stop`        模型正常收尾 → 这条正文就是回答
     *   - `tool-calls`  还要继续调工具 → 这条正文只是过程说明
     *   - `length`      被输出长度截断 → 仍是回答，只是不完整（兜底用）
     *
     * 实测（2026-11-01，笔电主机 ses_e6cc8b786ffepHbTstQ3zvDJ7f）：用户在工作中
     * 点停止，那一轮最后一条是 `finish=tool-calls` 且带 41 字过程说明。旧判据
     * 只看「有没有 text」，于是把过程说明当最终回复挂到折叠块**外面** ——
     * 正是「打断后过程内容泄漏」的形态；刷新（走投影，服务端该轮没有回复）后
     * 那句话又消失，前后不一致。
     *
     * 判据分两层，缺一不可：
     *
     *   1. 轮内**有** `finish` → 只信 `finish`（`stop` → `length`）。
     *      `tool-calls` 一律是过程，即使带正文也不露到壳外。这条挡住的是
     *      「打断/中断后过程说明泄漏」：实测该轮最后一条是 `finish=tool-calls`
     *      且带 41 字过程说明，服务端最终形状里这一轮**没有回复**。
     *
     *   2. 轮内**完全没有** `finish` → 按位置兜底（最后一条带正文的）。
     *
     * 第 2 条是必需的，不是兼容性妥协：**轮次骨架**（历史快照主路径）合成的
     * 回复消息不带 `finish` —— 实测骨架响应里 `reply` 只有 `{text, messageID,
     * ordinal}`，没有 finish 字段（见 `api/turnSkeleton.ts` 的 raw.push）。
     * 若只认 `finish === 'stop'`，刷新后**所有历史轮次的回答都会消失**，
     * 只剩一行「已处理 N 步」。
     *
     * 两层用「轮内是否出现过 finish」来分，而不是逐条兜底：逐条兜底会让
     * 中断轮里那条 `tool-calls` 的过程说明被重新选中（实测复现）。
     */
    const finishOf = (message: Message) => (message.info as { finish?: string }).finish
    const hasFinalText = (message: Message) => messageHasFinal(message)
    const turnHasFinish = assistants.some(m => finishOf(m) != null)
    /**
     * 这一轮是否被中断。
     *
     * 服务端在中断轮补一条带 `error.type = 'aborted'` 的 assistant（实测见
     * `chatPageModel.interruptView.test.ts` 与 `true-abort` 现场：中断时服务端
     * 发 `session.step.failed{error:{type:'aborted'}}`，刷新后的消息形状是
     * `finish:'error', error:'aborted'`）。
     *
     * 它是唯一能把「被用户打断」和「本来就没有回复的纯工具轮」区分开的信号：
     * 两者在内容上完全一样（都是若干 tool-calls + 没有 stop）。
     */
    const interrupted = assistants.some(m => isAbortedMessage(m.info))
    /**
     * 这一轮里**所有**「结论消息」的下标。
     *
     * ⚠️ 不能只取最后一个。后台任务完成通知（`synthetic`）会把一次「轮次」拆成
     * 两段执行，两段各有自己的结论：
     *
     * 服务端实测（2026-11-01，ARM 主机 ses_e6e0b3d23ffe7YEJI1DItkyUuv，下标 154~186）：
     *   154  user      继续
     *   …    26 条 finish=tool-calls（各带一句过程说明）
     *   179  assistant finish=stop  text(806)   "CI 还在运行，Release 需要约 13 分钟…"
     *   180  idle      succeeded                 ← 第一段结束
     *   181  synthetic <shell id="sh_19397e3f..." state="completed">  ← 后台任务完成通知
     *   182-184 assistant finish=tool-calls
     *   185  assistant finish=stop  text(1164)  "全部完成，且都已核实。v2.0.55 已发布…"
     *   186  idle      succeeded                 ← 第二段结束
     *
     * 前端只在遇到下一条 user 时切轮（下面的 TurnBag 累积），所以 182~185 被并进
     * 154 那一轮 —— 整轮出现**两个** `stop`。只取最后一个的后果：806 那句结论被
     * 当成过程项塞进折叠块，于是「展开已处理」时多出 806 字、「收起」后又只剩
     * 1164 字，页面上最终回答的内容随折叠状态变化（用户实测反馈）。
     *
     * 正确语义：**每个 stop 都是它那一段执行的结论**，都要露在折叠块外。
     */
    const finalIndexes: number[] = []
    if (interrupted) {
      /**
       * 中断/失败轮：**以正文收尾**的消息才是回答。
       *
       * 这里有一组容易混淆的形态，必须靠「末 part 是不是 text」区分：
       *
       *   ❌ 过程说明（不该外露）：finish=tool-calls、末 part = tool
       *      实测笔电主机 ses_e6cc8b786ffepHbTstQ3zvDJ7f：那一轮最后一条带
       *      41 字「收到，我逐条执行这 12 个 echo 命令…」，后面紧跟工具调用。
       *      旧实现把它当回答露到折叠块外，正是「打断后泄露折叠设计」。
       *
       *   ✅ 已写出的回答（该外露）：finish=error(aborted)、末 part = text
       *      实测 ARM 主机 ses_eaa3442ccffeFLuqH2Vt3aN9TA 第 4 轮：用户点停止
       *      时，模型已经写完 2480 字的实质性分析（「## 二、次要热点…」）。
       *      若因「中断轮一律没有回复」把它折进壳里，用户看到的就是
       *      「回复后所有内容全部直接折叠了」——实际反馈的正是这个。
       *
       * 全量实测（三台主机 30 个会话 / 308 轮 / 5861 条带 finish 的消息）：
       *   - `finish=tool-calls` 且以正文收尾：**0 条**（所以按此判据不会误选
       *     过程说明；服务端的语义是「还要调工具」的消息一定以 tool 收尾）
       *   - `finish=error` 且以正文收尾：3 条（含上面那个 2480 字）
       *   - `finish=error` 且以工具收尾：65 条（真过程，保持折叠）
       *
       * 再看中断/失败轮的分布（68 轮）：66 轮没有任何以正文收尾的消息，
       * 2 轮各有 1 条，**没有**任何一轮出现多条 —— 所以即使放开这个判据，
       * 也不会把一段过程说明同时外露。
       */
      const last = assistants.findLastIndex(m => endsWithVisibleText(m))
      if (last >= 0) finalIndexes.push(last)
    } else if (turnHasFinish) {
      for (let i = 0; i < assistants.length; i++) {
        const finish = finishOf(assistants[i])
        if ((finish === 'stop' || finish === 'length') && hasFinalText(assistants[i])) finalIndexes.push(i)
      }
    } else {
      /**
       * 轮内完全没有 `finish`。有两种来源，可靠性不同：
       *
       * 1. **骨架轮**（历史快照主路径，带 `isCompressed`）：后端合成的消息
       *    content 末尾一定是回复正文（`replies` 每条各合成一条）。用它自己的
       *    判据（最后一条带正文的消息），不能被「末 part 必须是 text」误伤。
       *
       * 2. **无 finish 的实时消息 / 老数据**：全量实测 5868 条 assistant 里只有
       *    8 条（0.14%），且全部 `completed: null`（仍在流式）。这种数据没有
       *    服务端结论可依，按「以正文收尾」优先；一条都没有时才退回「带正文」，
       *    保留旧行为兜底（否则老会话的回复会整轮消失）。
       */
      const skeletonLike = assistants.some(m => m.isCompressed && m.compressedStats)
      let last = skeletonLike
        ? assistants.findLastIndex(hasFinalText)
        : assistants.findLastIndex(m => endsWithVisibleText(m))
      // 兜底：没有任何「以正文收尾」的消息时，退回「带正文」（兼容老数据）
      if (last < 0 && !skeletonLike) last = assistants.findLastIndex(hasFinalText)
      if (last >= 0) finalIndexes.push(last)
    }
    const finalIndexSet = new Set(finalIndexes)
    /** 最后一个结论消息：改动文件汇总、耗时页脚、操作按钮挂在它上面 */
    const finalAssistant = finalIndexes.length > 0 ? assistants[finalIndexes[finalIndexes.length - 1]] : null
    const finalId = finalAssistant?.info.id ?? null
    // 缺 time（v2 轻量投影）时保持 undefined：回落成 0 会让「进行中」
    // 计时器从 1970 年起算，界面显示成 Working for 56y…
    const startedAt = turn.user.info.time?.created

    /**
     * 骨架轮次使用 Agent 给出的总时长，**不按 active 丢弃**。
     *
     * 骨架的每条助手消息都是「该轮最终回复」，没有真实的流式状态：若按 active
     * 处理，折叠块会用 `now - startedAt` 现算，而 startedAt 是用户消息的创建时间
     * （可能是几十小时前），算出来就是「Worked for 0ms」或一个荒唐的巨大值。
     * 骨架给出的 durationMs 是「首条 user → 末条 assistant 完成」的真实总耗时。
     *
     * 例外：**正在流式的那一轮**没有 durationMs（末条还没完成），此时仍走
     * 实时计时，保持「Working for 3s」逐秒跳动的观感。
     */
    const skeletonDuration = assistants.reduce<number | undefined>((found, m) => {
      if (found != null) return found
      const value = m.compressedStats?.durationMs
      return value != null && value > 0 ? value : undefined
    }, undefined)
    /**
     * 这一轮是否仍在生成。
     *
     * ⚠️ `skeletonDuration` **不能**参与这里的判定。
     *
     * 它原本的用意是「骨架轮已有确定时长 → 一定已结束，别再按 active 现算
     * 计时（会算出荒唐的巨大值）」。但那只是**计时来源**的选择，不是
     * 「是否结束」的证据 —— 实测骨架对**未定稿轮次**同样带 `durationMs`：
     *
     *   {"id":"msg_9558a...","durationMs":104110,"settled":false,
     *    "stats":{"stepCount":12},"reply":null}
     *
     * 这一轮 `reply` 为 null、步骤还在 10→13 增长（agent 正在跑），却因为
     * durationMs 非空把 `turnIsActive` 判成 false，于是：
     *   - header 从「Working for 2m 4s」变成「Worked for 1m 33s」；
     *   - 折叠块按历史轮次处理并**收起**，正在生成的过程内容被藏起来；
     *   - 硬刷新后尤其明显（实测用户截图就是这个形态）。
     *
     * 正确判据只有「有没有活跃工作」：`activeUserId` 由 `isTurnSettled`
     * 三层判据算出（live 工作 / serverRunning 权威 / 本地 streaming 兜底），
     * 已经把「服务端还在跑」的情况包含进去了。
     */
    const turnIsActive = activeUserId != null && userId === activeUserId
    /**
     * 计时来源。
     *
     * 进行中一律走实时计时（`undefined` → header 用 now - startedAt 现算），
     * 这样「Working for 3s」会逐秒跳动；已结束才用确定时长。
     *
     * 骨架 durationMs 只用于**已结束**的轮次 —— 也正因如此上面不能拿它
     * 反推「已结束」，否则就循环论证了。
     */
    const durationMs =
      turnIsActive ? undefined : (skeletonDuration ?? resolveTurnDurationMs(assistants, startedAt, turnDurationMap))

    /**
     * 最后一轮**且仍在生成** → 原样输出，不拆过程/最终。
     *
     * 结束后（`turnIsActive === false`）走下面与历史轮次相同的拆分规则，
     * 否则收起折叠块会把整轮回复一起藏起来。
     */
    const lastTurnStillStreaming = isLastUserTurn && turnIsActive

    // 最后一轮且仍在生成：内容原样输出（不拆过程/最终），壳照常承载状态与开合。
    // 纯文本轮不挂壳：只有一条回复、没有任何过程可折叠，套个壳纯属多一层边框。
    if (lastTurnStillStreaming) {
      /** 空回合 + 会话仍在跑 → 需要空壳承载 Working（与历史设计一致） */
      const needsEmptyWorkingShell = assistants.length === 0 && turnIsActive
      const needsShell =
        needsEmptyWorkingShell ||
        assistants.length > 1 ||
        turnIsActive ||
        assistants.some(m => messageHasProcess(m))
      if (needsShell) {
        const rawChildren = assistants.map(m => ({ message: m, processContentScope: 'all' as const }))
        items.push({
          kind: 'process-shell',
          key: `process-shell:${userId}`,
          userMessageId: userId,
          startedAt,
          durationMs,
          isActive: turnIsActive,
          children: rawChildren,
          ...(interrupted ? { interrupted: true } : {}),
        })
        continue
      }
      for (const m of assistants) {
        items.push({ kind: 'message', key: m.info.id, message: m })
      }
      continue
    }

    // 进行中：全部进壳；结束：中间全进 + 末尾仅 process
    /**
     * 壳内子消息的作用域。
     *
     * `process`/`inline`：只渲染过程项；`final`：只渲染正文（最终回答那条既有
     * 正文又有过程时用，见下方说明）。
     */
    const children: Array<{ message: Message; processContentScope: 'process' | 'inline' | 'final' }> = []
    if (turnIsActive) {
      for (const m of assistants) {
        children.push({
          message: m,
          processContentScope: m.info.id === finalId ? 'process' : 'inline',
        })
      }
    } else {
      /**
       * ⚠️ 最终回答那条消息**不能整个塞进过程块**。
       *
       * 工具密集型回合里，真正带回答的那条 assistant 常常是
       * `[reasoning, text(回答), tool]` —— 它以工具调用收尾，但正文就是回答。
       * 2026-10-31 实测（arm 主机 ses_e6dcd22dbffe67R75bZIbrBWHI）：六条
       * assistant 全部 finish=tool-calls，末条只有工具，回答在倒数第一条里。
       *
       * 旧写法在「最终回答消息本身也有过程内容」时把**整条**以
       * `process` 作用域挂进壳内：MarkdownRenderer 对 `process` 作用域只渲染
       * 过程项（`split.processItems`），而正文属于 finalItems → 答案不渲染；
       * 折叠块收起后页面上只剩一句过程说明，用户以为回复被吞了，只能刷新。
       *
       * 正确做法：把它拆成两半 —— 过程部分进壳，正文（finalItems）放壳外。
       * 同一轮里**其他**消息即使带正文也只算中间说明（`inline`），
       * 避免把每条说明都摊到壳外。
       */
      for (let index = 0; index < assistants.length; index++) {
        const m = assistants[index]
        /**
         * 内容为空的中断标记消息**不进壳**。
         *
         * 多步中断时服务端会补一条空 assistant 只带 `error.type = 'aborted'`。
         * 它唯一的用途是把「这一轮被中断」告诉时间线（见上面的 `interrupted`）。
         * 放进壳里的话，MessageRenderer 会把它的错误视图画在折叠区内部 ——
         * 收起时看不见，展开时又和壳下方的中断提示重复。
         *
         * 单步中断时那条消息**本身有内容**（reasoning/text/tool），走下面的
         * 正常分支进壳即可：它的正文属于过程，`interrupted` 已保证不会被当成回答。
         */
        if (isAbortedMessage(m.info) && m.content.length === 0) continue
        if (finalIndexSet.has(index)) {
          /**
           * 结论消息：**正文一律不进壳**。
           *
           * 旧写法在 `messageHasProcess(m)` 时把它以 `final` 作用域挂进壳内
           * （壳内只画正文）。单段执行时那样没问题（正文本来就要露在壳外，
           * 壳内这份是给「展开时能看到完整上下文」用的）。
           *
           * 但多段执行时会出现多个 stop（见上方 `finalIndexes` 的说明），
           * 结果就是**同一段正文在壳内外各渲染一次**：收起时壳内那份被裁掉、
           * 只剩壳外一份；展开时壳内那份又出现 —— 用户看到的就是「展开/收起
           * 后最终回复多了或者换了内容」。
           *
           * 所以结论消息的过程部分（reasoning / tool）仍进壳，正文只留在壳外。
           */
          if (messageHasProcess(m)) children.push({ message: m, processContentScope: 'process' })
        } else {
          children.push({ message: m, processContentScope: 'inline' })
        }
      }
    }

    /**
     * 折叠块外的最终回答（可能有多条）。
     *
     * 一个 user 轮可能包含**多段执行**（后台任务完成通知会把 agent 唤醒继续跑），
     * 每段都有自己的 `finish=stop` 结论。全部都要露在壳外，否则「展开/收起」
     * 会让页面上最终回答的内容变化（用户实测反馈）。
     *
     * `finalMessages` 的每一条都以 `processContentScope: 'final'` 渲染 ——
     * 只画正文（`split.finalItems`），不会把过程内容再画一遍。
     * 最后一条同时承担改动文件汇总（turnFiles）、耗时页脚与操作按钮。
     */
    const finalMessages = !turnIsActive
      ? finalIndexes.map(i => assistants[i]).filter((m): m is Message => m != null)
      : []
    const finalOutside = finalMessages.length > 0 ? finalMessages[finalMessages.length - 1] : undefined
    /** 向后兼容：既有调用点读 `finalMessage` 的地方都指最后一条结论 */
    const primaryFinal = finalOutside
    /**
     * 这一轮是否**需要折叠**（有过程内容要收起来）。
     *
     * ⚠️ 不能只看 `children.length > 0`：结论消息里「纯正文」的那些**不进壳**
     * （见上面的分支），所以一个真正需要折叠的轮次可能算出来 children 为空。
     *
     * 实测反例（三台主机 30 会话 / 308 轮，其中 8 例）：单条 assistant、
     * `finish=error(aborted)`、内容 `[text(「这条命令会先暂停 90 秒…」), tool]`。
     * 它没有结论（以 tool 收尾 → 按判据不该露），但 `children` 也是空
     * （结论集合为空 → 那条消息以 `inline` 进壳……实际上它进了 children）。
     *
     * 真正要防的是另一种形态：**整轮只有一条消息、且它不是结论**。
     * 旧代码在这种情况下会落到下面的 `else` 分支，把那一条**整条平铺**出去，
     * 于是「这条命令会先暂停 90 秒…」这种过程说明就露在了折叠块外 ——
     * 正是「打断后泄露折叠设计」的形态。
     *
     * 所以这里用「是否有任何需要折叠的过程」来判断，而不是「children 是否为空」。
     */
    const hasCollapsibleProcess = assistants.some(m => messageHasProcess(m))
    const onlyAssistantIsNonFinal =
      assistants.length === 1 && !finalIndexSet.has(0)


    // 进行中或有过程内容 → 挂壳
    // 更晚的空 pending 回合：turnIsActive=false 且无 children → 不挂壳（只显示 user）
    // 纯 final 正文、无过程 → 直接平铺
    /**
     * ⚠️ 中断轮即使 `children` 为空也要挂壳。
     *
     * 中断标记消息本身不进壳（它没有内容，只承载「被中断」这个事实），
     * 所以「只有一条中断消息」的轮次（例如刚发出去就被停止、还没产生任何
     * 过程）算出来 `children.length === 0`。此时若不挂壳，就会落到下面的
     * `else` 分支把那条空消息平铺出去 —— 渲染成一个独立的「Message Aborted」
     * 错误卡片（实测刷新后就是这样），而不是折叠块下方的一行说明。
     */
    if (children.length > 0 || turnIsActive || interrupted || (onlyAssistantIsNonFinal && hasCollapsibleProcess)) {
      items.push({
        kind: 'process-shell',
        key: `process-shell:${userId}`,
        userMessageId: userId,
        startedAt,
        durationMs,
        isActive: turnIsActive,
        children,
        finalMessage: primaryFinal,
        ...(finalMessages.length > 0 ? { finalMessages } : {}),
        ...(interrupted ? { interrupted: true } : {}),
      })
    } else if (finalOutside) {
      items.push({
        kind: 'message',
        key: finalOutside.info.id,
        message: finalOutside,
      })
    } else {
      for (const m of assistants) {
        items.push({ kind: 'message', key: m.info.id, message: m })
      }
    }
  }

  return items
}

/**
 * 是否在消息流末尾展示「历史已压缩」分隔条。
 *
 * 条件：存在一次已完成的压缩，且它发生在当前最后一条消息之后（或同时）。
 * 用户随后发新消息时，压缩点已不在末尾，分隔条自然消失——否则它会一直悬在
 * 最新对话下方，让人误以为新内容也被压缩了。
 */
export function shouldShowCompactionDivider(messages: Message[], compactedAt: number | undefined): boolean {
  if (compactedAt == null || messages.length === 0) return false
  const lastCreated = messages[messages.length - 1]?.info.time?.created ?? 0
  return compactedAt >= lastCreated
}

/** 一个回合里所有助手消息的改动文件（按消息 id 去重后聚合） */
export function collectTurnChangedFiles(messages: Message[]): ChangedFile[] {
  const byId = new Map<string, Message>()
  for (const m of messages) {
    if (m && m.info.role === 'assistant') byId.set(m.info.id, m)
  }
  const toolParts: ToolPart[] = []
  for (const m of byId.values()) {
    for (const part of m.content) {
      if (part.type === 'tool') toolParts.push(part)
    }
  }
  return collectChangedFiles(toolParts)
}
