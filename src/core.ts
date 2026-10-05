// 两级页表核心模拟器（纯内存逻辑，不触碰真实内存/硬件）
export const PAGE_SIZE = 256;          // 低 8 位页内偏移
export const DIR_ENTRIES = 16;         // 高 4 位
export const PT_ENTRIES = 16;          // 中间 4 位
export const VA_BITS = 16;

export type ErrorCode =
  | 'ERR_VALIDATION'        // 参数非法
  | 'ERR_SPACE_NOT_FOUND'
  | 'ERR_LIMIT_EXCEEDED'
  | 'ERR_DIR_NOT_PRESENT'   // 目录项不存在
  | 'ERR_PTE_NOT_PRESENT'   // 页表项不存在
  | 'ERR_PERMISSION'        // 权限拒绝（目录或页表项）
  | 'ERR_FRAME_OUT_OF_RANGE'// 物理页框越界
  | 'ERR_CONFLICT';

export class SimError extends Error {
  constructor(public code: ErrorCode, message: string) { super(message); }
}

export interface Perms { readable: boolean; writable: boolean; }

export interface DirEntry extends Perms {
  present: boolean;
  ptIndex: number; // 指向该地址空间第几张页表
}

export interface PtEntry extends Perms {
  present: boolean;
  frame: number;   // 物理页框号
  accessed: boolean;
  dirty: boolean;
}

export interface TranslateStep {
  level: 'DIR' | 'PTE' | 'FRAME';
  ok: boolean;
  detail: string;
}

export interface TranslateResult {
  va: number;
  dirIndex: number;
  pteIndex: number;
  offset: number;
  dirEntry: DirEntry | null;
  pteEntry: PtEntry | null;
  pa: number | null;          // 物理地址（成功时）
  ok: boolean;
  failAt: 'DIR' | 'PTE' | 'FRAME' | null;
  error: ErrorCode | null;
  steps: TranslateStep[];
}

export function splitVA(va: number) {
  return {
    dirIndex: (va >> 12) & 0xF,
    pteIndex: (va >> 8) & 0xF,
    offset: va & 0xFF,
  };
}

export function validateAddr(va: unknown): number {
  if (typeof va !== 'number' || !Number.isInteger(va) || va < 0 || va > 0xFFFF) {
    throw new SimError('ERR_VALIDATION', `地址必须是 0..0xFFFF 的整数，收到: ${va}`);
  }
  return va;
}

export function validateByte(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 0xFF) {
    throw new SimError('ERR_VALIDATION', `字节值必须是 0..255 的整数，收到: ${v}`);
  }
  return v;
}

export function validatePerms(p: any): Perms {
  if (!p || typeof p.readable !== 'boolean' || typeof p.writable !== 'boolean') {
    throw new SimError('ERR_VALIDATION', '权限必须形如 {readable:boolean, writable:boolean}');
  }
  return { readable: p.readable, writable: p.writable };
}

// 地址空间：独立页目录 + 16 张页表
export class AddressSpace {
  dir: DirEntry[] = [];
  tables: PtEntry[][] = [];
  constructor(public id: string) {
    for (let i = 0; i < DIR_ENTRIES; i++) {
      this.dir.push({ present: false, readable: false, writable: false, ptIndex: i });
      const t: PtEntry[] = [];
      for (let j = 0; j < PT_ENTRIES; j++) {
        t.push({ present: false, readable: false, writable: false, frame: 0, accessed: false, dirty: false });
      }
      this.tables.push(t);
    }
  }
}

export interface EngineOptions {
  frameCount: number;   // 物理页框数量
  maxSpaces: number;
}

export class Engine {
  spaces = new Map<string, AddressSpace>();
  frames: Uint8Array[] = [];
  constructor(public opts: EngineOptions) {
    for (let i = 0; i < opts.frameCount; i++) this.frames.push(new Uint8Array(PAGE_SIZE));
  }

  createSpace(id: string): AddressSpace {
    if (!id || typeof id !== 'string') throw new SimError('ERR_VALIDATION', '地址空间 id 必须是非空字符串');
    if (this.spaces.has(id)) throw new SimError('ERR_CONFLICT', `地址空间已存在: ${id}`);
    if (this.spaces.size >= this.opts.maxSpaces) throw new SimError('ERR_LIMIT_EXCEEDED', `地址空间数量已达上限 ${this.opts.maxSpaces}`);
    const s = new AddressSpace(id);
    this.spaces.set(id, s);
    return s;
  }

