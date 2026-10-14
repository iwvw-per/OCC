// 真实 opencode v2 端到端验证脚本（用本机真实配置）
// 运行: node src/api/realE2E.mjs
// 依赖: 后台启动的真实 v2 serve (port 4100, 真实配置), 密码经 env REAL_V2_PASSWORD 传入
import { OpenCode } from '@opencode/client'

const BASE = 'http://127.0.0.1:4100'
const PW = process.env.REAL_V2_PASSWORD
if (!PW) throw new Error('REAL_V2_PASSWORD 未设置')

const client = OpenCode.make({
  baseUrl: BASE,
  headers: { Authorization: 'Basic ' + Buffer.from(`opencode:${PW}`).toString('base64') },
})

const LOC = { directory: '/opt/code/OpenCodeUI' }

let failures = 0
function check(name, ok, detail) {
  if (ok) {
    console.log(`  ✓ ${name}`)
  } else {
    failures++
    console.log(`  ✗ ${name} :: ${detail ?? ''}`)
  }
}

async function main() {
  console.log('\n[1] Provider / Model（真实 dsukhub provider）')
  try {
    const provs = await client.provider.list({ location: LOC })
    const pnames = (provs.data ?? []).map(p => p.id ?? p.name)
    check('provider.list 返回非空', pnames.length > 0, JSON.stringify(pnames))
    check('包含 dsukhub', pnames.includes('dsukhub'), JSON.stringify(pnames))
    const models = await client.model.list({ location: LOC })
    const mids = (models.data ?? []).map(m => m.id ?? m.modelID ?? '')
    check('model.list 返回非空', mids.length > 0, JSON.stringify(mids.slice(0, 10)))
    check('包含 deepseek-v4-flash', mids.includes('deepseek-v4-flash'), JSON.stringify(mids.slice(0, 10)))
  } catch (e) {
    check('provider/model 真实读取', false, e?.message)
  }

  console.log('\n[2] Skill（本机 skills）')
  try {
    const skills = await client.skill.list({ location: LOC })
    const snames = (skills.data ?? []).map(s => s.name ?? s.path ?? '')
    check('skill.list 返回非空', snames.length > 0, JSON.stringify(snames))
    check('包含 open-code-review', snames.some(n => String(n).includes('open-code-review')), JSON.stringify(snames))
  } catch (e) {
    check('skill 真实读取', false, e?.message)
  }

  console.log('\n[3] MCP（真实远程 api-monitor）')
  try {
    const mcp = await client.mcp.list({ location: LOC })
    const list = mcp.data ?? []
    const names = list.map(m => m.name)
    check('mcp.list 返回条目', names.length > 0, JSON.stringify(names))
    check('包含 api-monitor', names.includes('api-monitor'), JSON.stringify(names))
    const am = list.find(m => m.name === 'api-monitor')
    check('api-monitor status 字段存在', !!am && !!am.status, JSON.stringify(am))
  } catch (e) {
    check('mcp 真实读取', false, e?.message)
  }

  console.log('\n[4] 真实对话（session.create + message.prompt）')
  let sessionId = null
  try {
    const s = await client.session.create({ title: 'real-e2e', directory: '/opt/code/OpenCodeUI' })
    sessionId = s.id
    check('session.create 成功', !!sessionId, JSON.stringify(s))
  } catch (e) {
    check('session.create', false, e?.message)
  }

  if (sessionId) {
    try {
      const model = { providerID: 'dsukhub', modelID: 'deepseek-v4-flash' }
      await client.session.prompt({
        sessionID: sessionId,
        text: '请只回复两个字：收到',
        model,
      })
      check('message.prompt 已发送', true)

      // 轮询等待 assistant 回复
      let reply = ''
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 1000))
        const page = await client.message.list({ sessionID: sessionId, limit: 20 })
        const msgs = page.data ?? []
        const asst = msgs
          .filter(m => m.type === 'assistant')
          .map(m => (m.content ?? []).filter(c => c.type === 'text').map(c => c.text).join(''))
          .join('')
        if (asst.trim()) {
          reply = asst.trim()
          break
        }
      }
      check('assistant 返回真实文本', reply.length > 0, JSON.stringify(reply))
      if (reply) console.log(`      回复内容: ${reply}`)
    } catch (e) {
      check('真实对话链路', false, e?.message)
    }
  }

  console.log('\n[5] 真实 MCP 工具调用（模型调用 api-monitor）')
  try {
    const s = await client.session.create({ title: 'real-e2e-mcp', directory: '/opt/code/OpenCodeUI' })
    await client.session.prompt({
      sessionID: s.id,
      text: '使用 api-monitor 这个 MCP 服务器，列出它提供的任意一个接口并返回接口名。',
      model: { providerID: 'dsukhub', modelID: 'deepseek-v4-flash' },
    })
    let tool = null
    for (let i = 0; i < 90; i++) {
      await new Promise(r => setTimeout(r, 1000))
      const page = await client.message.list({ sessionID: s.id, limit: 20 })
      const msgs = page.data ?? []
      const asst = msgs.find(m => m.type === 'assistant')
      if (asst) {
        const t = (asst.content ?? []).find(c => c.type === 'tool' && c.state?.status === 'completed')
        if (t) {
          tool = t
          break
        }
      }
    }
    check('模型发起了真实工具调用', !!tool, '未观察到 completed 的 tool content')
    if (tool) {
      const input = JSON.stringify(tool.state?.input ?? '')
      check('工具调用引用了 api-monitor MCP', /api[-_]monitor/.test(input), input.slice(0, 120))
      const out = tool.state?.output ?? tool.state?.content?.map(c => c.text ?? '').join('') ?? ''
      check('工具返回了真实结果', String(out).trim().length > 0, JSON.stringify(String(out).slice(0, 120)))
      if (String(out).trim()) console.log(`      工具输出: ${String(out).trim().slice(0, 120)}`)
    }
  } catch (e) {
    check('真实 MCP 工具调用', false, e?.message)
  }

  console.log(`\n========== 结果: ${failures === 0 ? '全部通过' : failures + ' 项失败'} ==========\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(e => {
  console.error('脚本异常:', e)
  process.exit(1)
})
