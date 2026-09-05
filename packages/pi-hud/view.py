"""HUD presentation: command/status center and footer rendering."""

from data import fmt_money as _fmt_money, fmt_tokens as _fmt_tokens
from theme import C

def render(self, d):
    cmd = d.get("command", "")
    tool = d.get("tool", "")
    tokens = d.get("tokens", {})
    thinking = d.get("thinking", "—")
    provider = d.get("provider", "—")
    auth_ok = d.get("auth_ok")
    model = d.get("model", "—")
    # 状态来自 Pi 的 agent_start / agent_settled 生命周期事件。
    is_active = bool(d.get("agent_active", False))
    if is_active and cmd:
        status_color = C["cyan"]
        self.lbl_status.config(text="RUNNING", fg=status_color)
        txt = f"▶ {tool}: {cmd}" if tool else cmd
        if len(txt) > 120:
            txt = txt[:117] + "…"
        self.lbl_cmd.config(text=txt)
    elif is_active:
        status_color = C["purple"]
        self.lbl_status.config(text="THINKING", fg=status_color)
        self.lbl_cmd.config(text="(generating…)")
    else:
        status_color = C["dim"]
        self.lbl_status.config(text="IDLE", fg=status_color)
        self.lbl_cmd.config(text="(idle)")
    self._set_bell(is_active, status_color)

    # Footer 彩色分段
    self.txt_footer.config(state="normal")
    self.txt_footer.delete("1.0", "end")
    self.txt_footer.insert("end", "🧠 ", "brain")
    self.txt_footer.insert("end", provider, "prov")
    if auth_ok:
        self.txt_footer.insert("end", " 🔒", "lock")
    self.txt_footer.insert("end", "  ·  ", "sep")
    self.txt_footer.insert("end", model, "model")
    self.txt_footer.insert("end", "  ·  ", "sep")
    self.txt_footer.insert("end", thinking, "think")
    self.txt_footer.insert("end", "  │  ", "sep")
    # token 统计（来自 session jsonl，单轮实时）
    tin = tokens.get("in", 0)
    tout = tokens.get("out", 0)
    cost = tokens.get("cost", 0.0)
    subagents_cost = tokens.get("subagents_cost", 0.0)
    ctx_pct = tokens.get("ctx_pct", 0.0)
    hit_rate = tokens.get("hit_rate", 0.0)
    # In/Out (绿色)
    self.txt_footer.insert(
        "end", f"In {_fmt_tokens(tin)}  Out {_fmt_tokens(tout)}", "tokens"
    )
    self.txt_footer.insert("end", "  │  ", "sep")
    # 缓存命中率 (黄色)
    self.txt_footer.insert("end", f"HitCache {hit_rate:.1f}%", "cache")
    self.txt_footer.insert("end", "  │  ", "sep")
    # 上下文占用 (蓝色)
    self.txt_footer.insert("end", f"Ctx {ctx_pct:.1f}%" if ctx_pct else "Ctx —", "ctx")
    self.txt_footer.insert("end", "  │  ", "sep")
    # 费用 (橙色)
    self.txt_footer.insert(
        "end", f"{_fmt_money(cost)} Pi  ·  {_fmt_money(subagents_cost)} subagents", "cost"
    )
    # 全选文字加上 body tag 预留下伸空间
    self.txt_footer.tag_add("body", "1.0", "end")
    self.txt_footer.config(state="disabled")
    self.lbl_time.config(text=d.get("time", ""))
    self._sync_footer_height()