  getSpace(id: string): AddressSpace {
    const s = this.spaces.get(id);
    if (!s) throw new SimError('ERR_SPACE_NOT_FOUND', `地址空间不存在: ${id}`);
    return s;
  }

  validateFrame(frame: unknown): number {
    if (typeof frame !== 'number' || !Number.isInteger(frame) || frame < 0 || frame >= this.opts.frameCount) {
      throw new SimError('ERR_FRAME_OUT_OF_RANGE', `物理页框必须是 0..${this.opts.frameCount - 1} 的整数，收到: ${frame}`);
    }
    return frame;
  }

  // 逐级翻译；access='read'|'write'；commit=false 为纯预览，不置 accessed/dirty
  translate(space: AddressSpace, va: number, access: 'read' | 'write'): TranslateResult {
    validateAddr(va);
    const { dirIndex, pteIndex, offset } = splitVA(va);
    const steps: TranslateStep[] = [];
    const de = space.dir[dirIndex];
    const base: Omit<TranslateResult, 'ok' | 'failAt' | 'error'> = {
      va, dirIndex, pteIndex, offset, dirEntry: de, pteEntry: null, pa: null, steps,
    };
    if (!de.present) {
      steps.push({ level: 'DIR', ok: false, detail: `目录项[${dirIndex}] 不存在(present=0)` });
      return { ...base, ok: false, failAt: 'DIR', error: 'ERR_DIR_NOT_PRESENT' };
    }
    if (access === 'read' && !de.readable) {
      steps.push({ level: 'DIR', ok: false, detail: `目录项[${dirIndex}] 不可读` });
      return { ...base, ok: false, failAt: 'DIR', error: 'ERR_PERMISSION' };
    }
    if (access === 'write' && !de.writable) {
      steps.push({ level: 'DIR', ok: false, detail: `目录项[${dirIndex}] 只读，拒绝写入（父级只读不能被子级可写覆盖）` });
      return { ...base, ok: false, failAt: 'DIR', error: 'ERR_PERMISSION' };
    }
    steps.push({ level: 'DIR', ok: true, detail: `目录项[${dirIndex}] -> 页表 ${de.ptIndex}` });

    const pte = space.tables[de.ptIndex][pteIndex];
    base.pteEntry = pte;
    if (!pte.present) {
      steps.push({ level: 'PTE', ok: false, detail: `页表项[${pteIndex}] 不存在(present=0)` });
      return { ...base, ok: false, failAt: 'PTE', error: 'ERR_PTE_NOT_PRESENT' };
    }
    if (access === 'read' && !pte.readable) {
      steps.push({ level: 'PTE', ok: false, detail: `页表项[${pteIndex}] 不可读` });
      return { ...base, ok: false, failAt: 'PTE', error: 'ERR_PERMISSION' };
    }
    if (access === 'write' && !pte.writable) {
      steps.push({ level: 'PTE', ok: false, detail: `页表项[${pteIndex}] 不可写` });
      return { ...base, ok: false, failAt: 'PTE', error: 'ERR_PERMISSION' };
    }
    if (pte.frame >= this.opts.frameCount) {
      steps.push({ level: 'FRAME', ok: false, detail: `页框号 ${pte.frame} 越界(共 ${this.opts.frameCount})` });
      return { ...base, ok: false, failAt: 'FRAME', error: 'ERR_FRAME_OUT_OF_RANGE' };
    }
    const pa = pte.frame * PAGE_SIZE + offset;
    steps.push({ level: 'FRAME', ok: true, detail: `页框 ${pte.frame} + 偏移 0x${offset.toString(16).padStart(2, '0')} -> PA 0x${pa.toString(16).padStart(4, '0')}` });
    return { ...base, ok: true, failAt: null, error: null, pa };
  }

  readByte(space: AddressSpace, va: number, preview = false): { value: number | null; tr: TranslateResult } {
    const tr = this.translate(space, va, 'read');
    if (!tr.ok) return { value: null, tr };
    const value = this.frames[tr.pteEntry!.frame][tr.offset];
    if (!preview) tr.pteEntry!.accessed = true;
    return { value, tr };
  }

  writeByte(space: AddressSpace, va: number, value: number, preview = false): { tr: TranslateResult } {
    validateByte(value);
    const tr = this.translate(space, va, 'write');
    if (!tr.ok) return { tr };
    if (!preview) {
      this.frames[tr.pteEntry!.frame][tr.offset] = value;
      tr.pteEntry!.accessed = true;
      tr.pteEntry!.dirty = true;
    }
    return { tr };
  }
}
