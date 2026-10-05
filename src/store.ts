// SQLite 持久化层：目录/页表/页框/事件，映射更新与访问结果按事务提交
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  Engine, EngineOptions, AddressSpace, SimError, TranslateResult,
  validateAddr, validateByte, validatePerms, splitVA, PAGE_SIZE,
} from './core';

export interface StoreOptions extends Partial<EngineOptions> {
  dbPath?: string; // ':memory:' 或文件路径
}

const DEFAULTS: EngineOptions = { frameCount: 256, maxSpaces: 16 };

export class Store {
  db: DatabaseSync;
  engine: Engine;
  opts: EngineOptions;

  constructor(o: StoreOptions = {}) {
    this.opts = { ...DEFAULTS, frameCount: o.frameCount ?? DEFAULTS.frameCount, maxSpaces: o.maxSpaces ?? DEFAULTS.maxSpaces };
    const dbPath = o.dbPath ?? path.join(process.cwd(), 'data', 'ptsim.db');
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS spaces(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS dir_entries(
        space TEXT, idx INTEGER, present INTEGER, readable INTEGER, writable INTEGER, pt_index INTEGER,
        PRIMARY KEY(space, idx));
      CREATE TABLE IF NOT EXISTS ptes(
        space TEXT, pt INTEGER, idx INTEGER, present INTEGER, readable INTEGER, writable INTEGER,
        frame INTEGER, accessed INTEGER, dirty INTEGER,
        PRIMARY KEY(space, pt, idx));
      CREATE TABLE IF NOT EXISTS frames(id INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE IF NOT EXISTS events(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT, space TEXT, op TEXT, va INTEGER, value INTEGER, ok INTEGER,
        error TEXT, detail TEXT);
    `);
    const fc = this.db.prepare(`SELECT v FROM meta WHERE k='frameCount'`).get() as any;
    if (fc) this.opts.frameCount = Number(fc.v);
    else this.db.prepare(`INSERT INTO meta(k,v) VALUES('frameCount',?)`).run(String(this.opts.frameCount));
    this.engine = new Engine(this.opts);
    this.load();
  }

  private load() {
    for (const r of this.db.prepare(`SELECT id FROM spaces`).all() as any[]) {
      this.engine.spaces.set(r.id, new AddressSpace(r.id));
    }
    for (const r of this.db.prepare(`SELECT * FROM dir_entries`).all() as any[]) {
      const s = this.engine.spaces.get(r.space); if (!s) continue;
      s.dir[r.idx] = { present: !!r.present, readable: !!r.readable, writable: !!r.writable, ptIndex: r.pt_index };
    }
    for (const r of this.db.prepare(`SELECT * FROM ptes`).all() as any[]) {
      const s = this.engine.spaces.get(r.space); if (!s) continue;
      s.tables[r.pt][r.idx] = {
        present: !!r.present, readable: !!r.readable, writable: !!r.writable,
        frame: r.frame, accessed: !!r.accessed, dirty: !!r.dirty,
      };
    }
    for (const r of this.db.prepare(`SELECT id, data FROM frames`).all() as any[]) {
      this.engine.frames[r.id] = new Uint8Array(r.data as Buffer);
    }
  }

  private saveDir(s: AddressSpace, idx: number) {
    const d = s.dir[idx];
    this.db.prepare(`INSERT OR REPLACE INTO dir_entries VALUES(?,?,?,?,?,?)`)
      .run(s.id, idx, +d.present, +d.readable, +d.writable, d.ptIndex);
  }
  private savePte(s: AddressSpace, pt: number, idx: number) {
    const p = s.tables[pt][idx];
    this.db.prepare(`INSERT OR REPLACE INTO ptes VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(s.id, pt, idx, +p.present, +p.readable, +p.writable, p.frame, +p.accessed, +p.dirty);
  }
  private saveFrame(id: number) {
    this.db.prepare(`INSERT OR REPLACE INTO frames(id,data) VALUES(?,?)`)
      .run(id, Buffer.from(this.engine.frames[id]));
  }
  private logEvent(space: string, op: string, va: number | null, value: number | null, ok: boolean, error: string | null, detail: string) {
    this.db.prepare(`INSERT INTO events(ts,space,op,va,value,ok,error,detail) VALUES(?,?,?,?,?,?,?,?)`)
      .run(new Date().toISOString(), space, op, va, value, +ok, error, detail);
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  createSpace(id: string) {
    return this.tx(() => {
      const s = this.engine.createSpace(id);
      this.db.prepare(`INSERT INTO spaces(id) VALUES(?)`).run(id);
      for (let i = 0; i < 16; i++) { this.saveDir(s, i); for (let j = 0; j < 16; j++) this.savePte(s, i, j); }
      this.logEvent(id, 'create_space', null, null, true, null, '');
      return s;
    });
  }

  // 配置目录项权限（present 由调用方给定；不自动修复错误配置）
  setDirEntry(spaceId: string, idx: number, cfg: { present: boolean; readable: boolean; writable: boolean; ptIndex?: number }) {
    if (!Number.isInteger(idx) || idx < 0 || idx > 15) throw new SimError('ERR_VALIDATION', '目录索引必须是 0..15');
    if (typeof cfg.present !== 'boolean') throw new SimError('ERR_VALIDATION', 'present 必须是布尔值');
    const perms = validatePerms(cfg);
    const ptIndex = cfg.ptIndex ?? idx;
    if (!Number.isInteger(ptIndex) || ptIndex < 0 || ptIndex > 15) throw new SimError('ERR_VALIDATION', '页表索引必须是 0..15');
    return this.tx(() => {
      const s = this.engine.getSpace(spaceId);
      s.dir[idx] = { present: cfg.present, ...perms, ptIndex };
      this.saveDir(s, idx);
      this.logEvent(spaceId, 'set_dir', null, null, true, null, JSON.stringify({ idx, ...s.dir[idx] }));
      return s.dir[idx];
    });
  }

  // 映射虚拟页：vpn (0..255) 或 256 对齐基址 base
  map(spaceId: string, arg: { vpn?: number; base?: number; frame: number; readable: boolean; writable: boolean }) {
    const perms = validatePerms(arg);
    const frame = this.engine.validateFrame(arg.frame);
    let vpn: number;
    if (arg.vpn !== undefined) {
      if (!Number.isInteger(arg.vpn) || arg.vpn < 0 || arg.vpn > 255) throw new SimError('ERR_VALIDATION', 'vpn 必须是 0..255');
      vpn = arg.vpn;
    } else if (arg.base !== undefined) {
      const b = validateAddr(arg.base);
      if (b % PAGE_SIZE !== 0) throw new SimError('ERR_VALIDATION', `映射基址必须按 ${PAGE_SIZE} 字节对齐，收到 0x${b.toString(16)}`);
      vpn = b / PAGE_SIZE;
    } else throw new SimError('ERR_VALIDATION', '必须提供 vpn 或 base');
    return this.tx(() => {
      const s = this.engine.getSpace(spaceId);
      const dirIndex = (vpn >> 4) & 0xF, pteIndex = vpn & 0xF;
      const ptIndex = s.dir[dirIndex].ptIndex;
      const pte = s.tables[ptIndex][pteIndex];
      Object.assign(pte, { present: true, ...perms, frame });
      this.savePte(s, ptIndex, pteIndex);
      this.logEvent(spaceId, 'map', null, null, true, null, JSON.stringify({ vpn, frame, ...perms }));
      return { vpn, dirIndex, pteIndex, ptIndex, pte };
    });
  }

  unmap(spaceId: string, arg: { vpn?: number; base?: number }) {
    let vpn: number;
    if (arg.vpn !== undefined) vpn = arg.vpn;
    else if (arg.base !== undefined) {
      const b = validateAddr(arg.base);
      if (b % PAGE_SIZE !== 0) throw new SimError('ERR_VALIDATION', '基址未对齐');
      vpn = b / PAGE_SIZE;
    } else throw new SimError('ERR_VALIDATION', '必须提供 vpn 或 base');
    if (!Number.isInteger(vpn) || vpn < 0 || vpn > 255) throw new SimError('ERR_VALIDATION', 'vpn 必须是 0..255');
    return this.tx(() => {
      const s = this.engine.getSpace(spaceId);
      const dirIndex = (vpn >> 4) & 0xF, pteIndex = vpn & 0xF;
      const ptIndex = s.dir[dirIndex].ptIndex;
      // 只清 present 与权限，不触碰物理页框数据，也不影响其他别名
      s.tables[ptIndex][pteIndex] = { present: false, readable: false, writable: false, frame: 0, accessed: false, dirty: false };
      this.savePte(s, ptIndex, pteIndex);
      this.logEvent(spaceId, 'unmap', null, null, true, null, JSON.stringify({ vpn }));
      return { vpn };
    });
  }

  setPtePerms(spaceId: string, vpn: number, perms: { readable: boolean; writable: boolean }) {
    const p = validatePerms(perms);
    if (!Number.isInteger(vpn) || vpn < 0 || vpn > 255) throw new SimError('ERR_VALIDATION', 'vpn 必须是 0..255');
    return this.tx(() => {
      const s = this.engine.getSpace(spaceId);
      const dirIndex = (vpn >> 4) & 0xF, pteIndex = vpn & 0xF;
      const ptIndex = s.dir[dirIndex].ptIndex;
      const pte = s.tables[ptIndex][pteIndex];
      if (!pte.present) throw new SimError('ERR_PTE_NOT_PRESENT', `vpn ${vpn} 未映射`);
      Object.assign(pte, p);
      this.savePte(s, ptIndex, pteIndex);
      this.logEvent(spaceId, 'set_pte_perms', null, null, true, null, JSON.stringify({ vpn, ...p }));
      return pte;
    });
  }

  read(spaceId: string, va: number, preview = false) {
    validateAddr(va);
    return this.tx(() => {
      const s = this.engine.getSpace(spaceId);
      const r = this.engine.readByte(s, va, preview);
      if (r.tr.ok && !preview) {
        this.savePte(s, s.dir[r.tr.dirIndex].ptIndex, r.tr.pteIndex);
        this.saveFrame(r.tr.pteEntry!.frame);
      }
      this.logEvent(spaceId, preview ? 'read_preview' : 'read', va, r.value, r.tr.ok, r.tr.error, JSON.stringify(r.tr.steps));
      return r;
    });
  }

  write(spaceId: string, va: number, value: number, preview = false) {
    validateAddr(va); validateByte(value);
    return this.tx(() => {
      const s = this.engine.getSpace(spaceId);
      const r = this.engine.writeByte(s, va, value, preview);
      if (r.tr.ok && !preview) {
        this.savePte(s, s.dir[r.tr.dirIndex].ptIndex, r.tr.pteIndex);
        this.saveFrame(r.tr.pteEntry!.frame);
      }
      this.logEvent(spaceId, preview ? 'write_preview' : 'write', va, value, r.tr.ok, r.tr.error, JSON.stringify(r.tr.steps));
      return r;
    });
  }

  translateOnly(spaceId: string, va: number, access: 'read' | 'write'): TranslateResult {
    const s = this.engine.getSpace(spaceId);
    return this.engine.translate(s, validateAddr(va), access); // 纯预览，不置位、不落库
  }

  mappings(spaceId: string) {
    const s = this.engine.getSpace(spaceId);
    const out: any[] = [];
    for (let d = 0; d < 16; d++) {
      const de = s.dir[d];
      for (let p = 0; p < 16; p++) {
        const pte = s.tables[de.ptIndex][p];
        if (pte.present) out.push({ vpn: (d << 4) | p, dirIndex: d, pteIndex: p, ...pte });
      }
    }
    return { space: spaceId, dir: s.dir, mappings: out };
  }

  frameSummary(id: number) {
    this.engine.validateFrame(id);
    const f = this.engine.frames[id];
    let nonZero = 0;
    for (const b of f) if (b !== 0) nonZero++;
    return { frame: id, nonZeroBytes: nonZero, hex: Buffer.from(f).toString('hex') };
  }

  events(spaceId?: string, limit = 100) {
    const q = spaceId
      ? this.db.prepare(`SELECT * FROM events WHERE space=? ORDER BY id DESC LIMIT ?`).all(spaceId, limit)
      : this.db.prepare(`SELECT * FROM events ORDER BY id DESC LIMIT ?`).all(limit);
    return q;
  }

  // 回放：按顺序执行一批访问，返回每步结果（用于演示与测试）
  replay(spaceId: string, ops: { op: 'read' | 'write'; addr: number; value?: number; preview?: boolean }[]) {
    return ops.map(o => o.op === 'read'
      ? { op: o, ...this.read(spaceId, o.addr, o.preview) }
      : { op: o, ...this.write(spaceId, o.addr, o.value!, o.preview) });
  }

  close() { this.db.close(); }
}
