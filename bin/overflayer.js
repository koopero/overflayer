#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')
const { program } = require('commander')

const Overflayer = require('..')

program
  .name('overflayer')
  .description('Persistent runtime layer for Mineflayer with hot-reloading snippets')
  .argument('[config]', 'Path to YAML config file', 'config.yaml')
  .parse(process.argv)

const configPath = path.resolve(process.cwd(), program.processedArgs[0])

let config
try {
  config = yaml.load(fs.readFileSync(configPath, 'utf8'))
} catch (err) {
  console.error(`Failed to read config ${configPath}: ${err.message}`)
  process.exit(1)
}

const server = config.server || {}
const players = Array.isArray(config.players) ? config.players : []
if (players.length === 0) {
  console.error(`Config ${configPath} has no players.`)
  process.exit(1)
}

let mineflayer
try {
  mineflayer = require('mineflayer')
} catch (_) {
  console.error('Error: mineflayer is not installed. Run `npm install mineflayer` in your project.')
  process.exit(1)
}

let pathfinderPlugin = null
try { pathfinderPlugin = require('mineflayer-pathfinder').pathfinder } catch (_) {}

const ts = () => new Date().toISOString()
const tag = (name) => `[${ts()}] (${name})`

const sessions = []

for (const p of players) {
  if (!p.username) {
    console.error(`Skipping player with no username: ${JSON.stringify(p)}`)
    continue
  }
  sessions.push(startPlayer(p))
}

function startPlayer (p) {
  const debounce = p.debounce ?? server.debounce ?? 300
  const bot = mineflayer.createBot({
    host: p.host ?? server.host ?? 'localhost',
    port: p.port ?? server.port ?? 25565,
    username: p.username,
    auth: p.auth ?? server.auth ?? 'offline',
    version: (p.version ?? server.version) === 'auto' ? undefined : (p.version ?? server.version)
  })

  if (pathfinderPlugin) {
    try { bot.loadPlugin(pathfinderPlugin) } catch (err) {
      console.error(`${tag(p.username)} failed to load pathfinder plugin: ${err.message}`)
    }
  }

  const ov = new Overflayer(bot, {
    watchDebounce: debounce,
    errorHandler: (id, err) => {
      console.error(`${tag(p.username)} error  ${id ?? '-'}: ${err && err.stack ? err.stack : err}`)
    }
  })

  ov.on('load',         (id, src) => console.log(`${tag(p.username)} load   ${id} ← ${src}`))
  ov.on('unload',       (id)      => console.log(`${tag(p.username)} unload ${id}`))
  ov.on('reload',       (id, src) => console.log(`${tag(p.username)} reload ${id} ← ${src}`))
  ov.on('watch:add',    (id, fp)  => console.log(`${tag(p.username)} +file  ${id} (${fp})`))
  ov.on('watch:change', (id, fp)  => console.log(`${tag(p.username)} ~file  ${id} (${fp})`))
  ov.on('watch:remove', (id, fp)  => console.log(`${tag(p.username)} -file  ${id} (${fp})`))
  ov.on('report', (id, payload) => {
    const s = typeof payload === 'string' ? payload : JSON.stringify(payload)
    console.log(`${tag(p.username)} report ${id}: ${s}`)
  })

  bot.on('error',  (err)    => console.error(`${tag(p.username)} bot error:`, err && err.message ? err.message : err))
  bot.on('kicked', (reason) => console.error(`${tag(p.username)} kicked:`, reason))
  bot.on('end',    (reason) => console.log(`${tag(p.username)} end:`, reason))

  bot.once('spawn', async () => {
    console.log(`${tag(p.username)} spawned`)
    for (const file of p.load || []) {
      try {
        const id = path.basename(file, path.extname(file))
        await ov.load(id, file)
      } catch (err) {
        console.error(`${tag(p.username)} failed to load ${file}: ${err.message}`)
      }
    }
    for (const dir of p.watch || []) {
      try { ov.watch(dir); console.log(`${tag(p.username)} watching ${dir}`) }
      catch (err) { console.error(`${tag(p.username)} failed to watch ${dir}: ${err.message}`) }
    }
  })

  return { bot, ov, name: p.username }
}

async function shutdown (signal) {
  console.log(`[${ts()}] received ${signal}, shutting down ${sessions.length} session(s)`)
  await Promise.all(sessions.map(async (s) => {
    try { await s.ov.close() } catch (_) {}
    try { s.bot.quit() } catch (_) {}
  }))
  setTimeout(() => process.exit(0), 250).unref()
}

process.on('SIGINT',  () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
