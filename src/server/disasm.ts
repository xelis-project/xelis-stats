// Xelis VM (XVM) bytecode disassembler.
//
// Turns the compiled `get_contract_module` payload into a flat, readable
// opcode listing: per-chunk instructions with resolved operands, jump/iterator
// labels, constant annotations and raw syscall ids.
//
// The operand layouts mirror xelis-vm `bytecode/src/opcode.rs` and the
// reference `assembler/src/disassembler.rs` (`OpCodeWithArgs`). This is a
// straight disassembler only: it never tries to reconstruct Silex source, and
// it tolerates unknown opcodes / truncated operands so every stored module
// renders something instead of throwing.

type ArgKind = "u8" | "u16" | "u32" | "addr" | "type" | "chunk" | "syscall";

type OpSpec = { name: string; args: ArgKind[] };

// Index == opcode byte (see xelis-vm `bytecode/src/opcode.rs`).
const OPS: OpSpec[] = [
  { name: "CONSTANT", args: ["u16"] }, // 0
  { name: "MEMORY_LOAD", args: ["u16"] }, // 1
  { name: "MEMORY_SET", args: ["u16"] }, // 2
  { name: "MEMORY_POP", args: [] }, // 3
  { name: "MEMORY_LEN", args: [] }, // 4
  { name: "MEMORY_TO_OWNED", args: ["u16"] }, // 5
  { name: "SUBLOAD", args: ["u8"] }, // 6
  { name: "POP", args: [] }, // 7
  { name: "POP_N", args: ["u8"] }, // 8
  { name: "COPY", args: [] }, // 9
  { name: "COPY_N", args: ["u8"] }, // 10
  { name: "TO_OWNED", args: [] }, // 11
  { name: "SWAP", args: ["u8"] }, // 12
  { name: "SWAP2", args: ["u8", "u8"] }, // 13
  { name: "JUMP", args: ["addr"] }, // 14
  { name: "JUMP_IF_FALSE", args: ["addr"] }, // 15
  { name: "ITERABLE_LENGTH", args: [] }, // 16
  { name: "ITERATOR_BEGIN", args: [] }, // 17
  { name: "ITERATOR_NEXT", args: ["addr"] }, // 18
  { name: "ITERATOR_END", args: [] }, // 19
  { name: "RETURN", args: [] }, // 20
  { name: "ARRAY_CALL", args: [] }, // 21
  { name: "CAST", args: ["type"] }, // 22
  { name: "INVOKE_CHUNK", args: ["chunk", "u8"] }, // 23
  { name: "SYS_CALL", args: ["syscall"] }, // 24
  { name: "NEW_OBJECT", args: ["u8"] }, // 25
  { name: "NEW_RANGE", args: [] }, // 26
  { name: "NEW_MAP", args: ["u8"] }, // 27
  { name: "ADD", args: [] }, // 28
  { name: "SUB", args: [] }, // 29
  { name: "MUL", args: [] }, // 30
  { name: "DIV", args: [] }, // 31
  { name: "MOD", args: [] }, // 32
  { name: "POW", args: [] }, // 33
  { name: "AND", args: [] }, // 34
  { name: "OR", args: [] }, // 35
  { name: "BITWISE_AND", args: [] }, // 36
  { name: "BITWISE_OR", args: [] }, // 37
  { name: "BITWISE_XOR", args: [] }, // 38
  { name: "BITWISE_SHL", args: [] }, // 39
  { name: "BITWISE_SHR", args: [] }, // 40
  { name: "EQ", args: [] }, // 41
  { name: "NEG", args: [] }, // 42
  { name: "GT", args: [] }, // 43
  { name: "LT", args: [] }, // 44
  { name: "GTE", args: [] }, // 45
  { name: "LTE", args: [] }, // 46
  { name: "ASSIGN", args: [] }, // 47
  { name: "ASSIGN_ADD", args: [] }, // 48
  { name: "ASSIGN_SUB", args: [] }, // 49
  { name: "ASSIGN_MUL", args: [] }, // 50
  { name: "ASSIGN_DIV", args: [] }, // 51
  { name: "ASSIGN_MOD", args: [] }, // 52
  { name: "ASSIGN_POW", args: [] }, // 53
  { name: "ASSIGN_AND", args: [] }, // 54
  { name: "ASSIGN_OR", args: [] }, // 55
  { name: "ASSIGN_XOR", args: [] }, // 56
  { name: "ASSIGN_SHL", args: [] }, // 57
  { name: "ASSIGN_SHR", args: [] }, // 58
  { name: "INC", args: [] }, // 59
  { name: "DEC", args: [] }, // 60
  { name: "FLATTEN", args: [] }, // 61
  { name: "MATCH", args: ["u8", "addr"] }, // 62
  { name: "DYNAMIC_CALL", args: ["u8"] }, // 63
  { name: "CAPTURE_CONTEXT", args: [] }, // 64
];

// Primitive type ids used by CAST (xelis-vm `types/src/types/mod.rs`).
const TYPE_NAMES = ["u8", "u16", "u32", "u64", "u128", "u256", "bool", "string"];

type DecodedArg = { kind: ArgKind; value: number };

type DecodedOp = {
  addr: number;
  size: number;
  name: string;
  args: DecodedArg[];
  unknown?: number;
  truncated?: boolean;
};

export type DisasmChunk = {
  index: number;
  access: string;
  bytes: number;
  instructions: number;
  labels: number;
  lines: string;
  error?: string;
};

export type Disasm = {
  ok: boolean;
  version: string;
  chunks: DisasmChunk[];
  constants: string[];
  error?: string;
};

