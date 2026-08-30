"""HUD presentation: command/status center and footer rendering."""

from datetime import datetime, timezone

from data import fmt_money as _fmt_money, fmt_tokens as _fmt_tokens, ts_to_dt as _ts_to_dt
from theme import C

def render(self, d):
    cmd = d.get("command", "")
    tool = d.get("tool", "")
    cmd_ts = d.get("cmd_ts", "")
    last_act = d.get("last_act_ts", "")
    tokens = d.get("tokens", {})
    thinking = d.get("thinking", "—")
    provider = d.get("provider", "—")
    auth_ok = d.get("auth_ok")
    model = d.get("model", "—")
    now = datetime.now(timezone.utc)

    # 状态判断：基于最近活动时间
    act_dt = _ts_to_dt(last_act)
    cmd_dt = _ts_to_dt(cmd_ts)
    is_active = False
    if act_dt:
        secs = (now - act_dt).total_seconds()
        is_active = secs < 60  # 60s 内算活跃
    elif cmd_dt:
        secs = (now - cmd_dt).total_seconds()
        is_active = secs < 60

    if is_active and cmd:
        self.lbl_status.config(text="RUNNING", fg=C["cyan"])
        txt = f"▶ {tool}: {cmd}" if tool else cmd
        if len(txt) > 120:
            txt = txt[:117] + "…"
        self.lbl_cmd.config(text=txt)
    elif is_active:
        self.lbl_status.config(text="THINKING", fg=C["purple"])
        self.lbl_cmd.config(text="(generating…)")
    else:
        self.lbl_status.config(text="IDLE", fg=C["dim"])
        self.lbl_cmd.config(text="(idle)")

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
    self.txt_footer.insert("end", _fmt_money(cost), "cost")
    # 全选文字加上 body tag 预留下伸空间
    self.txt_footer.tag_add("body", "1.0", "end")
    self.txt_footer.config(state="disabled")
    self.lbl_time.config(text=d.get("time", ""))
    self._sync_footer_height()
