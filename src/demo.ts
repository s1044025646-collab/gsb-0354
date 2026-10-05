// 演示脚本：跨目录项映射、同页不同偏移、别名共享页框、父目录只读阻止写入
// 每个场景先给出手算的独立答案，再与模拟器逐项核对
import { Store } from './store';
import { splitVA } from './core';
import * as assert from 'node:assert';

const store = new Store({ dbPath: ':memory:' });
const hex = (n: number, w = 4) => '0x' + n.toString(16).toUpperCase().padStart(w, '0');
let pass = 0;
function check(name: string, actual: unknown, expected: unknown) {
  assert.deepStrictEqual(actual, expected);
  console.log(`  ✔ ${name}: ${JSON.stringify(actual)}`);
  pass++;
}

// 手算函数：与实现无关的独立答案
function hand(va: number, frame: number) {
  const d = (va >> 12) & 0xF, p = (va >> 8) & 0xF, o = va & 0xFF;
  return { d, p, o, pa: frame * 256 + o };
}

console.log('== 场景1: 跨不同目录项的映射 + 同页不同偏移 ==');
store.createSpace('A');
store.setDirEntry('A', 0, { present: true, readable: true, writable: true });
store.setDirEntry('A', 3, { present: true, readable: true, writable: true });
store.map('A', { vpn: 0x02, frame: 10, readable: true, writable: true });   // 目录0
store.map('A', { vpn: 0x35, frame: 20, readable: true, writable: true });   // 目录3
const va1 = 0x02FF, va2 = 0x0200, va3 = 0x357A;
let h = hand(va1, 10);
check(`VA ${hex(va1)} 手算 目录/页项/偏移`, [h.d, h.p, h.o], [0, 2, 0xFF]);
check(`VA ${hex(va1)} 手算 物理地址`, hex(h.pa), hex(10 * 256 + 0xFF));
store.write('A', va1, 0xAB);
store.write('A', va2, 0xCD);
store.write('A', va3, 0x5A);
check('同页偏移0xFF读回', store.read('A', va1).value, 0xAB);
check('同页偏移0x00读回(页边界)', store.read('A', va2).value, 0xCD);
check('跨目录项 VA 0x357A 读回', store.read('A', va3).value, 0x5A);
h = hand(va3, 20);
check('0x357A 翻译物理地址', store.translateOnly('A', va3, 'read').pa, h.pa);

console.log('== 场景2: 两个虚拟页共享同一物理页框（别名） ==');
store.map('A', { vpn: 0x07, frame: 30, readable: true, writable: true });
store.map('A', { vpn: 0x39, frame: 30, readable: true, writable: true });
store.write('A', 0x0710, 0x66);
check('从另一别名 0x3910 读到同一字节', store.read('A', 0x3910).value, 0x66);
store.unmap('A', { vpn: 0x07 });
check('取消一个别名后访问报错', store.read('A', 0x0710).tr.error, 'ERR_PTE_NOT_PRESENT');
check('另一别名仍可读', store.read('A', 0x3910).value, 0x66);

console.log('== 场景3: 父目录只读阻止子级写入 ==');
store.setDirEntry('A', 5, { present: true, readable: true, writable: false }); // 目录只读
store.map('A', { vpn: 0x50, frame: 40, readable: true, writable: true });     // 子级可写
const w = store.write('A', 0x5000, 0x99);
check('写入被父级只读拒绝', [w.tr.ok, w.tr.error, w.tr.failAt], [false, 'ERR_PERMISSION', 'DIR']);
check('失败写入不置脏位', store.translateOnly('A', 0x5000, 'read').pteEntry!.dirty, false);
check('读取仍被允许', store.read('A', 0x5000).tr.ok, true);
store.setDirEntry('A', 5, { present: true, readable: true, writable: true });
check('目录改为可写后立即生效', store.write('A', 0x5000, 0x99).tr.ok, true);
check('脏位已置', store.translateOnly('A', 0x5000, 'read').pteEntry!.dirty, true);

console.log('== 场景4: 诊断区分 目录缺失 / 叶项缺失 / 预览不置位 ==');
store.setDirEntry('A', 8, { present: true, readable: true, writable: true }); // 目录在、页项不在
check('目录缺失诊断', store.read('A', 0x9000).tr.error, 'ERR_DIR_NOT_PRESENT');
check('叶项缺失诊断', store.read('A', 0x8000).tr.error, 'ERR_PTE_NOT_PRESENT');
const before = store.translateOnly('A', 0x3910, 'read').pteEntry!.accessed;
store.translateOnly('A', 0x3910, 'read'); // 纯预览
check('纯预览不改变访问位', store.translateOnly('A', 0x3910, 'read').pteEntry!.accessed, before);

console.log(`\n全部 ${pass} 项手算核对通过`);
store.close();