function toBytes(instructions: unknown): Uint8Array | null {
  if (typeof instructions === "string") {
    const clean = instructions.replace(/[^0-9a-fA-F]/g, "");
    const n = clean.length >> 1;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  if (Array.isArray(instructions)) return Uint8Array.from(instructions.map((v) => Number(v) & 0xff));
  return null;
}

function decodeChunk(bytes: Uint8Array): { ops: DecodedOp[]; error?: string } {
  const ops: DecodedOp[] = [];
  let ip = 0;
  const len = bytes.length;
  while (ip < len) {
    const start = ip;
    const opcode = bytes[ip++];
    const spec = OPS[opcode];
    if (!spec) {
      ops.push({ addr: start, size: ip - start, name: "INVALID", args: [], unknown: opcode });
      continue;
    }
    const args: DecodedArg[] = [];
    let truncated = false;
    for (const kind of spec.args) {
      const size = kind === "u8" || kind === "type" ? 1 : kind === "u16" || kind === "chunk" || kind === "syscall" ? 2 : 4;
      if (ip + size > len) {
        truncated = true;
        ip = len;
        break;
      }
      let value: number;
      if (size === 1) value = bytes[ip];
      else if (size === 2) value = bytes[ip] | (bytes[ip + 1] << 8);
      else value = (bytes[ip] | (bytes[ip + 1] << 8) | (bytes[ip + 2] << 16) | (bytes[ip + 3] << 24)) >>> 0;
      ip += size;
      args.push({ kind, value });
    }
    ops.push({ addr: start, size: ip - start, name: spec.name, args, truncated });
    if (truncated) break;
  }
  return { ops };
}

function hex4(n: number): string {
  return n.toString(16).padStart(4, "0");
}

function renderConstant(value: unknown): string {
  try {
    if (value === null || value === undefined) return "null";
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (typeof value !== "object") return String(value);
    const cell = value as Record<string, unknown>;
    const type = cell.type;
    if (type === "primitive" && cell.value && typeof cell.value === "object") {
      const p = cell.value as Record<string, unknown>;
      if (p.type === "string") return JSON.stringify(p.value);
      if (p.type === "boolean") return String(p.value);
      if (p.type === "null") return "null";
      return String(p.value);
    }
    const json = JSON.stringify(cell.value ?? cell);
    const s = json === undefined ? String(value) : json;
    return s.length > 72 ? `${s.slice(0, 69)}…` : s;
  } catch {
    return String(value);
  }
}

function accessLabel(chunk: Record<string, unknown>): string {
  const type = String(chunk.type ?? "");
  const value = (chunk.value ?? {}) as Record<string, unknown>;
  if (type === "hook") return `hook ${Number(value.id ?? 0)}`;
  if (type === "entry") return "entry";
  if (type === "all") return "public";
  if (type === "internal") return "internal";
  return type || "unknown";
}

function renderChunk(ops: DecodedOp[], constants: string[]): { lines: string; labelCount: number } {
  // Jump / iterator / match targets become per-chunk labels.
  const targets = new Set<number>();
  for (const op of ops) for (const a of op.args) if (a.kind === "addr") targets.add(a.value);
  const labelOf = new Map<number, string>();
  let n = 0;
  for (const addr of Array.from(targets).sort((a, b) => a - b)) labelOf.set(addr, `L${n++}`);

  const out: string[] = [];
  for (const op of ops) {
    const label = labelOf.get(op.addr);
    if (label) out.push(`${label}:`);
    const rendered = op.args.map((a) => {
      switch (a.kind) {
        case "addr": return labelOf.get(a.value) ?? String(a.value);
        case "type": return TYPE_NAMES[a.value] ?? `type#${a.value}`;
        case "chunk": return `#${a.value}`;
        default: return String(a.value);
      }
    });
    let comment = "";
    if (op.truncated) {
      comment = "  ; truncated operand";
    } else if (op.unknown !== undefined) {
      comment = `  ; unknown opcode 0x${op.unknown.toString(16).padStart(2, "0")}`;
    } else if (op.name === "CONSTANT") {
      const idx = op.args[0]?.value;
      const c = idx !== undefined ? constants[idx] : undefined;
      if (c !== undefined) comment = `  ; ${c}`;
    }
    const operands = rendered.join(", ");
    out.push(`${hex4(op.addr)}  ${op.name.padEnd(16)}${operands}${comment}`.trimEnd());
  }
  return { lines: out.join("\n"), labelCount: labelOf.size };
}

export function disassembleModule(raw: unknown): Disasm {
  const empty: Disasm = { ok: false, version: "", chunks: [], constants: [] };
  if (!raw || typeof raw !== "object") return empty;
  const root = raw as Record<string, unknown>;
  // `get_contract_module` returns { module, version }; accept a bare module too.
  const module = (root.module ?? root) as Record<string, unknown>;
  const version = typeof root.version === "string" ? root.version : "";

  const rawConstants = Array.isArray(module.constants) ? module.constants : [];
  const constants = rawConstants.map(renderConstant);

  const rawChunks = Array.isArray(module.chunks) ? module.chunks : [];
  const chunks: DisasmChunk[] = rawChunks.map((entry, index) => {
    const c = (entry ?? {}) as Record<string, unknown>;
    const access = accessLabel(c);
    const bytes = toBytes(c.instructions);
    if (!bytes) return { index, access, bytes: 0, instructions: 0, labels: 0, lines: "", error: "unreadable instructions" };
    const { ops } = decodeChunk(bytes);
    const { lines, labelCount } = renderChunk(ops, constants);
    return { index, access, bytes: bytes.length, instructions: ops.length, labels: labelCount, lines };
  });

  return { ok: chunks.length > 0, version, chunks, constants };
}
