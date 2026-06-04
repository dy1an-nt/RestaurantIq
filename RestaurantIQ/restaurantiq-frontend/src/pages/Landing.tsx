import { Link } from 'react-router-dom';
import Logo from '../components/Logo';
import Icon, { IconName } from '../components/Icons';
import RevenueTrendChart from '../components/charts/RevenueTrendChart';
import TopItemsChart from '../components/charts/TopItemsChart';
import SalesHeatmap from '../components/charts/SalesHeatmap';

/* ──────────────────────────────────────────────────────────────────────────
 * Sample marketing data — illustrative only (this is a public landing page,
 * not a signed-in view). Mirrors the real chart-component prop shapes.
 * ────────────────────────────────────────────────────────────────────────── */

const SAMPLE_TREND = [
  8200, 7600, 9100, 8800, 10200, 9600, 11400, 10800, 12100, 11600, 12800, 12300,
].map((dollars, i) => ({
  date: `2026-05-${String(i * 2 + 1).padStart(2, '0')}`,
  revenue_cents: dollars * 100,
}));

const SAMPLE_TOP = [
  { name: 'Wood-Fired Margherita', revenue_cents: 1184000, orders: 740 },
  { name: 'Short Rib Pappardelle', revenue_cents: 912800, orders: 326 },
  { name: 'Burrata & Heirloom', revenue_cents: 762000, orders: 508 },
  { name: 'Crispy Calamari', revenue_cents: 634200, orders: 453 },
  { name: 'Tuscan Kale Caesar', revenue_cents: 516100, orders: 397 },
  { name: 'Truffle Fries', revenue_cents: 387000, orders: 430 },
];

const SAMPLE_HEAT = (() => {
  const out: { day: number; hour: number; revenue_cents: number; orders: number }[] = [];
  for (let day = 0; day < 7; day++) {
    for (let hour = 11; hour <= 22; hour++) {
      const peak = hour >= 18 && hour <= 20;
      const weekend = day === 5 || day === 6;
      let orders = (hour - 9) * 2;
      if (peak) orders *= 3;
      if (weekend) orders = Math.round(orders * 1.4);
      out.push({ day, hour, orders, revenue_cents: orders * 1600 });
    }
  }
  return out;
})();

/* ── Brand wordmark ── */
const Wordmark = ({ footer = false }: { footer?: boolean }) => (
  <span className="text-[18px] font-extrabold tracking-[-0.03em]">
    Restaurant<span className={footer ? 'text-[#9db8d6]' : 'text-navy-700'}>IQ</span>
  </span>
);

