import { Link } from 'react-router-dom';
import Logo from '../components/Logo';
import Icon, { IconName } from '../components/Icons';
import RevenueTrendChart from '../components/charts/RevenueTrendChart';
import TopItemsChart from '../components/charts/TopItemsChart';
import SalesHeatmap from '../components/charts/SalesHeatmap';
import dashboardScreenshot from '../../../docs/screenshots/dashboard.png';

const CONTACT_EMAIL = 'dylanteopaco@gmail.com';
const WALKTHROUGH_HREF = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('RestaurantIQ walkthrough')}`;

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

const Wordmark = ({ footer = false }: { footer?: boolean }) => (
  <span className="text-[18px] font-extrabold tracking-normal">
    Restaurant<span className={footer ? 'text-[#9db8d6]' : 'text-navy-700'}>IQ</span>
  </span>
);

const TopNav = () => (
  <nav className="sticky top-0 z-40 bg-white/95 backdrop-blur border-b border-line">
    <div className="max-w-[1200px] mx-auto px-5 sm:px-8 lg:px-10 flex items-center h-[68px] gap-4">
      <Link to="/" className="flex items-center gap-[11px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy-500 rounded-md">
        <Logo size={28} on="navy" />
        <Wordmark />
      </Link>
      <div className="hidden md:flex items-center gap-1 ml-5">
        {[
          ['Product', '#product'],
          ['Decisions', '#decisions'],
          ['Analytics', '#analytics'],
        ].map(([label, href]) => (
          <a key={href} href={href} className="px-3 py-2 rounded-md text-[14px] font-semibold text-ink-2 hover:text-ink hover:bg-canvas transition-colors">
            {label}
          </a>
        ))}
      </div>
      <div className="ml-auto flex items-center gap-2">
        <Link to="/login" className="px-3 text-[14px] font-semibold text-ink-2 hover:text-ink whitespace-nowrap">
          Sign in
        </Link>
        <Link to="/signup" className="inline-flex items-center h-[40px] px-4 rounded-md bg-navy-700 text-white text-[14px] font-bold hover:bg-navy-800 transition-colors whitespace-nowrap">
          Join pilot
        </Link>
      </div>
    </div>
  </nav>
);

const Eyebrow = ({ children, navy = false, center = false }: { children: React.ReactNode; navy?: boolean; center?: boolean }) => (
  <span className={`inline-flex items-center gap-2 text-[12px] font-bold tracking-[0.08em] uppercase whitespace-nowrap ${navy ? 'text-[#9db8d6]' : 'text-navy-600'} ${center ? 'justify-center' : ''}`}>
    <span className={`inline-block w-[8px] h-[8px] rotate-45 ${navy ? 'bg-[#9db8d6]' : 'bg-navy-600'}`} />
    {children}
  </span>
);

const ScreenshotPanel = () => (
  <figure className="border border-line bg-surface rounded-lg shadow-shot overflow-hidden">
    <img
      src={dashboardScreenshot}
      alt="RestaurantIQ dashboard showing menu performance, alert summary, revenue, orders, average order value, and item table"
      className="block w-full h-auto"
    />
    <figcaption className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-t border-line bg-canvas px-4 py-3 text-[12.5px] font-semibold text-ink-3">
      <span>The live dashboard tracks real menu behavior across the last 30 days.</span>
      <span className="text-ink-2">No sample prompt. No generic score.</span>
    </figcaption>
  </figure>
);

const Hero = () => (
  <section className="pt-12 sm:pt-16 pb-12 sm:pb-16 bg-surface">
    <div className="max-w-[1200px] mx-auto px-5 sm:px-8 lg:px-10">
      <div className="grid grid-cols-1 lg:grid-cols-[0.82fr_1.18fr] gap-10 lg:gap-12 items-center">
        <div>
          <div className="mb-5"><Eyebrow>RestaurantIQ pilot</Eyebrow></div>
          <h1 className="text-[38px] sm:text-[52px] font-extrabold tracking-normal leading-[1.06] text-ink max-w-[12ch]">
            Menu decisions from actual sales.
          </h1>
          <p className="text-[18px] leading-[1.58] font-medium text-ink-2 max-w-[35ch] mt-5">
            RestaurantIQ connects Square and DoorDash data, then shows which dishes
            are driving revenue, dragging margin, or slipping before the next rush.
          </p>
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 mt-8">
            <Link to="/signup" className="inline-flex items-center justify-center gap-2 h-[48px] px-5 rounded-md bg-navy-700 text-white text-[15px] font-bold hover:bg-navy-800 transition-colors">
              Join the pilot
              <Icon name="arrowUp" size={16} strokeWidth={2} className="rotate-90" />
            </Link>
            <a href={WALKTHROUGH_HREF} className="inline-flex items-center justify-center h-[48px] px-5 rounded-md border border-line text-ink font-bold text-[15px] hover:bg-canvas hover:border-ink-3 transition-colors">
              Request walkthrough
            </a>
          </div>
          <dl className="grid grid-cols-3 gap-4 mt-8 max-w-[440px]">
            {[
              ['30 days', 'default view'],
              ['2 feeds', 'Square + DoorDash'],
              ['Costs', 'margin-ready'],
            ].map(([value, label]) => (
              <div key={label} className="border-t border-line pt-3">
                <dt className="text-[18px] font-extrabold text-ink tnum">{value}</dt>
                <dd className="text-[12.5px] font-semibold text-ink-3">{label}</dd>
              </div>
            ))}
          </dl>
        </div>
        <ScreenshotPanel />
      </div>
    </div>
  </section>
);

const PilotBar = () => (
  <section className="border-y border-line bg-canvas">
    <div className="max-w-[1200px] mx-auto px-5 sm:px-8 lg:px-10 py-5 grid grid-cols-1 md:grid-cols-[auto_1fr_auto] gap-3 md:gap-5 items-center">
      <span className="inline-flex items-center gap-2 text-[12px] font-bold tracking-[0.08em] uppercase text-navy-600">
        <Icon name="store" size={16} /> Pilot restaurants wanted
      </span>
      <p className="text-[14.5px] leading-[1.55] font-medium text-ink-2">
        Built for independent operators who need weekly decisions, not another
        dashboard to babysit.
      </p>
      <a href={WALKTHROUGH_HREF} className="text-[14px] font-bold text-navy-700 hover:text-navy-800 underline underline-offset-4">
        Talk to the team
      </a>
    </div>
  </section>
);

const SectionHead = ({ eyebrow, title, body, center = false, navy = false }: { eyebrow: string; title: string; body: string; center?: boolean; navy?: boolean }) => (
  <div className={`max-w-[760px] ${center ? 'mx-auto text-center' : ''}`}>
    <div className="mb-4"><Eyebrow navy={navy} center={center}>{eyebrow}</Eyebrow></div>
    <h2 className={`text-[30px] sm:text-[40px] font-extrabold tracking-normal leading-[1.08] mb-4 ${navy ? 'text-white' : 'text-ink'}`}>{title}</h2>
    <p className={`text-[17px] leading-[1.58] font-medium ${navy ? 'text-white/75' : 'text-ink-2'}`}>{body}</p>
  </div>
);

const DecisionRow = ({ icon, title, body, signal }: { icon: IconName; title: string; body: string; signal: string }) => (
  <div className="grid grid-cols-[42px_1fr] sm:grid-cols-[42px_1fr_160px] gap-4 sm:gap-5 items-start border-t border-line py-5">
    <div className="w-[42px] h-[42px] rounded-md bg-navy-50 text-navy-700 flex items-center justify-center">
      <Icon name={icon} size={21} />
    </div>
    <div>
      <h3 className="text-[18px] font-extrabold text-ink">{title}</h3>
      <p className="text-[15px] leading-[1.55] font-medium text-ink-2 mt-1">{body}</p>
    </div>
    <div className="col-start-2 sm:col-start-auto text-[12.5px] font-bold text-ink-2 bg-canvas border border-line rounded-md px-3 py-2">
      {signal}
    </div>
  </div>
);

const ProductSection = () => (
  <section id="product" className="py-16 sm:py-20">
    <div className="max-w-[1200px] mx-auto px-5 sm:px-8 lg:px-10 grid grid-cols-1 lg:grid-cols-[0.95fr_1.05fr] gap-10 lg:gap-14">
      <SectionHead
        eyebrow="Built around operator questions"
        title="Less dashboard theater. More useful next moves."
        body="The first screen starts with what changed, then backs it up with the numbers an owner can act on: revenue, orders, item count, and menu-level trend."
      />
      <div>
        <DecisionRow
          icon="alerts"
          title="Catch the dish that is slipping"
          body="Flag a top item before the revenue drop becomes the whole week."
          signal="Wagyu Burger down 31%"
        />
        <DecisionRow
          icon="margins"
          title="Separate sales from profit"
          body="Pair revenue with item cost so best-sellers do not hide thin margins."
          signal="Cost tracked in cents"
        />
        <DecisionRow
          icon="marketing"
          title="Turn the finding into a promo"
          body="Use the performance signal as the brief for a caption or special."
          signal="Promote, reprice, or cut"
        />
      </div>
    </div>
  </section>
);

const WorkflowSection = () => {
  const steps: { n: string; icon: IconName; t: string; d: string }[] = [
    { n: '01', icon: 'integrations', t: 'Connect the feeds', d: 'Square and DoorDash orders land in one view, with setup help during the pilot.' },
    { n: '02', icon: 'analytics', t: 'Review the week', d: 'Scan top movers, weak margins, time-of-day heat, and recent alerts without exporting a spreadsheet.' },
    { n: '03', icon: 'check', t: 'Make one clean move', d: 'Pick the dish to feature, fix, reprice, or stop pushing before the next service window.' },
  ];

  return (
    <section id="decisions" className="py-16 sm:py-20 bg-canvas">
      <div className="max-w-[1200px] mx-auto px-5 sm:px-8 lg:px-10">
        <SectionHead center eyebrow="Workflow" title="A weekly rhythm for menu decisions." body="RestaurantIQ is intentionally narrow: connect the sources, read the signals, make the menu move." />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-10">
          {steps.map((s) => (
            <div key={s.n} className="bg-surface border border-line rounded-lg p-5">
              <div className="flex items-center gap-3 text-[12px] font-extrabold text-navy-700 tracking-[0.08em] uppercase mb-5">
                {s.n}<span className="flex-1 h-px bg-line" />
              </div>
              <div className="w-[44px] h-[44px] rounded-md border border-line bg-canvas flex items-center justify-center text-navy-700 mb-4">
                <Icon name={s.icon} size={21} />
              </div>
              <h3 className="text-[18px] font-extrabold text-ink mb-2">{s.t}</h3>
              <p className="text-[14.5px] leading-[1.55] font-medium text-ink-2">{s.d}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

const AnalyticsShowcase = () => (
  <section id="analytics" className="py-16 sm:py-20">
    <div className="max-w-[1200px] mx-auto px-5 sm:px-8 lg:px-10">
      <SectionHead eyebrow="Analytics" title="Concrete numbers before generated advice." body="The charts stay grounded in order and item data. AI-written guidance only sits on top of the measured facts." />
      <div className="grid grid-cols-1 lg:grid-cols-[1.5fr_1fr] gap-4 mt-10">
        <div className="bg-surface border border-line rounded-lg px-5 py-5 shadow-sm">
          <div className="flex items-baseline justify-between gap-3 mb-4">
            <h3 className="text-lg font-extrabold text-ink">Revenue Trend</h3>
            <span className="text-[12.5px] font-bold text-pos whitespace-nowrap">+8.4% vs. previous 30 days</span>
          </div>
          <RevenueTrendChart data={SAMPLE_TREND} loading={false} />
        </div>
        <div className="bg-surface border border-line rounded-lg px-5 py-5 shadow-sm">
          <h3 className="text-lg font-extrabold text-ink mb-4">Top Items by Revenue</h3>
          <TopItemsChart data={SAMPLE_TOP} loading={false} />
        </div>
        <div className="bg-surface border border-line rounded-lg px-5 py-5 shadow-sm lg:col-span-2">
          <div className="flex items-baseline justify-between gap-3 mb-4">
            <h3 className="text-lg font-extrabold text-ink">Busiest Hours</h3>
            <span className="text-[12.5px] font-bold text-ink-3 whitespace-nowrap">Last 30 days · by day &amp; hour</span>
          </div>
          <SalesHeatmap data={SAMPLE_HEAT} loading={false} />
        </div>
      </div>
    </div>
  </section>
);

const FinalCTA = () => (
  <section className="py-16 sm:py-20 bg-navy-700 text-white text-center">
    <div className="max-w-[1200px] mx-auto px-5 sm:px-8 lg:px-10">
      <Eyebrow navy center>Start with one restaurant</Eyebrow>
      <h2 className="mt-4 text-[34px] sm:text-[46px] font-extrabold tracking-normal leading-[1.08] max-w-[20ch] mx-auto mb-5">
        Bring your menu data into one usable view.
      </h2>
      <p className="text-[18px] font-medium text-white/75 max-w-[48ch] mx-auto mb-8">
        Pilot restaurants get hands-on setup help and a direct line to the product team.
      </p>
      <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
        <Link to="/signup" className="inline-flex items-center justify-center gap-2 h-[48px] px-5 rounded-md bg-white text-navy-700 text-[15px] font-bold hover:bg-navy-50 transition-colors">
          Join pilot
          <Icon name="arrowUp" size={16} strokeWidth={2} className="rotate-90" />
        </Link>
        <a href={WALKTHROUGH_HREF} className="inline-flex items-center justify-center h-[48px] px-5 rounded-md border border-white/25 bg-white/10 text-white text-[15px] font-bold hover:bg-white/15 transition-colors">
          Request walkthrough
        </a>
      </div>
    </div>
  </section>
);

const Footer = () => (
  <footer className="bg-navy-900 text-white/65 pt-12 pb-8">
    <div className="max-w-[1200px] mx-auto px-5 sm:px-8 lg:px-10 grid grid-cols-1 md:grid-cols-[1.6fr_1fr_1fr] gap-8">
      <div className="max-w-[32ch]">
        <div className="flex items-center gap-[11px] text-white mb-4">
          <Logo size={28} on="light" /> <Wordmark footer />
        </div>
        <p className="text-[14.5px] leading-[1.6]">
          Restaurant analytics for weekly menu decisions: what sells, what slips,
          and what deserves attention before the next rush.
        </p>
      </div>
      <div>
        <h4 className="text-[13px] font-bold text-white tracking-[0.08em] uppercase mb-4">Product</h4>
        {[
          ['Product', '#product'],
          ['Decisions', '#decisions'],
          ['Analytics', '#analytics'],
        ].map(([label, href]) => (
          <a key={label} href={href} className="block text-[14.5px] text-white/70 py-1.5 font-medium hover:text-white">{label}</a>
        ))}
      </div>
      <div>
        <h4 className="text-[13px] font-bold text-white tracking-[0.08em] uppercase mb-4">Contact</h4>
        <a href={WALKTHROUGH_HREF} className="block text-[14.5px] text-white/70 py-1.5 font-medium hover:text-white">Join the pilot</a>
        <a href={`mailto:${CONTACT_EMAIL}`} className="block text-[14.5px] text-white/70 py-1.5 font-medium hover:text-white">{CONTACT_EMAIL}</a>
      </div>
    </div>
    <div className="max-w-[1200px] mx-auto px-5 sm:px-8 lg:px-10 border-t border-white/10 mt-10 pt-6 text-[13.5px]">
      <span>© 2026 RestaurantIQ. All rights reserved.</span>
    </div>
  </footer>
);

const Landing = () => (
  <div className="bg-surface text-ink min-h-screen">
    <TopNav />
    <Hero />
    <PilotBar />
    <ProductSection />
    <WorkflowSection />
    <AnalyticsShowcase />
    <FinalCTA />
    <Footer />
  </div>
);

export default Landing;
