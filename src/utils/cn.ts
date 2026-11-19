// ============================================
// cn - 类名合并工具
//
// 用 clsx 处理条件类名,再用 tailwind-merge 消解冲突:后出现的同类
// Tailwind 类会覆盖先出现的(如默认 `px-3` 与调用方传入 `px-5`)。
// 这是所有 ui/ 组件接受 className 覆盖的约定基础。
// ============================================

import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/**
 * 让 tailwind-merge 认识 ZCode 字号令牌(text-ui-*)。
 *
 * 默认配置里 text-<x> 会先尝试按已知 font-size 匹配,匹配不到就落到
 * text-color 组。`text-ui-sm` 不在内置字号表里,于是被当成颜色类,
 * 与紧随其后的 `text-text-400` 冲突并被丢弃 —— 合并后元素退回继承字号,
 * 表现为「有些元素字号不对」。
 *
 * 这里把 text-ui-* 显式登记进 font-size 组:既保证字号类不被颜色类覆盖,
 * 也保留 `text-ui-sm text-ui-base` 这类后者覆盖前者的正常语义。
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        {
          text: [
            'ui-2xs',
            'ui-xs',
            'ui-sm',
            'ui-caption',
            'ui-base',
            'ui-lg',
            'ui-xl',
            'ui-settings-title',
            'ui-settings-title-lg',
            'mobile-input-safe',
          ],
        },
      ],
    },
  },
})

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}