import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

const root = new URL('.', import.meta.url)
const port = Number.parseInt(process.env.PROTOTYPE_PORT ?? '4177', 10)
const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
])

createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://prototype.local').pathname
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  if (relative.includes('..')) {
    response.writeHead(400).end('Bad request')
    return
  }

  try {
    const body = await readFile(join(root.pathname, relative))
    response.writeHead(200, {
      'content-type': types.get(extname(relative)) ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    response.end(body)
  } catch {
    response.writeHead(404).end('Not found')
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Brutalist Quartz prototype: http://127.0.0.1:${port}/?variant=A`)
})
