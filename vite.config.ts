import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'
import { bundledLanguagesInfo } from 'shiki/langs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as { version: string }

const shikiSupportedLangs = bundledLanguagesInfo.flatMap(info => [info.id, ...(info.aliases ?? [])])

function katexWoff2Only() {
  return {
    name: 'katex-woff2-only',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const normalizedId = id.split('?')[0].replace(/\\/g, '/')
      if (!normalizedId.endsWith('/katex/dist/katex.min.css') && !normalizedId.endsWith('/katex/dist/katex.css')) {
        return null
      }

      return code.replace(
        /,url\(fonts\/KaTeX_[^)]+\.woff\) format\("woff"\),url\(fonts\/KaTeX_[^)]+\.ttf\) format\("truetype"\)/g,
        '',
      )
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __SHIKI_SUPPORTED_LANGS__: JSON.stringify(shikiSupportedLangs),
  },
  plugins: [katexWoff2Only(), react(), tailwindcss()],
  build: {
    // 生产环境生成 sourcemap：Lighthouse 的 valid-source-maps 审计要求
    // 首方大 JS 有可用的 sourcemap，同时便于线上错误定位堆栈。
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return

          if (id.includes('@xterm/')) return 'vendor-terminal'
          // CodeMirror 被 ContentBlock 懒加载，单独成 chunk 便于长期缓存；
          // 缺少这条规则时它会落进主 chunk，把首屏体积抬高约 25%。
          if (id.includes('@codemirror/') || id.includes('@lezer/')) return 'vendor-codemirror'
          // shiki 主题元数据（shiki/themes，仅 9KB 的 {id,displayName,type} 列表）
          // 被 themeStore 在首屏同步引用；engine（oniguruma）只在语法高亮 worker
          // 里用。二者若同归 vendor-shiki，首屏会连带预加载引擎。拆开：
          // 元数据单独小 chunk 进首屏，引擎留在 worker 按需加载。
          if (id.includes('shiki/dist/themes')) return 'vendor-shiki-themes'
          // shiki core + engine + themes → 一个小 chunk；
          // 语言 grammar（@shikijs/langs/*）由 dynamic import 自动拆分
          if ((id.includes('shiki') || id.includes('@shikijs/')) && !id.includes('@shikijs/langs'))
            return 'vendor-shiki'
          if (id.includes('marked') || id.includes('dompurify') || id.includes('morphdom') || id.includes('katex'))
            return 'vendor-markdown'

          if (id.includes('@tauri-apps/')) return 'vendor-tauri'

          // Radix / floating-ui 是稳定且跨页面共用的一组依赖，独立成 chunk
          // 可避免它们随业务代码每次发版一起失效。
          if (id.includes('@radix-ui/') || id.includes('@floating-ui/')) return 'vendor-radix'

          // 稳定依赖单独成 chunk:它们几乎不随业务迭代变化,拆出后发版不会让这些库的
          // 浏览器缓存失效(此前它们全落在 entry,每次发版 hash 都会变)。
          if (
            id.includes('node_modules/react-dom/') ||
            id.includes('node_modules/react/') ||
            id.includes('node_modules/scheduler/')
          )
            return 'vendor-react'
          if (
            id.includes('node_modules/motion-dom/') ||
            id.includes('node_modules/motion-utils/') ||
            id.includes('node_modules/framer-motion/') ||
            id.includes('node_modules/motion/')
          )
            return 'vendor-motion'
          if (id.includes('node_modules/@tanstack/')) return 'vendor-tanstack'
          if (
            id.includes('node_modules/i18next/') ||
            id.includes('node_modules/react-i18next/') ||
            id.includes('node_modules/i18next-browser-languagedetector/')
          )
            return 'vendor-i18n'
          if (id.includes('node_modules/zod/')) return 'vendor-zod'
          if (id.includes('node_modules/lucide-react/')) return 'vendor-icons'
        },
      },
    },
  },

  // 生产构建本地预览：与 dev 一致把 /api 代理到 opencode 后端，
  // 便于对真实数据做性能测量（vite preview 默认不继承 server.proxy）。
  preview: {
    port: 4188,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4096',
        changeOrigin: true,
        ws: true,
        rewrite: path => path.replace(/^\/api/, ''),
      },
    },
  },

  worker: {
    format: 'es',
  },

  // Tauri CLI 兼容：不清屏，让 Tauri 的日志能保留在终端
  clearScreen: false,

  server: {
    // Tauri mobile dev 需要通过网络访问 Vite dev server
    host: process.env.TAURI_DEV_HOST || false,
    // 固定端口，避免与占用 5173 的其他工具冲突
    port: 5176,
    strictPort: true,
    // 允许所有域名
    allowedHosts: true,

    watch: {
      // src-tauri 下是 Rust 构建产物（target/ 里的 dll/exe 会被 cargo 锁住），
      // 监听它们会导致 vite 报 EBUSY 并退出。
      ignored: ['**/src-tauri/**'],
    },

    proxy: {
      // 开发环境代理 - 将 /api 前缀的请求转发到 OpenCode 后端
      // 注意：Tauri 模式下前端直接请求后端（通过 plugin-http），不走此代理
      '/api': {
        target: 'http://127.0.0.1:4096',
        changeOrigin: true,
        ws: true,
        rewrite: path => path.replace(/^\/api/, ''),
      },
    },
  },
})