/* ── Light browser frame wrapping the product mock ── */
const ProductShot = () => (
  <div className="rounded-lg overflow-hidden bg-surface border border-line shadow-shot">
    {/* chrome */}
    <div className="h-11 flex-shrink-0 bg-canvas border-b border-line flex items-center gap-[14px] px-4">
      <div className="flex gap-[7px]">
        {['#e2655a', '#e8b13e', '#3fae6b'].map((c) => (
          <span key={c} className="w-[11px] h-[11px] rounded-full opacity-90" style={{ background: c }} />
        ))}
      </div>
      <div className="flex-1 max-w-[360px] mx-auto h-7 rounded-lg bg-surface border border-line flex items-center justify-center gap-2 text-[12.5px] font-semibold text-ink-3">
        <Icon name="lock" size={12} strokeWidth={1.8} /> app.restaurantiq.com/dashboard
      </div>
      <div className="w-[52px]" />
    </div>
    {/* mock content */}
    <div className="p-5 bg-canvas">
      <div className="text-[15px] font-extrabold tracking-[-0.02em] text-ink">Menu Performance</div>
      <div className="text-xs text-ink-3 mt-0.5 mb-3">Bella Trattoria · Downtown · Last 30 days</div>
      <div className="grid grid-cols-4 gap-2.5 mb-3">
        {[
          { l: '30-Day Revenue', v: '$56,419', i: 'margins' as IconName },
          { l: 'Orders', v: '3,663', i: 'analytics' as IconName },
          { l: 'Avg. Order', v: '$15.40', i: 'dashboard' as IconName },
          { l: 'Items', v: '124', i: 'integrations' as IconName },
        ].map((k) => (
          <div key={k.l} className="bg-surface border border-line rounded p-2.5">
            <div className="w-7 h-7 rounded-md bg-navy-50 text-navy-700 flex items-center justify-center mb-2">
              <Icon name={k.i} size={15} />
            </div>
            <div className="text-[8.5px] font-bold uppercase tracking-wide text-ink-3">{k.l}</div>
            <div className="text-[15px] font-extrabold text-ink tnum">{k.v}</div>
          </div>
        ))}
      </div>
      <div className="bg-surface border border-line rounded overflow-hidden">
        {[
          ['Wood-Fired Margherita', '$11,840', 'up'],
          ['Short Rib Pappardelle', '$9,128', 'up'],
          ['Burrata & Heirloom', '$7,620', 'flat'],
          ['Truffle Fries', '$3,870', 'down'],
        ].map(([name, rev, trend], idx) => (
          <div
            key={name}
            className={`flex items-center justify-between px-3 py-2 text-xs ${idx > 0 ? 'border-t border-line-2' : ''}`}
            style={{ boxShadow: trend === 'up' ? 'inset 3px 0 0 #2f7a5b' : trend === 'down' ? 'inset 3px 0 0 #b25140' : undefined }}
          >
            <span className="font-bold text-ink">{name}</span>
            <span className="flex items-center gap-2">
              <span className="font-bold text-ink tnum">{rev}</span>
              <span
                className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold ${
                  trend === 'up' ? 'bg-pos-bg text-pos' : trend === 'down' ? 'bg-neg-bg text-neg' : 'bg-canvas text-ink-3'
                }`}
              >
                <Icon name={trend === 'up' ? 'arrowUp' : trend === 'down' ? 'arrowDown' : 'flat'} size={10} strokeWidth={2} />
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  </div>
);

/* ── Sections ── */
const TopNav = () => (
  <nav className="sticky top-0 z-40 bg-white/[0.86] backdrop-blur-md backdrop-saturate-150 border-b border-line">
    <div className="max-w-[1200px] mx-auto px-10 flex items-center h-[70px] gap-[14px]">
      <div className="flex items-center gap-[11px]">
        <Logo size={28} on="navy" />
        <Wordmark />
      </div>
      <div className="hidden md:flex items-center gap-1 ml-[18px]">
        {[
          ['Features', '#features'],
          ['How it works', '#how'],
          ['Analytics', '#analytics'],
        ].map(([label, href]) => (
          <a key={href} href={href} className="px-[14px] py-2 rounded-lg text-[14.5px] font-semibold text-ink-2 hover:text-ink hover:bg-canvas transition-colors">
            {label}
          </a>
        ))}
      </div>
      <div className="ml-auto flex items-center gap-2">
        <Link to="/login" className="px-3 text-[14.5px] font-semibold text-ink-2 hover:text-ink whitespace-nowrap">
          Sign in
        </Link>
        <Link to="/signup" className="inline-flex items-center h-[42px] px-[18px] rounded-[9px] bg-navy-700 text-white text-[14.5px] font-bold hover:bg-navy-800 hover:-translate-y-px transition-all whitespace-nowrap">
          Get started free
        </Link>
      </div>
    </div>
  </nav>
);

const Eyebrow = ({ children, navy = false, center = false }: { children: React.ReactNode; navy?: boolean; center?: boolean }) => (
  <span className={`inline-flex items-center gap-2 text-[12.5px] font-bold tracking-[0.12em] uppercase whitespace-nowrap ${navy ? 'text-[#9db8d6]' : 'text-navy-600'} ${center ? 'justify-center' : ''}`}>
    <span className={`inline-block w-[18px] h-[1.5px] ${navy ? 'bg-[#9db8d6]' : 'bg-navy-500'}`} />
    {children}
  </span>
);

const Hero = () => (
  <section className="relative overflow-hidden pt-[76px] pb-[86px]">
    <div className="max-w-[1200px] mx-auto px-10 grid grid-cols-1 lg:grid-cols-[1fr_1.04fr] gap-14 items-center">
      <div>
        <div className="mb-[22px]"><Eyebrow>Restaurant analytics, made plain</Eyebrow></div>
        <h1 className="text-[44px] sm:text-[62px] font-extrabold tracking-tightest leading-[1.04] text-ink mb-[22px]">
          Know which dishes make you money.
        </h1>
        <p className="text-[19px] leading-[1.55] font-medium text-ink-2 max-w-[34ch] mb-8">
          RestaurantIQ syncs your POS and delivery orders, then turns the numbers into clear decisions — what to feature, reprice, or cut.
        </p>
        <div className="flex items-center gap-3 mb-[26px]">
          <Link to="/signup" className="inline-flex items-center justify-center gap-2 h-[50px] px-[26px] rounded-[10px] bg-navy-700 text-white text-[15.5px] font-bold hover:bg-navy-800 hover:-translate-y-px transition-all">
            Get started free
            <Icon name="arrowUp" size={17} strokeWidth={2} style={{ transform: 'rotate(90deg)' }} />
          </Link>
          <a href="#how" className="inline-flex items-center justify-center h-[50px] px-[26px] rounded-[10px] border border-line text-ink font-bold text-[15.5px] hover:bg-canvas hover:border-ink-3 transition-colors">
            See how it works
          </a>
        </div>
        <div className="flex items-center gap-[18px] text-[13.5px] font-semibold text-ink-3">
          {['No card required', 'Connects in minutes'].map((t) => (
            <span key={t} className="inline-flex items-center gap-[7px] whitespace-nowrap">
              <Icon name="check" size={16} strokeWidth={2.2} className="text-pos" /> {t}
            </span>
          ))}
        </div>
      </div>
      <div className="relative">
        <div className="absolute -inset-y-[10%] -right-[40%] left-0 -z-0" style={{ background: 'radial-gradient(60% 60% at 70% 40%, rgba(30,58,95,.10), transparent 70%)' }} />
        <div className="relative z-[2]"><ProductShot /></div>
      </div>
    </div>
  </section>
);

const ProofBar = () => {
  const marks: [string, IconName][] = [
    ['Bella Trattoria', 'store'],
    ['Harborline', 'margins'],
    ['Saffron & Co.', 'star'],
    ['The Mason Room', 'dashboard'],
    ['Pier 9 Kitchen', 'marketing'],
  ];
  return (
    <section className="pt-[46px] pb-2.5">
      <div className="max-w-[1200px] mx-auto px-10">
        <p className="text-center text-[13px] font-semibold text-ink-3 mb-[26px]">
          Trusted by independent restaurants and small groups
        </p>
        <div className="flex items-center justify-center gap-x-14 gap-y-6 flex-wrap opacity-75">
          {marks.map(([name, icon]) => (
            <span key={name} className="flex items-center gap-2.5 text-ink-2 font-extrabold text-[17px] tracking-[-0.02em]">
              <Icon name={icon} size={20} className="text-navy-600" /> {name}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
};

const SectionHead = ({ eyebrow, title, body, center = false, navy = false }: { eyebrow: string; title: string; body: string; center?: boolean; navy?: boolean }) => (
  <div className={`max-w-[720px] ${center ? 'mx-auto text-center' : ''}`}>
    <div className="mb-[18px]"><Eyebrow navy={navy} center={center}>{eyebrow}</Eyebrow></div>
    <h2 className={`text-[34px] sm:text-[44px] font-extrabold tracking-tightest leading-[1.04] mb-[18px] ${navy ? 'text-white' : 'text-ink'}`}>{title}</h2>
    <p className={`text-[18px] leading-[1.55] font-medium ${navy ? 'text-white/[0.74]' : 'text-ink-2'}`}>{body}</p>
  </div>
);

const FeatureCard = ({ icon, title, body, span, children }: { icon: IconName; title: string; body: string; span: 'big' | 'sm'; children?: React.ReactNode }) => (
  <div className={`border border-line rounded-2xl p-7 bg-surface flex flex-col ${span === 'big' ? 'sm:col-span-3' : 'sm:col-span-2'}`}>
    <div className="w-[46px] h-[46px] rounded-xl bg-navy-50 text-navy-700 flex items-center justify-center mb-5">
      <Icon name={icon} size={23} />
    </div>
    <h3 className="text-xl font-extrabold tracking-tighter mb-[9px] text-ink">{title}</h3>
    <p className="text-[15px] leading-[1.55] font-medium text-ink-2">{body}</p>
    {children && <div className="mt-[22px] border-t border-line-2 pt-[18px]">{children}</div>}
  </div>
);

const Features = () => (
  <section id="features" className="py-[100px]">
    <div className="max-w-[1200px] mx-auto px-10">
      <SectionHead
        eyebrow="Everything in one place"
        title="Your numbers, finally working for you."
        body="Stop stitching together POS reports and delivery dashboards. RestaurantIQ brings it together and tells you what matters."
      />
      <div className="grid grid-cols-1 sm:grid-cols-6 gap-[22px] mt-[54px]">
        <FeatureCard icon="integrations" title="Connect once, synced forever" body="Link your POS and delivery apps in minutes. Orders, items, and prices stay current automatically — no spreadsheets, no exports." span="big">
          <div className="flex gap-2 flex-wrap">
            {['Square', 'Toast', 'DoorDash', 'Uber Eats'].map((t) => (
              <span key={t} className="text-xs font-bold px-[11px] py-[5px] rounded-sm bg-canvas text-ink-2">{t}</span>
            ))}
            <span className="text-xs font-bold px-[11px] py-[5px] rounded-sm bg-pos-bg text-pos inline-flex items-center gap-1">
              <Icon name="check" size={12} strokeWidth={2.4} /> Synced 4 min ago
            </span>
          </div>
        </FeatureCard>
        <FeatureCard icon="dashboard" title="See what actually sells" body="Every item ranked by revenue, orders, and trend — so you know what to feature, what to fix, and what to quietly retire." span="big">
          <div className="flex flex-col gap-[9px]">
            {([['Wood-Fired Margherita', 100, '+14%', false], ['Short Rib Pappardelle', 78, '+9%', false], ['Truffle Fries', 34, '-12%', true]] as const).map(([name, w, pct, neg]) => (
              <div key={name} className="flex items-center gap-[11px] text-[13px]">
                <span className="font-bold text-ink flex-1">{name}</span>
                <span className="block h-2 rounded w-[92px] bg-canvas overflow-hidden">
                  <i className="block h-full bg-navy-600 rounded" style={{ width: `${w}%` }} />
                </span>
                <span className={`tnum font-bold w-[42px] text-right ${neg ? 'text-neg' : 'text-pos'}`}>{pct}</span>
              </div>
            ))}
          </div>
        </FeatureCard>
        <FeatureCard icon="margins" title="Know your true margins" body="Add item costs once and see real profit per dish — not just sales." span="sm">
          <div className="flex items-end gap-[5px] h-14">
            {[40, 55, 48, 62, 70, 66, 82, 90].map((h, i) => (
              <i key={i} className={`flex-1 rounded-t ${i >= 6 ? 'bg-navy-700' : 'bg-navy-100'}`} style={{ height: `${h}%` }} />
            ))}
          </div>
        </FeatureCard>
        <FeatureCard icon="insights" title="Plain-English insights" body="Specific suggestions, written for owners — not analysts." span="sm">
          <div className="flex gap-3 items-start p-[13px] rounded bg-canvas border border-line-2">
            <span className="w-[30px] h-[30px] rounded-md bg-surface border border-line flex items-center justify-center text-navy-700 flex-shrink-0">
              <Icon name="insights" size={17} />
            </span>
            <span className="text-[12.5px] leading-[1.45] text-ink-2 font-medium">
              <b className="text-ink font-bold">Reprice Tuscan Kale Caesar.</b> Orders are up 18% but it's your lowest-margin entrée — a $1 increase adds ~$390/mo.
            </span>
          </div>
        </FeatureCard>
        <FeatureCard icon="alerts" title="Never miss a shift" body="Quiet alerts when a top seller dips or a slow night needs a push." span="sm">
          <div className="flex gap-2 flex-wrap">
            <span className="text-xs font-bold px-[11px] py-[5px] rounded-sm bg-warn-bg text-warn inline-flex items-center gap-1">
              <Icon name="attention" size={12} strokeWidth={2} /> Tiramisu down 22%
            </span>
            <span className="text-xs font-bold px-[11px] py-[5px] rounded-sm bg-pos-bg text-pos inline-flex items-center gap-1">
              <Icon name="arrowUp" size={12} strokeWidth={2.2} /> Calamari trending
            </span>
          </div>
        </FeatureCard>
      </div>
    </div>
  </section>
);

const HowItWorks = () => {
  const steps: { n: string; icon: IconName; t: string; d: string }[] = [
    { n: '01', icon: 'integrations', t: 'Connect your POS', d: 'Link Square or Toast and your delivery apps in a couple of clicks. We handle the rest.' },
    { n: '02', icon: 'analytics', t: 'We crunch the numbers', d: 'RestaurantIQ analyzes every order, item, and price across the last 30+ days — automatically.' },
    { n: '03', icon: 'check', t: 'Act with confidence', d: 'Get a ranked menu and clear, specific actions you can make this week.' },
  ];
  return (
    <section id="how" className="py-[100px] bg-canvas">
      <div className="max-w-[1200px] mx-auto px-10">
        <SectionHead center eyebrow="From sign-up to insight" title="Up and running in an afternoon." body="No analysts, no setup projects. Connect your tools and RestaurantIQ does the heavy lifting." />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-7 mt-[58px]">
          {steps.map((s) => (
            <div key={s.n}>
              <div className="flex items-center gap-3 text-sm font-extrabold text-navy-700 tracking-wide mb-4">
                {s.n}<span className="flex-1 h-px bg-line" />
              </div>
              <div className="w-[54px] h-[54px] rounded-lg border border-line bg-surface flex items-center justify-center text-navy-700 mb-5">
                <Icon name={s.icon} size={24} />
              </div>
              <h3 className="text-[21px] font-extrabold tracking-tighter mb-2.5 text-ink">{s.t}</h3>
              <p className="text-[15.5px] leading-[1.55] font-medium text-ink-2">{s.d}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

const AnalyticsShowcase = () => (
  <section id="analytics" className="py-[100px]">
    <div className="max-w-[1200px] mx-auto px-10">
      <SectionHead eyebrow="The whole picture" title="Answers, not just dashboards." body="Revenue trends, your best and worst performers, and the hours that actually drive the week — all in one calm view." />
      <div className="grid grid-cols-1 lg:grid-cols-[1.5fr_1fr] gap-[22px] mt-[56px]">
        <div className="bg-surface border border-line rounded-2xl px-[26px] py-6 shadow-sm">
          <div className="flex items-baseline justify-between gap-3 mb-4">
            <h3 className="text-lg font-extrabold tracking-[-0.02em] text-ink">Revenue Trend</h3>
            <span className="text-[12.5px] font-bold text-pos whitespace-nowrap">+8.4% vs. previous 30 days</span>
          </div>
          <RevenueTrendChart data={SAMPLE_TREND} loading={false} />
        </div>
        <div className="bg-surface border border-line rounded-2xl px-[26px] py-6 shadow-sm">
          <h3 className="text-lg font-extrabold tracking-[-0.02em] text-ink mb-4">Top Items by Revenue</h3>
          <TopItemsChart data={SAMPLE_TOP} loading={false} />
        </div>
        <div className="bg-surface border border-line rounded-2xl px-[26px] py-6 shadow-sm lg:col-span-2">
          <div className="flex items-baseline justify-between gap-3 mb-4">
            <h3 className="text-lg font-extrabold tracking-[-0.02em] text-ink">Busiest Hours</h3>
            <span className="text-[12.5px] font-bold text-ink-3 whitespace-nowrap">Last 30 days · by day &amp; hour</span>
          </div>
          <SalesHeatmap data={SAMPLE_HEAT} loading={false} />
        </div>
      </div>
    </div>
  </section>
);

const FinalCTA = () => (
  <section className="py-[100px] bg-navy-700 text-white text-center">
    <div className="max-w-[1200px] mx-auto px-10">
      <Eyebrow navy center>Start today</Eyebrow>
      <h2 className="mt-[18px] text-[40px] sm:text-[52px] font-extrabold tracking-tightest leading-[1.04] max-w-[18ch] mx-auto mb-5">
        See what your menu is really telling you.
      </h2>
      <p className="text-[19px] font-medium text-white/[0.76] max-w-[46ch] mx-auto mb-[34px]">
        Connect your POS and get your first insights in minutes. Free to start — no card required.
      </p>
      <div className="flex items-center justify-center gap-3">
        <Link to="/signup" className="inline-flex items-center justify-center gap-2 h-[50px] px-[26px] rounded-[10px] bg-white text-navy-700 text-[15.5px] font-bold hover:-translate-y-px transition-transform">
          Get started free
          <Icon name="arrowUp" size={17} strokeWidth={2} style={{ transform: 'rotate(90deg)' }} />
        </Link>
        <a href="#features" className="inline-flex items-center justify-center h-[50px] px-[26px] rounded-[10px] border border-white/[0.24] bg-white/[0.06] text-white text-[15.5px] font-bold hover:bg-white/[0.12] transition-colors">
          Book a walkthrough
        </a>
      </div>
    </div>
  </section>
);

const Footer = () => {
  const cols = [
    { h: 'Product', links: ['Features', 'How it works', 'Analytics', 'Integrations'] },
    { h: 'Company', links: ['About', 'Customers', 'Careers', 'Contact'] },
    { h: 'Resources', links: ['Help center', 'Guides', 'Privacy', 'Terms'] },
  ];
  const socials: IconName[] = ['marketing', 'analytics', 'insights'];
  return (
    <footer className="bg-navy-900 text-white/[0.62] pt-[60px] pb-10">
      <div className="max-w-[1200px] mx-auto px-10 grid grid-cols-2 md:grid-cols-[1.6fr_1fr_1fr_1fr] gap-10">
        <div className="max-w-[30ch] col-span-2 md:col-span-1">
          <div className="flex items-center gap-[11px] text-white mb-4">
            <Logo size={28} on="light" /> <Wordmark footer />
          </div>
          <p className="text-[14.5px] leading-[1.6]">
            Analytics and clear decisions for independent restaurants. Sync your POS, see your numbers, grow with confidence.
          </p>
        </div>
        {cols.map((c) => (
          <div key={c.h}>
            <h4 className="text-[13px] font-bold text-white tracking-wide uppercase mb-4">{c.h}</h4>
            {c.links.map((l) => (
              <a key={l} className="block text-[14.5px] text-white/[0.66] py-1.5 font-medium hover:text-white cursor-pointer">{l}</a>
            ))}
          </div>
        ))}
      </div>
      <div className="max-w-[1200px] mx-auto px-10 border-t border-white/10 mt-[46px] pt-[26px] flex items-center justify-between text-[13.5px]">
        <span>© 2026 RestaurantIQ, Inc. All rights reserved.</span>
        <div className="flex gap-2.5">
          {socials.map((s, i) => (
            <a key={i} className="w-[34px] h-[34px] rounded-[9px] border border-white/[0.16] flex items-center justify-center text-white/70 hover:bg-white/[0.08] hover:text-white cursor-pointer">
              <Icon name={s} size={16} />
            </a>
          ))}
        </div>
      </div>
    </footer>
  );
};

const Landing = () => (
  <div className="bg-surface text-ink min-h-screen">
    <TopNav />
    <Hero />
    <ProofBar />
    <Features />
    <HowItWorks />
    <AnalyticsShowcase />
    <FinalCTA />
    <Footer />
  </div>
);

export default Landing;
