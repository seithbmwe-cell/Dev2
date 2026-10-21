(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const WINDOW = 100, THRESHOLD = 7.9;

  // Last decimal digit using the market's pip_size (decimal places), never raw float math.
  function lastDigit(quote, pip) {
    const q = Number(quote);
    if (!Number.isFinite(q) || !Number.isInteger(pip) || pip < 0) return null;
    const s = q.toFixed(pip);
    return Number(s[s.length - 1]);
  }
  const qualifies = (pct) => pct < THRESHOLD; // strict

  function analyze(digits) {
    const counts = Array(10).fill(0);
    digits.forEach((d) => { counts[d]++; });
    const ready = digits.length === WINDOW;
    const pct = counts.map((c) => (c / WINDOW) * 100);
    let sel = null;
    if (ready) for (let d = 0; d < 10; d++) {
      if (!qualifies(pct[d])) continue;
      if (sel === null || counts[d] < counts[sel]) sel = d; // strict < keeps smallest digit on ties
    }
    return { ready, counts, pct, sel };
  }

  class TickWindow {
    constructor() { this.reset(); }
    reset() { this.digits = []; this.seen = new Set(); this.last = null; }
    push(t) {
      if (!t || !Number.isFinite(Number(t.quote)) || t.epoch == null) return false;
      const d = lastDigit(t.quote, t.pip_size);
      if (d === null) return false;
      const key = t.id || String(t.epoch) + ':' + t.quote;
      if (this.seen.has(key)) return false;
      this.seen.add(key);
      if (this.seen.size > 500) this.seen = new Set([...this.seen].slice(-200));
      this.digits.push(d);
      if (this.digits.length > WINDOW) this.digits.shift();
      this.last = { quote: t.quote, digit: d };
      return true;
    }
    get full() { return this.digits.length === WINDOW; }
  }

  function validateLimits(l) {
    const ok = (v) => Number.isFinite(v) && v > 0;
    if (!ok(l.stake)) return 'Stake must be > 0';
    if (!Number.isInteger(l.maxTrades) || l.maxTrades < 1) return 'Max trades must be a whole number >= 1';
    if (!ok(l.stopLoss)) return 'Stop loss must be > 0';
    if (!ok(l.target)) return 'Profit target must be > 0';
    if (!Number.isInteger(l.maxConsec) || l.maxConsec < 1) return 'Max consecutive losses must be >= 1';
    return null;
  }

  class Risk {
    constructor(l) { this.l = l; this.trades = 0; this.wins = 0; this.losses = 0; this.net = 0; this.consec = 0; }
    stopReason() {
      const l = this.l;
      if (this.trades >= l.maxTrades) return 'Max trades reached';
      if (this.net <= -l.stopLoss) return 'Session stop loss reached';
      if (this.net >= l.target) return 'Profit target reached';
      if (this.consec >= l.maxConsec) return 'Max consecutive losses reached';
      return null;
    }
    onPurchased() { this.trades++; }
    onSettled(profit) { // only called for settled contracts
      this.net = Math.round((this.net + profit) * 100) / 100;
      if (profit > 0) { this.wins++; this.consec = 0; } else { this.losses++; this.consec++; }
    }
  }

  const isDemo = (acc) => !!acc && acc.account_type === 'demo'; // anything else fails closed

  // Controller. `api` = { proposal(params), buy(id, price) } (both Promises). Stake is fixed.
  class Bot {
    constructor(api, limits, log) {
      this.api = api; this.limits = limits; this.log = log || (() => {});
      this.risk = new Risk(limits); this.win = new TickWindow();
      this.state = 'DISCONNECTED'; this.connected = false; this.demo = false;
      this.running = false; this.busy = false; this.symbol = null; this.currency = 'USD'; this.contractId = null;
    }
    setAccount(acc) {
      if (!isDemo(acc)) { this.log('Rejected: account is not a verified demo account'); this.disconnect(); return false; }
      this.demo = true; this.connected = true; this.currency = acc.currency || 'USD'; this.state = 'CONNECTED_DEMO'; return true;
    }
    disconnect() { this.running = false; this.connected = false; this.demo = false; this.state = 'DISCONNECTED'; }
    setMarket(sym) { this.running = false; this.win.reset(); this.symbol = sym; if (this.connected && !this.busy) this.state = 'COLLECTING_TICKS'; }
    start(limits) {
      if (!this.connected || !this.demo || !this.symbol) return false;
      if (validateLimits(limits)) return false;
      this.limits = limits; this.risk.l = limits; this.running = true;
      this.state = this.win.full ? 'READY' : 'COLLECTING_TICKS'; this.evaluate(); return true;
    }
    stop() { this.running = false; if (!this.busy) this.state = 'STOPPED'; }
    onTick(t) { if (this.win.push(t)) this.evaluate(); }
    async evaluate() {
      if (!this.running || !this.connected || !this.demo || this.busy) return;
      if (!this.win.full) { this.state = 'COLLECTING_TICKS'; return; }
      this.state = 'READY';
      const why = this.risk.stopReason();
      if (why) { this.running = false; this.state = 'STOPPED'; this.log('Safety stop: ' + why); return; }
      const { sel } = analyze(this.win.digits);
      if (sel === null) return; // no qualifying digit -> no trade
      const sym = this.symbol; this.busy = true; this.state = 'PROPOSAL_PENDING';
      const still = () => this.running && this.connected && this.demo && this.symbol === sym;
      let p;
      try {
        p = await this.api.proposal({ contract_type: 'DIGITDIFF', symbol: sym, amount: this.limits.stake, basis: 'stake',
          currency: this.currency, duration: 1, duration_unit: 't', barrier: String(sel) });
      } catch (e) { this.busy = false; this.state = this.running ? 'READY' : 'STOPPED'; this.log('Proposal error: ' + (e.message || e.code)); return; }
      if (!still() || this.risk.stopReason()) { this.busy = false; this.state = this.running ? 'READY' : 'STOPPED'; return; }
      let b;
      try { b = await this.api.buy(p.id, p.ask_price); }
      catch (e) {
        if (e && e.uncertain) { this.running = false; this.state = 'HALTED_UNCERTAIN'; this.log('Buy outcome UNKNOWN - halted. Check the demo account statement before restarting.'); return; } // busy stays true
        this.busy = false; this.state = this.running ? 'READY' : 'STOPPED'; this.log('Buy rejected: ' + (e.message || e.code)); return;
      }
      this.risk.onPurchased(); this.contractId = b.contract_id; this.state = 'CONTRACT_OPEN';
      this.log('Purchased contract ' + b.contract_id + ' (barrier ' + sel + ')');
    }
    onContract(c) { // proposal_open_contract updates
      if (this.state !== 'CONTRACT_OPEN' || !c || c.contract_id !== this.contractId) return;
      if (!(c.is_sold === 1 || c.is_sold === true || c.status === 'won' || c.status === 'lost')) return;
      this.state = 'SETTLEMENT'; const profit = Number(c.profit);
      this.risk.onSettled(profit); this.contractId = null; this.busy = false;
      this.log('Settled: ' + (profit > 0 ? 'WIN ' : 'LOSS ') + profit);
      this.state = this.running ? 'READY' : 'STOPPED'; this.evaluate();
    }
  }
  return { WINDOW, THRESHOLD, lastDigit, qualifies, analyze, TickWindow, validateLimits, Risk, isDemo, Bot };
});
