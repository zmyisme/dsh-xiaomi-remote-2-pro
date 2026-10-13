import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function readJson(relativePath) {
  return JSON.parse(await readFile(resolve(ROOT, relativePath), 'utf8'))
}

async function exists(relativePath) {
  try {
    await stat(resolve(ROOT, relativePath))
    return true
  } catch {
    return false
  }
}

test('package.json 的 dsh 清单形状符合 loader 的解析规则', async () => {
  const pkg = await readJson('package.json')

  assert.equal(pkg.name, 'dsh-xiaomi-remote-2-pro')
  assert.equal(pkg.type, 'module', '宿主半区是 ESM')
  assert.equal(pkg.main, 'host.js')
  assert.ok(pkg.dsh, '必须声明 dsh 清单')

  // bundle：profile 靠它把本插件插进配置树
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')

  // client：声明了 dsh.client 就必须提供 exports["./client"]，否则启动即抛错
  assert.ok(pkg.dsh.client, '需要 dsh.client 才能有浏览器侧 UI')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(Array.isArray(pkg.dsh.client.inject))
  assert.equal(pkg.exports['./client'], './client.js')
  assert.equal(pkg.exports['.'], './host.js')
})

test('清单里提到的文件都真实存在', async () => {
  const pkg = await readJson('package.json')
  for (const file of pkg.files) {
    assert.equal(await exists(file), true, `files 里声明的 ${file} 不存在`)
  }
  for (const target of Object.values(pkg.exports)) {
    assert.equal(await exists(target), true, `exports 指向的 ${target} 不存在`)
  }
  assert.equal(await exists(pkg.dsh.bundle.patch), true)
})

test('cordis.patch.yml 的 id 与 host.js 导出的 name 一致', async () => {
  const patch = await readFile(resolve(ROOT, 'cordis.patch.yml'), 'utf8')
  const pkg = await readJson('package.json')

  const idMatch = /-\s*insert:\s*\n\s*-\s*id:\s*([^\s]+)/.exec(patch)
  assert.ok(idMatch, 'patch 必须是 - insert: 形状')

  const nameMatch = /-\s*id:\s*([^\s]+)\s*\n\s*name:\s*([^\s]+)/.exec(patch)
  assert.ok(nameMatch, 'insert 行必须同时声明 id 与 name')
  assert.equal(nameMatch[2], pkg.name, 'name 必须是包名')

  const host = await readFile(resolve(ROOT, 'host.js'), 'utf8')
  const exportedName = /export const name = '([^']+)'/.exec(host)
  assert.ok(exportedName, 'host.js 必须导出 name')
  assert.equal(exportedName[1], nameMatch[1], 'host.js 的 name 必须等于 patch 里的 id')
})

test('客户端半区是 Lane 1（Module Loader 包）形状', async () => {
  const client = await readFile(resolve(ROOT, 'client.js'), 'utf8')
  const pkg = await readJson('package.json')

  const loaderMatch = /window\.__ModuleLoader__\.load\(\{\s*\n\s*id:\s*'([^']+)'/.exec(client)
  assert.ok(loaderMatch, 'client.js 必须调用 window.__ModuleLoader__.load({ id, factory })')
  assert.equal(loaderMatch[1], pkg.name, 'loader 的 id 必须等于包名（loader 会强制校验）')
  assert.match(client, /factory:\s*\(require\)\s*=>/)
  assert.match(client, /exports\.name = name/)
  assert.match(client, /exports\.apply = apply/)
  assert.match(client, /exports\.Config = Config/)
})

test('两个半区都没有引入需要构建或原生的依赖', async () => {
  const host = await readFile(resolve(ROOT, 'host.js'), 'utf8')
  const client = await readFile(resolve(ROOT, 'client.js'), 'utf8')
  const pkg = await readJson('package.json')

  assert.equal(pkg.dependencies, undefined, '运行时零依赖，装完即用')
  assert.equal(pkg.devDependencies, undefined, '不需要构建工具链')

  // 宿主侧只允许 node: 内置模块
  const imports = [...host.matchAll(/from '([^']+)'/g)].map((match) => match[1])
  for (const specifier of imports) {
    assert.ok(
      specifier.startsWith('./') || specifier.startsWith('node:'),
      `host.js 不应依赖外部包：${specifier}`,
    )
  }
  // 客户端侧只能 require 白名单里的模块
  const requires = [...client.matchAll(/require\(["']([^"']+)["']\)/g)].map((match) => match[1])
  for (const specifier of requires) {
    assert.equal(specifier, 'react', `client.js 只能 require react，收到 ${specifier}`)
  }
  assert.doesNotMatch(host, /from 'koffi'/, '不使用原生 FFI')
})

test('host.js 的 PLUGIN_VERSION 与 package.json 的版本一致', async () => {
  const pkg = await readJson('package.json')
  const host = await readFile(resolve(ROOT, 'host.js'), 'utf8')
  const match = /export const PLUGIN_VERSION = '([^']+)'/.exec(host)
  assert.ok(match, 'host.js 必须导出 PLUGIN_VERSION')
  assert.equal(match[1], pkg.version, '版本号必须与 package.json 一致')
})

test('README 与 LICENSE 就位', async () => {
  assert.equal(await exists('README.md'), true)
  assert.equal(await exists('LICENSE'), true)
  const license = await readFile(resolve(ROOT, 'LICENSE'), 'utf8')
  assert.match(license, /MIT License/)
})
