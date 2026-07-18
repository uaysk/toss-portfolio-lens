import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Boxes,
  Braces,
  Check,
  CircleDollarSign,
  Gauge,
  GitCompareArrows,
  Landmark,
  LineChart,
  Orbit,
  Play,
  Search,
  ServerCog,
  Settings2,
  ShieldCheck,
  Sparkles,
  WalletCards,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type ShowcaseView = "overview" | "backtest" | "optimization";

const navItems: Array<{ id: ShowcaseView; label: string; icon: typeof Activity }> = [
  { id: "overview", label: "포트폴리오", icon: WalletCards },
  { id: "backtest", label: "백테스트", icon: GitCompareArrows },
  { id: "optimization", label: "전략 연구", icon: Orbit },
];

const linePath = "M0 130 C55 118,82 139,132 110 C184 80,221 104,270 82 C323 58,354 76,405 48 C454 22,495 55,548 28 C602 8,646 30,700 12";
const comparisonPath = "M0 138 C62 128,92 126,143 118 C198 111,244 112,300 99 C352 91,405 88,457 79 C510 70,558 72,612 60 C648 53,676 50,700 44";

function MiniLineChart({ comparison = false }: { comparison?: boolean }) {
  return (
    <svg viewBox="0 0 700 170" className="h-full w-full overflow-visible" role="img" aria-label="포트폴리오 성장 경로 예시">
      <defs>
        <linearGradient id="readme-area" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="white" stopOpacity="0.22" />
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[34, 68, 102, 136].map((y) => <line key={y} x1="0" x2="700" y1={y} y2={y} stroke="white" strokeOpacity="0.055" />)}
      <path d={`${linePath} L700 170 L0 170 Z`} fill="url(#readme-area)" />
      {comparison ? <path d={comparisonPath} fill="none" stroke="#6b6b70" strokeDasharray="6 7" strokeWidth="2" /> : null}
      <path d={linePath} fill="none" stroke="#f5f5f5" strokeLinecap="round" strokeWidth="3" />
      <circle cx="700" cy="12" r="5" fill="#fafafa" />
    </svg>
  );
}

function Sidebar({ view }: { view: ShowcaseView }) {
  return (
    <aside className="flex h-[876px] w-[220px] shrink-0 flex-col rounded-[30px] bg-[#111112] px-4 py-5 text-white">
      <div className="flex items-center gap-3 px-2">
        <div className="grid size-10 place-items-center rounded-2xl bg-white text-black"><LineChart className="size-5" /></div>
        <div><p className="text-[13px] font-black tracking-[-0.03em]">Portfolio Lens</p><p className="mt-0.5 text-[9px] font-semibold text-zinc-500">RUST COMPUTE</p></div>
      </div>
      <nav className="mt-10 space-y-1.5">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.id} className={cn("flex h-11 items-center gap-3 rounded-2xl px-3 text-xs font-bold", item.id === view ? "bg-white text-black" : "text-zinc-500")}>
              <Icon className="size-4" />{item.label}
            </div>
          );
        })}
      </nav>
      <div className="mt-7 px-3 text-[9px] font-bold uppercase tracking-[0.16em] text-zinc-700">Workspace</div>
      <div className="mt-3 space-y-1.5">
        <div className="flex h-10 items-center gap-3 rounded-2xl px-3 text-[11px] font-semibold text-zinc-500"><Braces className="size-4" />MCP tools</div>
        <div className="flex h-10 items-center gap-3 rounded-2xl px-3 text-[11px] font-semibold text-zinc-500"><ServerCog className="size-4" />Run history</div>
      </div>
      <div className="mt-auto rounded-[22px] bg-[#1b1b1d] p-4">
        <div className="flex items-center gap-2 text-[10px] font-bold text-zinc-300"><span className="size-1.5 rounded-full bg-zinc-200" />Compute online</div>
        <p className="mt-2 text-[9px] leading-4 text-zinc-600">Node control plane<br />Rust worker · UDS</p>
      </div>
    </aside>
  );
}

