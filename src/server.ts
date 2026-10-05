// HTTP API（node:http，无外部依赖）。默认端口 0 = 自动选空闲端口。
import * as http from 'node:http';
import { Store } from './store';
import { SimError } from './core';

function json(res: http.ServerResponse, code: number, body: unknown) {
  const s = JSON.stringify(body, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(s);
}

async function body(req: http.IncomingMessage): Promise<any> {
  let data = '';
  for await (const c of req) data += c;
  return data ? JSON.parse(data) : {};
}

export function createServer(store: Store) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      const b = req.method === 'GET' ? Object.fromEntries(url.searchParams) : await body(req);
      const num = (v: any) => (typeof v === 'string' && v !== '' ? Number(v) : v);

      if (req.method === 'POST' && parts[0] === 'spaces' && parts.length === 1)
        return json(res, 201, { id: store.createSpace(b.id).id });
      if (req.method === 'GET' && parts[0] === 'spaces' && parts.length === 1)
        return json(res, 200, { spaces: [...store.engine.spaces.keys()] });

      const spaceId = parts[1];
      if (parts[0] === 'spaces' && parts.length >= 3) {
        const sub = parts[2];
        if (req.method === 'PUT' && sub === 'dir')
          return json(res, 200, store.setDirEntry(spaceId, num(b.idx), b));
        if (req.method === 'PUT' && sub === 'map')
          return json(res, 200, store.map(spaceId, b));
        if (req.method === 'DELETE' && sub === 'map')
          return json(res, 200, store.unmap(spaceId, b));
        if (req.method === 'PATCH' && sub === 'perms')
          return json(res, 200, store.setPtePerms(spaceId, num(b.vpn), b));
        if (req.method === 'POST' && sub === 'read')
          return json(res, 200, store.read(spaceId, num(b.addr), !!b.preview));
        if (req.method === 'POST' && sub === 'write')
          return json(res, 200, store.write(spaceId, num(b.addr), num(b.value), !!b.preview));
        if (req.method === 'POST' && sub === 'translate')
          return json(res, 200, store.translateOnly(spaceId, num(b.addr), b.access ?? 'read'));
        if (req.method === 'GET' && sub === 'map')
          return json(res, 200, store.mappings(spaceId));
        if (req.method === 'POST' && sub === 'replay')
          return json(res, 200, store.replay(spaceId, b.ops));
      }
      if (req.method === 'GET' && parts[0] === 'frames' && parts.length === 2)
        return json(res, 200, store.frameSummary(Number(parts[1])));
      if (req.method === 'GET' && parts[0] === 'events')
        return json(res, 200, store.events(b.space, num(b.limit) ?? 100));
      return json(res, 404, { error: 'ERR_NOT_FOUND', message: url.pathname });
    } catch (e: any) {
      if (e instanceof SimError) return json(res, 400, { error: e.code, message: e.message });
      return json(res, 500, { error: 'ERR_INTERNAL', message: String(e?.message ?? e) });
    }
  });
}

if (require.main === module) {
  const store = new Store({ dbPath: process.env.PTSIM_DB });
  const port = process.env.PORT ? Number(process.env.PORT) : 0; // 0 = 空闲端口
  const srv = createServer(store);
  srv.listen(port, () => {
    const a = srv.address() as any;
    console.log(`ptsim API 已启动: http://127.0.0.1:${a.port}  (数据库: ${process.env.PTSIM_DB ?? 'data/ptsim.db'})`);
  });
}
