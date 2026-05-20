'use strict'

const BLOCKED = ['require', 'module', 'exports', 'process', 'global', '__dirname', '__filename']

function runSnippet (code, globals) {
  const globalKeys = Object.keys(globals)
  const keys = [...globalKeys, ...BLOCKED]
  const values = [...globalKeys.map(k => globals[k]), ...BLOCKED.map(() => undefined)]
  // eslint-disable-next-line no-new-func
  const fn = new Function(...keys, `"use strict";\n${code}`)
  return fn(...values)
}

module.exports = { runSnippet, BLOCKED }
