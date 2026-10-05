import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Store } from '../src/store';
import { SimError } from '../src/core';

const TMP = path.join(__dirname, '..', 'data', 'test.db');
function fresh(): Store {
  for (const s of ['', '-wal', '-shm']) fs.rmSync(TMP + s, { force: true });
  return new Store({ dbPath: TMP });
}

test('页边界前后读写', () => {
  const s = fresh();
  s.createSpace('A');
  s.setDirEntry('A', 0, { present: true, readable: true, writable: true });
  s.map('A', { vpn: 1, frame: 5, readable: true, writable: true });
  s.write('A', 0x01FF, 0x11); // 页内最后字节
  s.write('A', 0x0100, 0x22); // 页内第一字节
  assert.equal(s.read('A', 0x01FF).value, 0x11);
  assert.equal(s.read('A', 0x0100).value, 0x22);
  assert.equal(s.read('A', 0x0200).tr.error, 'ERR_PTE_NOT_PRESENT'); // 下一页未映射
  s.close();
});

test('目录缺失与叶项缺失诊断不同', () => {
  const s = fresh();
  s.createSpace('A');
  s.setDirEntry('A', 2, { present: true, readable: true, writable: true });
  assert.equal(s.read('A', 0x1000).tr.error, 'ERR_DIR_NOT_PRESENT');
  assert.equal(s.read('A', 0x1000).tr.failAt, 'DIR');
  assert.equal(s.read('A', 0x2000).tr.error, 'ERR_PTE_NOT_PRESENT');
  assert.equal(s.read('A', 0x2000).tr.failAt, 'PTE');
  s.close();
});

test('别名共享页框；取消一个别名不影响另一个与物理数据', () => {
  const s = fresh();
  s.createSpace('A'); s.createSpace('B');
  s.setDirEntry('A', 0, { present: true, readable: true, writable: true });
  s.setDirEntry('B', 0, { present: true, readable: true, writable: true });
  s.map('A', { vpn: 3, frame: 7, readable: true, writable: true });
  s.map('B', { vpn: 9, frame: 7, readable: true, writable: true }); // 跨空间别名
  s.write('A', 0x0342, 0x77);
  assert.equal(s.read('B', 0x0942).value, 0x77);
  s.unmap('A', { vpn: 3 });
  assert.equal(s.read('A', 0x0342).tr.error, 'ERR_PTE_NOT_PRESENT');
  assert.equal(s.read('B', 0x0942).value, 0x77); // 数据未被擦除
  s.close();
});

test('权限修改立即生效；父只读阻止子写；失败不留脏位', () => {
  const s = fresh();
  s.createSpace('A');
  s.setDirEntry('A', 1, { present: true, readable: true, writable: false });
  s.map('A', { vpn: 0x10, frame: 8, readable: true, writable: true });
  const w = s.write('A', 0x1000, 0x55);
  assert.equal(w.tr.error, 'ERR_PERMISSION');
  assert.equal(w.tr.failAt, 'DIR');
  assert.equal(s.translateOnly('A', 0x1000, 'read').pteEntry!.dirty, false);
  s.setDirEntry('A', 1, { present: true, readable: true, writable: true });
  assert.equal(s.write('A', 0x1000, 0x55).tr.ok, true);
  s.setPtePerms('A', 0x10, { readable: true, writable: false });
  assert.equal(s.write('A', 0x1000, 0x66).tr.error, 'ERR_PERMISSION');
  assert.equal(s.read('A', 0x1000).value, 0x55); // 未被失败写入修改
  s.close();
});

test('参数校验', () => {
  const s = fresh();
  s.createSpace('A');
  s.setDirEntry('A', 0, { present: true, readable: true, writable: true });
  assert.throws(() => s.read('A', -1), (e: SimError) => e.code === 'ERR_VALIDATION');
  assert.throws(() => s.read('A', 0x10000), (e: SimError) => e.code === 'ERR_VALIDATION');
  assert.throws(() => s.read('A', 1.5), (e: SimError) => e.code === 'ERR_VALIDATION');
  assert.throws(() => s.write('A', 0, 256), (e: SimError) => e.code === 'ERR_VALIDATION');
  assert.throws(() => s.map('A', { vpn: 1, frame: 999, readable: true, writable: true }), (e: SimError) => e.code === 'ERR_FRAME_OUT_OF_RANGE');
  assert.throws(() => s.map('A', { base: 0x0101, frame: 1, readable: true, writable: true }), (e: SimError) => e.code === 'ERR_VALIDATION');
  assert.throws(() => s.map('A', { vpn: 1, frame: 1, readable: 1 as any, writable: true }), (e: SimError) => e.code === 'ERR_VALIDATION');
  s.close();
});

test('失败操作事务回滚，不留部分状态', () => {
  const s = fresh();
  s.createSpace('A');
  s.setDirEntry('A', 0, { present: true, readable: true, writable: true });
  // 在已映射页上 setPtePerms 传非法权限 -> 事务内抛错 -> 回滚
  s.map('A', { vpn: 2, frame: 3, readable: true, writable: true });
  assert.throws(() => s.setPtePerms('A', 2, { readable: 'x' as any, writable: false }));
  const m = s.mappings('A').mappings.find(x => x.vpn === 2)!;
  assert.equal(m.writable, true); // 原权限未被破坏
  // 越界页框的 map 失败 -> 页项仍不存在
  assert.throws(() => s.map('A', { vpn: 4, frame: 9999, readable: true, writable: true }));
  assert.equal(s.read('A', 0x0400).tr.error, 'ERR_PTE_NOT_PRESENT');
  s.close();
});

test('重启后映射、别名共享与数据一致', () => {
  let s = fresh();
  s.createSpace('A'); s.createSpace('B');
  s.setDirEntry('A', 0, { present: true, readable: true, writable: true });
  s.setDirEntry('B', 0, { present: true, readable: true, writable: true });
  s.map('A', { vpn: 5, frame: 12, readable: true, writable: true });
  s.map('B', { vpn: 6, frame: 12, readable: true, writable: true });
  s.write('A', 0x0520, 0xE1);
  s.close();
  s = new Store({ dbPath: TMP }); // 模拟重启
  assert.equal(s.read('A', 0x0520).value, 0xE1);           // 数据持久
  s.write('B', 0x0620, 0xF2);                               // 经别名写入
  assert.equal(s.read('A', 0x0520).value, 0xF2);           // 共享关系保留，非复制
  assert.equal(s.read('A', 0x0600).tr.error, 'ERR_PTE_NOT_PRESENT'); // 各空间同名页独立
  s.close();
});

test('纯预览不置 A/D 位，成功访问置位', () => {
  const s = fresh();
  s.createSpace('A');
  s.setDirEntry('A', 0, { present: true, readable: true, writable: true });
  s.map('A', { vpn: 1, frame: 2, readable: true, writable: true });
  s.translateOnly('A', 0x0100, 'read');
  s.read('A', 0x0100, true);
  let pte = s.translateOnly('A', 0x0100, 'read').pteEntry!;
  assert.equal(pte.accessed, false);
  assert.equal(pte.dirty, false);
  s.read('A', 0x0100);
  pte = s.translateOnly('A', 0x0100, 'read').pteEntry!;
  assert.equal(pte.accessed, true);
  assert.equal(pte.dirty, false);
  s.write('A', 0x0100, 1);
  pte = s.translateOnly('A', 0x0100, 'read').pteEntry!;
  assert.equal(pte.dirty, true);
  s.close();
});
