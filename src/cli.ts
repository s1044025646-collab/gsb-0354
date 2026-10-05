// CLI：直接操作同一数据库，用逐级查表记录与十六进制地址表演示
import { Store } from './store';
import { splitVA, PAGE_SIZE } from './core';

const store = new Store({ dbPath: process.env.PTSIM_DB });
const [cmd, ...args] = process.argv.slice(2);
const hex = (n: number, w = 4) => '0x' + n.toString(16).toUpperCase().padStart(w, '0');
const num = (s: string) => (s?.startsWith('0x') ? parseInt(s, 16) : Number(s));

function showTr(tr: any) {
  const { dirIndex, pteIndex, offset } = splitVA(tr.va);
  console.log(`VA ${hex(tr.va)} = 目录[${dirIndex}] 页表项[${pteIndex}] 偏移[${hex(offset, 2)}]`);
  for (const s of tr.steps) console.log(`  [${s.level}] ${s.ok ? 'OK ' : '失败'} ${s.detail}`);
  console.log(tr.ok ? `  => 物理地址 ${hex(tr.pa!)}` : `  => 失败于 ${tr.failAt}: ${tr.error}`);
}

try {
  switch (cmd) {
    case 'create': console.log('已创建地址空间', store.createSpace(args[0]).id); break;
    case 'dir': // dir <space> <idx> <present0/1> <r0/1> <w0/1>
      console.log(store.setDirEntry(args[0], num(args[1]), { present: args[2] === '1', readable: args[3] === '1', writable: args[4] === '1' })); break;
    case 'map': // map <space> <vpn> <frame> <r> <w>
      console.log(store.map(args[0], { vpn: num(args[1]), frame: num(args[2]), readable: args[3] === '1', writable: args[4] === '1' })); break;
    case 'unmap': console.log(store.unmap(args[0], { vpn: num(args[1]) })); break;
    case 'perms': console.log(store.setPtePerms(args[0], num(args[1]), { readable: args[2] === '1', writable: args[3] === '1' })); break;
    case 'read': { const r = store.read(args[0], num(args[1])); showTr(r.tr); if (r.tr.ok) console.log(`  读到的字节: ${hex(r.value!, 2)}`); break; }
    case 'write': { const r = store.write(args[0], num(args[1]), num(args[2])); showTr(r.tr); break; }
    case 'translate': showTr(store.translateOnly(args[0], num(args[1]), (args[2] as any) ?? 'read')); break;
    case 'maptable': {
      const m = store.mappings(args[0]);
      console.log(`地址空间 ${m.space} 映射表 (页大小 ${PAGE_SIZE}B):`);
      console.log('VPN  | VA范围          | 页框 | R W | A D');
      for (const x of m.mappings)
        console.log(`${String(x.vpn).padStart(4)} | ${hex(x.vpn << 8)}-${hex((x.vpn << 8) + 255)} | ${String(x.frame).padStart(4)} | ${+x.readable} ${+x.writable} | ${+x.accessed} ${+x.dirty}`);
      break;
    }
    case 'frame': {
      const f = store.frameSummary(num(args[0]));
      console.log(`页框 ${f.frame}: 非零字节 ${f.nonZeroBytes}`);
      for (let i = 0; i < 256; i += 16) console.log(hex(i, 2) + ': ' + f.hex.slice(i * 2, i * 2 + 32).replace(/../g, '$& '));
      break;
    }
    case 'events': console.log(JSON.stringify(store.events(args[0]), null, 2)); break;
    default:
      console.log(`用法: node dist/src/cli.js <命令>
  create <space>                 创建地址空间
  dir <space> <idx> <p> <r> <w>  配置目录项(0/1)
  map <space> <vpn> <frame> <r> <w>   映射虚拟页到页框
  unmap <space> <vpn>            取消映射
  perms <space> <vpn> <r> <w>    调整页权限
  read <space> <addr>            读单字节(地址可十六进制 0x....)
  write <space> <addr> <value>   写单字节
  translate <space> <addr> [read|write]  仅预览翻译，不置 A/D 位
  maptable <space>               查看映射表
  frame <n>                      物理页框十六进制摘要
  events [space]                 查看事件日志`);
  }
} catch (e: any) {
  console.error(`错误 [${e.code ?? 'ERR'}]: ${e.message}`);
  process.exitCode = 1;
} finally {
  store.close();
}
