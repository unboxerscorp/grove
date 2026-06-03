import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api, targetNode } from "../api";
import type { AuditEvent } from "../api";
import { AGENTS, agentGlyph, COLUMNS, cx, statusColor } from "../constants";
import { statusLabel, useI18n } from "../i18n";
import type { TFn } from "../i18n";
import type { OrgNode } from "../types";
import { useFocusTrap } from "../useFocusTrap";

// ---------------------------------------------------------------------------
// Canvas geometry + helpers
// ---------------------------------------------------------------------------
const NODE_W = 172;
const NODE_H = 96;
const GAP_X = 200;
const GAP_Y = 152;
const PAD = 52;
const GROUP_R = 156; // proximity radius (px, center-to-center) for grouping
const TWEEN_MS = 360;

const GROUP_PALETTE = ["var(--teal)", "var(--amber)", "var(--blue)", "var(--coral)", "#c9a6ff", "#5fd0e0"];
const PRIORITIES = ["low", "normal", "high"] as const;

type XY = { x: number; y: number };
type Positions = Record<string, XY>;

function statusClass(status: string): string {
  switch (status) {
    case "running":
      return "is-running";
    case "error":
      return "is-error";
    case "done":
      return "is-done";
    default:
      return "is-idle";
  }
}

/** Tidy top-down layout: leaves get sequential x-slots, parents centre over kids. */
function computeLayout(names: string[], roots: string[], childrenOf: (n: string) => string[]) {
  const slot: Record<string, number> = {};
  const depth: Record<string, number> = {};
  const placed = new Set<string>();
  let cursor = 0;

  function place(name: string, d: number): number {
    if (placed.has(name)) return slot[name]!;
    placed.add(name);
    depth[name] = d;
    const kids = childrenOf(name).filter((k) => !placed.has(k));
    let s: number;
    if (kids.length === 0) {
      s = cursor++;
    } else {
      const xs = kids.map((k) => place(k, d + 1));
      s = (xs[0]! + xs[xs.length - 1]!) / 2;
    }
    slot[name] = s;
    return s;
  }

  for (const r of roots) place(r, 0);
  for (const n of names) if (!placed.has(n)) place(n, 0);

  const positions: Positions = {};
  let maxX = 0;
  let maxY = 0;
  for (const n of names) {
    const x = PAD + (slot[n] ?? 0) * GAP_X;
    const y = PAD + (depth[n] ?? 0) * GAP_Y;
    positions[n] = { x, y };
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { positions, width: maxX + NODE_W + PAD, height: maxY + NODE_H + PAD };
}

function descendantsOf(name: string, childrenOf: (n: string) => string[]): Set<string> {
  const acc = new Set<string>();
  const stack = [...childrenOf(name)];
  while (stack.length) {
    const x = stack.pop()!;
    if (acc.has(x)) continue;
    acc.add(x);
    for (const k of childrenOf(x)) stack.push(k);
  }
  return acc;
}

/** Vertical S-curve from a parent's bottom-centre to a child's top-centre. */
function edgePath(a: XY, b: XY): string {
  const sx = a.x + NODE_W / 2;
  const sy = a.y + NODE_H;
  const ex = b.x + NODE_W / 2;
  const ey = b.y;
  const my = (sy + ey) / 2;
  return `M ${sx} ${sy} C ${sx} ${my}, ${ex} ${my}, ${ex} ${ey}`;
}

const centerOf = (p: XY): XY => ({ x: p.x + NODE_W / 2, y: p.y + NODE_H / 2 });

/** The point on a node box's border along the ray from `from` toward its centre. */
function borderPoint(from: XY, box: XY): XY {
  const c = centerOf(box);
  const dx = c.x - from.x;
  const dy = c.y - from.y;
  if (dx === 0 && dy === 0) return c;
  const hw = NODE_W / 2;
  const hh = NODE_H / 2;
  const scale = Math.min(
    Math.abs(dx) > 1e-6 ? hw / Math.abs(dx) : Infinity,
    Math.abs(dy) > 1e-6 ? hh / Math.abs(dy) : Infinity,
  );
  return { x: c.x - dx * scale, y: c.y - dy * scale };
}

/**
 * Delegation arc: actor box → target box, trimmed to both borders so the
 * arrowhead lands on the target edge, bowed perpendicular so it reads as an
 * overlay distinct from the vertical parent S-curves.
 */
function delegPath(a: XY, b: XY): string {
  const ca = centerOf(a);
  const cb = centerOf(b);
  const start = borderPoint(cb, a);
  const end = borderPoint(ca, b);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy) || 1;
  const bow = 26;
  const mx = (start.x + end.x) / 2 + (-dy / len) * bow;
  const my = (start.y + end.y) / 2 + (dx / len) * bow;
  return `M ${start.x} ${start.y} Q ${mx} ${my}, ${end.x} ${end.y}`;
}

