// Measured synthetic startup benchmark; never connects to application services.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { Writable } = require('node:stream')
const { performance } = require('node:perf_hooks')
const { executeJob } = require(
  process.env.QUEST_BASELINE_EXECUTOR || '../lib/core/executor'
)
const { createRuntime } = require('../lib/core/runtime')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'quest-efficiency-'))
const iterations = Number(process.env.QUEST_BENCH_ITERATIONS || 8)
const variant = process.env.QUEST_BENCH_VARIANT || 'baseline'
const output = process.env.QUEST_BENCH_OUTPUT
const sink = new Writable({
  write(_data, _enc, done) {
    done()
  }
})
const script = `const fs=require('node:fs'),path=require('node:path');
process.once('exit',()=>{fs.writeFileSync(path.join(process.cwd(),'metrics-'+process.pid+'.json'),JSON.stringify({pid:process.pid,cpu:process.cpuUsage(),maxRSS:process.resourceUsage().maxRSS}))});
module.exports={friendlyName:'Synthetic queue poll',inputs:{busy:{type:'boolean',defaultsTo:false},token:{type:'string'}},fn:async function({busy,token}){let sum=0;if(busy){for(let n=0;n<100000;n++)sum=(sum+n)%997;fs.appendFileSync('completed.txt',token+'\\n')}return {processed:busy?1:0,sum,pid:process.pid,rssBytes:process.memoryUsage().rss}}}`
fs.mkdirSync(path.join(root, 'scripts'))
fs.mkdirSync(path.join(root, 'config'))
fs.symlinkSync(
  path.resolve('node_modules'),
  path.join(root, 'node_modules'),
  'dir'
)
fs.writeFileSync(
  path.join(root, 'package.json'),
  JSON.stringify({ name: 'quest-synthetic-benchmark', scripts: {} })
)
fs.writeFileSync(
  path.join(root, 'config', 'runtime.js'),
  "module.exports={hooks:{session:false,grunt:false,orm:false},quest:{autoStart:false},log:{level:'silent'}}"
)
fs.writeFileSync(path.join(root, 'scripts', 'poll.js'), script)
const report = {
  variant,
  node: process.version,
  arch: process.arch,
  sourceRevision:
    process.env.QUEST_BENCH_SOURCE_REVISION ||
    require('node:child_process')
      .execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })
      .trim(),
  executionSource: process.env.QUEST_BASELINE_EXECUTOR
    ? 'frozen-0.0.9'
    : 'working-candidate',
  platform: process.platform,
  iterations,
  fixtureSha256: crypto.createHash('sha256').update(script).digest('hex'),
  workloads: []
}
;(async () => {
  for (const busy of [false, true]) {
    const parentStart = process.cpuUsage()
    const running = new Map(),
      runtime = createRuntime()
    const context = {
      config: {
        appPath: root,
        environment: 'console',
        worker: { concurrency: 1, executionTimeoutMs: 5000 }
      },
      running,
      runtime,
      stdout: sink,
      stderr: sink,
      trigger: 'scheduled'
    }
    const samples = []
    const existing = new Set(fs.readdirSync(root))
    for (let n = 0; n < iterations; n++) {
      const start = performance.now()
      const receipt = await executeJob(
        'poll',
        {
          name: 'poll',
          withoutOverlapping: true,
          inputSchema: {
            busy: { type: 'boolean', defaultsTo: false },
            token: { type: 'string' }
          },
          ...(variant === 'candidate'
            ? { execution: 'worker', when: async () => busy }
            : {})
        },
        { busy, token: variant + '-' + busy + '-' + n },
        context
      )
      samples.push({
        wallMs: performance.now() - start,
        skipped: Boolean(receipt.skipped),
        result: receipt.result?.value
      })
    }
    let warmIdleRssMiB = 0
    if (variant === 'candidate' && busy && process.platform === 'linux') {
      await new Promise((resolve) => setTimeout(resolve, 50))
      const pid = samples.at(-1)?.result?.pid
      if (pid) {
        const status = fs.readFileSync('/proc/' + pid + '/status', 'utf8')
        warmIdleRssMiB =
          Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] || 0) / 1024
      }
    }
    if (runtime.workerPool) await runtime.workerPool.drain()
    const metrics = fs
      .readdirSync(root)
      .filter((f) => f.startsWith('metrics-') && !existing.has(f))
      .map((f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')))
    const parent = process.cpuUsage(parentStart)
    const parentCpuMs = (parent.user + parent.system) / 1000
    const childCpuMs = metrics.reduce(
      (sum, m) => sum + (m.cpu.user + m.cpu.system) / 1000,
      0
    )
    report.workloads.push({
      parentCpuMs,
      childCpuMs,
      totalProcessTreeCpuMs: parentCpuMs + childCpuMs,
      warmIdleRssMiB,
      busy,
      samples,
      starts: metrics.length,
      totalCpuMs: metrics.reduce(
        (sum, m) => sum + (m.cpu.user + m.cpu.system) / 1000,
        0
      ),
      peakProcessRssMiB: metrics.length
        ? Math.max(...metrics.map((m) => m.maxRSS)) / 1024
        : 0
    })
  }
  report.completed = fs.existsSync(path.join(root, 'completed.txt'))
    ? fs
        .readFileSync(path.join(root, 'completed.txt'), 'utf8')
        .trim()
        .split('\n').length
    : 0
  console.log(JSON.stringify(report, null, 2))
  if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2))
})().finally(() => fs.rmSync(root, { recursive: true, force: true }))
