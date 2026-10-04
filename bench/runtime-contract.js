const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { performance } = require('node:perf_hooks')
const { Writable } = require('node:stream')
const current = require('../lib/core/executor')
const { encodeResult } = require('../lib/core/result')
const baselinePath = process.env.QUEST_BASELINE_PATH
if (!baselinePath)
  throw new Error('Set QUEST_BASELINE_PATH to the released v0.0.5 executor.js')
const baseline = require(path.resolve(baselinePath))
const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'quest-benchmark-'))
fs.mkdirSync(path.join(appPath, 'scripts'))
fs.symlinkSync(
  path.resolve('node_modules'),
  path.join(appPath, 'node_modules'),
  'dir'
)
fs.writeFileSync(
  path.join(appPath, 'package.json'),
  JSON.stringify({
    name: 'quest-benchmark',
    scripts: {},
    dependencies: { 'sails-hook-orm': '^4.0.3' }
  })
)
fs.writeFileSync(
  path.join(appPath, 'scripts', 'fixture.js'),
  `module.exports={friendlyName:'Bench fixture',habitat:'none',inputs:{mode:{type:'string',defaultsTo:'quiet'}},fn:async function({mode}){if(mode==='noisy')for(let i=0;i<32;i++)console.log('x'.repeat(65536));if(mode==='error')throw new Error('synthetic failure');return {count:0}}}`
)
fs.writeFileSync(
  path.join(appPath, 'scripts', 'resident.js'),
  fs
    .readFileSync(path.join(appPath, 'scripts', 'fixture.js'), 'utf8')
    .replace("habitat:'none',", '')
)
fs.mkdirSync(path.join(appPath, 'api', 'hooks', 'quest'), { recursive: true })
fs.writeFileSync(
  path.join(appPath, 'api', 'hooks', 'quest', 'index.js'),
  `module.exports=require(${JSON.stringify(path.resolve('lib'))})`
)
fs.mkdirSync(path.join(appPath, 'config'))
fs.writeFileSync(
  path.join(appPath, 'config', 'runtime.js'),
  "module.exports.hooks={session:false,grunt:false};module.exports.quest={autoStart:false};module.exports.log={level:'silent'}"
)
const sink = new Writable({
  write(_chunk, _encoding, done) {
    done()
  }
})
const output = {
  node: process.version,
  iterations: 12,
  execution: [],
  serialization: []
}
const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
async function run(executor, mode) {
  try {
    await executor.executeJob(
      mode === 'resident' ? 'resident' : 'fixture',
      {
        name: 'fixture',
        inputSchema: require(
          path.join(
            appPath,
            'scripts',
            mode === 'resident' ? 'resident.js' : 'fixture.js'
          )
        ).inputs
      },
      { mode },
      { config: { appPath }, stdout: sink, stderr: sink }
    )
  } catch (error) {
    if (mode !== 'error') throw error
  }
}
;(async () => {
  for (const mode of ['quiet', 'noisy', 'error', 'resident']) {
    await run(baseline, mode)
    await run(current, mode)
    const old = [],
      next = []
    for (let i = 0; i < output.iterations; i++) {
      for (const [executor, values] of i % 2
        ? [
            [current, next],
            [baseline, old]
          ]
        : [
            [baseline, old],
            [current, next]
          ]) {
        const start = performance.now()
        await run(executor, mode)
        values.push(performance.now() - start)
      }
    }
    output.execution.push({
      mode,
      baselineMedianMs: median(old),
      currentMedianMs: median(next),
      baselineSamplesMs: old,
      currentSamplesMs: next,
      changePercent: (median(next) / median(old) - 1) * 100
    })
  }
  for (const [name, value] of [
    [
      'small',
      {
        count: 0,
        ok: true,
        rows: Array.from({ length: 20 }, (_, i) => ({ id: i, name: 'row' }))
      }
    ],
    ['oversized', 'x'.repeat(16 * 1024 * 1024)]
  ]) {
    const start = performance.now()
    for (let i = 0; i < 1000; i++) encodeResult(value)
    output.serialization.push({
      name,
      iterations: 1000,
      totalMs: performance.now() - start,
      status: encodeResult(value).status
    })
  }
  for (const [name, executor] of [
    ['baseline', baseline],
    ['current', current]
  ]) {
    const tail = executor.createDiagnosticTail(65536),
      chunk = Buffer.alloc(16 * 1024 * 1024, 120)
    const start = performance.now()
    for (let i = 0; i < 100; i++) tail.append(chunk)
    output.serialization.push({
      name: `${name} 16MiB diagnostic chunk`,
      iterations: 100,
      totalMs: performance.now() - start,
      retainedBytes: Buffer.byteLength(tail.value())
    })
  }
  console.log(JSON.stringify(output, null, 2))
})().finally(() => fs.rmSync(appPath, { recursive: true, force: true }))
