import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "../api";
import { AGENTS, agentGlyph, cx, statusColor } from "../constants";
import { statusLabel, useI18n } from "../i18n";
import { buildOrgTree, isBgServiceNode } from "../orgTree";
import type { TFn } from "../i18n";
import type { NodeHealth, OrgNode, ProjectLead } from "../types";
import { useFocusTrap } from "../useFocusTrap";
import { ROLE_PRESETS, rolePresetBody } from "../rolePresets";
import { GroveMark } from "./GroveMark";
import { NodeHealthBadge } from "./NodeHealthBadge";

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
type XY = { x: number; y: number };
type Positions = Record<string, XY>;

function statusClass(status: string): string {
  switch (status) {
    case "active":
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

function isServiceNode(node: OrgNode): boolean {
  return isBgServiceNode(node);
}

function nodeDisplayGlyph(node: OrgNode, t: TFn): string {
  return isServiceNode(node) ? t("node.kind.service.short") : agentGlyph(node.agent);
}

function nodeTypeLabel(node: OrgNode, t: TFn): string {
  return isServiceNode(node) ? t("node.kind.service") : node.agent;
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
  // Role preset key + the editable persona body. Picking a preset fills the body
  // (and clears the "dirty" flag); any manual edit marks it dirty so it travels
  // as a free `role` override. When a preset is selected and left untouched, the
  // body is omitted so the backend's canonical expansion of `role_preset` wins.
  const [rolePreset, setRolePreset] = useState("");
  const [role, setRole] = useState("");
  const [roleDirty, setRoleDirty] = useState(false);
  const [description, setDescription] = useState("");
  const [workInstructions, setWorkInstructions] = useState("");
  const [parent, setParent] = useState(presetParent ?? "");
  const [group, setGroup] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyPreset = (key: string) => {
    setRolePreset(key);
    if (key) {
      setRole(rolePresetBody(key));
      setRoleDirty(false);
    }
  };

  const presetBody = rolePresetBody(rolePreset);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const nm = name.trim();
    if (!nm) {
      setError(t("node.nameRequired"));
      return;
    }
    const eff = presetParent ?? parent;
    // Override the canonical preset body only when the operator edited it (or
    // typed a custom role with no preset selected); otherwise send the key alone.
    const roleOverride = rolePreset && !roleDirty ? "" : role.trim();
    setBusy(true);
    setError(null);
    onCreating({ name: nm, parent: eff || undefined });
    api
      .createNode({
        name: nm,
        agent,
        role: roleOverride || undefined,
        rolePreset: rolePreset || undefined,
        description: description.trim() || undefined,
        work_instructions: workInstructions.trim() || undefined,
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
      <div className="node-form__rolepreset">
        <select
          className="dr-select node-form__role-preset"
          name="rolePreset"
          value={rolePreset}
          aria-label={t("node.rolePreset")}
          onChange={(e) => applyPreset(e.target.value)}
        >
          <option value="">{t("node.rolePreset.none")}</option>
          {ROLE_PRESETS.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </select>
        {rolePreset && presetBody && (
          <div className="node-form__role-preview" aria-label={t("node.rolePreview")}>
            <span className="node-form__role-preview-label">{t("node.rolePreview")}</span>
            <pre className="node-form__role-preview-body">{presetBody}</pre>
          </div>
        )}
        <textarea
          className="dr-input node-form__role"
          name="role"
          rows={rolePreset ? 5 : 2}
          placeholder={t("node.role")}
          value={role}
          spellCheck={false}
          onChange={(e) => {
            setRole(e.target.value);
            setRoleDirty(true);
          }}
        />
      </div>
      <input
        className="dr-input"
        name="description"
        type="text"
        placeholder={t("node.description")}
        value={description}
        spellCheck={false}
        onChange={(e) => setDescription(e.target.value)}
      />
      <textarea
        className="dr-input node-form__work-instructions"
        name="workInstructions"
        rows={2}
        placeholder={t("node.workInstructions")}
        value={workInstructions}
        spellCheck={false}
        onChange={(e) => setWorkInstructions(e.target.value)}
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
// Node info drawer
// ---------------------------------------------------------------------------
function NodeDrawer(props: {
  node: OrgNode;
  onClose: () => void;
  onTerminal: (node: OrgNode) => void;
  onTerminate: (node: OrgNode) => void;
  terminating?: boolean;
  canEdit: boolean;
  onPatched: () => void;
}) {
  const { node, onClose, onTerminal, onTerminate, terminating, canEdit, onPatched } = props;
  const { t } = useI18n();
  const panelRef = useRef<HTMLElement | null>(null);
  useFocusTrap(true, panelRef);

  // Inline edit of operator-tunable advisory fields, reusing the existing
  // operator-gated PATCH /api/nodes/{name} (api.patchNode). role is not editable
  // here (not in the backend NodeUpdatePayload).
  const [editing, setEditing] = useState(false);
  const [wi, setWi] = useState(node.work_instructions ?? "");
  const [desc, setDesc] = useState(node.description ?? "");
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const startEdit = () => {
    setWi(node.work_instructions ?? "");
    setDesc(node.description ?? "");
    setEditError(null);
    setEditing(true);
  };
  const saveEdit = async () => {
    setSaving(true);
    setEditError(null);
    try {
      await api.patchNode(node.name, { work_instructions: wi, description: desc });
      onPatched();
      setEditing(false);
    } catch {
      setEditError(t("node.editError"));
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
              {nodeDisplayGlyph(node, t)} {node.name}
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
            {fact(t("node.fact.workInstructions"), node.work_instructions)}
            {node.kind === "service" && fact(t("node.fact.kind"), t("node.kind.service"))}
            {fact(t("node.fact.group"), node.group)}
            {fact(isServiceNode(node) ? t("node.fact.runtime") : t("node.fact.agent"), node.agent)}
            {fact(t("node.fact.parent"), node.parent ?? undefined)}
            {fact(t("node.fact.children"), node.children?.length ?? 0)}
            {fact(t("node.fact.pane"), node.tmux_pane)}
            {fact(t("node.fact.session"), node.session_id)}
          </div>

          {canEdit && !editing && (
            <button
              type="button"
              className="dr-btn dr-btn--ghost node-drawer__edit"
              onClick={startEdit}
            >
              {t("node.edit")}
            </button>
          )}
          {canEdit && editing && (
            <form
              className="node-form node-drawer__edit-form"
              onSubmit={(e) => {
                e.preventDefault();
                void saveEdit();
              }}
            >
              <label className="node-form__label">
                {t("node.fact.workInstructions")}
                <textarea
                  className="dr-input"
                  rows={3}
                  value={wi}
                  onChange={(e) => setWi(e.target.value)}
                />
              </label>
              <label className="node-form__label">
                {t("node.fact.description")}
                <textarea
                  className="dr-input"
                  rows={2}
                  value={desc}
                  onChange={(e) => setDesc(e.target.value)}
                />
              </label>
              {editError && <div className="node-form__error">{editError}</div>}
              <div className="node-form__actions">
                <button
                  type="button"
                  className="dr-btn dr-btn--ghost"
                  onClick={() => setEditing(false)}
                >
                  {t("node.cancel")}
                </button>
                <button type="submit" className="dr-btn dr-btn--primary" disabled={saving}>
                  {saving ? t("node.saving") : t("node.save")}
                </button>
              </div>
            </form>
          )}
          {node.terminal_allowed !== false && (
            <button type="button" className="dr-btn dr-btn--ghost node-drawer__term" onClick={() => onTerminal(node)}>
              {t("org.openTerminal")} ↗
            </button>
          )}
          <button
            type="button"
            className="dr-btn dr-btn--ghost node-drawer__terminate"
            disabled={terminating}
            onClick={() => onTerminate(node)}
          >
            {terminating ? t("node.terminating") : t("node.terminate")}
          </button>

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
  liveTick: number;
  projectTick: number;
  onOpenTerminal: (pane: string) => void;
  onSwitchProject?: (project: string) => void;
}) {
  const { liveTick, projectTick, onOpenTerminal, onSwitchProject } = props;
  const { t } = useI18n();

  const [nodes, setNodes] = useState<OrgNode[]>([]);
  const [childrenMap, setChildrenMap] = useState<Record<string, string[]>>({});
  const [rootList, setRootList] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  // v1.29 cross-project org.
  const [projectLeads, setProjectLeads] = useState<ProjectLead[]>([]);
  const [nodeHealth, setNodeHealth] = useState<Record<string, NodeHealth>>({}); // PR1 watchdog
  // Operator gate for the drawer edit form. Optimistic (server still enforces
  // _require_operator_state_change); we proactively hide the affordance only
  // when /me confirms a viewer. Re-checked per project.
  const [canEdit, setCanEdit] = useState(true);

  const [cur, setCur] = useState<Positions>({});
  const [drag, setDrag] = useState<DragState | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [adding, setAdding] = useState(false); // toolbar global add
  const [addChild, setAddChild] = useState<string | null>(null); // hover-"+" parent
  const [pending, setPending] = useState<{ name: string; parent?: string } | null>(null);
  const [drawerNode, setDrawerNode] = useState<OrgNode | null>(null);
  const [terminating, setTerminating] = useState<string | null>(null);
  const [terminateError, setTerminateError] = useState<string | null>(null);

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
    setLoading(true);
    api
      .getOrg()
      .then((o) => {
        if (!alive) return;
        setNodes(o.nodes ?? []);
        setRootList(o.roots ?? []);
        setChildrenMap(o.children ?? {});
        setProjectLeads(o.project_leads ?? []);
        setError(null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (alive) {
          setError(e instanceof Error ? e.message : t("org.loadError"));
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [liveTick, reloadKey, t]);

  // PR1 watchdog: per-node health (display-only). Absent-tolerant via the api
  // helper — a missing endpoint resolves to {} so nodes show neutral "unknown".
  // Re-scoped per project; polled so transient states (cooldown/rate_limited) clear.
  useEffect(() => {
    let alive = true;
    const load = () =>
      api.getNodeHealth().then((h) => {
        if (alive) setNodeHealth(h);
      });
    void load();
    const id = setInterval(() => void load(), 10000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [projectTick, reloadKey]);

  useEffect(() => {
    let alive = true;
    api
      .getMe()
      .then((me) => {
        if (alive) setCanEdit(me?.member?.role !== "viewer");
      })
      .catch(() => {
        if (alive) setCanEdit(true);
      });
    return () => {
      alive = false;
    };
  }, [projectTick]);

  const byName = useMemo(() => {
    const m: Record<string, OrgNode> = {};
    for (const n of nodes) m[n.name] = n;
    return m;
  }, [nodes]);

  const orgTree = useMemo(() => buildOrgTree(nodes, childrenMap, rootList), [childrenMap, nodes, rootList]);
  const { treeNodes, serviceNodes, roots, names, childrenOf } = orgTree;

  const groups = useMemo(() => {
    const set = new Set<string>();
    for (const n of nodes) if (n.group) set.add(n.group);
    return Array.from(set).sort();
  }, [nodes]);
  const allNames = useMemo(() => nodes.map((n) => n.name), [nodes]);
  const groupColor = useCallback(
    (group?: string) => (group ? GROUP_PALETTE[groups.indexOf(group) % GROUP_PALETTE.length]! : "var(--slate)"),
    [groups],
  );

  const structSig = useMemo(
    () => roots.join(",") + "#" + treeNodes.map((n) => `${n.name}>${n.parent ?? ""}`).sort().join("|"),
    [roots, treeNodes],
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

  const terminateNode = useCallback(
    (node: OrgNode) => {
      if (terminating) return;
      setTerminating(node.name);
      setTerminateError(null);
      api
        .terminateNode(node.name, { operatorOverride: true })
        .then((preview) => {
          const subtreeCount = preview.subtree?.length ?? 1;
          if (!window.confirm(t("node.terminateConfirm", { node: node.name, count: subtreeCount }))) return null;
          return api.terminateNode(node.name, {
            operatorOverride: true,
            confirm: true,
            confirmationId: preview.confirmation_id,
          });
        })
        .then((confirmed) => {
          if (!confirmed) return;
          setReloadKey((k) => k + 1);
          setDrawerNode((curNode) => (curNode?.name === node.name ? null : curNode));
        })
        .catch(() => {
          setTerminateError(t("node.terminateError"));
        })
        .finally(() => {
          setTerminating((curNode) => (curNode === node.name ? null : curNode));
        });
    },
    [t, terminating],
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

  const parentCandidatesFor = useCallback(
    (node: OrgNode): OrgNode[] => {
      const descendants = descendantsOf(node.name, childrenOf);
      return treeNodes.filter((candidate) => candidate.name !== node.name && candidate.name !== node.parent && !descendants.has(candidate.name));
    },
    [childrenOf, treeNodes],
  );

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
      {/* v1.29 cross-project bar: CHAT MASTER entrypoint + project
          leads. Current lead expands the tree below; others switch project. */}
      {/* grove-master is the canonical tree root (org-level, with its master plane
          nested) — this bar is now the project-lead switcher only. */}
      {projectLeads.length > 0 && (
        <div className="org-master-bar" role="navigation" aria-label={t("org.crossProject")}>
          <div className="org-pleads">
            {projectLeads.map((pl) => (
              <button
                key={pl.id}
                type="button"
                data-project={pl.project}
                className={cx("org-plead", pl.current && "is-current")}
                aria-current={pl.current ? "true" : undefined}
                title={pl.current ? t("org.leadCurrent") : t("org.leadSwitch", { p: pl.display_name })}
                onClick={() => {
                  if (!pl.current) onSwitchProject?.(pl.switch_target);
                }}
              >
                {pl.display_name}
                {pl.current && <span className="org-plead__dot" aria-hidden="true" />}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="org__toolbar">
        <div className="org__lead">
          <GroveMark size={18} className="org__mark" />
          <span className="org__title">{t("org.title")}</span>
          <span className="org__sub">{loading ? t("org.loading") : t("org.subtitle", { n: nodes.length, g: groups.length })}</span>
        </div>
        <div className="org__tools">
          <button type="button" className={cx("org-addbtn", adding && "is-open")} onClick={() => setAdding((v) => !v)}>
            {t("org.addNode")}
          </button>
        </div>
      </div>

      {adding && (
        <NodeForm
          existing={allNames}
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
      {terminateError && <div className="org__msg is-error">{terminateError}</div>}
      {!error && loading && nodes.length === 0 && <div className="org__msg">{t("org.loading")}</div>}
      {!error && !loading && nodes.length === 0 && <div className="org__msg">{t("org.empty")}</div>}

      {serviceNodes.length > 0 && (
        <div className="org-services" aria-label={t("org.services")}>
          <span className="org-services__label">{t("org.services")}</span>
          {serviceNodes.map((node) => (
            <button
              key={node.name}
              type="button"
              className="org-services__item"
              onClick={() => onOpenTerminal(node.tmux_pane)}
              title={t("node.kind.service.hint")}
            >
              <span className={cx("org-node__dot", statusClass(node.status))} />
              <span className="org-services__name">{node.name}</span>
              <span className="org-services__type">{t("node.kind.service")}</span>
              <span className="org-services__pane">{node.tmux_pane}</span>
            </button>
          ))}
        </div>
      )}

      <div className={cx("org-canvas", drag && "is-dragging")} ref={canvasRef}>
        <div className="org-stage" style={{ width: layout.width, height: layout.height }}>
          <svg className={cx("org-edges", drag && "is-dragging")} width={layout.width} height={layout.height}>
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

          </svg>

          {treeNodes.map((node) => {
            const p = posFor(node.name);
            const isDrag = drag?.name === node.name;
            const isOver = drag?.over === node.name;
            const isGroup = drag?.group === node.name;
            const parentCandidates = parentCandidatesFor(node);
            return (
              <div
                key={node.name}
                data-name={node.name}
                role="group"
                aria-label={`${node.name} ${nodeTypeLabel(node, t)} ${statusLabel(t, node.status)}`}
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
                  <NodeHealthBadge health={nodeHealth[node.name] ?? node.health} compact />
                  <span className={cx("org-node__agent", isServiceNode(node) && "is-service")}>
                    {nodeDisplayGlyph(node, t)}
                  </span>
                  {node.kind === "service" && (
                    <span className="org-node__kind" title={t("node.kind.service.hint")}>
                      {t("node.kind.service")}
                    </span>
                  )}
                </div>
                {node.role && <div className="org-node__role">{node.role}</div>}
                {node.description && (
                  <div className="org-node__desc" title={node.description}>
                    {node.description}
                  </div>
                )}
                {node.group && <div className="org-node__group">{node.group}</div>}

                <div className="org-node__actions">
                  {node.terminal_allowed !== false && (
                    <button
                      type="button"
                      className="org-act org-act--term"
                      onPointerDown={stopPD}
                      onClick={() => onOpenTerminal(node.tmux_pane)}
                    >
                      {t("org.openTerminal")}
                    </button>
                  )}
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
                  {parentCandidates.length > 0 && (
                    <label className="org-keyboard-parent-wrap" onPointerDown={stopPD}>
                      <span className="org-keyboard-parent__label">{t("org.keyboardParent")}</span>
                      <select
                        className="dr-select org-keyboard-parent"
                        aria-label={t("org.keyboardParentFor", { node: node.name })}
                        value=""
                        onPointerDown={stopPD}
                        onChange={(e) => {
                          const parent = e.target.value;
                          if (parent) applyPatch(node.name, { parent });
                        }}
                      >
                        <option value="">{t("org.keyboardParentChoose")}</option>
                        {parentCandidates.map((candidate) => (
                          <option key={candidate.name} value={candidate.name}>
                            {candidate.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>

                <button
                  type="button"
                  className="org-node__plus"
                  title={t("org.addNode")}
                  aria-label={`${t("org.addNode")} · ${node.name}`}
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
          onClose={() => setDrawerNode(null)}
          onTerminal={(node) => {
            setDrawerNode(null);
            onOpenTerminal(node.tmux_pane);
          }}
          onTerminate={terminateNode}
          terminating={terminating === drawerNode.name}
          canEdit={canEdit}
          onPatched={() => setReloadKey((k) => k + 1)}
        />
      )}
    </section>
  );
}