function Topbar({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return (
    <header className="flex items-start justify-between gap-8">
      <div>
        <p className="text-[10px] font-black uppercase tracking-[0.17em] text-zinc-500">{eyebrow}</p>
        <h1 className="mt-3 text-[34px] font-black tracking-[-0.055em] text-zinc-50">{title}</h1>
        <p className="mt-2 text-[11px] text-zinc-500">{description}</p>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" className="bg-[#1a1a1c] text-zinc-300 hover:bg-[#222225]"><Search />종목 검색</Button>
        <Button size="sm" className="bg-zinc-100 text-black hover:bg-white"><Play className="fill-current" />실행</Button>
      </div>
    </header>
  );
}

function Metric({ label, value, trend, muted = false }: { label: string; value: string; trend?: string; muted?: boolean }) {
  return (
    <div className={cn("rounded-[22px] p-5", muted ? "bg-[#111112]" : "bg-[#171719]")}>
      <p className="text-[9px] font-bold uppercase tracking-[0.1em] text-zinc-600">{label}</p>
      <div className="mt-4 flex items-end justify-between gap-3">
        <strong className="text-[24px] font-black tracking-[-0.05em] text-zinc-100">{value}</strong>
        {trend ? <span className="mb-1 text-[9px] font-bold text-zinc-400">{trend}</span> : null}
      </div>
    </div>
  );
}

function Overview() {
  const holdings = [
    ["005930", "삼성전자", "28.4%", "+18.7%"],
    ["AAPL", "Apple", "24.1%", "+31.2%"],
    ["069500", "KODEX 200", "19.6%", "+11.4%"],
    ["QQQ", "Invesco QQQ", "17.9%", "+27.8%"],
  ];
  return (
    <>
      <Topbar eyebrow="Portfolio intelligence" title="하나의 기준통화로 보는 투자 성과" description="국내·해외 보유자산, 과거 환율과 현금흐름을 같은 시간축에서 분석합니다." />
      <section className="mt-7 grid grid-cols-[1.35fr_.65fr] gap-3">
        <Card className="overflow-hidden bg-[#111112]">
          <CardHeader className="flex-row items-start justify-between space-y-0 p-6 pb-0">
            <div><p className="text-[10px] font-bold text-zinc-600">총 평가금액</p><CardTitle className="mt-2 text-[30px] font-black tracking-[-0.055em]">₩128,420,000</CardTitle><p className="mt-2 flex items-center gap-1 text-[10px] font-bold text-zinc-300"><ArrowUpRight className="size-3" />+18.42% · ₩19,980,000</p></div>
            <span className="rounded-full bg-[#202023] px-3 py-2 text-[9px] font-bold text-zinc-400">2022.08 — 2026.07</span>
          </CardHeader>
          <CardContent className="h-[235px] px-6 pb-5 pt-4"><MiniLineChart comparison /></CardContent>
          <div className="flex gap-5 px-6 pb-5 text-[9px] font-semibold text-zinc-500"><span className="flex items-center gap-2"><i className="size-2 rounded-full bg-zinc-100" />Portfolio</span><span className="flex items-center gap-2"><i className="size-2 rounded-full bg-zinc-600" />S&amp;P 500 · KRW</span></div>
        </Card>
        <div className="grid grid-cols-2 gap-3">
          <Metric label="TWR" value="18.42%" trend="+7.6%p" />
          <Metric label="XIRR" value="19.08%" trend="현금흐름 반영" muted />
          <Metric label="Max drawdown" value="−8.31%" trend="64일" muted />
          <Metric label="Sharpe" value="1.46" trend="RF 2.5%" />
        </div>
      </section>
      <section className="mt-3 grid grid-cols-[1.1fr_.9fr] gap-3">
        <Card className="bg-[#111112]">
          <CardHeader className="flex-row items-center justify-between space-y-0 px-6 pb-3 pt-5"><div><CardTitle className="text-sm">보유 종목</CardTitle><p className="mt-1 text-[9px] text-zinc-600">수정주가 · 과거 USD/KRW 환율 반영</p></div><span className="text-[9px] font-bold text-zinc-600">6 assets</span></CardHeader>
          <CardContent className="px-6 pb-4">
            {holdings.map(([symbol, name, weight, gain]) => <div key={symbol} className="grid grid-cols-[72px_1fr_68px_68px] items-center py-2.5 text-[10px]"><code className="font-bold text-zinc-300">{symbol}</code><span className="font-semibold text-zinc-500">{name}</span><span className="text-right font-bold text-zinc-300">{weight}</span><span className="text-right font-bold text-zinc-300">{gain}</span></div>)}
          </CardContent>
        </Card>
        <Card className="bg-[#111112]">
          <CardHeader className="px-6 pb-3 pt-5"><CardTitle className="text-sm">데이터 품질</CardTitle></CardHeader>
          <CardContent className="space-y-3 px-6 pb-5">
            {[["공통 수익률 관측", "938일", "96%"], ["환율 관측", "1,012일", "99%"], ["실제 거래일", "carry-forward 분리", "100%"]].map(([label, value, rate]) => <div key={label}><div className="flex justify-between text-[9px]"><span className="text-zinc-600">{label}</span><strong className="text-zinc-300">{value}</strong></div><div className="mt-2 h-1.5 rounded-full bg-[#242427]"><div className="h-full rounded-full bg-zinc-300" style={{ width: rate }} /></div></div>)}
          </CardContent>
        </Card>
      </section>
    </>
  );
}

function Backtest() {
  return (
    <>
      <Topbar eyebrow="Feature-complete ledger" title="현실적인 포트폴리오 경로를 재현" description="환율, 비용, 정수 수량, 잔여 현금과 리밸런싱을 하나의 Rust ledger에서 계산합니다." />
      <section className="mt-7 grid grid-cols-[310px_1fr] gap-3">
        <Card className="bg-[#111112]">
          <CardHeader className="px-5 pb-3 pt-5"><div className="flex items-center justify-between"><CardTitle className="text-sm">실행 설정</CardTitle><Settings2 className="size-4 text-zinc-600" /></div></CardHeader>
          <CardContent className="space-y-3 px-5 pb-5">
            {[["기간", "2022. 08. 30 — 2026. 07. 16"], ["초기 투자금", "₩100,000,000"], ["리밸런싱", "분기 · 이탈 5%"], ["거래비용", "15 bps"], ["수량 방식", "정수 수량"], ["현금 목표", "5.0%"]].map(([label, value]) => <div key={label} className="rounded-2xl bg-[#1a1a1c] px-4 py-3"><p className="text-[8px] font-bold uppercase tracking-[0.1em] text-zinc-600">{label}</p><p className="mt-1.5 text-[10px] font-bold text-zinc-300">{value}</p></div>)}
            <div className="flex items-center gap-2 rounded-2xl bg-zinc-100 px-4 py-3 text-[10px] font-black text-black"><Check className="size-4" />과거 USD/KRW 환율 반영</div>
          </CardContent>
        </Card>
        <div className="space-y-3">
          <Card className="bg-[#111112]">
            <CardHeader className="flex-row items-start justify-between space-y-0 px-6 pb-0 pt-5"><div><p className="text-[9px] font-bold text-zinc-600">순자산 성장</p><CardTitle className="mt-2 text-[26px] font-black">₩146,820,000</CardTitle></div><div className="text-right"><p className="text-[9px] text-zinc-600">CAGR</p><p className="mt-1 text-sm font-black text-zinc-100">10.31%</p></div></CardHeader>
            <CardContent className="h-[230px] px-6 pb-5 pt-3"><MiniLineChart comparison /></CardContent>
          </Card>
          <div className="grid grid-cols-4 gap-3">
            <Metric label="Net return" value="46.82%" trend="비용 후" />
            <Metric label="Cost drag" value="−0.41%" trend="₩438K" muted />
            <Metric label="XIRR" value="11.02%" trend="cash flows" muted />
            <Metric label="Cash" value="5.16%" trend="residual" />
          </div>
          <Card className="bg-[#111112]">
            <CardContent className="grid grid-cols-4 gap-3 p-5">
              {[{ icon: CircleDollarSign, t: "거래비용", d: "매 체결 즉시 현금 차감" }, { icon: Boxes, t: "정수 수량", d: "잔여 현금까지 추적" }, { icon: Gauge, t: "임계치", d: "목표 비중 이탈 감지" }, { icon: Activity, t: "XIRR", d: "불규칙 현금흐름 반영" }].map(({ icon: Icon, t, d }) => <div key={t} className="rounded-[18px] bg-[#1a1a1c] p-4"><Icon className="size-4 text-zinc-300" /><p className="mt-4 text-[10px] font-black text-zinc-300">{t}</p><p className="mt-1 text-[8px] leading-4 text-zinc-600">{d}</p></div>)}
            </CardContent>
          </Card>
        </div>
      </section>
    </>
  );
}

function Optimization() {
  const points = [[6, 88], [13, 74], [20, 63], [28, 54], [36, 47], [45, 40], [55, 34], [66, 29], [77, 25], [88, 22]];
  return (
    <>
      <Topbar eyebrow="Parallel strategy search" title="제약 안에서 더 나은 조합을 탐색" description="결정적 후보 생성, Pareto frontier와 Walk-forward 검증을 Rust/Rayon으로 병렬 실행합니다." />
      <section className="mt-7 grid grid-cols-[1fr_330px] gap-3">
        <Card className="bg-[#111112]">
          <CardHeader className="flex-row items-start justify-between space-y-0 px-6 pb-0 pt-5"><div><CardTitle className="text-sm">위험 · 수익 Pareto frontier</CardTitle><p className="mt-1 text-[9px] text-zinc-600">1,000 deterministic candidates · KRW return</p></div><span className="rounded-full bg-[#202023] px-3 py-2 text-[9px] font-bold text-zinc-400">robust score</span></CardHeader>
          <CardContent className="relative h-[390px] px-8 pb-8 pt-8">
            <div className="absolute bottom-8 left-8 top-8 w-px bg-white/5" /><div className="absolute bottom-8 left-8 right-8 h-px bg-white/5" />
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full overflow-visible">
              <path d="M6 88 C18 66,32 50,45 40 C61 29,73 26,88 22" fill="none" stroke="#fafafa" strokeWidth="1" vectorEffect="non-scaling-stroke" />
              {points.map(([x, y], index) => <circle key={x} cx={x} cy={y} r={index === 7 ? 2.2 : 1.2} fill={index === 7 ? "#fff" : "#77777d"} vectorEffect="non-scaling-stroke" />)}
              {Array.from({ length: 28 }, (_, index) => <circle key={`f-${index}`} cx={8 + (index * 17) % 82} cy={28 + (index * 29) % 65} r="0.55" fill="#454549" />)}
            </svg>
            <div className="absolute bottom-2 left-1/2 text-[8px] font-bold uppercase tracking-widest text-zinc-700">Annualized volatility →</div>
            <div className="absolute left-0 top-1/2 -rotate-90 text-[8px] font-bold uppercase tracking-widest text-zinc-700">Return →</div>
          </CardContent>
        </Card>
        <div className="space-y-3">
          <Card className="bg-zinc-100 text-black">
            <CardHeader className="px-5 pb-2 pt-5"><p className="text-[9px] font-black uppercase tracking-[0.13em] text-zinc-500">Selected portfolio</p><CardTitle className="mt-2 text-[22px] font-black tracking-[-0.045em]">Max robust score</CardTitle></CardHeader>
            <CardContent className="px-5 pb-5">
              <div className="grid grid-cols-2 gap-2">{[["Return", "13.8%"], ["Volatility", "11.2%"], ["Sharpe", "1.09"], ["CVaR 95", "−2.7%"]].map(([a, b]) => <div key={a} className="rounded-2xl bg-black/5 p-3"><p className="text-[8px] font-bold text-zinc-500">{a}</p><p className="mt-1 text-sm font-black">{b}</p></div>)}</div>
              <Button className="mt-4 w-full bg-black text-white hover:bg-zinc-800" size="sm">비중 적용<ArrowRight /></Button>
            </CardContent>
          </Card>
          <Card className="bg-[#111112]">
            <CardContent className="p-5">
              <div className="flex items-center justify-between"><div className="flex items-center gap-2 text-[10px] font-black"><Zap className="size-4" />Rust worker</div><span className="text-[9px] font-bold text-zinc-500">p50</span></div>
              <div className="mt-5 flex items-end gap-2"><strong className="text-[31px] font-black tracking-[-0.06em]">90.999</strong><span className="mb-1 text-[10px] text-zinc-600">ms compute</span></div>
              <div className="mt-4 rounded-2xl bg-[#1a1a1c] p-3"><div className="flex justify-between text-[9px]"><span className="text-zinc-600">vs Node.js</span><strong className="text-zinc-200">64.589×</strong></div><div className="mt-2 flex justify-between text-[9px]"><span className="text-zinc-600">UDS end-to-end</span><strong className="text-zinc-200">49.521×</strong></div></div>
            </CardContent>
          </Card>
        </div>
      </section>
      <section className="mt-3 grid grid-cols-4 gap-3">
        {[{ icon: BarChart3, title: "제약 최적화", text: "비중·종목수·회전율·목표수익" }, { icon: Landmark, title: "Walk-forward", text: "train / OOS fold와 안정성" }, { icon: Sparkles, title: "Monte Carlo", text: "상관 보존 block bootstrap" }, { icon: ShieldCheck, title: "결정적 검증", text: "seed·계약·수치 동등성" }].map(({ icon: Icon, title, text }) => <Card key={title} className="bg-[#111112]"><CardContent className="p-5"><Icon className="size-4 text-zinc-300" /><p className="mt-4 text-[10px] font-black">{title}</p><p className="mt-1 text-[8px] text-zinc-600">{text}</p></CardContent></Card>)}
      </section>
    </>
  );
}

export function ReadmeShowcase() {
  const requested = new URLSearchParams(window.location.search).get("view");
  const view: ShowcaseView = requested === "backtest" || requested === "optimization" ? requested : "overview";
  return (
    <main className="min-h-screen bg-[#050505] p-3 text-zinc-100" data-showcase-view={view}>
      <div className="mx-auto flex h-[876px] w-[1416px] gap-3 overflow-hidden rounded-[36px] bg-[#09090a] p-3 shadow-2xl shadow-black">
        <Sidebar view={view} />
        <section className="min-w-0 flex-1 overflow-hidden rounded-[30px] bg-[#0d0d0e] px-8 py-7">
          {view === "overview" ? <Overview /> : view === "backtest" ? <Backtest /> : <Optimization />}
        </section>
      </div>
    </main>
  );
}
