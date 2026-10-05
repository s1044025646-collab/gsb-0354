# ptsim — 教学用两级页表地址翻译与访问权限诊断后端

纯后端（API + CLI），TypeScript + Node.js + SQLite（`node:sqlite`，无原生依赖、无外部服务）。
**仅模拟**：只维护项目内字节数组与元数据，不读真实进程内存、不改操作系统页表，无 TLB / 页置换 / 交换文件 / 硬件驱动。

## 地址格式（固定 16 位虚拟地址）

```
 15      12 11       8 7        0
+-----------+-----------+----------+
| 目录索引  | 页表索引  | 页内偏移 |
|  (4 位)   |  (4 位)   |  (8 位)  |
+-----------+-----------+----------+
```

- 页大小 256 字节；每地址空间 16 个目录项 × 16 个页表项。
- 物理内存为模拟页框数组（默认 256 个页框 × 256B = 64KB），页框号由调用者显式指定。
- 物理地址 = 页框号 × 256 + 页内偏移。虚拟地址绝不直接用作物理数组下标；未映射页访问一律报错，绝不返回全零冒充成功。

## 翻译与权限规则

1. 查目录项：不存在 → `ERR_DIR_NOT_PRESENT`（failAt=DIR）。
2. 目录权限：读需目录可读，写需目录可写。**父级只读时，子级可写不能放行写入** → `ERR_PERMISSION`（failAt=DIR）。
3. 查页表项：不存在 → `ERR_PTE_NOT_PRESENT`（failAt=PTE）；权限不足 → `ERR_PERMISSION`（failAt=PTE）。
4. 页框号越界 → `ERR_FRAME_OUT_OF_RANGE`（failAt=FRAME）。
5. 成功：返回物理地址；读置访问位 A，写置 A 与脏位 D。**纯预览（translate / preview）不置位**；失败访问不修改任何字节与标记。

每次翻译返回分解出的 `dirIndex / pteIndex / offset`、经过的条目、`steps` 逐级记录与具体失败位置 `failAt`。

## 空目录 / 空页表规则

- 新建地址空间的目录项与页表项全部 `present=0`，即“空”。
- 访问空目录下任意地址 → `ERR_DIR_NOT_PRESENT`；目录已配置但其下页未映射 → `ERR_PTE_NOT_PRESENT`。
- 系统**不自动修复**用户配置中的错误映射（如越界页框、权限矛盾），只在访问时如实诊断。

## 别名与独立性

- 同一或不同地址空间的多个虚拟页可映射同一物理页框（别名）。经一个别名写入，从其他别名可读。
- `unmap` 只清除该页表项，不擦除物理页框数据，不影响其他别名。
- 各地址空间的同名虚拟页相互独立，除非显式映射到同一页框。页框在 SQLite 中只存一份，别名关系重启后保留。

## 限制与校验

- 地址空间数量上限 16，物理页框 256（可在构造 Store 时调整，数据库 `meta` 表记录页框数）。
- 拒绝：负地址、超过 0xFFFF、非整数、非法权限（非布尔）、未按 256 对齐的映射基址、越界字节值（>255）、越界页框号。
- 映射可用 `vpn`（0..255）或 256 对齐的 `base` 指定，二者换算固定：`vpn = base / 256`。

## 事务边界

- 每个映射更新（`setDirEntry` / `map` / `unmap` / `setPtePerms`）在单个事务内提交，失败整体回滚。
- 每次读/写访问把页表项标记、页框数据与事件日志在同一事务内提交。
- 事件表 `events` 记录全部操作与访问结果（含失败原因与逐级步骤），可查询、可回放。

## 构建 / 测试 / 启动 / 演示

```powershell
npm install        # 仅安装 typescript 与 @types/node
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试（node:test）
npm start          # 启动 API；默认端口 0 = 自动选空闲端口，PORT=8080 可指定
npm run demo       # 运行演示：手算答案逐项核对（跨目录项、别名、父只读等）
```

数据目录为项目内 `data/`（默认 `data/ptsim.db`，可用环境变量 `PTSIM_DB` 覆盖）。

## API（JSON）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/spaces` `{id}` | 创建地址空间 |
| GET | `/spaces` | 列出地址空间 |
| PUT | `/spaces/:id/dir` `{idx,present,readable,writable,ptIndex?}` | 配置目录项 |
| PUT | `/spaces/:id/map` `{vpn\|base,frame,readable,writable}` | 映射虚拟页 |
| DELETE | `/spaces/:id/map` `{vpn\|base}` | 取消映射 |
| PATCH | `/spaces/:id/perms` `{vpn,readable,writable}` | 调整页权限 |
| POST | `/spaces/:id/read` `{addr,preview?}` | 读单字节 |
| POST | `/spaces/:id/write` `{addr,value,preview?}` | 写单字节 |
| POST | `/spaces/:id/translate` `{addr,access}` | 仅预览翻译（不置 A/D 位） |
| GET | `/spaces/:id/map` | 查询映射表 |
| POST | `/spaces/:id/replay` `{ops:[...]}` | 回放访问序列 |
| GET | `/frames/:n` | 物理页框摘要（非零字节数 + hex） |
| GET | `/events?space=&limit=` | 事件日志 |

错误统一返回 `{error: 错误码, message}`，HTTP 400。错误码：`ERR_VALIDATION`、`ERR_SPACE_NOT_FOUND`、`ERR_LIMIT_EXCEEDED`、`ERR_DIR_NOT_PRESENT`、`ERR_PTE_NOT_PRESENT`、`ERR_PERMISSION`、`ERR_FRAME_OUT_OF_RANGE`、`ERR_CONFLICT`。

## CLI（直接操作同一数据库）

```powershell
npm run build
node dist/src/cli.js create A
node dist/src/cli.js dir A 0 1 1 1        # 目录项0: present/r/w
node dist/src/cli.js map A 1 9 1 1        # vpn1 -> 页框9
node dist/src/cli.js write A 0x0124 0x42
node dist/src/cli.js read A 0x0124        # 打印逐级查表记录与物理地址
node dist/src/cli.js translate A 0x0124 write   # 纯预览
node dist/src/cli.js maptable A           # 十六进制映射表
node dist/src/cli.js frame 9              # 页框 hex 摘要
node dist/src/cli.js events A
```

## 项目结构

- `src/core.ts` — 纯内存两级页表引擎（翻译、权限、A/D 位）
- `src/store.ts` — SQLite 持久化、事务、事件日志、回放
- `src/server.ts` — HTTP API（`node:http`，无框架）
- `src/cli.ts` — 命令行演示工具
- `src/demo.ts` — 手算答案逐项核对的演示
- `test/simulator.test.ts` — 边界、诊断、别名、权限、回滚、重启一致性测试

## 限制说明

- 单字节读写为最小操作粒度，未实现批量读写接口（可用 replay 循环）。
- `node:sqlite` 在 Node 25 仍打印 ExperimentalWarning，属正常提示。
- 页框数量在数据库首次创建时固定，之后以数据库记录为准。