// ---------------------------------------------------------------------------
// Node create form (reused for the toolbar add + the hover-"+" child add)
// ---------------------------------------------------------------------------
function NodeForm(props: {
  presetParent?: string;
  existing: string[];
  groups: string[];
  onCreating: (info: { name: string; parent?: string } | null) => void;
  onCreated: () => void;
  onClose: () => void;
}) {
  const { presetParent, existing, groups, onCreating, onCreated, onClose } = props;
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [agent, setAgent] = useState<string>("claude");
  const [role, setRole] = useState("");
  const [description, setDescription] = useState("");
  const [parent, setParent] = useState(presetParent ?? "");
  const [group, setGroup] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const nm = name.trim();
    if (!nm) {
      setError(t("node.nameRequired"));
      return;
    }
    const eff = presetParent ?? parent;
    setBusy(true);
    setError(null);
    onCreating({ name: nm, parent: eff || undefined });
    api
      .createNode({
        name: nm,
        agent,
        role: role.trim() || undefined,
        description: description.trim() || undefined,
        parent: eff || undefined,
        group: group.trim() || undefined,
      })
      .then(() => {
        setBusy(false);
        onCreating(null);
        onCreated();
        onClose();
      })
      .catch((err: unknown) => {
        setBusy(false);
        onCreating(null);
        setError(err instanceof Error ? err.message : t("node.createError"));
      });
  };

  return (
    <form className="node-form" onSubmit={submit}>
      <div className="node-form__head">
        {presetParent ? `${t("node.heading")} · ${presetParent}` : t("node.heading")}
      </div>
      <div className="node-form__row">
        <input
          className="dr-input node-form__name"
          name="name"
          type="text"
          placeholder={t("node.name")}
          value={name}
          autoFocus
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
        />
        <select
          className="dr-select"
          name="agent"
          value={agent}
          aria-label={t("node.agent")}
          onChange={(e) => setAgent(e.target.value)}
        >
          {AGENTS.map((a) => (
            <option key={a} value={a}>
              {agentGlyph(a)} {a}
            </option>
          ))}
        </select>
      </div>
      <input
        className="dr-input"
        name="role"
        type="text"
        placeholder={t("node.role")}
        value={role}
        spellCheck={false}
        onChange={(e) => setRole(e.target.value)}
      />
      <input
        className="dr-input"
        name="description"
        type="text"
        placeholder={t("node.description")}
        value={description}
        spellCheck={false}
        onChange={(e) => setDescription(e.target.value)}
      />
      {!presetParent && (
        <div className="node-form__row">
          <select
            className="dr-select"
            name="parent"
            value={parent}
            aria-label={t("node.parent")}
            onChange={(e) => setParent(e.target.value)}
          >
            <option value="">{t("node.parentNone")}</option>
            {existing.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <input
            className="dr-input"
            name="group"
            type="text"
            list="org-groups"
            placeholder={t("node.group")}
            value={group}
            spellCheck={false}
            onChange={(e) => setGroup(e.target.value)}
          />
          <datalist id="org-groups">
            {groups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </div>
      )}
      {error && <div className="node-form__err">{error}</div>}
      <div className="node-form__actions">
        <button type="button" className="dr-btn dr-btn--ghost" onClick={onClose}>
          {t("node.cancel")}
        </button>
        <button type="submit" className="dr-btn dr-btn--primary node-form__submit" disabled={busy}>
          {busy ? t("node.creating") : t("node.create")}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Node info + task-assign drawer
// ---------------------------------------------------------------------------
function NodeDrawer(props: {
  node: OrgNode;
  boardId: string | null;
  onClose: () => void;
  onTerminal: (node: OrgNode) => void;
}) {
  const { node, boardId, onClose, onTerminal } = props;
  const { t } = useI18n();
  const panelRef = useRef<HTMLElement | null>(null);
  useFocusTrap(true, panelRef);
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<string>(COLUMNS[0].key);
  const [priority, setPriority] = useState<string>("normal");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const assign = (e: React.FormEvent) => {
    e.preventDefault();
    if (!boardId) {
      setError(t("node.noBoard"));
      return;
    }
    const ti = title.trim();
    if (!ti) return;
    setBusy(true);
    setError(null);
    setDone(false);
    api
      .createTask(boardId, { title: ti, assignee: node.name, status, priority })
      .then(() => {
        setBusy(false);
        setDone(true);
        setTitle("");
      })
      .catch(() => {
        setBusy(false);
        setError(t("node.assignError"));
      });
  };

  const fact = (k: string, v?: string | number | null) =>
    v !== undefined && v !== "" && v !== null ? (
      <span className="dr-fact">
        <span className="dr-fact__k">{k}</span>
        <span className="dr-fact__v">{v}</span>
      </span>
    ) : null;

  return (
    <div className="dr-drawer">
      <div className="dr-drawer__scrim" onClick={onClose} />
      <aside
        className="dr-drawer__panel node-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={node.name}
        tabIndex={-1}
        ref={panelRef}
      >
        <header className="dr-drawer__head">
          <div className="dr-drawer__id">
            <span className="dr-drawer__ticket">
              {agentGlyph(node.agent)} {node.name}
            </span>
            <span className="dr-pill" style={{ "--accent": statusColor(node.status) } as React.CSSProperties}>
              {statusLabel(t, node.status)}
            </span>
          </div>
          <button type="button" className="dr-drawer__close" onClick={onClose} aria-label={t("drawer.close")}>
            ✕
          </button>
        </header>

        <div className="dr-drawer__scroll">
          <div className="dr-drawer__facts">
            {fact(t("node.fact.role"), node.role)}
            {fact(t("node.fact.group"), node.group)}
            {fact(t("node.fact.agent"), node.agent)}
            {fact(t("node.fact.parent"), node.parent ?? undefined)}
            {fact(t("node.fact.children"), node.children?.length ?? 0)}
            {fact(t("node.fact.pane"), node.tmux_pane)}
            {fact(t("node.fact.session"), node.session_id)}
          </div>

          <button type="button" className="dr-btn dr-btn--ghost node-drawer__term" onClick={() => onTerminal(node)}>
            {t("org.openTerminal")} ↗
          </button>

          <form className="dr-drawer__section node-drawer__assign-sec" onSubmit={assign}>
            <h3 className="dr-drawer__h">{t("node.assign")}</h3>
            <input
              className="dr-input"
              name="assignTitle"
              type="text"
              placeholder={t("node.assignTitle")}
              value={title}
              spellCheck={false}
              onChange={(e) => {
                setTitle(e.target.value);
                setDone(false);
              }}
            />
            <div className="node-drawer__assign-row">
              <select className="dr-select" value={status} aria-label={t("add.status")} onChange={(e) => setStatus(e.target.value)}>
                {COLUMNS.map((c) => (
                  <option key={c.key} value={c.key}>
                    {statusLabel(t, c.key)}
                  </option>
                ))}
              </select>
              <select className="dr-select" value={priority} aria-label={t("add.priority")} onChange={(e) => setPriority(e.target.value)}>
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {t(`priority.${p}`)}
                  </option>
                ))}
              </select>
              <button type="submit" className="dr-btn dr-btn--primary node-drawer__assign" disabled={busy || !title.trim()}>
                {t("node.assignSubmit")}
              </button>
            </div>
            {done && <div className="node-drawer__ok">✓ {t("node.assigned")}</div>}
            {error && <div className="node-form__err">{error}</div>}
          </form>
        </div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Interactive org canvas
// ---------------------------------------------------------------------------
type DragState = {
  name: string;
  offX: number;
  offY: number;
  x: number;
  y: number;
  over: string | null;
  group: string | null;
  invalid: boolean;
};

export function OrgChart(props: {
  boardId: string | null;
  liveTick: number;
  projectTick: number;
  onOpenTerminal: (pane: string) => void;
}) {
  const { boardId, liveTick, projectTick, onOpenTerminal } = props;
  const { t } = useI18n();

  const [nodes, setNodes] = useState<OrgNode[]>([]);
  const [childrenMap, setChildrenMap] = useState<Record<string, string[]>>({});
  const [rootList, setRootList] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [delegEvents, setDelegEvents] = useState<AuditEvent[]>([]);
  const [showDeleg, setShowDeleg] = useState(false); // overlay off by default

  const [cur, setCur] = useState<Positions>({});
  const [drag, setDrag] = useState<DragState | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [adding, setAdding] = useState(false); // toolbar global add
  const [addChild, setAddChild] = useState<string | null>(null); // hover-"+" parent
  const [pending, setPending] = useState<{ name: string; parent?: string } | null>(null);
  const [drawerNode, setDrawerNode] = useState<OrgNode | null>(null);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  const curRef = useRef<Positions>(cur);
  const dragRef = useRef<DragState | null>(drag);
  const rafRef = useRef(0);
  const firstRef = useRef(true);
  curRef.current = cur;
  dragRef.current = drag;

  // --- load -----------------------------------------------------------------
  // Per-run `alive` flag (closure-scoped, NOT a shared ref) so an in-flight
  // fetch from a previous project/tick can't apply stale data after a switch —
  // its cleanup sets its own `alive=false` before the new run starts.
  useEffect(() => {
    let alive = true;
    api
      .getOrg()
      .then((o) => {
        if (!alive) return;
        setNodes(o.nodes ?? []);
        setRootList(o.roots ?? []);
        setChildrenMap(o.children ?? {});
        setError(null);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : t("org.loadError"));
      });
    return () => {
      alive = false;
    };
  }, [liveTick, reloadKey, t]);

  // Delegation source: recent audit events, re-scoped per project (projectTick).
  // Read-only; on failure or empty audit we simply render no delegation edges.
  useEffect(() => {
    let alive = true;
    api
      .getAudit({ limit: 50 })
      .then((page) => {
        if (alive) setDelegEvents(Array.isArray(page.events) ? page.events : []);
      })
      .catch(() => {
        if (alive) setDelegEvents([]);
      });
    return () => {
      alive = false;
    };
  }, [liveTick, projectTick, reloadKey]);

  const byName = useMemo(() => {
    const m: Record<string, OrgNode> = {};
    for (const n of nodes) m[n.name] = n;
    return m;
  }, [nodes]);

  const childrenOf = useCallback(
    (name: string): string[] => {
      if (childrenMap[name]) return childrenMap[name]!;
      const node = byName[name];
      if (node?.children?.length) return node.children;
      return nodes.filter((n) => n.parent === name).map((n) => n.name);
    },
    [childrenMap, byName, nodes],
  );

  const roots = useMemo(() => {
    if (rootList.length) return rootList;
    return nodes.filter((n) => !n.parent).map((n) => n.name);
  }, [rootList, nodes]);

  const groups = useMemo(() => {
    const set = new Set<string>();
    for (const n of nodes) if (n.group) set.add(n.group);
    return Array.from(set).sort();
  }, [nodes]);
  const groupColor = useCallback(
    (group?: string) => (group ? GROUP_PALETTE[groups.indexOf(group) % GROUP_PALETTE.length]! : "var(--slate)"),
    [groups],
  );

  const names = useMemo(() => nodes.map((n) => n.name), [nodes]);
  const structSig = useMemo(
    () => roots.join(",") + "#" + nodes.map((n) => `${n.name}>${n.parent ?? ""}`).sort().join("|"),
    [roots, nodes],
  );
  const layout = useMemo(
    () => computeLayout(names, roots, childrenOf),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [structSig],
  );

  // --- position tween -------------------------------------------------------
  const runTween = useCallback(
    (to: Positions) => {
      cancelAnimationFrame(rafRef.current);
      const from: Positions = { ...curRef.current };
      for (const nm of Object.keys(to)) {
        if (!(nm in from)) {
          const parent = byName[nm]?.parent;
          from[nm] = parent && from[parent] ? { ...from[parent]! } : { ...to[nm]! };
        }
      }
      const t0 = performance.now();
      const step = (now: number) => {
        const k = Math.min(1, (now - t0) / TWEEN_MS);
        const e = 1 - Math.pow(1 - k, 3);
        const next: Positions = {};
        for (const nm of Object.keys(to)) {
          const a = from[nm] ?? to[nm]!;
          const b = to[nm]!;
          next[nm] = { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e };
        }
        setCur(next);
        if (k < 1) rafRef.current = requestAnimationFrame(step);
      };
      rafRef.current = requestAnimationFrame(step);
    },
    [byName],
  );

  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false;
      setCur(layout.positions);
      curRef.current = layout.positions;
      return;
    }
    runTween(layout.positions);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structSig]);

  // --- patch (reparent / group) ---------------------------------------------
  const applyPatch = useCallback(
    (name: string, patch: { parent?: string | null; group?: string | null }) => {
      api
        .patchNode(name, patch)
        .then(() => setReloadKey((k) => k + 1))
        .catch(() => runTween(layout.positions)); // snap back on failure
    },
    [layout.positions, runTween],
  );

  // --- drag -----------------------------------------------------------------
  const startDrag = (e: React.PointerEvent, name: string) => {
    if (e.button !== 0) return;
    const el = canvasRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = e.clientX - rect.left + el.scrollLeft;
    const py = e.clientY - rect.top + el.scrollTop;
    const p = curRef.current[name] ?? layout.positions[name] ?? { x: 0, y: 0 };
    setDrag({ name, offX: px - p.x, offY: py - p.y, x: p.x, y: p.y, over: null, group: null, invalid: false });
  };

  useEffect(() => {
    if (!drag) return;
    const el = canvasRef.current;
    if (!el) return;

    const onMove = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left + el.scrollLeft;
      const py = e.clientY - rect.top + el.scrollTop;
      setDrag((d) => {
        if (!d) return d;
        const x = px - d.offX;
        const y = py - d.offY;
        const positions = curRef.current;
        const desc = descendantsOf(d.name, childrenOf);
        let over: string | null = null;
        let near: string | null = null;
        let nearDist = Infinity;
        let invalid = false;
        for (const nm of Object.keys(positions)) {
          if (nm === d.name) continue;
          const p = positions[nm]!;
          if (px >= p.x && px <= p.x + NODE_W && py >= p.y && py <= p.y + NODE_H) {
            over = nm;
            invalid = desc.has(nm);
          }
          const dist = Math.hypot(px - (p.x + NODE_W / 2), py - (p.y + NODE_H / 2));
          if (dist < nearDist) {
            nearDist = dist;
            near = nm;
          }
        }
        const group = !over && near && nearDist < GROUP_R ? near : null;
        return { ...d, x, y, over, group, invalid };
      });
    };

    const onUp = () => {
      const d = dragRef.current;
      setDrag(null);
      if (!d) return;
      // Freeze the dropped node where released so the next tween starts there.
      setCur((prev) => ({ ...prev, [d.name]: { x: d.x, y: d.y } }));
      curRef.current = { ...curRef.current, [d.name]: { x: d.x, y: d.y } };
      if (d.over && !d.invalid) {
        applyPatch(d.name, { parent: d.over });
      } else if (d.group) {
        const target = byName[d.group];
        applyPatch(d.name, { group: target?.group || d.group });
      } else if (byName[d.name]?.group) {
        applyPatch(d.name, { group: null }); // dropped in open space → ungroup
      } else {
        runTween(layout.positions); // snap back
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.name]);

  // --- render helpers -------------------------------------------------------
  const posFor = (name: string): XY =>
    drag?.name === name ? { x: drag.x, y: drag.y } : (cur[name] ?? layout.positions[name] ?? { x: 0, y: 0 });

  const edges = useMemo(() => {
    const out: [string, string][] = [];
    const seen = new Set<string>();
    for (const n of names) {
      for (const c of childrenOf(n)) {
        const key = `${n}>${c}`;
        if (seen.has(key) || !byName[c]) continue;
        seen.add(key);
        out.push([n, c]);
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structSig]);

  // Delegation edges: assign/delegate audit events → actor → target.node.
  // Both endpoints must be live org nodes; duplicates are merged with a count
  // and the most-recent timestamp so frequency/recency can be surfaced.
  const delegations = useMemo(() => {
    const m = new Map<string, { from: string; to: string; count: number; lastTs: string | number }>();
    for (const ev of delegEvents) {
      if (ev.action !== "assign" && ev.action !== "delegate") continue;
      const from = ev.actor;
      const to = targetNode(ev.target);
      if (!to || from === to || !byName[from] || !byName[to]) continue;
      const key = `${from}>${to}`;
      const prev = m.get(key);
      if (prev) {
        prev.count += 1;
        if (ev.ts > prev.lastTs) prev.lastTs = ev.ts;
      } else {
        m.set(key, { from, to, count: 1, lastTs: ev.ts });
      }
    }
    return Array.from(m.values());
  }, [delegEvents, byName]);

  const stopPD = (e: React.PointerEvent) => e.stopPropagation();

  // What will happen if the user drops right now — drives the floating badge
  // and the target highlight colours.
  const dragInfo: { mode: string; text: string } | null = (() => {
    if (!drag) return null;
    if (drag.over) {
      return drag.invalid
        ? { mode: "invalid", text: t("drag.invalid") }
        : { mode: "reparent", text: t("drag.reparent", { target: drag.over }) };
    }
    if (drag.group) return { mode: "group", text: t("drag.group", { target: drag.group }) };
    if (byName[drag.name]?.group) return { mode: "ungroup", text: t("drag.ungroup") };
    return null;
  })();

  return (
    <section className="org">
      <div className="org__toolbar">
        <div className="org__lead">
          <span className="org__title">{t("org.title")}</span>
          <span className="org__sub">{t("org.subtitle", { n: nodes.length, g: groups.length })}</span>
        </div>
        <div className="org__tools">
          <button
            type="button"
            className={cx("org-deleg-toggle", showDeleg && "is-on")}
            aria-pressed={showDeleg}
            onClick={() => setShowDeleg((v) => !v)}
          >
            <span className="org-deleg-toggle__line" aria-hidden="true" />
            {t("org.delegEdges")}
            {showDeleg && delegations.length > 0 && (
              <span className="org-deleg-toggle__n">{delegations.length}</span>
            )}
          </button>
          <button type="button" className={cx("org-addbtn", adding && "is-open")} onClick={() => setAdding((v) => !v)}>
            {t("org.addNode")}
          </button>
        </div>
      </div>

      {showDeleg && (
        <div className="org-deleg-legend" role="note">
          <span className="org-deleg-legend__swatch" aria-hidden="true" />
          {delegations.length > 0 ? t("org.delegLegend") : t("org.delegEmpty")}
        </div>
      )}

      {adding && (
        <NodeForm
          existing={names}
          groups={groups}
          onCreating={setPending}
          onCreated={() => setReloadKey((k) => k + 1)}
          onClose={() => setAdding(false)}
        />
      )}

      {groups.length > 0 && (
        <div className="org-legend">
          <span className="org-legend__label">{t("org.groups")}</span>
          {groups.map((g) => (
            <span key={g} className="org-legend__item">
              <span className="org-legend__dot" style={{ background: groupColor(g) }} />
              {g}
            </span>
          ))}
        </div>
      )}

      {error && <div className="org__msg is-error">{error}</div>}
      {!error && nodes.length === 0 && <div className="org__msg">{t("org.empty")}</div>}

      <div className={cx("org-canvas", drag && "is-dragging")} ref={canvasRef}>
        <div className="org-stage" style={{ width: layout.width, height: layout.height }}>
          <svg className={cx("org-edges", drag && "is-dragging")} width={layout.width} height={layout.height}>
            <defs>
              <marker
                id="org-deleg-arrow"
                viewBox="0 0 10 10"
                refX="8.5"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path className="org-deleg-arrowhead" d="M 0 0 L 10 5 L 0 10 z" />
              </marker>
            </defs>
            {edges.map(([par, ch]) => {
              const a = posFor(par);
              const b = posFor(ch);
              const d = edgePath(a, b);
              const mx = (a.x + b.x) / 2 + NODE_W / 2;
              const my = (a.y + NODE_H + b.y) / 2;
              return (
                <g key={`${par}>${ch}`} className="org-edge-g" data-edge-child={ch}>
                  <path
                    className={cx("org-edge", drag?.name === ch && "is-active")}
                    d={d}
                    style={{ stroke: groupColor(byName[ch]?.group) }}
                  />
                  <path className="org-edge-hit" d={d} />
                  <g
                    className="org-edge-cut"
                    transform={`translate(${mx}, ${my})`}
                    role="button"
                    tabIndex={0}
                    aria-label={t("org.cutParent")}
                    onClick={() => applyPatch(ch, { parent: null })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        applyPatch(ch, { parent: null });
                      }
                    }}
                  >
                    <title>{t("org.cutParent")}</title>
                    <circle className="org-edge-cut__bg" r="10" />
                    <path className="org-edge-cut__x" d="M -3.5 -3.5 L 3.5 3.5 M 3.5 -3.5 L -3.5 3.5" />
                  </g>
                </g>
              );
            })}

            {showDeleg && (
              <g className="org-deleg-layer">
                {delegations.map((dl) => {
                  const a = posFor(dl.from);
                  const b = posFor(dl.to);
                  const d = delegPath(a, b);
                  return (
                    <path
                      key={`${dl.from}>${dl.to}`}
                      className="org-deleg-edge"
                      data-deleg={`${dl.from}>${dl.to}`}
                      data-count={dl.count}
                      d={d}
                      markerEnd="url(#org-deleg-arrow)"
                      style={{ strokeWidth: 1.4 + Math.min(dl.count, 4) * 0.45 }}
                    >
                      <title>{t("org.delegEdge", { from: dl.from, to: dl.to, n: dl.count })}</title>
                    </path>
                  );
                })}
              </g>
            )}
          </svg>

          {nodes.map((node) => {
            const p = posFor(node.name);
            const isDrag = drag?.name === node.name;
            const isOver = drag?.over === node.name;
            const isGroup = drag?.group === node.name;
            return (
              <div
                key={node.name}
                data-name={node.name}
                className={cx(
                  "org-node",
                  isDrag && "is-dragging",
                  isOver && (drag?.invalid ? "is-invalid" : "is-drop"),
                  isGroup && "is-grouptarget",
                  hover === node.name && "is-hover",
                )}
                style={{
                  transform: `translate(${p.x}px, ${p.y}px)`,
                  width: NODE_W,
                  height: NODE_H,
                  "--group": groupColor(node.group),
                } as React.CSSProperties}
                onPointerDown={(e) => startDrag(e, node.name)}
                onPointerEnter={() => setHover(node.name)}
                onPointerLeave={() => setHover((h) => (h === node.name ? null : h))}
              >
                <div className="org-node__main">
                  <span className={cx("org-node__dot", statusClass(node.status))} />
                  <span className="org-node__name">{node.name}</span>
                  <span className="org-node__agent">{agentGlyph(node.agent)}</span>
                </div>
                {node.role && <div className="org-node__role">{node.role}</div>}
                {node.description && (
                  <div className="org-node__desc" title={node.description}>
                    {node.description}
                  </div>
                )}
                {node.group && <div className="org-node__group">{node.group}</div>}

                <div className="org-node__actions">
                  <button
                    type="button"
                    className="org-act org-act--term"
                    onPointerDown={stopPD}
                    onClick={() => onOpenTerminal(node.tmux_pane)}
                  >
                    {t("org.openTerminal")}
                  </button>
                  <button
                    type="button"
                    className="org-act org-act--info"
                    onPointerDown={stopPD}
                    onClick={() => setDrawerNode(node)}
                  >
                    {t("org.info")}
                  </button>
                  {node.parent && (
                    <button
                      type="button"
                      className="org-act org-act--detach"
                      onPointerDown={stopPD}
                      onClick={() => applyPatch(node.name, { parent: null })}
                    >
                      {t("org.detach")}
                    </button>
                  )}
                </div>

                <button
                  type="button"
                  className="org-node__plus"
                  title={t("org.addNode")}
                  onPointerDown={stopPD}
                  onClick={() => setAddChild(node.name)}
                >
                  +
                </button>
              </div>
            );
          })}

          {pending && (
            <div
              className="org-node is-pending"
              style={{
                transform: `translate(${(pending.parent && posFor(pending.parent).x) || PAD}px, ${
                  (pending.parent ? posFor(pending.parent).y + GAP_Y : PAD) || PAD
                }px)`,
                width: NODE_W,
                height: NODE_H,
              }}
            >
              <div className="org-node__main">
                <span className="org-node__dot" />
                <span className="org-node__name">{pending.name}</span>
              </div>
              <div className="org-node__role">{t("node.creating")}</div>
            </div>
          )}

          {addChild && (
            <div
              className="org-popover"
              style={{
                transform: `translate(${posFor(addChild).x}px, ${posFor(addChild).y + NODE_H + 18}px)`,
              }}
            >
              <NodeForm
                presetParent={addChild}
                existing={names}
                groups={groups}
                onCreating={setPending}
                onCreated={() => setReloadKey((k) => k + 1)}
                onClose={() => setAddChild(null)}
              />
            </div>
          )}

          {drag && dragInfo && (
            <div
              className={cx("org-dragbadge", `is-${dragInfo.mode}`)}
              style={{ transform: `translate(${drag.x + NODE_W + 12}px, ${drag.y - 6}px)` }}
            >
              {dragInfo.text}
            </div>
          )}
        </div>
      </div>

      {drawerNode && (
        <NodeDrawer
          node={byName[drawerNode.name] ?? drawerNode}
          boardId={boardId}
          onClose={() => setDrawerNode(null)}
          onTerminal={(node) => {
            setDrawerNode(null);
            onOpenTerminal(node.tmux_pane);
          }}
        />
      )}
    </section>
  );
}
